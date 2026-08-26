/**
 * Corpus doré ERP — synthétisé depuis les règles _ERP_AI_KNOWLEDGE du wizard
 * (modules/import-wizard.js). Chaque fixture encode LE piège documenté de son
 * ERP ; chaque test échoue si le piège redevient actif. Invariant commun :
 * Σdébits == Σcrédits sur les lignes retenues, et le total attendu est celui
 * des BONNES colonnes (les colonnes-pièges portent des montants sentinelles
 * 999999 qui feraient exploser le total si elles étaient lues).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLedger } from "../dist/parse-ledger.js";

function sums(r) {
  return {
    dr: r.entries.reduce((a, e) => a + e.dr, 0),
    cr: r.entries.reduce((a, e) => a + e.cr, 0),
  };
}
function balanced(r) {
  const { dr, cr } = sums(r);
  assert.ok(Math.abs(dr - cr) < 0.01, `équilibre DR/CR (${dr} vs ${cr})`);
  return dr;
}

/* ── SAP FBL3N : DMBTR toujours positif, direction UNIQUEMENT via SHKZG ── */
const FBL3N = `BUKRS;BELNR;GJAHR;BUDAT;MONAT;HKONT;SGTXT;DMBTR;WAERS;SHKZG
1000;4900000001;2025;15.01.2025;1;113100;Zahlungseingang;1.234,56;EUR;S
1000;4900000001;2025;15.01.2025;1;140000;Zahlungseingang;1.234,56;EUR;H
1000;4900000002;2025;20.02.2025;2;140000;Rechnung;500,00;EUR;S
1000;4900000002;2025;20.02.2025;2;800000;Rechnung;500,00;EUR;H
`;
test("FBL3N : montant unique + SHKZG (S/H), jamais de mode signé, dates allemandes", () => {
  const r = parseLedger(FBL3N);
  assert.equal(r.entries.length, 4);
  assert.equal(balanced(r), 1734.56);
  assert.equal(r.entries[0].date, "2025-01-15");
  assert.equal(r.entries[0].entity, "1000");
  assert.ok(r.warnings.some(w => /indicateur D\/C/.test(w)));
  assert.equal(r.genre, "ledger");
});

/* ── SAP ACDOCA : HSL SIGNÉ, pas d'indicateur, pas de date (POPER+GJAHR) ── */
const ACDOCA = `RBUKRS,BELNR,GJAHR,POPER,RACCT,SGTXT,HSL,RHCUR
2000,100000001,2025,3,113100,Umbuchung,750.00,EUR
2000,100000001,2025,3,800000,Umbuchung,-750.00,EUR
2000,100000002,2025,4,113100,Erlös,250.00,EUR
2000,100000002,2025,4,800000,Erlös,-250.00,EUR
`;
test("ACDOCA : HSL signé, dates synthétiques depuis POPER+GJAHR", () => {
  const r = parseLedger(ACDOCA);
  assert.equal(balanced(r), 1000);
  assert.ok(r.entries.every(e => e._is_synth_date));
  assert.equal(r.entries[0].period, "2025-03");
  assert.equal(r.entries[2].date, "2025-04-30");
});

/* ── Oracle : ACCOUNTED prime sur ENTERED (sentinelles 999999) ── */
const ORACLE = `EFFECTIVE_DATE,ACCOUNT,DESCRIPTION,ENTERED_DR,ENTERED_CR,ACCOUNTED_DR,ACCOUNTED_CR,CURRENCY_CODE
2025-01-10,11000,Invoice,999999,0,880.00,0,USD
2025-01-10,40000,Invoice,0,999999,0,880.00,USD
`;
test("Oracle : ACCOUNTED_DR/CR choisis, ENTERED (devise transaction) ignoré", () => {
  const r = parseLedger(ORACLE);
  assert.equal(balanced(r), 880, "total = colonnes ACCOUNTED, pas les sentinelles ENTERED");
});

/* ── D365 : MAINACCOUNTID prime sur ACCOUNTDISPLAYVALUE ; devise comptable ── */
const D365 = `JOURNALNUMBER,TRANSDATE,MAINACCOUNTID,ACCOUNTDISPLAYVALUE,TEXT,ACCOUNTINGCURRENCYDEBITAMOUNT,ACCOUNTINGCURRENCYCREDITAMOUNT,TRANSACTIONCURRENCYDEBITAMOUNT,TRANSACTIONCURRENCYCREDITAMOUNT,DATAAREAID
GL0001,2025-02-01,110110,110110-001-SALES,Payment,640.00,0,999999,0,usmf
GL0001,2025-02-01,130100,130100-001-SALES,Payment,0,640.00,0,999999,usmf
`;
test("D365 : compte = MAINACCOUNTID (pas la chaîne à dimensions), montants comptables", () => {
  const r = parseLedger(D365);
  assert.equal(r.entries[0].acct, "110110", "pas « 110110-001-SALES »");
  assert.equal(balanced(r), 640);
  assert.equal(r.entries[0].entity, "usmf");
});
test("D365 dégradé : sans MAINACCOUNTID, repli ACCOUNTDISPLAYVALUE avec avertissement", () => {
  const degraded = D365.split("\n").map(l => l.split(",").filter((_, i) => i !== 2).join(",")).join("\n");
  const r = parseLedger(degraded);
  assert.equal(r.entries[0].acct, "110110-001-SALES");
  assert.ok(r.warnings.some(w => /dimensions concaténées/.test(w)));
});

/* ── QuickBooks : Balance = solde CUMULÉ, Split = contrepartie — poison ── */
const QB = `Date,Type,Num,Name,Memo,Account,Split,Debit,Credit,Balance
2025-01-05,Invoice,1001,Contoso,Consulting,Accounts Receivable,Sales Income,300.00,,999999
2025-01-05,Invoice,1001,Contoso,Consulting,Sales Income,Accounts Receivable,,300.00,999999
2025-01-20,Payment,1002,Contoso,Payment,Checking,Accounts Receivable,300.00,,999999
2025-01-20,Payment,1002,Contoso,Payment,Accounts Receivable,Checking,,300.00,999999
`;
test("QuickBooks : Balance et Split exclus (avertis), comptes = noms", () => {
  const r = parseLedger(QB);
  assert.equal(balanced(r), 600, "Balance (999999 cumulés) jamais lu comme montant");
  assert.ok(r.warnings.some(w => /ignorées/.test(w) && /Balance/.test(w) && /Split/.test(w)));
  assert.equal(r.entries[0].acct, "Accounts Receivable");
});

/* ── NetSuite : « Account » porte des NOMS, le code est « Account Number » ── */
const NETSUITE = `Date,Type,Account,Account Number,Name,Memo,Amount,Currency,Subsidiary
2025-03-02,Invoice,Accounts Receivable,11000,Fabrikam,INV-9,450.00,USD,HQ
2025-03-02,Invoice,Sales : Product,40000,Fabrikam,INV-9,-450.00,USD,HQ
`;
test("NetSuite : compte = Account Number, la colonne Account devient l'intitulé", () => {
  const r = parseLedger(NETSUITE);
  assert.equal(r.entries[0].acct, "11000", "le code, pas « Accounts Receivable »");
  assert.equal(r.coa_dict["11000"], "Accounts Receivable");
  assert.equal(r.coa_dict["40000"], "Sales : Product");
  assert.equal(balanced(r), 450);
  assert.equal(r.entries[0].entity, "HQ");
});

/* ── Xero : Gross/GST = montants TTC/taxe — double-comptage si lus ── */
const XERO = `JournalDate,Source,Contact,Description,Reference,AccountCode,Account,Debit,Credit,Gross,GST
2025-04-01,Invoice,Litware,Subscription,INV-77,610,Accounts Receivable,240.00,,999999,999999
2025-04-01,Invoice,Litware,Subscription,INV-77,200,Sales,,240.00,999999,999999
`;
test("Xero : Gross/GST exclus, compte = AccountCode, Account → intitulé, Contact → tiers", () => {
  const r = parseLedger(XERO);
  assert.equal(balanced(r), 240, "Gross/GST (sentinelles) jamais lus");
  assert.equal(r.entries[0].acct, "610");
  assert.equal(r.coa_dict["610"], "Accounts Receivable");
  assert.equal(r.entries[0].tp, "Litware");
});

/* ── Sage X3 : AMTLOC + SENS (D/C), SITE = entité ── */
const SAGEX3 = `Date,SITE,ACC,DES,AMTLOC,SENS
2025-05-03,FR011,411000,Facture,980.00,D
2025-05-03,FR011,706000,Facture,980.00,C
`;
test("Sage X3 : indicateur SENS, entité = SITE", () => {
  const r = parseLedger(SAGEX3);
  assert.equal(balanced(r), 980);
  assert.equal(r.entries[0].entity, "FR011");
});

/* ── HFM : pas de dates ; Scenario/View MIXTES → seuls Actual+Periodic comptent ── */
const HFM = `Scenario,Year,Period,Entity,Account,View,Amount
Actual,2025,3,E100,4000,Periodic,-500.00
Actual,2025,3,E100,1100,Periodic,500.00
Actual,2025,3,E100,4000,YTD,-1500.00
Budget,2025,3,E100,4000,Periodic,-999999
Budget,2025,3,E100,1100,Periodic,999999
`;
test("HFM : lignes Budget et YTD exclues (averties), dates synthétiques Year+Period, genre balance", () => {
  const r = parseLedger(HFM);
  assert.equal(r.entries.length, 2, "seules les lignes Actual+Periodic");
  assert.equal(balanced(r), 500);
  assert.ok(r.entries.every(e => e._is_synth_date && e.period === "2025-03"));
  assert.ok(r.warnings.some(w => /Scenario/.test(w)));
  assert.ok(r.warnings.some(w => /YTD/.test(w)));
  assert.equal(r.genre, "trial_balance");
});

/* ── Sage Intacct : LOCATIONID = ENTITÉ (pas un lieu), ACCT_TITLE = intitulé ── */
const INTACCT = `WHENPOSTED,LOCATIONID,ACCT_NO,ACCT_TITLE,DESCRIPTION,DEBIT,CREDIT
2025-06-10,ENT-US,1200,Accounts Receivable,Inv 5,320.00,
2025-06-10,ENT-US,4000,Product Revenue,Inv 5,,320.00
`;
test("Intacct : LOCATIONID lu comme entité, ACCT_TITLE comme intitulé", () => {
  const r = parseLedger(INTACCT);
  assert.equal(r.entries[0].entity, "ENT-US");
  assert.equal(r.coa_dict["1200"], "Accounts Receivable");
  assert.equal(balanced(r), 320);
});

/* ── Invariant transversal : aucun golden ne régresse sur le ladder de dates ── */
test("corpus : toutes les périodes viennent du FICHIER (2025), jamais du mois de l'analyse", () => {
  for (const fx of [FBL3N, ACDOCA, ORACLE, D365, QB, NETSUITE, XERO, SAGEX3, HFM, INTACCT]) {
    const r = parseLedger(fx);
    for (const e of r.entries)
      assert.ok(e.period.startsWith("2025"), `période hors fichier : ${e.period}`);
  }
});

/* ── column_map : le contrat inspectable/corrigeable (PR 10) ─────── */

test("column_map en sortie : plan final + en-têtes non mappés + provenance des intitulés", () => {
  const r = parseLedger(`Date,Account,AccountName,Mystery,Debit,Credit
2025-01-31,10100,Cash,x1,10.00,0.00
2025-01-31,40000,Sales,x2,0.00,10.00
`);
  assert.equal(r.column_map.acct, "Account");
  assert.equal(r.column_map.acct_name, "AccountName");
  assert.equal(r.column_map.dr, "Debit");
  assert.deepEqual(r.unmapped_headers, ["Mystery"]);
  assert.equal(r.name_source, "mapped");
  assert.equal(r.overrides_applied, 0);
});

test("column_map en entrée : l'override prime sur l'inférence et libère la colonne volée", () => {
  /* « Konto » serait inféré acct ; l'appelant sait que le vrai compte est « Ref » */
  const r = parseLedger(`Date,Konto,Ref,Debit,Credit
2025-01-31,WRONG,10100,10.00,0.00
2025-01-31,WRONG,40000,0.00,10.00
`, undefined, { columnMap: { acct: "Ref" } });
  assert.equal(r.entries[0].acct, "10100", "le champ forcé prime");
  assert.equal(r.overrides_applied, 1);
  assert.ok(r.warnings.some(w => /forcés par column_map/.test(w)));
});

test("column_map : en-tête introuvable ou champ inconnu → avertissement, jamais un crash", () => {
  const r = parseLedger(`Date,Account,Debit,Credit
2025-01-31,10100,10.00,0.00
2025-01-31,40000,0.00,10.00
`, undefined, { columnMap: { acct: "Nonexistent", frobnicate: "Account" } });
  assert.ok(r.warnings.some(w => /introuvable/.test(w)));
  assert.ok(r.warnings.some(w => /champ inconnu/.test(w)));
  assert.equal(r.entries[0].acct, "10100", "l'inférence reste en place");
});

test("amount_mode signed_inv forcé : positif → crédit (convention PCG/Cegid)", () => {
  const r = parseLedger(`Date,Compte,Montant
2025-01-31,706000,500.00
2025-01-31,411000,-500.00
`, undefined, { columnMap: { amount_mode: "signed_inv" } });
  const rev = r.entries.find(e => e.acct === "706000");
  assert.equal(rev.cr, 500, "le produit est bien au crédit");
  assert.equal(rev.dr, 0);
});

test("un override lève même une colonne-piège (l'appelant assume)", () => {
  const r = parseLedger(`Date,Account,Debit,Credit,Balance
2025-01-31,10100,0,0,10.00
2025-01-31,40000,0,0,-10.00
`, undefined, { columnMap: { amount: "Balance", amount_mode: "signed" } });
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].dr, 10);
});

test("comptes à suffixe float (« 68000.0 », artefact pandas/Excel) : normalisés — le piège du scheme-flip", () => {
  const r = parseLedger(`Period,Account,AccountName,Debit,Credit
2025-01,68000.0,Freight & Logistics,500.00,0.00
2025-01,40000.0,Revenue,0.00,500.00
`);
  assert.equal(r.entries[0].acct, "68000", "jamais « 68000.0 »");
  assert.equal(r.entries[1].acct, "40000");
  assert.equal(r.coa_dict["68000"], "Freight & Logistics", "le coa_dict suit le compte normalisé");
});

test("balance mensuelle MULTI-ENTITÉS : genre trial_balance (l'entité fait partie du grain)", () => {
  let csv = "Entity,Period,Account,AccountName,Debit,Credit\n";
  for (const ent of ["E1", "E2", "E3", "E4", "E5"])
    for (const per of ["2025-01", "2025-02"])
      csv += `${ent},${per},10100,Cash,100.00,0.00\n${ent},${per},40000,Revenue,0.00,100.00\n`;
  const r = parseLedger(csv);
  assert.equal(r.genre, "trial_balance", "5 lignes par (compte, période) ≠ grand livre quand ce sont 5 entités");
});
