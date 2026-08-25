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
  ? new KphiHttpEngine({ baseUrl: KPHI_ENGINE_URL, serviceSecret: KPHI_SANDBOX_SECRET })
  : new MockEngine();
console.log(`engine: ${engine instanceof MockEngine ? "MOCK (KPHI_ENGINE_URL/KPHI_SANDBOX_SECRET non définis)" : "K-Phi @ " + KPHI_ENGINE_URL}`);
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

app.get("/healthz", (_req, res) => { res.json({ ok: true }); });

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
app.put("/upload/:token", express.raw({ type: "*/*", limit: "500mb" }), async (req, res) => {
  const analysisId = await store.consumeUploadToken(req.params.token as string);
  if (!analysisId) { res.status(410).json({ error: "Lien expiré ou invalide." }); return; }
  const rec = await store.get(analysisId);
  if (!rec) { res.status(404).json({ error: "Analyse introuvable." }); return; }

  // TODO : antivirus, persistance objet, chiffrement au repos, TTL 24 h
  const storageKey = `uploads/${analysisId}`;
  await store.update(analysisId, { storage_key: storageKey });
  res.status(202).json({ analysis_id: analysisId, status: "pending" });

  // Analyse asynchrone
  try {
    const result = await engine.analyzeFromStorage(storageKey, rec.opts);
    await store.update(analysisId, { status: "ready", result });
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
  // Le tenant sandbox qui héberge l'analyse : c'est lui que la plateforme doit
  // rattacher au compte créé par magic link. Absent avec le mock.
  const rec = await store.get(req.params.id);
  const sb = rec?.result?.sandbox;
  // Moteur réel : lien signé qui ouvre le tenant en lecture seule dans l'app.
  if (sb?.open_url) { res.redirect(302, sb.open_url); return; }
  // Repli (mock, ou open-link en échec) : la page /a/:id côté plateforme.
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
