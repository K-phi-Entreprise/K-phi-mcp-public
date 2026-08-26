/**
 * Serveur MCP public K-Phi — transport Streamable HTTP, mode stateless
 * (un McpServer + transport par requête : simple à scaler sur Render, pas d'état
 * en mémoire à partager entre instances).
 *
 * Endpoints :
 *   POST /mcp            — endpoint MCP (Claude, ChatGPT, Cursor…)
 *   PUT  /upload/:token  — dépôt direct du fichier (lien signé, 15 min)
 *   GET  /healthz
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { MockEngine, type AnalysisEngine } from "./engine.js";
import { KphiHttpEngine } from "./engine-http.js";
import { MemoryStore, type Store } from "./store.js";
import { RateLimiter, contextMiddleware, type RequestContext } from "./ratelimit.js";
import { createUploadStorage } from "./upload-storage.js";
import { UsageCounter } from "./usage.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Icône du serveur (SEP-973, MCP ≥ 2025-11-25) : K-Φ 192×192 en data URI. Inerte
// tant que claude.ai ne lit pas serverInfo.icons pour les connecteurs custom,
// mais conforme à la spec et prêt pour l'annuaire.
const ICON_DATA_URI = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const png = readFileSync(join(here, "..", "assets", "icon-192.png"));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch { return undefined; }
})();

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://k-phi.com";
const INGEST_BASE_URL = process.env.INGEST_BASE_URL ?? `http://localhost:${PORT}`;
const UTM_SOURCE = process.env.UTM_SOURCE ?? "mcp";
// Optionnel : si défini, /stats exige ?token=... ou l'en-tête X-Stats-Token.
// Sans ça, les compteurs d'usage (volume d'analyses, taux de conversion) sont
// visibles publiquement — acceptable au tout début pour se motiver et itérer
// vite, mais à définir avant que le lien /stats circule au-delà de vous.
const STATS_TOKEN = process.env.STATS_TOKEN;

// ---- Moteur : réel si configuré, mock sinon (le mock reste le défaut tant que
// l'endpoint sandbox n'est pas déployé côté moteur — rien ne casse entre-temps).
const KPHI_ENGINE_URL = process.env.KPHI_ENGINE_URL;        // ex. https://k-phi.com
const KPHI_SANDBOX_SECRET = process.env.KPHI_SANDBOX_SECRET; // = même valeur côté moteur
const engine: AnalysisEngine = (KPHI_ENGINE_URL && KPHI_SANDBOX_SECRET)
  ? new KphiHttpEngine({
      baseUrl: KPHI_ENGINE_URL, serviceSecret: KPHI_SANDBOX_SECRET,
      /* branché plus bas une fois le stockage construit — voir _wireStorage */
    })
  : new MockEngine();
console.log(`engine: ${engine instanceof MockEngine ? "MOCK (KPHI_ENGINE_URL/KPHI_SANDBOX_SECRET non définis)" : "K-Phi @ " + KPHI_ENGINE_URL}`);

// ---- Upload volumineux : refusé tant que le stockage objet n'est pas branché.
// Sans ce garde, PUT /upload acceptait le fichier (202) puis le PERDAIT :
// req.body n'était écrit nulle part et analyzeFromStorage est un stub qui
// throw — l'utilisateur ne voyait l'échec qu'au kphi_get_analysis suivant.
// KPHI_UPLOAD_STORAGE portera la config du backend (URL S3/R2) en Phase 2 ;
// sa simple présence ré-active la route (valeur "mock" possible pour tester
// le routage avec MockEngine.analyzeFromStorage).
const KPHI_UPLOAD_STORAGE = process.env.KPHI_UPLOAD_STORAGE;
const uploadSetup = createUploadStorage(KPHI_UPLOAD_STORAGE);
const UPLOAD_ENABLED = uploadSetup.kind !== "disabled";
console.log(`upload volumineux: ${UPLOAD_ENABLED ? "activé — " + uploadSetup.note
  : uploadSetup.note + " — kphi_request_upload refuse, PUT /upload → 501"}`);
/* Balayage TTL : les uploads sont consommés en secondes ; tout fichier de
   plus de 24 h est un déchet (analyse en erreur jamais reprise). unref() :
   le timer n'empêche pas le process de sortir. */
if (uploadSetup.storage) {
  const sweepEvery = setInterval(() => {
    void uploadSetup.storage!.sweep(24 * 3600 * 1000)
      .then(n => { if (n > 0) console.log(`upload sweep: ${n} fichier(s) purgé(s)`); });
  }, 3600 * 1000);
  sweepEvery.unref();
}
/* Le moteur HTTP lit les uploads via le même backend que la route PUT.
   (Affectation ici : uploadSetup est construit après l'instance moteur.) */
if (engine instanceof KphiHttpEngine && uploadSetup.storage) {
  engine.cfg.storageRead = async (key: string) => (await uploadSetup.storage!.read(key)).toString("utf8");
}
const store: Store = new MemoryStore();
const limiter = new RateLimiter({
  analysesPerIpPerDay: Number(process.env.RL_PER_IP_PER_DAY ?? 0),          // 0 : désactivé (IPs partagées côté assistant)
  analysesPerSessionPerDay: Number(process.env.RL_PER_SESSION_PER_DAY ?? 5),
  analysesPerDayGlobal: Number(process.env.RL_GLOBAL_PER_DAY ?? 500),
});
const usage = new UsageCounter();

const app = express();
app.set("trust proxy", true); // Render / reverse proxy → X-Forwarded-For
app.use(contextMiddleware);

/* Version déployée exposée : chaque aller-retour terrain de cette semaine a
   commencé par « le fix est-il déployé ? » sans moyen de répondre. Render
   fournit RENDER_GIT_COMMIT ; curl /healthz clôt la question. */
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, commit: (process.env.RENDER_GIT_COMMIT ?? "dev").slice(0, 9),
             deployed_at: process.env.RENDER_DEPLOY_TIME ?? null });
});

// ---- Endpoint MCP ----
app.post("/mcp", express.json({ limit: "3mb" }), async (req, res) => {
  const ctx = res.locals.ctx as RequestContext;

  const server = new McpServer({
    name: "k-phi", version: "0.2.0", title: "K-Φ",
    websiteUrl: PUBLIC_BASE_URL,
    ...(ICON_DATA_URI ? { icons: [{ src: ICON_DATA_URI, mimeType: "image/png", sizes: ["192x192"] }] } : {}),
  }, {
    instructions:
      "K-Φ est un moteur comptable : il calcule des états financiers et des KPI exacts, déterministes et " +
      "traçables à partir d'un export brut (grand livre, balance, FEC), et conserve l'analyse. Utilisez " +
      "kphi_analyze_ledger dès qu'un utilisateur fournit des données comptables et demande une analyse, " +
      "plutôt que d'estimer les chiffres vous-même : sur un fichier réel, l'estimation tronque ou se trompe.",
  });
  registerTools(server, {
    engine, store, limiter, usage,
    publicBaseUrl: PUBLIC_BASE_URL,
    ingestBaseUrl: INGEST_BASE_URL,
    ctx: () => ctx,
    source: UTM_SOURCE,
    uploadEnabled: UPLOAD_ENABLED,
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless
    enableJsonResponse: true,         // réponse JSON simple (pas de SSE) : suffisant pour des appels courts
  });
  res.on("close", () => { void transport.close(); void server.close(); });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP error", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

// GET/DELETE /mcp non supportés en stateless
app.all("/mcp", (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

// ---- Upload signé (gros fichiers) ----
// En prod : générer plutôt une URL pré-signée S3/R2 et déclencher l'analyse par événement.
app.put("/upload/:token",
  // Garde AVANT express.raw : refuser sans bufferiser jusqu'à 500 Mo en mémoire.
  // 501 (pas 4xx) : la route existe, la capacité n'est pas implémentée ici.
  // Le token n'est pas consommé — normalement aucun n'est émis quand l'upload
  // est désactivé (tools.ts), ce garde couvre les liens anciens ou forgés.
  (_req, res, next) => {
    if (UPLOAD_ENABLED) { next(); return; }
    res.status(501).json({
      error: "Upload volumineux indisponible sur ce déploiement (stockage objet non configuré). " +
             "Fichiers ≤ 2 Mo : kphi_analyze_ledger.",
    });
  },
  express.raw({ type: "*/*", limit: "500mb" }), async (req, res) => {
  const analysisId = await store.consumeUploadToken(req.params.token as string);
  if (!analysisId) { res.status(410).json({ error: "Lien expiré ou invalide." }); return; }
  const rec = await store.get(analysisId);
  if (!rec) { res.status(404).json({ error: "Analyse introuvable." }); return; }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: "Corps vide : envoyez le fichier en corps de requête (PUT binaire)." }); return;
  }

  const storageKey = `uploads/${analysisId}`;
  /* PERSISTER AVANT de répondre 202 : la version précédente répondait 202
     puis jetait req.body — un « pending » qui ne pouvait jamais aboutir.
     Si l'écriture échoue, l'appelant le sait tout de suite (500), le token
     est déjà consommé mais kphi_request_upload peut en réémettre un. */
  if (uploadSetup.storage) {
    try { await uploadSetup.storage.save(storageKey, req.body); }
    catch (e) {
      console.error("upload save failed", e);
      res.status(500).json({ error: "Échec d'écriture du fichier — réessayez avec un nouveau lien." });
      return;
    }
  }
  await store.update(analysisId, { storage_key: storageKey });
  res.status(202).json({ analysis_id: analysisId, status: "pending" });

  // Analyse asynchrone : le résultat (ou l'erreur, via la taxonomie) est
  // relevé par kphi_get_analysis. Fichier supprimé sur succès ; conservé
  // sur erreur jusqu'au sweep 24 h (diagnostic).
  try {
    const result = await engine.analyzeFromStorage(storageKey, rec.opts);
    await store.update(analysisId, { status: "ready", result });
    if (uploadSetup.storage) await uploadSetup.storage.remove(storageKey).catch(() => {});
  } catch (e) {
    await store.update(analysisId, { status: "error", error: e instanceof Error ? e.message : String(e) });
  }
});

// ---- Clic de conversion : compté ici, puis redirigé vers la plateforme ----
// /a/:id doit pointer sur CE serveur (voir ingestBaseUrl dans tools.ts), pas
// sur k-phi.com directement, sinon le clic ne laisse aucune trace.
// TODO côté app K-Phi : la cible réelle doit créer un compte par magic link
// et rattacher analysisId — à date cette route n'existe peut-être pas encore
// sur k-phi.com, d'où le repli sur PUBLIC_BASE_URL tel quel en attendant.
app.get("/a/:id", async (req, res) => {
  usage.record("conversion_click");
  const q = new URLSearchParams(req.query as Record<string, string>);
  const rec = await store.get(req.params.id);
  const sb = rec?.result?.sandbox;
  // Moteur réel : lien signé qui ouvre le tenant en lecture seule dans l'app.
  // Jamais d'UTM ici — c'est un JWT, pas une query string, donc rien à ajouter.
  if (sb?.open_url) { res.redirect(302, sb.open_url); return; }
  // Repli (mock, ou open-link en échec) : la page /a/:id côté plateforme.
  // L'attribution (deps.source, ex. "mcp") vit dans le store depuis la création
  // de l'analyse, pas dans l'URL affichée à l'utilisateur (voir tools.ts) —
  // elle n'apparaît que sur CETTE redirection serveur, invisible pour lui.
  if (rec) q.set("utm_source", rec.attribution);
  if (sb) { q.set("tenant", sb.tenant_id); q.set("ver", sb.ver); }
  res.redirect(302, `${PUBLIC_BASE_URL}/a/${req.params.id}?${q.toString()}`);
});

// ---- Compteurs d'usage (volume, conversion) — protégé si STATS_TOKEN est défini ----
app.get("/stats", (req, res) => {
  if (STATS_TOKEN) {
    const supplied = (req.query.token as string | undefined) ?? req.header("X-Stats-Token");
    if (supplied !== STATS_TOKEN) { res.status(401).json({ error: "Token manquant ou invalide." }); return; }
  }
  res.json(usage.snapshot());
});

app.listen(PORT, () => {
  console.log(`K-Phi MCP server listening on :${PORT}  (POST /mcp)`);
});
