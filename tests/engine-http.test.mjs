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
