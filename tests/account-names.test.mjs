/**
 * Tests intitulés de compte — dépendance fonctionnelle compte → libellé.
 * Le test porte sur les valeurs, pas sur les en-têtes : voir NameCandidate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLedger } from "../dist/parse-ledger.js";

/** Style Meridian/Business Central : AccountName explicite. */
const TB_WITH_NAMES = `Date,Account,AccountName,Type,Debit,Credit
2025-01-31,10100,Cash - Operating Bank,Asset,1000.00,200.00
2025-01-31,40000,Revenue - Product Sales,Revenue,0.00,800.00
2025-02-28,10100,Cash - Operating Bank,Asset,500.00,100.00
2025-02-28,40000,Revenue - Product Sales,Revenue,0.00,400.00
`;

/** Bezeichnung : happée par la règle d'inclusion des synonymes
 *  (kontobezeichnung ⊃ bezeichnung) — chemin mappé, silencieux. */
const DE_BEZEICHNUNG = `Datum,Konto,Bezeichnung,Soll,Haben
2025-01-15,1200,Bank Girokonto,300.00,0.00
2025-01-15,8400,Erlöse 19% USt,0.00,300.00
2025-02-15,1200,Bank Girokonto,150.00,0.00
2025-02-15,8400,Erlöse 19% USt,0.00,150.00
`;

/** En-tête hongrois hors de portée de toute table de synonymes : Megnevezes
 *  doit être ADOPTÉE par la seule dépendance compte→libellé (valeurs). */
const HU_UNKNOWN_HEADER = `Datum,Konto,Megnevezes,Soll,Haben
2025-01-15,3841,Bankbetetek forintban,300.00,0.00
2025-01-15,9111,Belfoldi ertekesites,0.00,300.00
2025-02-15,3841,Bankbetetek forintban,150.00,0.00
2025-02-15,9111,Belfoldi ertekesites,0.00,150.00
`;

/** "AccountName" qui contient en réalité des mémos par ligne : à RÉTROGRADER. */
const MEMO_AS_NAME = `Date,Account,AccountName,Debit,Credit
2025-01-05,11000,Invoice Contoso Ltd,100.00,0.00
2025-01-05,40000,Invoice Contoso Ltd,0.00,100.00
2025-01-09,11000,Invoice Fabrikam GmbH,200.00,0.00
2025-01-09,40000,Invoice Fabrikam GmbH,0.00,200.00
2025-01-12,11000,Credit note Litware,50.00,0.00
2025-01-12,40000,Credit note Litware,0.00,50.00
`;

/** Seule colonne texte = catégorie (stable mais non discriminante) : pas un nom. */
const CATEGORY_ONLY = `Date,Account,Type,Debit,Credit
2025-01-31,10100,Asset,10.00,0.00
2025-01-31,10200,Asset,5.00,0.00
2025-01-31,40000,Revenue,0.00,10.00
2025-01-31,40100,Revenue,0.00,5.00
2025-01-31,10300,Asset,3.00,0.00
2025-01-31,40200,Revenue,0.00,3.00
`;

const FEC = [
  "JournalCode\tJournalLib\tEcritureNum\tEcritureDate\tCompteNum\tCompteLib\tCompAuxNum\tCompAuxLib\tPieceRef\tPieceDate\tEcritureLib\tDebit\tCredit\tEcritureLet\tDateLet\tValidDate\tMontantdevise\tIdevise",
  "VE\tVentes\t1\t20250115\t411000\tClients\t\t\tF001\t20250115\tFacture Contoso\t1200,00\t0,00\t\t\t\t\t",
  "VE\tVentes\t1\t20250115\t706000\tPrestations de services\t\t\tF001\t20250115\tFacture Contoso\t0,00\t1200,00\t\t\t\t\t",
].join("\n") + "\n";

test("colonne AccountName mappée et stable : coa_dict + header_text sur chaque écriture", () => {
  const r = parseLedger(TB_WITH_NAMES);
  assert.equal(r.coa_dict["10100"], "Cash - Operating Bank");
  assert.equal(r.coa_dict["40000"], "Revenue - Product Sales");
  assert.ok(r.entries.every(e => e.header_text === r.coa_dict[e.acct]));
  /* le mémo de ligne (desc) n'est pas pollué par l'intitulé */
  assert.ok(!r.warnings.some(w => /mémo/.test(w)));
});

test("Bezeichnung : mappée par inclusion de synonyme, silencieuse", () => {
  const r = parseLedger(DE_BEZEICHNUNG);
  assert.equal(r.coa_dict["1200"], "Bank Girokonto");
  assert.equal(r.coa_dict["8400"], "Erlös" + "e 19% USt");
  assert.ok(!r.warnings.some(w => /dépendance/.test(w)), "chemin mappé : pas d'avertissement d'adoption");
});

test("en-tête inconnu (Megnevezes) : adoption par dépendance fonctionnelle, avec avertissement explicite", () => {
  const r = parseLedger(HU_UNKNOWN_HEADER);
  assert.equal(r.coa_dict["3841"], "Bankbetetek forintban");
  assert.equal(r.coa_dict["9111"], "Belfoldi ertekesites");
  assert.ok(r.warnings.some(w => /Megnevezes/.test(w) && /dépendance/.test(w)));
  assert.equal(r.entries[0].header_text, "Bankbetetek forintban");
});

test("mémos déguisés en AccountName : rétrogradés, aucun header_text, avertissement", () => {
  const r = parseLedger(MEMO_AS_NAME);
  assert.deepEqual(r.coa_dict, {});
  assert.ok(r.entries.every(e => e.header_text === undefined));
  assert.ok(r.warnings.some(w => /mémo/.test(w)));
});

test("colonne catégorie (Asset/Revenue) : rejetée — stable mais non discriminante", () => {
  const r = parseLedger(CATEGORY_ONLY);
  assert.deepEqual(r.coa_dict, {});
  assert.ok(r.entries.every(e => e.header_text === undefined));
});

test("FEC : CompteLib enfin lu — coa_dict + header_text, EcritureLib reste le mémo", () => {
  const r = parseLedger(FEC);
  assert.equal(r.format, "fec");
  assert.equal(r.coa_dict["411000"], "Clients");
  assert.equal(r.coa_dict["706000"], "Prestations de services");
  assert.equal(r.entries[0].header_text, "Clients");
  assert.equal(r.entries[0].desc, "Facture Contoso");
});

test("l'intitulé ne fuit jamais dans desc, le mémo ne fuit jamais dans header_text", () => {
  const r = parseLedger(TB_WITH_NAMES);
  assert.ok(r.entries.every(e => e.desc === "" || e.desc !== e.header_text));
  const memo = parseLedger(MEMO_AS_NAME);
  assert.ok(memo.entries.every(e => e.header_text === undefined));
});
