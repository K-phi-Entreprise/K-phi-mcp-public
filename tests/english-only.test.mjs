/**
 * english-only.test.mjs — WHY: the server is listed in AI-assistant directories
 * (Anthropic, OpenAI). Every string a reviewer or an end user can see must be
 * English by default. A French string that slips through is a listing risk,
 * not a cosmetic bug — so this runs on every commit, not on someone's eyes.
 *
 * Two layers:
 *   A. RUNTIME — a real McpServer wired in memory, driven by the SDK Client:
 *      tools/list, prompts/list+get, resources/list+read, tools/call on all
 *      four tools (positive and negative paths). Every string in every
 *      response is scanned, at any depth.
 *   B. STATIC  — src/*.ts scanned line by line, comments stripped. Regions
 *      that are legitimately French (header synonyms, the fr dashboard
 *      locale) are marked in the source with i18n:fr-ok markers; nothing
 *      here is guessed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, describeAnalysisError } from "../dist/tools.js";
import { MockEngine } from "../dist/engine.js";
import { MemoryStore } from "../dist/store.js";
import { RateLimiter } from "../dist/ratelimit.js";
import { UsageCounter } from "../dist/usage.js";
import { parseLedger, ParseError, NeedsInputError } from "../dist/parse-ledger.js";

/* ───────────────────────── scanner ───────────────────────── */

/** Non-ASCII characters allowed in English output. */
const ALLOWED = new Set([..."ΦφΔ€£¥₣−—–‘’“”…≥≤≠×÷·°±≈→←↑↓↗↘ℹ⚠⛔✅✓•▰▱⚪🟢🟡🔴📊📈💧🏦🔗🔮➡️📄", "\u00A0", "\uFE0F"]);

/** French markers. Only words that are NOT also English. */
const FRENCH_WORDS = [
  "veuillez", "fichier", "fichiers", "erreur", "erreurs", "aucun", "aucune", "votre", "vos", "vous",
  "notre", "nous", "cette", "avec", "pour", "dans", "mais", "donnees", "colonne", "colonnes",
  "ecriture", "ecritures", "montant", "montants", "compte", "comptes", "periode", "resultat",
  "manquant", "manquante", "invalide", "introuvable", "verifiez", "reessayez", "seuil", "tresorerie",
  "synthese", "analyse", "relancez", "indisponible", "disponible", "valable", "au besoin", "en cours",
  "n'est pas", "il faut", "s'il vous", "ci-dessous", "plutot", "jamais", "toujours",
];
const WORD_RE = new RegExp("\\b(" + FRENCH_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i");

function inspect(s, where) {
  const out = [];
  for (const ch of s) {
    if (ch.codePointAt(0) > 127 && !ALLOWED.has(ch)) {
      out.push(`${where}\n    non-ASCII "${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")})\n    → ${JSON.stringify(s.slice(0, 160))}`);
      break;
    }
  }
  const m = WORD_RE.exec(s);
  if (m) out.push(`${where}\n    French marker "${m[1]}"\n    → ${JSON.stringify(s.slice(0, 160))}`);
  return out;
}

/** Deep-walk any value; every string is inspected with its JSON path. */
function collect(v, path = "$") {
  if (typeof v === "string") return inspect(v, path);
  if (Array.isArray(v)) return v.flatMap((x, i) => collect(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => collect(x, `${path}.${k}`));
  return [];
}

function assertEnglish(label, value) {
  const f = collect(value);
  assert.equal(f.length, 0, `\n${f.length} non-English string(s) in ${label}:\n  ${f.join("\n  ")}\n`);
}

/* ─────────────────── layer A: real server, in memory ─────────────────── */

async function boot({ uploadEnabled = false } = {}) {
  const server = new McpServer({ name: "k-phi-test", version: "0.0.0" });
  registerTools(server, {
    engine: new MockEngine(),          // English, labelled MOCK; content is irrelevant to it
    store: new MemoryStore(),
    limiter: new RateLimiter({ analysesPerIpPerDay: 0, analysesPerSessionPerDay: 100, analysesPerDayGlobal: 1000 }),
    usage: new UsageCounter(),
    publicBaseUrl: "https://k-phi.test",
    ingestBaseUrl: "https://mcp.k-phi.test",
    ctx: () => ({ ip: "127.0.0.1", sessionId: "s1" }),
    source: "test",
    uploadEnabled,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "english-only-test", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

const SMALL_CSV =
  "Date,Account,AccountName,Debit,Credit\n" +
  "2025-01-15,411000,Trade receivables,1000.00,0.00\n" +
  "2025-01-15,706000,Revenue,0.00,1000.00\n";

test("tools/list — names, titles, descriptions and input schemas are English", async () => {
  const c = await boot();
  const { tools } = await c.listTools();
  assert.equal(tools.length, 4);
  assertEnglish("tools/list", tools);
});

test("prompts and resources — English", async () => {
  const c = await boot();
  const prompts = await c.listPrompts();
  assertEnglish("prompts/list", prompts);
  for (const p of prompts.prompts) assertEnglish(`prompts/get ${p.name}`, await c.getPrompt({ name: p.name }));
  const res = await c.listResources();
  assertEnglish("resources/list", res);
  for (const r of res.resources) assertEnglish(`resources/read ${r.uri}`, await c.readResource({ uri: r.uri }));
});

test("kphi_analyze_ledger — happy path: text, resource_link and structuredContent", async () => {
  const c = await boot();
  const out = await c.callTool({ name: "kphi_analyze_ledger", arguments: { content: SMALL_CSV } });
  assert.ok(!out.isError, "the mock engine analyzes anything");
  assertEnglish("kphi_analyze_ledger (ok)", out);
});

test("kphi_analyze_ledger — covenant breach alert wording", async () => {
  const c = await boot();
  const out = await c.callTool({ name: "kphi_analyze_ledger", arguments: {
    content: SMALL_CSV, covenants: [{ name: "dscr", operator: ">=", threshold: 1.2 }] } });
  assertEnglish("kphi_analyze_ledger (covenant)", out);
});

test("kphi_analyze_ledger — oversized inline content is refused in English", async () => {
  const c = await boot();
  const out = await c.callTool({ name: "kphi_analyze_ledger", arguments: { content: "x".repeat(2 * 1024 * 1024 + 1) } });
  assert.ok(out.isError);
  assertEnglish("kphi_analyze_ledger (too large)", out);
});

test("kphi_get_analysis — unknown id, and pending state", async () => {
  const c = await boot();
  assertEnglish("kphi_get_analysis (unknown)", await c.callTool({ name: "kphi_get_analysis", arguments: { analysis_id: "nope" } }));
});

test("kphi_explain_kpi — unknown KPI, and a real one from an analysis", async () => {
  const c = await boot();
  assertEnglish("kphi_explain_kpi (unknown)", await c.callTool({ name: "kphi_explain_kpi", arguments: { analysis_id: "nope", kpi_id: "dscr" } }));
  const a = await c.callTool({ name: "kphi_analyze_ledger", arguments: { content: SMALL_CSV } });
  const id = a.structuredContent?.analysis_id;
  assert.ok(id, "analysis_id returned");
  const e = await c.callTool({ name: "kphi_explain_kpi", arguments: { analysis_id: id, kpi_id: "dscr" } });
  assert.ok(!e.isError);
  assertEnglish("kphi_explain_kpi (dscr)", e);
});

test("kphi_request_upload — both the unavailable refusal and the issued link", async () => {
  const off = await boot({ uploadEnabled: false });
  const r1 = await off.callTool({ name: "kphi_request_upload", arguments: {} });
  assert.ok(r1.isError);
  assertEnglish("kphi_request_upload (disabled)", r1);
  const on = await boot({ uploadEnabled: true });
  const r2 = await on.callTool({ name: "kphi_request_upload", arguments: {} });
  assert.ok(!r2.isError);
  assertEnglish("kphi_request_upload (enabled)", r2);
});

test("typed errors from the real parser, rendered through describeAnalysisError", () => {
  const cases = [
    ["garbage", "this is not a ledger\njust text\n"],
    ["empty", ""],
    ["no date column", "Account,Debit,Credit\n411000,100,0\n706000,0,100\n"],
  ];
  for (const [label, content] of cases) {
    let err;
    try { parseLedger(content, {}); } catch (e) { err = e; }
    assert.ok(err instanceof ParseError || err instanceof NeedsInputError, `${label}: a typed error is thrown`);
    assertEnglish(`parser error (${label})`, err.message);
    assertEnglish(`describeAnalysisError (${label})`, describeAnalysisError(err, "an_x"));
  }
});

test("parser warnings → notes[] are English on a messy but valid file", () => {
  const messy =
    "Date,Account,Debit,Credit,Balance,Currency\n" +
    "2025-01-15,411000,1000.00,0.00,1000.00,0.92\n" +
    "2025-01-15,706000,0.00,900.00,100.00,0.92\n";
  const r = parseLedger(messy, {});
  assertEnglish("parser warnings", r.warnings);
});

/* ───────────────────── layer B: static source scan ───────────────────── */

test("src/*.ts contains no French outside i18n:fr-ok regions", () => {
  const dir = new URL("../src/", import.meta.url);
  const findings = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith(".ts"))) {
    const lines = readFileSync(new URL(f, dir), "utf8").split("\n");
    let inBlockComment = false, inFrOk = 0;
    lines.forEach((raw, i) => {
      let line = raw;
      if (line.includes("i18n:fr-ok-begin")) inFrOk++;
      const endsHere = line.includes("i18n:fr-ok-end");
      // strip block comments (single-line and multi-line)
      if (inBlockComment) {
        const end = line.indexOf("*/");
        if (end < 0) { return; }
        line = line.slice(end + 2); inBlockComment = false;
      }
      line = line.replace(/\/\*[\s\S]*?\*\//g, "");
      const open = line.indexOf("/*");
      if (open >= 0) { line = line.slice(0, open); inBlockComment = true; }
      // strip line comments (but not the // inside https://)
      line = line.replace(/(^|\s)\/\/.*$/, "$1");
      if (endsHere) inFrOk = Math.max(0, inFrOk - 1);
      if (inFrOk > 0 || raw.includes("i18n:fr-ok")) return;
      if (!line.trim()) return;
      for (const hit of inspect(line, `${f}:${i + 1}`)) findings.push(hit);
    });
  }
  assert.equal(findings.length, 0, `\n${findings.length} French string(s) in source:\n  ${findings.join("\n  ")}\n`);
});
