/**
 * Tests genre d'export — détection structurelle (forme, pas en-tête) et
 * bornage des KPI. Cas fondateur : une balance annuelle équilibrée analysée
 * comme un grand livre d'un mois (DSO 9,5 j, DSCR −20,4 « sous seuil »).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLedger } from "../dist/parse-ledger.js";
import { KphiHttpEngine } from "../dist/engine-http.js";

/** Balance : 1 ligne par (compte, période), aucune référence de pièce. */
const TB = `Period,Account,AccountName,Debit,Credit
2025-01,10100,Cash,1000.00,200.00
2025-01,11000,Trade Receivables,600.00,100.00
2025-01,40000,Revenue,0.00,1300.00
2025-02,10100,Cash,500.00,100.00
2025-02,11000,Trade Receivables,300.00,50.00
2025-02,40000,Revenue,0.00,650.00
`;

/** Grand livre : plusieurs lignes par compte, références et tiers. */
const GL = `Date,Document No.,Account,Counterparty,Debit,Credit
2025-01-05,SINV-001,11000,Contoso,100.00,0.00
2025-01-05,SINV-001,40000,Contoso,0.00,100.00
2025-01-09,SINV-002,11000,Fabrikam,200.00,0.00
2025-01-09,SINV-002,40000,Fabrikam,0.00,200.00
2025-01-12,RCPT-001,10100,Contoso,100.00,0.00
2025-01-12,RCPT-001,11000,Contoso,0.00,100.00
2025-01-20,SINV-003,11000,Litware,50.00,0.00
2025-01-20,SINV-003,40000,Litware,0.00,50.00
`;

test("genre : balance détectée (1 ligne par compte-période, sans références)", () => {
  assert.equal(parseLedger(TB).genre, "trial_balance");
});

test("genre : grand livre détecté (multi-lignes par compte, références/tiers)", () => {
  assert.equal(parseLedger(GL).genre, "ledger");
});

/* ── Bornage des KPI via le moteur simulé ────────────────────────── */

function mockEngine(ratios) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const ok = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (u.includes("/sandbox/tenant")) return ok({ tenantId: "a".repeat(32), name: "MCP-TST", token: "jwt" });
    if (u.includes("/gl/import")) return ok({ imported: JSON.parse(init.body).entries.length });
    if (u.includes("/api/statements")) return ok({ kpi: { "Net Revenue": 1950, "Net Income": 1950 }, ratios });
    if (u.includes("/open-link")) return ok({ url: "https://x" });
    return ok({}, 404);
  };
  return new KphiHttpEngine({ baseUrl: "https://engine.test", serviceSecret: "s", retryDelayMs: 5 });
}

test("balance : DSCR retiré + alerte explicite, DSO annoté ordre de grandeur, plus jamais de faux breach", async () => {
  const e = mockEngine({ dso: 9.5, dscr: -20.39 });
  const r = await e.analyze({ content: TB, format_hint: "generic", locale: "fr" });
  assert.equal(r.detected.genre, "trial_balance");
  assert.ok(!r.kpis.some(k => k.id === "dscr"), "dscr absent des KPI");
  assert.ok(r.alerts.some(a => /DSCR non calculé/.test(a) && /balance/.test(a)));
  assert.ok(r.notes.some(n => /ordres de grandeur/.test(n)));
  assert.ok(!/sous le seuil bancaire/.test(r.summary_markdown), "la vigilance DSCR de la synthèse disparaît mécaniquement");
});

test("balance + covenant DSCR : « non calculable », pas breach", async () => {
  const e = mockEngine({ dscr: -20.39 });
  const r = await e.analyze({ content: TB, format_hint: "generic", locale: "fr",
    covenants: [{ name: "DSCR", operator: ">=", threshold: 1.2 }] });
  assert.ok(r.alerts.some(a => /non calculable/.test(a)));
  assert.ok(!r.alerts.some(a => /breach/.test(a)));
});

test("grand livre : DSCR conservé, aucune annotation de balance", async () => {
  const e = mockEngine({ dso: 37, dscr: 1.5 });
  const r = await e.analyze({ content: GL, format_hint: "generic", locale: "fr" });
  assert.equal(r.detected.genre, "ledger");
  assert.ok(r.kpis.some(k => k.id === "dscr"));
  assert.ok(!r.notes.some(n => /ordres de grandeur/.test(n)));
});
