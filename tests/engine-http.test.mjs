/**
 * Tests KphiHttpEngine avec fetch simulé : contrat sur le fil (fiscal_year,
 * period_num, header_text), retry sur 5xx transitoire, taxonomie des erreurs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KphiHttpEngine, EngineError } from "../dist/engine-http.js";
import { NeedsInputError, ParseError } from "../dist/parse-ledger.js";
import { describeAnalysisError } from "../dist/tools.js";

const LEDGER = `Date,Account,AccountName,Debit,Credit
2025-01-05,10100,Cash,100.00,0.00
2025-01-05,40000,Sales,0.00,100.00
2025-02-07,10100,Cash,50.00,0.00
2025-02-07,40000,Sales,0.00,50.00
`;

/** Moteur simulé. failImports = nombre de 500 à servir sur /api/gl/import. */
function mockEngine({ failImports = 0 } = {}) {
  const calls = { tenant: 0, imports: [], statements: 0, openLink: 0 };
  let importFails = failImports;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const ok = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.includes("/api/internal/sandbox/tenant")) {
      calls.tenant++;
      return ok({ tenantId: "a".repeat(32), name: "MCP-TST-20260825", token: "jwt" });
    }
    if (u.includes("/api/gl/import")) {
      const body = JSON.parse(init.body);
      calls.imports.push(body);
      if (importFails > 0) { importFails--; return ok({ error: "Internal server error" }, 500); }
      return ok({ imported: body.entries.length });
    }
    if (u.includes("/api/statements")) {
      calls.statements++;
      return ok({ kpi: { "Net Revenue": 150, "Net Income": 150 }, ratios: { dso: 30 } });
    }
    if (u.includes("/api/internal/sandbox/open-link")) {
      calls.openLink++;
      return ok({ url: "https://k-phi.example/open?t=x" });
    }
    return ok({ error: "unexpected " + u }, 404);
  };
  return calls;
}

function engine() {
  return new KphiHttpEngine({ baseUrl: "https://engine.test", serviceSecret: "s", retryDelayMs: 5 });
}

test("contrat sur le fil : une version par période, fiscal_year/period_num, header_text transmis", async () => {
  const calls = mockEngine();
  const r = await engine().analyze({ content: LEDGER, format_hint: "generic", locale: "fr" });
  assert.equal(calls.imports.length, 2, "deux périodes → deux imports");
  const jan = calls.imports.find(b => b.ver === "2025-01");
  assert.equal(jan.fiscal_year, 2025);
  assert.equal(jan.period_num, 1);
  assert.equal(jan.mode, "replace");
  assert.equal(jan.entries[0].header_text, "Cash", "l'intitulé de compte voyage avec l'écriture");
  assert.equal(r.detected.period, "2025-01..2025-02");
});

test("retry : un 500 transitoire sur le premier import est absorbé (le « try again » automatisé)", async () => {
  const calls = mockEngine({ failImports: 1 });
  await engine().analyze({ content: LEDGER, format_hint: "generic", locale: "fr" });
  assert.equal(calls.imports.length, 3, "1 échec + 1 retry + 2e période");
});

test("500 persistant : EngineError avec statut, après épuisement du retry", async () => {
  mockEngine({ failImports: 99 });
  await assert.rejects(
    engine().analyze({ content: LEDGER, format_hint: "generic", locale: "fr" }),
    (e) => e instanceof EngineError && e.status === 500);
});

test("NeedsInputError du parseur remonte telle quelle (pas transformée en EngineError)", async () => {
  mockEngine();
  const noDates = "Account,Debit,Credit\n10100,10.00,0.00\n40000,0.00,10.00\n";
  await assert.rejects(
    engine().analyze({ content: noDates, format_hint: "generic", locale: "fr" }),
    (e) => e instanceof NeedsInputError);
});

/* ── Taxonomie côté outil : trois messages, trois responsables ───── */

test("taxonomie : NeedsInput → question structurée ; Engine → jamais la faute du fichier ; Parse → conseils de format", () => {
  const need = describeAnalysisError(new NeedsInputError("Aucune information de date.", ["period_end"]), "an_1");
  assert.deepEqual(need.needs, ["period_end"]);
  assert.match(need.text, /period_end/);

  const eng = describeAnalysisError(new EngineError("import 2025-01: 500 Internal server error", 500), "an_2");
  assert.match(eng.text, /n'est pas en cause/);
  assert.doesNotMatch(eng.text, /export comptable/, "un 5xx moteur n'accuse plus le fichier");
  assert.match(eng.text, /an_2/);

  const parse = describeAnalysisError(new ParseError("Colonne compte introuvable"), "an_3");
  assert.match(parse.text, /export comptable/);
  assert.equal(parse.needs, undefined);

  const other = describeAnalysisError(new Error("boom"), "an_4");
  assert.match(other.text, /an_4/);
});

/* ── Seed CoA (Phase 2) ──────────────────────────────────────────── */

test("coa_dict transmis à /api/internal/sandbox/coa avec le secret, AVANT statements", async () => {
  const calls = mockEngine();
  const order = [];
  const base = globalThis.fetch;
  let coaBody = null, coaHeaders = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/sandbox/coa")) {
      order.push("coa"); coaBody = JSON.parse(init.body); coaHeaders = init.headers;
      return new Response(JSON.stringify({ seeded: 2 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/api/statements")) order.push("statements");
    return base(url, init);
  };
  await engine().analyze({ content: LEDGER, format_hint: "generic", locale: "fr" });
  assert.deepEqual(coaBody.coa, { "10100": "Cash", "40000": "Sales" });
  assert.equal(coaBody.tenantId, "a".repeat(32));
  assert.equal(coaHeaders["X-Sandbox-Secret"], "s");
  assert.ok(order.indexOf("coa") < order.indexOf("statements"), "seed avant les lectures");
});

test("moteur sans le endpoint coa (404) : l'analyse aboutit quand même", async () => {
  mockEngine(); /* le mock répond 404 sur les URLs inconnues, dont /sandbox/coa */
  const r = await engine().analyze({ content: LEDGER, format_hint: "generic", locale: "fr" });
  assert.equal(r.detected.entries, 4);
});

/* ── Upload storage (Phase 2, PR 5) ──────────────────────────────── */
import { FsUploadStorage, createUploadStorage, safeName } from "../dist/upload-storage.js";
import { LimitError } from "../dist/engine-http.js";
import { mkdtemp, writeFile as wf, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("stockage fichier : save/read/remove, clés assainies (pas de traversal)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kphi-t-"));
  const st = new FsUploadStorage(dir);
  await st.save("uploads/an_x1", Buffer.from("a,b\n1,2\n"));
  assert.equal((await st.read("uploads/an_x1")).toString(), "a,b\n1,2\n");
  assert.equal(safeName("../../etc/passwd"), ".._.._etc_passwd");
  await st.save("../../evil", Buffer.from("x"));
  const names = await readdir(dir);
  assert.ok(names.every(n => !n.includes("/") && !n.includes("..") || n.startsWith(".._")), JSON.stringify(names));
  await st.remove("uploads/an_x1");
  await assert.rejects(st.read("uploads/an_x1"));
});

test("sweep TTL : purge les vieux fichiers, épargne les récents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kphi-t-"));
  const st = new FsUploadStorage(dir);
  await st.save("old", Buffer.from("o"));
  await st.save("fresh", Buffer.from("f"));
  const past = new Date(Date.now() - 48 * 3600 * 1000);
  await utimes(join(dir, "old"), past, past);
  const purged = await st.sweep(24 * 3600 * 1000);
  assert.equal(purged, 1);
  assert.equal((await st.read("fresh")).toString(), "f");
});

test("createUploadStorage : tmp actif, valeur inconnue → désactivé (jamais accepter sans savoir relire)", () => {
  assert.equal(createUploadStorage(undefined).kind, "disabled");
  assert.equal(createUploadStorage("mock").kind, "mock");
  assert.equal(createUploadStorage("tmp").kind, "tmp");
  assert.equal(createUploadStorage("s3://bucket").kind, "disabled");
});

test("analyzeFromStorage : lit le fichier via storageRead et aboutit à une analyse complète", async () => {
  mockEngine();
  const dir = await mkdtemp(join(tmpdir(), "kphi-t-"));
  const st = new FsUploadStorage(dir);
  await st.save("uploads/an_up1", Buffer.from(LEDGER));
  const e = new KphiHttpEngine({
    baseUrl: "https://engine.test", serviceSecret: "s", retryDelayMs: 5,
    storageRead: async (k) => (await st.read(k)).toString("utf8"),
  });
  const r = await e.analyzeFromStorage("uploads/an_up1", { format_hint: "generic", locale: "fr" });
  assert.equal(r.detected.entries, 4);
});

test("analyzeFromStorage sans lecteur : EngineError explicite, jamais un fichier perdu en silence", async () => {
  await assert.rejects(
    engine().analyzeFromStorage("uploads/x", { format_hint: "generic", locale: "fr" }),
    (e) => e instanceof EngineError && /non configuré/.test(e.message));
});

test("cap d'écritures : LimitError claire, sans préfixe « Impossible de lire »", async () => {
  mockEngine();
  const e = new KphiHttpEngine({ baseUrl: "https://engine.test", serviceSecret: "s", retryDelayMs: 5, maxSandboxEntries: 2 });
  await assert.rejects(
    e.analyze({ content: LEDGER, format_hint: "generic", locale: "fr" }),
    (err) => err instanceof LimitError && /limitée à 2/.test(err.message));
  const d = describeAnalysisError(new LimitError("L'analyse anonyme est limitée à 2 écritures."), "an_9");
  assert.doesNotMatch(d.text, /Impossible de lire/);
  assert.match(d.text, /limitée/);
});

/* ── Télémétrie de mapping (PR 11) ───────────────────────────────── */
import { recordAnalysisSignals } from "../dist/tools.js";

test("signaux de mapping : genre, adoption/rétrogradation, overrides — comptés ; detected partiel toléré", () => {
  const events = [];
  const usage = { record: (e) => events.push(e) };
  recordAnalysisSignals(usage, { genre: "trial_balance", name_source: "adopted", overrides_applied: 2 });
  assert.deepEqual(events.sort(), ["acct_name:adopted", "column_map_override", "genre:trial_balance"]);
  events.length = 0;
  recordAnalysisSignals(usage, { genre: "ledger", name_source: "mapped", overrides_applied: 0 });
  assert.deepEqual(events, ["genre:ledger"]);
  events.length = 0;
  recordAnalysisSignals(usage, undefined);          /* moteur mock / ancien résultat */
  recordAnalysisSignals(usage, { genre: "bizarre" }); /* valeur inattendue : ignorée */
  assert.deepEqual(events, []);
});
