/**
 * Tests parse-ledger — node:test, zéro dépendance ("npm test").
 * Corpus : formes réelles rencontrées (dont la balance "Meridian" qui a mis
 * au jour le repli « mois courant » : voir le commit du ladder de dates).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLedger, ParseError, NeedsInputError } from "../dist/parse-ledger.js";

/* ── Fixtures ────────────────────────────────────────────────────── */

/** Balance mensuelle style Meridian : colonne Period numérique, PAS de date. */
const TB_PERIOD_NO_DATE = `Period,Entity,Account,AccountName,Type,Debit,Credit,Currency
1,DE,10100,Cash - Operating Bank,Asset,1035569.27,32488.01,USD
1,DE,40000,Revenue - Product Sales,Revenue,0.00,1003081.26,USD
2,DE,10100,Cash - Operating Bank,Asset,395358.92,257542.69,USD
2,DE,40000,Revenue - Product Sales,Revenue,0.00,137816.23,USD
12,DE,10100,Cash - Operating Bank,Asset,895296.00,394776.92,USD
12,DE,40000,Revenue - Product Sales,Revenue,0.00,500519.08,USD
`;

/** Balance annuelle : ni date, ni période. */
const TB_NO_DATE_NO_PERIOD = `Account,AccountName,Type,Debit,Credit,Currency
10100,Cash - Operating Bank,Asset,38425747.38,12886176.17,USD
40000,Revenue - Product Sales,Revenue,0.00,25539571.21,USD
`;

/** Grand livre daté classique. */
const LEDGER_DATED = `Posting Date,Document No.,Account,Description,Debit,Credit,Currency
2025-01-05,SINV-001,11000,Invoice Contoso,1000.00,0.00,USD
2025-01-05,SINV-001,40000,Invoice Contoso,0.00,1000.00,USD
2025-02-10,RCPT-001,10100,Payment Contoso,1000.00,0.00,USD
2025-02-10,RCPT-001,11000,Payment Contoso,0.00,1000.00,USD
`;

/** Période au format YYYY-MM (pas d'exercice nécessaire). */
const TB_PERIOD_YM = `Period,Account,Debit,Credit
2025-03,10100,50.00,0.00
2025-03,40000,0.00,50.00
`;

/** Colonne exercice explicite + période numérique. */
const TB_FY_COLUMN = `FiscalYear,Period,Account,Debit,Credit
2024,6,10100,10.00,0.00
2024,6,40000,0.00,10.00
`;

/* ── Échelle de résolution des dates ─────────────────────────────── */

test("échelon 1 — colonne date : lue telle quelle, aucune date synthétique", () => {
  const r = parseLedger(LEDGER_DATED);
  assert.equal(r.period_from, "2025-01");
  assert.equal(r.period_to, "2025-02");
  assert.ok(r.entries.every(e => !e._is_synth_date));
});

test("échelon 2 — période numérique + period_end : dates au dernier jour du mois, marquées", () => {
  const r = parseLedger(TB_PERIOD_NO_DATE, undefined, { periodEnd: "2025-12-31" });
  assert.equal(r.period_from, "2025-01");
  assert.equal(r.period_to, "2025-12");
  assert.equal(r.entries[0].date, "2025-01-31");
  assert.equal(r.entries.at(-1).date, "2025-12-31");
  assert.ok(r.entries.every(e => e._is_synth_date === true), "toutes marquées synthétiques");
  assert.ok(r.warnings.some(w => /synth/i.test(w)));
});

test("échelon 2 — période YYYY-MM autonome, sans period_end", () => {
  const r = parseLedger(TB_PERIOD_YM);
  assert.equal(r.period_from, "2025-03");
  assert.equal(r.entries[0].date, "2025-03-31");
  assert.ok(r.entries[0]._is_synth_date);
});

test("échelon 2 — colonne exercice fournit l'année", () => {
  const r = parseLedger(TB_FY_COLUMN);
  assert.equal(r.period_from, "2024-06");
  assert.equal(r.entries[0].date, "2024-06-30");
});

test("échelon 3 — ni date ni période : tout au period_end, marqué", () => {
  const r = parseLedger(TB_NO_DATE_NO_PERIOD, undefined, { periodEnd: "2025-12-31" });
  assert.equal(r.period_from, "2025-12");
  assert.equal(r.period_to, "2025-12");
  assert.ok(r.entries.every(e => e._is_synth_date === true));
});

test("échelon 4 — aucune information de date : NeedsInputError, jamais le mois courant", () => {
  assert.throws(() => parseLedger(TB_NO_DATE_NO_PERIOD), (e) => {
    assert.ok(e instanceof NeedsInputError);
    assert.ok(e instanceof ParseError, "reste un ParseError pour les appelants existants");
    assert.deepEqual(e.needs, ["period_end"]);
    return true;
  });
});

test("période numérique sans exercice ni period_end : NeedsInputError explicite", () => {
  assert.throws(() => parseLedger(TB_PERIOD_NO_DATE), (e) => e instanceof NeedsInputError);
});

test("plus jamais de date au mois courant : la période détectée ne dépend pas d'aujourd'hui", () => {
  const now = new Date().toISOString().slice(0, 7);
  const r = parseLedger(TB_PERIOD_NO_DATE, undefined, { periodEnd: "2025-12-31" });
  assert.ok(!r.entries.some(e => e.period === now && now !== "2025-12"),
    "aucune écriture datée du mois de l'analyse");
});

test("period_end invalide : ignoré avec avertissement, la colonne date prime", () => {
  const r = parseLedger(LEDGER_DATED, undefined, { periodEnd: "31/12/2025 minuit" });
  assert.ok(r.warnings.some(w => /period_end/.test(w) && /invalide/.test(w)));
  assert.equal(r.period_from, "2025-01");
});

test("écritures postérieures à period_end : signalées, pas supprimées", () => {
  const r = parseLedger(LEDGER_DATED, undefined, { periodEnd: "2025-01-31" });
  assert.equal(r.entries.length, 4);
  assert.ok(r.warnings.some(w => /postérieures/.test(w)));
});

/* ── Invariants comptables sur tout le corpus ────────────────────── */

for (const [name, content, opts] of [
  ["TB_PERIOD_NO_DATE", TB_PERIOD_NO_DATE, { periodEnd: "2025-12-31" }],
  ["TB_NO_DATE_NO_PERIOD", TB_NO_DATE_NO_PERIOD, { periodEnd: "2025-12-31" }],
  ["LEDGER_DATED", LEDGER_DATED, {}],
  ["TB_PERIOD_YM", TB_PERIOD_YM, {}],
  ["TB_FY_COLUMN", TB_FY_COLUMN, {}],
]) {
  test(`invariants ${name} : totaux préservés, lignes = entrées + ignorées`, () => {
    const r = parseLedger(content, undefined, opts);
    /* dropped compte aussi les lignes vides (fin de fichier incluse) :
       l'invariant porte sur les lignes de données non vides. */
    const dataLines = content.split("\n").filter(l => l.trim()).length - 1;
    assert.ok(r.entries.length + r.dropped >= dataLines, "aucune ligne perdue silencieusement");
    assert.equal(r.entries.length, dataLines, "toutes les lignes de données parsées");
    const dr = r.entries.reduce((a, e) => a + e.dr, 0);
    const cr = r.entries.reduce((a, e) => a + e.cr, 0);
    assert.ok(Math.abs(dr - cr) < 0.01, `équilibre DR/CR (${dr} vs ${cr})`);
  });
}
