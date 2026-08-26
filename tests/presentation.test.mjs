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
const text = out.content.find(c => c.type === "text").text;
const lines = text.split("\n");

test("le lien est un CTA de tête : titre ##, MAJUSCULES, dans les 6 premières lignes après la synthèse", () => {
  const idx = lines.findIndex(l => l.includes("OUVRIR L'ANALYSE COMPLÈTE"));
  assert.ok(idx >= 0 && idx <= 6, `CTA à la ligne ${idx}`);
  assert.ok(lines[idx].startsWith("## "), "rendu en titre");
  assert.ok(lines[idx].includes("https://mcp.test/a/an_test123"));
});

test("consigne au relais : une ligne prête à copier, jamais l'URL brute seule", () => {
  assert.match(text, /reproduire la ligne suivante telle quelle/);
  assert.match(text, /jamais l'URL brute/);
  /* la ligne à copier est un blockquote-titre autonome avec le lien Markdown */
  assert.match(text, /> ## 📊 \[Ouvrir l'analyse complète dans K-Φ\]\(https:\/\/mcp\.test\/a\/an_test123\)/);
});

test("le lien apparaît TROIS fois (CTA + ligne à copier + rappel de pied)", () => {
  const n = text.split("https://mcp.test/a/an_test123").length - 1;
  assert.equal(n, 3);
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

test("contrat versionné : report_version 1.0 ancré (additif ensuite, rupture = bump majeur)", () => {
  assert.equal(out.structuredContent.report_version, "1.0");
});

/* ── Dashboard /a/:id (implémentation de la maquette validée) ────── */
import { renderReport } from "../dist/report-page.js";

test("dashboard : tuiles, covenants, table, CTA /open, réserves conditionnelles", () => {
  const html = renderReport("an_x1", { ...R,
    series: [{ period: "2025-01", revenue: 3.4e6, ebitda: 6e4 }, { period: "2025-02", revenue: 3.2e6, ebitda: 7e4 }],
    notes: ["Ces chiffres sont une somme simple multi-entités (…)"],
    detected: { ...R.detected, currency: "USD, EUR" } });
  assert.match(html, /Marge d'EBITDA/);
  assert.match(html, /Réserves de lecture/);
  assert.match(html, /somme simple des entités/);
  assert.match(html, /Plusieurs devises détectées/);
  assert.match(html, /DSCR.*seuil 1.2.*covenant/s, "covenant fourni → son seuil, étiqueté");
  assert.match(html, /Marge d'EBITDA.*≥ 15 %/s, "sans covenant → bande mid-market typée");
  assert.match(html, /Chiffre d'affaires[\s\S]{0,320}?class="r mut"[^>]*>—/, "jamais de seuil sur un montant (tuile)");
  assert.match(html, /📈 Rentabilité[\s\S]*💧 Trésorerie[\s\S]*🏦 Structure/, "sections groupées (tuiles)");
  assert.match(html, /Waterfall/, "mode waterfall présent");
  assert.match(html, /ne se déduit pas fiablement/);
  assert.equal(html.split("/a/an_x1/open").length - 1, 2, "CTA tête + pied ; le bouton forecast ne REDIRIGE plus (rendu inline à venir, jamais un cul-de-sac app)");
  assert.match(html, /Créer le forecast/);
  assert.match(html, /rendu ICI/);
  assert.match(html, /Chart\.js|chart\.umd/);
});

test("dashboard mono-entité mono-devise : AUCUN bandeau de réserves à tort", () => {
  const html = renderReport("an_x2", { ...R, series: [] });
  assert.doesNotMatch(html, /Réserves de lecture/);
  assert.doesNotMatch(html, /chart\.umd/, "pas de graphique sans série");
});

test("dashboard : échappement HTML des données (un nom de fichier ne devient pas du script)", () => {
  const html = renderReport("an_x3", { ...R, alerts: ['<script>alert(1)</script>'] });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("le lien est un OBJET du protocole : resource_link en PREMIER bloc (rendu par l'hôte, systématique)", () => {
  assert.equal(out.content.length, 2);
  const rl = out.content[0];
  assert.equal(out.content[1].type, "text");
  assert.equal(rl.type, "resource_link");
  assert.equal(rl.uri, "https://mcp.test/a/an_test123");
  assert.match(rl.name, /Dashboard K-Φ/);
  assert.equal(rl.mimeType, "text/html");
});
