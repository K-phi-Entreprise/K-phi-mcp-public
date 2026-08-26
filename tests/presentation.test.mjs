/**
 * Présentation riche (2026-08-25, retour terrain n°1) : CTA lien en tête,
 * tableaux KPI avec jauges et états colorés, alertes en évidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { present } from "../dist/tools.js";

const deps = { ingestBaseUrl: "https://mcp.test", publicBaseUrl: "https://app.test" };
const R = {
  summary_markdown: "**Synthèse** — activité stable.",
  detected: { format: "csv", genre: "ledger", chart_of_accounts: "auto", currency: "USD",
              period: "2025-01..2025-12", entries: 17769,
              column_map: { acct: "Account", acct_name: "AccountName" } },
  alerts: ["DSCR non calculé : export balance."],
  notes: ["Amortissement par défaut."],
  kpis: [
    { id: "revenue",       label: "Chiffre d'affaires", unit: "USD",  value: 40844447 },
    { id: "ebitda_margin", label: "Marge d'EBITDA",     unit: "%",    value: 12.0 },
    { id: "dso",           label: "DSO",                unit: "days", value: 112 },
    { id: "current_ratio", label: "Ratio de liquidité", unit: "x",    value: 1.35, status: "ok", threshold: 1.2 },
    { id: "dscr",          label: "DSCR",               unit: "x",    value: 0.9,  status: "breach", threshold: 1.2 },
  ],
};

const out = present(deps, "an_test123", R);
const text = out.content[0].text;
const lines = text.split("\n");

test("le lien est un CTA de tête : titre ##, MAJUSCULES, dans les 6 premières lignes après la synthèse", () => {
  const idx = lines.findIndex(l => l.includes("OUVRIR L'ANALYSE COMPLÈTE"));
  assert.ok(idx >= 0 && idx <= 6, `CTA à la ligne ${idx}`);
  assert.ok(lines[idx].startsWith("## "), "rendu en titre");
  assert.ok(lines[idx].includes("https://mcp.test/a/an_test123"));
});

test("l'assistant appelant est invité à relayer le lien en évidence", () => {
  assert.match(text, /transmettre ce lien tel quel/);
});

test("le lien apparaît DEUX fois (tête + rappel de pied)", () => {
  const n = text.split("https://mcp.test/a/an_test123").length - 1;
  assert.equal(n, 2);
});

test("KPI en tableaux Markdown groupés, avec jauge et état coloré", () => {
  assert.match(text, /### 📈 Rentabilité/);
  assert.match(text, /### 💧 Trésorerie & cycle/);
  assert.match(text, /\| Indicateur \| Valeur \| Jauge \| État \|/);
  assert.match(text, /\| Marge d'EBITDA \| \*\*12[.,]0 %\*\* \| [▰▱]{10} \| 🟡 \|/);
  assert.match(text, /\| DSO \| \*\*112 j\*\* \| [▰▱]{10} \| 🔴 \|/);
  assert.match(text, /Ratio de liquidité ✅ \*covenant\*/);
  assert.match(text, /DSCR ⛔ \*covenant\*.*🔴/);
});

test("les montants ne portent pas de jugement : jauge — et état ⚪", () => {
  assert.match(text, /\| Chiffre d'affaires \| \*\*[^|]+\*\* \| — \| ⚪ \|/);
});

test("fichier analysé en tableau ; alertes en blockquote ⚠️ ; notes repliées", () => {
  assert.match(text, /\| Format \| csv — grand livre \|/);
  assert.match(text, /\| Écritures \| 17[  \u202f\u00a0]769 \|/);
  assert.match(text, /> ⚠️ DSCR non calculé/);
  assert.match(text, /<details><summary>À affiner/);
});
