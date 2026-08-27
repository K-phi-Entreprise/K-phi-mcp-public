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
  const html = renderReport("an_x1", { ...R, locale: "fr",
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
  assert.equal(html.split("/a/an_x1/open").length - 1, 2, "CTA tête + pied ; Projeter est un panneau, jamais une redirection");
  assert.match(html, /Projeter/, "critère 1 : bouton toujours présent");
  assert.match(html, /Chart\.js|chart\.umd/);
});

test("dashboard mono-entité mono-devise : AUCUN bandeau de réserves à tort", () => {
  const html = renderReport("an_x2", { ...R, locale: "fr", series: [] });
  assert.doesNotMatch(html, /Réserves de lecture/);
  assert.doesNotMatch(html, /Chiffre d'affaires &amp; EBITDA/, "pas de section graphique mensuel sans série (la lib, elle, sert au panneau forecast)");
});

test("dashboard : échappement HTML des données (un nom de fichier ne devient pas du script)", () => {
  const html = renderReport("an_x3", { ...R, locale: "fr", alerts: ['<script>alert(1)</script>'] });
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

/* ── Panneau forecast (SPEC ★ critères 1/2/3/4/6) ────────────────── */
test("forecast : bouton toujours, __FC injecté échappé, méthodes avec provenance, drill réel+projeté", () => {
  const fc = { horizon_months: 6,
    global: { series: [{ period: "2026-01", sales: 100, impliedDSO: 37 }], blocked: null },
    by_entity: { "E</script>1": { series: [{ period: "2026-01", sales: 60 }], blocked: null },
                 E2: { series: [], blocked: { reason: "no history" } } },
    by_bu: {},
    methods: { dso_by_entity: { E2: { value: 141, source: "gl_observed", basis: 8200 } },
               dpo_by_entity: {}, dso_by_bu: {}, dpo_by_bu: {} } };
  const html = renderReport("an_fc", { ...R, locale: "fr", forecast: fc, report_version: "1.1",
    series: [{ period: "2025-01", revenue: 3.4e6, ebitda: 6e4 }, { period: "2025-02", revenue: 3.2e6, ebitda: 7e4 }] });
  assert.match(html, /id="bF"[^>]*>Projeter/, "bouton présent avec forecast");
  assert.ok(!html.includes("E</script>1"), "nom d'entité hostile échappé dans __FC (\\u003c)");
  assert.match(html, /observé GL/, "provenance des méthodes rendue");
  assert.match(html, /"realBar":"CA réel"/, "drill : libellés réel + projeté injectés via __FT");
  assert.match(html, /Projection bloquée par le moteur/, "chemin fcBlocked rendu tel quel");
});

test("forecast absent (analyse 1.0) : le bouton EXISTE quand même et explique (critère 6)", () => {
  const html = renderReport("an_old", { ...R, locale: "fr" });
  assert.match(html, /id="bF"[^>]*>Projeter/);
  assert.match(html, /antérieure au contrat 1\.1/);
});

test("durcissement : Chart.js émis UNE fois, inconditionnel — balance mono-mois multi-entités = drill sans crash", () => {
  const fc = { horizon_months: 6, global: { series: [], blocked: null },
    by_entity: { E1: { series: [{ period: "2026-01", sales: 60 }], blocked: null },
                 E2: { series: [{ period: "2026-01", sales: 40 }], blocked: null } },
    by_bu: {}, methods: { dso_by_entity: {}, dpo_by_entity: {}, dso_by_bu: {}, dpo_by_bu: {} } };
  const html = renderReport("an_tb", { ...R, locale: "fr", forecast: fc, report_version: "1.1", series: [] });
  assert.equal(html.split("chart.umd.js").length - 1, 1, "CDN une seule fois");
  assert.match(html, /const FOPT=/, "options de repli présentes sans le graphique principal");
});

/* ── Découvrabilité (retour relais 2026-08-27 : descriptions différées) ── */
import { readFileSync } from "node:fs";
test("la PREMIÈRE ligne de kphi_analyze_ledger est bilingue et porte les déclencheurs factuels", () => {
  const src = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");
  const firstLine = src.match(/"Financial analysis & forecast[^"]+"/)?.[0] ?? "";
  for (const kw of ["KPI", "covenant", "DSCR", "forecast", "SAP", "trial-balance", "DSO"])
    assert.ok(new RegExp(kw, "i").test(firstLine + src.slice(src.indexOf(firstLine), src.indexOf(firstLine) + 700)),
      `déclencheur visible manquant : ${kw}`);
  assert.match(src, /Analyse et prévision d'un export comptable/, "la ligne reste bilingue — jamais un fix mono-langue");
});

/* ── i18n (2026-08-27, fondateur : « in ENGLISH ») ───────────────── */
test("locale absente → dashboard en ANGLAIS par défaut ; labels KPI traduits ; Projeter dans la barre du graphique", () => {
  const html = renderReport("an_en", { ...R,
    series: [{ period: "2025-01", revenue: 3.4e6, ebitda: 6e4 }, { period: "2025-02", revenue: 3.2e6, ebitda: 7e4 }] });
  assert.match(html, /K-Φ — Analysis /);
  assert.match(html, /Reading caveats|Attention points|Project forecast/);
  assert.match(html, /EBITDA margin/, "label KPI anglais");
  assert.doesNotMatch(html, /Marge d'EBITDA/);
  /* le bouton vit dans la barre du graphique, à côté des modes */
  const ti = html.indexOf("Revenue & EBITDA");
  assert.match(html.slice(ti, ti + 400), /id="bF"/, "Project forecast → dans l'en-tête du graphique, pas en bas de page");
});

test("Rentabilité seule en tuiles ; Trésorerie et Structure en table", () => {
  const html = renderReport("an_split", { ...R, locale: "fr" });
  const kpiZone = html.slice(html.indexOf("<h2>KPI</h2>"));
  assert.match(kpiZone, /📈 Rentabilité[\s\S]*class="tiles"/, "groupe 0 en tuiles");
  assert.match(kpiZone, /<table>[\s\S]*💧 Trésorerie[\s\S]*🏦 Structure/, "groupes 1-2 en table");
});

/* ── Narration forecast dans le texte (2026-08-27) ───────────────── */
test("le texte narre le forecast : règles listées, périmètres avec DSO observé, blocages verbatim", async () => {
  const { present } = await import("../dist/tools.js");
  const fx = { horizon_months: 6,
    global: { series: [{ period: "p1" }, { period: "p2" }], blocked: null },
    by_entity: { E1: { series: [{ period: "p1" }], blocked: null },
                 E2: { series: [], blocked: { reason: "no history" } } },
    by_bu: {},
    methods: { dso_by_entity: { E1: { value: 27, source: "gl_observed" } }, dpo_by_entity: {}, dso_by_bu: {}, dpo_by_bu: {} } };
  const out2 = present({ ingestBaseUrl: "https://mcp.test" }, "an_n1",
    { ...R, forecast: fx, notes: ["Règles de flux générées automatiquement de la classification du GL (5 règles : x)"] });
  const txt = out2.content.find(c => c.type === "text").text;
  assert.match(txt, /Forecast \(K-Φ engine\)/, "narration EN par défaut");
  assert.match(txt, /receivables→DSO · payables→DPO/, "règles listées");
  assert.match(txt, /\(5 rules\)/, "compte des règles auto");
  assert.match(txt, /\*\*E1\*\* — 1 months projected · DSO 27 j \(GL-observed\)/, "périmètre + méthode observée");
  assert.match(txt, /\*\*E2\*\* — ⚠ blocked by the engine: no history/, "blocage verbatim, jamais masqué");
});

/* ── Page d'upload (GET) — capture « Cannot GET » 2026-08-27 ─────── */
test("la page d'upload est un template constant : input fichier, PUT via pathname, token jamais injecté", async () => {
  const { uploadPageHtml } = await import("../dist/upload-page.js");
  const html = uploadPageHtml();
  assert.match(html, /type="file"/);
  assert.match(html, /location\.pathname/, "le PUT cible l'URL courante — le token reste hors du HTML");
  assert.match(html, /500 MB/, "plafond annoncé");
  assert.match(html, /What to send[\s\S]*What K-Φ returns/, "la page dit ce qu'elle attend et ce qu'elle rend");
  assert.match(html, /switch back to your Claude conversation/, "consigne de retour explicite : fermer l'onglet, répondre done");
  assert.doesNotMatch(html, /\$\{/, "template constant, aucune interpolation serveur");
});

/* ── Persistance du store (incident du premier upload réel, 2026-08-27) ── */
test("FsStore : une analyse et son jeton survivent à un REDÉMARRAGE du process", async () => {
  const { FsStore } = await import("../dist/store.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(tmpdir() + "/kphi-store-test-");
  const s1 = new FsStore(dir);
  const rec = await s1.create({ status: "ready", input_meta: { format: "csv" } });
  const tok = await s1.issueUploadToken(rec.id, 900_000);
  /* nouvelle instance = ce que fait un redeploy Render */
  const s2 = new FsStore(dir);
  const back = await s2.get(rec.id);
  assert.equal(back?.id, rec.id, "l'analyse survit au redémarrage");
  assert.equal(await s2.consumeUploadToken(tok), rec.id, "le jeton d'upload survit aussi");
  assert.equal(await s2.consumeUploadToken(tok), undefined, "usage unique préservé");
});

/* ── Réconciliation dashboard/app (captures 2026-08-27) ─────────── */
test("devise non monétaire ignorée (« 0.01 » vu en prod) — jamais collée aux montants", () => {
  const html = renderReport("an_ccy", { ...R, detected: { ...R.detected, currency: "0.01" } });
  assert.doesNotMatch(html, /M 0\.01|k 0\.01/, "aucun montant suffixé par une pseudo-devise");
  const ok = renderReport("an_ccy2", { ...R, detected: { ...R.detected, currency: "EUR" } });
  assert.match(ok, /EUR/, "une vraie devise reste affichée");
});

test("forecast sans budget : le graphique montre les ENCAISSEMENTS projetés + la doctrine expliquée", () => {
  const fx = { horizon_months: 3,
    global: { series: [{ period: "2026-01", sales: 0, collections: 120000 }], blocked: null },
    by_entity: {}, by_bu: {},
    methods: { dso_by_entity: { E9: { value: -32231, source: "gl_observed" } }, dpo_by_entity: {}, dso_by_bu: {}, dpo_by_bu: {} } };
  const html = renderReport("an_nb", { ...R, forecast: fx, report_version: "1.1",
    series: [{ period: "2025-01", revenue: 1e6, ebitda: 1e5 }, { period: "2025-02", revenue: 1e6, ebitda: 1e5 }] });
  assert.match(html, /Projected collections \(cash\)/, "libellé encaissements disponible");
  assert.match(html, /does not extrapolate future revenue/, "doctrine « pas de budget, pas d'extrapolation » dite");
  assert.match(html, /okD=v=>/, "garde-fou DSO présent");
  assert.match(html, /id="fcdoc"/, "emplacement de la note doctrine rendu");
});
