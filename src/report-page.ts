/**
 * Dashboard /a/:id — la maquette « wrap-up » validée, rendue serveur depuis
 * le résultat d'analyse persisté. Zéro dépendance build : HTML autonome,
 * Chart.js via CDN. Le bouton « Ouvrir dans K-Φ » garde le comptage de
 * conversion (redirige via /a/:id/open). Les réserves conso/FX sont en
 * bandeau, conditionnelles aux faits (multi-entités, multi-devises).
 */
import type { AnalysisResult, Kpi } from "./engine.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/* Une devise se rend UNIQUEMENT si elle ressemble à un code/symbole
   monétaire. Vu en prod : la colonne « Exchange Rate » d'un export SAP a
   fait détecter « 0.01 » comme devise → « 3.18 M 0.01 » sur chaque montant. */
const CCY_OK = /^([A-Z]{3}|[€$£¥₣])(,\s*([A-Z]{3}|[€$£¥₣]))*$/;
const safeCcy = (c?: string): string => (c && CCY_OK.test(c.trim()) ? c.trim() : "");
const fmtV = (k: Kpi, ccy?: string) => {
  if (k.unit === "%") return `${k.value.toFixed(1)} %`;
  if (k.unit === "x") return `${k.value.toFixed(2)}x`;
  if (k.unit === "days") return `${Math.round(k.value)} j`;
  const a = Math.abs(k.value);
  const n = a >= 1e6 ? `${(k.value / 1e6).toFixed(2)} M` : a >= 1e3 ? `${(k.value / 1e3).toFixed(0)} k` : k.value.toFixed(0);
  const u = k.unit && CCY_OK.test(k.unit) ? k.unit : (ccy ?? "");
  return u ? `${n} ${u}` : n;
};
const GMAX: Record<string, [number, number]> = { ebitda_margin:[0,30], net_margin:[0,20], roe:[0,25], dso:[0,120], dio:[0,150], ccc:[0,150], net_debt_ebitda:[0,5], debt_to_equity:[0,3], dscr:[0,3], interest_coverage:[0,8], current_ratio:[0,3], quick_ratio:[0,2] };
const gauge = (k: Kpi): string => {
  const g = GMAX[k.id]; if (!g) return "";
  const f = Math.max(0, Math.min(1, (k.value - g[0]) / (g[1] - g[0])));
  return `<span style="display:inline-block;width:70px;height:6px;background:#2c2b30;border-radius:3px;vertical-align:middle"><span style="display:block;width:${Math.round(f * 100)}%;height:6px;background:${color(k)};border-radius:3px"></span></span>`;
};
const GROUPS: Array<[string, string[]]> = [
  ["📈 Rentabilité", ["revenue","gross_profit","ebitda","ebitda_margin","operating_income","net_income","net_margin","roe"]],
  ["💧 Trésorerie & cycle", ["cash","working_capital","dso","dpo","dio","ccc"]],
  ["🏦 Structure & dette", ["total_assets","total_equity","total_debt","net_debt_ebitda","net_debt_ebitda_net","debt_to_equity","dscr","interest_coverage","current_ratio","quick_ratio"]],
];
const BANDS: Record<string, [number, number, boolean]> = {
  ebitda_margin: [15, 5, true], net_margin: [8, 2, true], roe: [10, 5, true],
  dso: [45, 75, false], dio: [60, 100, false], ccc: [60, 100, false],
  net_debt_ebitda: [2, 3.5, false], debt_to_equity: [1, 2, false],
  dscr: [1.5, 1.2, true], interest_coverage: [4, 2, true],
  current_ratio: [1.5, 1.0, true], quick_ratio: [1.0, 0.7, true],
};
const refCell = (k: Kpi, loc?: string): string => {
  if (k.threshold !== undefined) return `${loc === "fr" ? "seuil" : "threshold"} ${k.threshold} <span style="color:#898781">(covenant)</span>`;
  const b = BANDS[k.id]; if (!b) return "—";                 /* montants : pas de seuil */
  const [g, , up] = b;
  const u = k.unit === "%" ? " %" : k.unit === "days" ? " j" : k.unit === "x" ? "x" : "";
  return `${up ? "≥" : "≤"} ${g}${u}`;
};
const color = (k: Kpi) => {
  if (k.status === "breach") return "#d03b3b";
  const b = BANDS[k.id]; if (!b) return "#e8e6e1";
  const [g, w, up] = b;
  const ok = up ? k.value >= g : k.value <= g;
  const warn = up ? k.value >= w : k.value <= w;
  return ok ? "#1baf7a" : warn ? "#fab219" : "#d03b3b";
};

function trendArrow(id: string, series: NonNullable<AnalysisResult["series"]>): string {
  if (series.length < 4) return "";
  const v = (s: (typeof series)[number]) =>
    id === "revenue" ? s.revenue : id === "ebitda" ? s.ebitda :
    id === "ebitda_margin" && s.revenue ? (s.ebitda ?? 0) / s.revenue : undefined;
  const a = series.slice(0, 3).map(v).filter((x): x is number => x !== undefined);
  const b = series.slice(-3).map(v).filter((x): x is number => x !== undefined);
  if (a.length < 2 || b.length < 2) return "";
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  if (Math.abs(mb - ma) < Math.abs(ma) * 0.03) return `<span style="color:#898781;font-size:13px"> →</span>`;
  return mb > ma ? `<span style="color:#1baf7a;font-size:13px"> ↗</span>` : `<span style="color:#d03b3b;font-size:13px"> ↘</span>`;
}

const EN_LABELS: Record<string, string> = {
  revenue: "Revenue", gross_profit: "Gross profit", ebitda: "EBITDA", ebitda_margin: "EBITDA margin",
  operating_income: "Operating income", net_income: "Net income", net_margin: "Net margin", roe: "ROE",
  cash: "Cash", working_capital: "Working capital", dso: "DSO", dpo: "DPO", dio: "DIO", ccc: "Cash conversion cycle",
  total_assets: "Total assets", total_equity: "Equity", total_debt: "Financial debt",
  net_debt_ebitda: "Debt / EBITDA", net_debt_ebitda_net: "Net debt / EBITDA", debt_to_equity: "Debt / Equity",
  dscr: "DSCR", interest_coverage: "Interest coverage", current_ratio: "Current ratio", quick_ratio: "Quick ratio",
};
const I18N = {
  en: { title: "Analysis", link24: "24 h link", open: "Open in K-Φ →", openLong: "Open the full analysis in K-Φ →",
        caveats: "Reading caveats", caveatConso: "Group = simple sum of entities, intercompany flows not eliminated.",
        caveatCcy: "Multiple currencies detected", caveatTail: "The forecast and ratios inherit these limits.",
        pdf: "Download PDF", total: "Total", byEntity: "By entity", byBU: "By axis",
        axesFound: "Analytic axes found in this export:", axisUsed: "sliced by", axisSwitch: "Ask your assistant to re-run with another axis (analytic_axis) to slice on it.",
        notInScope: "Not computable on this scope from the ledger", scopeNote: "Tiles, KPIs, Sankey, projection and breakdown below follow this scope.", groupLevel: "whole group — not affected by the filters below", scoped: "Result structure — follows the scope", runout: "Collections stop after month {n}: the receivables present in your ledger have all been collected by then, and without a budget the engine creates no new sales — so there is nothing left to collect. Load a budget in K-Φ to continue the projection beyond that point.", axisNoCash: "This axis carries no balance-sheet accounts (receivables, payables, cash) in your export — it is posted on P&L lines only. There is therefore no cash flow to unwind per value of this axis: the cash projection stays at zero. The P&L itself can still be analysed along this axis in K-Φ.", chart: "Revenue & EBITDA", monthly: "Monthly", waterfall: "Waterfall", pies: "Pies", negEbitda: "negative EBITDA", sankeyNA: "Income-statement flows need revenue and margins — not available on this scope.", skRev: "Revenue", skCogs: "Cost of sales", skGp: "Gross profit", skOpex: "Operating expenses", skEbitda: "EBITDA", skBelow: "D&A, interest, tax", skNi: "Net income", byLine: "By flow line", flCollect: "Customer collections", flPay: "Supplier payments", flPayroll: "Payroll", flOpex: "Operating expenses", flTax: "Taxes", flInt: "Interest", project: "Project forecast →",
        hide: "Hide projection", scope: "Scope", global: "Global", entity: "Entity", bu: "Analytic axis", allEnt: "All entities", allAx: "All values",
        horizon: "K-Φ engine projection · horizon", months: "months",
        alerts: "Attention points", covs: "Covenants", kpi: "KPI", value: "Value", ref: "Reference", gauge: "Gauge",
        sections: ["📈 Profitability", "💧 Cash & cycle", "🏦 Structure & debt"], other: "Other",
        cta_tail: "Balance sheet · P&L · Cash flow · entity & BU drill-down · 30 days free once you confirm your email.",
        old11: "Projection not available on this analysis (pre-1.1 contract) — re-run the analysis to get it.",
        blocked: "Projection blocked by the engine for this scope: ", threshold: "threshold", covenant: "covenant",
        drill: "Breakdown by entity", drillP: "Projection by entity, month by month (stacked)",
        realBar: "Actual revenue", projBar: "Projected revenue", ebitdaLine: "Actual EBITDA",
        projCash: "Projected collections (cash)", noD: "scopes excluded (implied DSO out of range)",
        noBudget: "No budget loaded: the K-Φ engine does not extrapolate future revenue — a sales forecast is a client decision, never invented. The projection unwinds your existing receivables and payables into cash; that is what the gray bars show. Load a budget in K-Φ to project revenue too.",
        methWc: "Working-capital mechanics", methDefault: "Engine projection (trend + working capital) — details in K-Φ",
        obs: "GL-observed", fb: "fallback", recv: "Receivables", pay: "Payables" },
  fr: { title: "Analyse", link24: "lien 24 h", open: "Ouvrir dans K-Φ →", openLong: "Ouvrir l'analyse détaillée dans K-Φ →",
        caveats: "Réserves de lecture", caveatConso: "Conso = somme simple des entités, flux intercos non éliminés.",
        caveatCcy: "Plusieurs devises détectées", caveatTail: "Le forecast et les ratios en héritent.",
        pdf: "Télécharger en PDF", total: "Total", byEntity: "Par entité", byBU: "Par axe",
        axesFound: "Axes analytiques détectés dans cet export :", axisUsed: "découpage sur", axisSwitch: "Demandez à votre assistant de relancer avec un autre axe (analytic_axis).",
        notInScope: "Non calculable sur ce périmètre à partir du grand livre", scopeNote: "Tuiles, KPI, Sankey, projection et décomposition ci-dessous suivent ce périmètre.", groupLevel: "groupe entier — non affecté par les filtres ci-dessous", scoped: "Structure du résultat — suit le périmètre", runout: "Les encaissements s'arrêtent après le mois {n} : les créances présentes dans votre grand livre ont alors toutes été encaissées, et sans budget le moteur ne crée aucune vente nouvelle — il n'y a donc plus rien à encaisser. Chargez un budget dans K-Φ pour prolonger la projection.", axisNoCash: "Cet axe ne porte pas les comptes de bilan (créances, dettes, banque) dans votre export : il n'est renseigné que sur les lignes de résultat. Il n'y a donc aucun flux de trésorerie à dérouler par valeur de cet axe — la projection reste à zéro. Le compte de résultat, lui, reste analysable selon cet axe dans K-Φ.", chart: "Chiffre d'affaires & EBITDA", monthly: "Mensuel", waterfall: "Waterfall", pies: "Camemberts", negEbitda: "EBITDA négatif", sankeyNA: "Les flux du compte de résultat exigent le CA et les marges — indisponibles sur ce périmètre.", skRev: "Chiffre d'affaires", skCogs: "Coût des ventes", skGp: "Marge brute", skOpex: "Charges d'exploitation", skEbitda: "EBITDA", skBelow: "D&A, intérêts, impôt", skNi: "Résultat net", byLine: "Par ligne de flux", flCollect: "Encaissements clients", flPay: "Règlements fournisseurs", flPayroll: "Paie", flOpex: "Charges d'exploitation", flTax: "Impôts", flInt: "Intérêts", project: "Projeter →",
        hide: "Masquer la projection", scope: "Périmètre", global: "Global", entity: "Entité", bu: "Axe analytique", allEnt: "Toutes entités", allAx: "Toutes valeurs",
        horizon: "projection moteur K-Φ · horizon", months: "mois",
        alerts: "Points d'attention", covs: "Covenants", kpi: "KPI", value: "Valeur", ref: "Référence", gauge: "Jauge",
        sections: ["📈 Rentabilité", "💧 Trésorerie & cycle", "🏦 Structure & dette"], other: "Autres",
        cta_tail: "Bilan · P&L · Flux · drill par entité et BU · 30 j gratuits en confirmant votre email.",
        old11: "Projection non disponible sur cette analyse (antérieure au contrat 1.1) — relancez l'analyse pour l'obtenir.",
        blocked: "Projection bloquée par le moteur pour ce périmètre : ", threshold: "seuil", covenant: "covenant",
        drill: "Décomposition par entité", drillP: "Projection par entité, mois par mois (empilée)",
        realBar: "CA réel", projBar: "CA projeté", ebitdaLine: "EBITDA réel",
        projCash: "Encaissements projetés", noD: "périmètres écartés (DSO implicite hors plage)",
        noBudget: "Aucun budget chargé : le moteur K-Φ n'extrapole pas le CA futur — une prévision de ventes est une décision client, jamais inventée. La projection déroule vos créances et dettes existantes en trésorerie : c'est ce que montrent les barres grises. Chargez un budget dans K-Φ pour projeter aussi le CA.",
        methWc: "Mécanique BFR", methDefault: "Projection moteur (tendance + BFR) — détail dans K-Φ",
        obs: "observé GL", fb: "repli", recv: "Créances", pay: "Fournisseurs" },
};

export function renderReport(analysisId: string, r: AnalysisResult): string {
  const T = I18N[r.locale === "fr" ? "fr" : "en"];
  const CCY = safeCcy(r.detected.currency);
  const lbl = (k: Kpi) => (r.locale === "fr" ? k.label : (EN_LABELS[k.id] ?? k.label));
  const byId = new Map(r.kpis.map(k => [k.id, k]));
  const tiles = ["revenue", "ebitda_margin", "dso", "net_debt_ebitda"]
    .map(id => byId.get(id)).filter((k): k is Kpi => !!k);
  const covs = r.kpis.filter(k => k.status);
  const multiCcy = /,/.test(r.detected.currency ?? "");
  const consoNote = r.notes.find(n => /multi-entités/.test(n));
  const series = (r.series ?? []).filter(s => s.revenue !== undefined);
  const caveats: string[] = [];
  const Tc = I18N[r.locale === "fr" ? "fr" : "en"];
  if (consoNote) caveats.push(Tc.caveatConso);
  if (multiCcy) caveats.push(`${Tc.caveatCcy} (${esc(r.detected.currency)}).`);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>K-Φ — Rapport ${esc(analysisId)}</title>
<style>
body{margin:0;background:#111013;color:#e8e6e1;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:24px 20px 48px}
.hd{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px}
.hd h1{font-size:19px;font-weight:600;margin:0}.mut{color:#898781;font-size:13px}
.cav{background:#2e2410;color:#fab219;border-radius:10px;padding:10px 14px;margin:14px 0;font-size:13px}
.tiles{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.tile{background:#1b1a1e;border-radius:10px;padding:12px 14px}
.tile .l{font-size:12px;color:#898781}.tile .v{font-size:23px;font-weight:600}
.covrow{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
.cov{border:1px solid #2c2b30;border-radius:10px;padding:7px 11px;font-size:13px}
table{font-size:16.5px;width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
th{color:#898781;font-weight:500;text-align:left;padding:6px 8px;font-size:12px}
td{padding:7px 8px;border-top:1px solid #232227}.r{text-align:right}
.cta{display:inline-block;background:#e8e6e1;color:#111013;font-weight:600;border-radius:10px;padding:11px 18px;text-decoration:none;margin-top:18px}
@media print{
  /* PDF = la même page, tout déplié, encre économe : le lecteur imprime ce
     qu'il voit, sans dépendance ni rendu serveur. */
  body{background:#fff;color:#111}
  .wrap{max-width:none;padding:0}
  .tile,.panel,table,.cav{background:#fff !important;border-color:#ccc !important;color:#111 !important}
  .mut,.l{color:#555 !important}
  .mbtn,.ctah,.cta,#bF,select{display:none !important}
  details{display:block}details>summary{list-style:none}
  #fcp{display:block !important}
  h1,h2{color:#111}
  tr,.tile,.chartbox{break-inside:avoid}
  a[href]:after{content:""}
}
.mbtn{background:#1b1a1e;color:#b7b5af;border:1px solid #2c2b30;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}
.ctah{background:#e8e6e1;color:#111013;font-weight:600;border-radius:9px;padding:8px 14px;text-decoration:none;font-size:13px;white-space:nowrap}
.chartbox{height:250px;position:relative;margin-top:6px;overflow:hidden}
/* Le mode flux a besoin de hauteur ET de marges pour ses libellés : la boîte
   s'agrandit uniquement dans ce mode, et borne toujours son contenu (le SVG
   débordait sur les covenants — deux captures fondateur). */
.chartbox.sk{height:330px}
h2{font-size:14px;color:#b7b5af;margin:22px 0 4px}
</style></head><body><div class="wrap">
<div class="hd"><h1>K-Φ — ${T.title} ${esc(r.detected.period)}</h1>
<span class="mut" style="margin-left:auto">${esc(r.detected.format)} · ${esc(r.detected.genre ?? "")} ${CCY ? ` · ${esc(CCY)}` : ""} · ${r.detected.entries.toLocaleString("fr-FR")} ${r.locale === "fr" ? "écritures" : "entries"} · ${T.link24}</span>
<button class="mbtn" onclick="window.print()" style="margin-right:8px">${T.pdf}</button><a class="ctah" href="/a/${esc(analysisId)}/open">${T.open}</a></div>
${caveats.length ? `<div class="cav">⚠ <b>${T.caveats}</b> — ${caveats.map(esc).join(" ")} ${T.caveatTail}</div>` : ""}
<h2 style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">${T.chart}<span class="mut" id="grpTag" style="font-size:12.5px;font-weight:400;display:none">&nbsp;— ${T.groupLevel}</span>
<span>${series.length > 1 ? ` ` : ""}<button class="mbtn" id="bF" style="border-color:#898781" onclick="fcpanel()">${T.project}</button></span></h2>
${series.length > 1 ? `<div class="chartbox"><canvas id="c"></canvas></div>` : ""}
<div id="fcp" style="display:none;margin-top:8px">
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
    <span class="mut" style="margin-left:auto">${T.horizon} ${(r.forecast?.horizon_months ?? 6)} ${T.months}</span>
  </div>
  <div id="fcblocked" class="cav" style="display:none"></div>
  <div id="fcdoc" style="display:none;background:#1b1a1e;border:1px solid #2c2b30;color:#b7b5af;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:8px"></div>
  <div id="fcmeth" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;margin-bottom:8px"></div>
  <div id="fcdrill" style="display:none;margin-top:10px">${(r.analytic_axes?.length ?? 0) ? `<div class="mut" style="font-size:12.5px;margin:10px 0 6px">${T.axesFound} ${
    r.analytic_axes!.map(a => `<b>${esc(a.label)}</b> (${esc(a.column)}${a.coverage !== undefined ? `, ${a.coverage}%` : ""})`).join(" · ")
  }${r.analytic_axis ? ` — ${T.axisUsed} <b>${esc(r.analytic_axis.label)}</b>. ${T.axisSwitch}` : ""}</div>` : ""}
  <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
    <span class="mut">${T.drillP}</span>
    <span style="margin-left:auto"><button class="mbtn" id="dL" onclick="ddim('l')">${T.byLine}</button>
    <button class="mbtn" id="dE" onclick="ddim('e')">${T.byEntity}</button>
    <button class="mbtn" id="dB" onclick="ddim('b')">${T.byBU}</button></span>
  </div><div style="position:relative;height:210px"><canvas id="cd"></canvas></div>
  <div id="fctbl" style="overflow-x:auto;margin-top:12px"></div>
  <div id="fcrunout" style="display:none;margin-top:10px;border:1px solid #2c2b30;border-radius:10px;padding:10px 14px;color:#b7b5af;font-size:13px"></div></div>
</div>
${covs.length ? `<h2>${T.covs}</h2><div class="covrow">${covs.map(k =>
  `<span class="cov">${k.status === "ok" ? "✅" : "⛔"} ${esc(lbl(k))} ${fmtV(k, CCY)} <span class="mut">${T.threshold} ${k.threshold}</span></span>`).join("")}</div>` : ""}
${r.alerts.length ? `<h2>${T.alerts}</h2>${r.alerts.map(a => `<div class="cav">⚠ ${esc(a)}</div>`).join("")}` : ""}
${r.forecast ? `<div id="scopebar" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#18171b;border:1px solid #2c2b30;border-radius:12px;padding:12px 16px;margin:14px 0">
  <span style="font-weight:600">${T.entity}</span>
  <select id="fcs" onchange="scopeChanged('e')" style="background:#1b1a1e;color:#e8e6e1;border:1px solid #2c2b30;border-radius:8px;padding:8px 12px;font-size:15px"></select>
  <span style="font-weight:600" id="axlbl">${esc(r.analytic_axis?.label ?? T.bu)}</span>
  <select id="fcax" onchange="scopeChanged('b')" style="background:#1b1a1e;color:#e8e6e1;border:1px solid #2c2b30;border-radius:8px;padding:8px 12px;font-size:15px"></select>
  <span class="mut" id="scopenote" style="font-size:12.5px"></span>
</div>` : ""}
${r.forecast || series.length > 1 ? `<h2 style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">${T.scoped}
<span><button class="mbtn" id="bW" onclick="cmode('W')">${T.waterfall}</button> <button class="mbtn" id="bS" onclick="cmode('S')">${T.pies}</button></span></h2>
<div class="chartbox sk" id="box2"><canvas id="c2"></canvas><div id="sk" style="display:none;overflow:auto;height:100%"></div></div>` : ""}
<div class="tiles">${tiles.map(k => `<details class="tile"><summary style="cursor:pointer;list-style:none"><div class="l">${esc(lbl(k))}</div><div class="v" style="color:${color(k)}">${fmtV(k, CCY)}</div></summary><div class="mut" style="font-size:11px;margin-top:6px">${esc(k.formula ?? (r.locale === "fr" ? "Voir le détail dans K-Φ" : "Details in K-Φ"))} · réf. ${refCell(k, r.locale).replace(/<[^>]+>/g, "")}</div></details>`).join("")}</div>
<h2>${T.kpi}</h2>
${(() => {
  const ids0 = GROUPS[0][1];
  const rows0 = ids0.map(id => byId.get(id)).filter((k): k is Kpi => !!k);
  const tiles0 = rows0.length ? `<div style="color:#b7b5af;font-weight:600;margin:14px 0 8px">${T.sections[0]}</div>
  <div class="tiles" style="margin:0 0 4px">${rows0.map(k =>
    `<div class="tile"><div class="l">${esc(lbl(k))}</div>
     <div class="v" data-kpi="${k.id}" data-unit="${k.unit === "%" ? "%" : k.unit === "days" ? "d" : "m"}" style="color:${color(k)}">${fmtV(k, CCY)}${trendArrow(k.id, series)}</div>
     <div style="margin-top:5px">${gauge(k)} <span class="r mut" style="font-size:11px">${refCell(k, r.locale)}</span></div></div>`).join("")}</div>` : "";
  const grouped = new Set(GROUPS.flatMap(g => g[1]));
  const rest = r.kpis.filter(k => !grouped.has(k.id));
  const row = (k: Kpi) => `<tr><td>${esc(lbl(k))}</td><td class="r" data-kpi="${k.id}" data-unit="${k.unit === "%" ? "%" : k.unit === "days" ? "d" : "m"}" style="color:${color(k)};font-weight:600">${fmtV(k, CCY)}</td><td class="r">${gauge(k)}</td><td class="r mut">${refCell(k, r.locale)}</td></tr>`;
  const tbl = GROUPS.slice(1).map(([, ids], gi) => {
    const rows = ids.map(id => byId.get(id)).filter((k): k is Kpi => !!k);
    return rows.length ? `<tr><td colspan="4" style="color:#b7b5af;font-weight:600;padding-top:14px">${T.sections[gi + 1]}</td></tr>` + rows.map(row).join("") : "";
  }).join("") + (rest.length ? `<tr><td colspan="4" style="color:#b7b5af;font-weight:600;padding-top:14px">${T.other}</td></tr>` + rest.map(row).join("") : "");
  return tiles0 + (tbl ? `<table><tr><th></th><th class="r">${T.value}</th><th class="r">${T.gauge}</th><th class="r">${T.ref}</th></tr>${tbl}</table>` : "");
})()}
<div class="mut" style="font-size:12px;margin-top:6px">${r.locale === "fr"
  ? "Références génériques mid-market — un secteur ne se déduit pas fiablement d'un grand livre seul. Précisez le vôtre dans K-Φ, ou passez vos seuils réels en covenants : ils remplacent la référence."
  : "Generic mid-market reference bands — an industry cannot be reliably inferred from a ledger alone. Set yours in K-Φ, or pass your real thresholds as covenants: they replace the reference."}</div>
<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:18px">
<a class="cta" style="margin-top:0" href="/a/${esc(analysisId)}/open">${T.openLong}</a>
<span class="mut">${esc(T.cta_tail)}</span>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
${series.length > 1 ? `<script>
const S=${JSON.stringify(series)};let CM='W',CH;
const FYr=S.reduce((a,s)=>a+(s.revenue||0),0),FYe=S.reduce((a,s)=>a+(s.ebitda||0),0);
const OPT={responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#b7b5af',boxWidth:10}}},scales:{x:{ticks:{color:'#898781'},grid:{display:false}},y:{ticks:{color:'#898781'},grid:{color:'#232227'}}}};
function cmode(m){CM=m;draw2();}
/* Sankey du compte de résultat — reprend la lecture en flux de K-Φ :
   CA → (COGS) → marge brute → (charges d'exploitation) → EBITDA → (D&A,
   intérêts, impôt) → résultat net. Construit des KPI DÉJÀ calculés par le
   moteur, donc il suit le périmètre sélectionné comme les tuiles.
   SVG inline : aucune dépendance, imprimable dans le PDF. */
function kpiOf(id){
  var v=(window.__SCOPE&&window.__SCOPE!=='g:')?null:undefined;
  var parts=(window.__SCOPE||'g:').split(':');
  if(parts[0]==='e'||parts[0]==='b'){
    var sc=parts[0]==='e'?(window.__FC.by_entity||{})[parts[1]]:(window.__FC.by_bu||{})[parts[1]];
    return sc&&sc.kpi&&sc.kpi[id]!==undefined?sc.kpi[id]:null;
  }
  var el=document.querySelector('[data-kpi="'+id+'"]');
  return el&&window.__KPIG&&window.__KPIG[id]!==undefined?window.__KPIG[id]:null;
}
/* Camemberts par entité : mêmes trois postes que le Waterfall (CA = charges
   + EBITDA), un beignet par périmètre, plus le groupe. Un EBITDA NÉGATIF ne
   se représente pas dans un camembert — on l'affiche alors en texte sous le
   graphe des charges plutôt que de dessiner une part impossible. */
var PIES=[];
function drawPies(){
  var box=document.getElementById('sk');if(!box)return;
  PIES.forEach(function(c){try{c.destroy();}catch(e){}});PIES=[];
  var items=[];
  var gRev=window.__KPIG&&window.__KPIG.revenue,gEb=window.__KPIG&&window.__KPIG.ebitda;
  if(typeof gRev==='number')items.push({name:FT.allEnt,rev:gRev,eb:(typeof gEb==='number')?gEb:null});
  var ents=window.__FC?(window.__FC.by_entity||{}):{};
  for(var e in ents){var k=ents[e].kpi;if(k&&typeof k.revenue==='number')items.push({name:nm(e),rev:k.revenue,eb:(typeof k.ebitda==='number')?k.ebitda:null});}
  if(!items.length){box.innerHTML='<div class="mut" style="padding:24px">'+FT.sankeyNA+'</div>';return;}
  box.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;padding:6px 2px">'+
    items.map(function(it,i){
      var neg=(it.eb!==null&&it.eb<0);
      return '<div style="text-align:center">'+
        '<div class="mut" style="font-size:12.5px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+it.name+'">'+it.name+'</div>'+
        '<div style="position:relative;height:150px"><canvas id="pie'+i+'"></canvas></div>'+
        '<div style="font-size:12.5px;margin-top:4px;color:'+(neg?'#d03b3b':'#b7b5af')+'">'+
          (neg?FT.negEbitda+' '+fmtN(it.eb):FT.skEbitda+' '+fmtN(it.eb===null?0:it.eb))+'</div></div>';
    }).join('')+'</div>';
  items.forEach(function(it,i){
    var el=document.getElementById('pie'+i);if(!el)return;
    var eb=(it.eb===null)?0:it.eb, charges=it.rev-eb, neg=eb<0;
    /* EBITDA négatif : la part n'existe pas, on montre les charges seules. */
    var data=neg?[Math.abs(charges)]:[Math.max(charges,0),Math.max(eb,0)];
    var labels=neg?[FT.skOpex]:[FT.skOpex,FT.skEbitda];
    var colors=neg?['#eb6834']:['#eb6834','#1baf7a'];
    PIES.push(new Chart(el,{type:'doughnut',data:{labels:labels,datasets:[{data:data,backgroundColor:colors,borderWidth:0}]},
      options:{responsive:true,maintainAspectRatio:false,cutout:'52%',
        plugins:{legend:{display:i===0,position:'bottom',labels:{color:'#b7b5af',boxWidth:9,font:{size:11}}},
          tooltip:{callbacks:{label:function(c){return c.label+': '+fmtN(c.parsed);}}}}}}));
  });
}
/* HAUT : historique mensuel du GROUPE, seul — il ne peut pas être découpé
   par périmètre aujourd'hui (option A à venir), donc il vit au-dessus des
   filtres et n'offre aucun mode qui, lui, serait scopé.
   BAS : Waterfall et Sankey, tous deux calculés sur le périmètre choisi. */
function draw2(){
 var _sk=document.getElementById('sk'),_cv=document.getElementById('c2');
 if(!_sk||!_cv)return;
 _sk.style.display=(CM==='S')?'block':'none';_cv.style.display=(CM==='S')?'none':'block';
 for(const b of ['bW','bS']){var _e=document.getElementById(b);if(_e)_e.style.borderColor=('b'+CM===b)?'#898781':'#2c2b30';}
 if(CH2){CH2.destroy();CH2=null;}
 if(CM==='S'){drawPies();return;}
 /* Waterfall du périmètre : CA → charges → EBITDA, depuis les KPI scopés. */
 var rev=kpiOf('revenue'),eb=kpiOf('ebitda');
 if(rev===null||eb===null){_cv.parentNode.innerHTML='<div class="mut" style="padding:24px">'+FT.sankeyNA+'</div>';return;}
 CH2=new Chart(_cv,{type:'bar',data:{labels:[FT.skRev,FT.skOpex,FT.skEbitda],datasets:[{
   data:[[0,rev],[rev,eb],[0,eb]],
   backgroundColor:['#2a78d6','#eb6834',eb<0?'#d03b3b':'#1baf7a'],borderRadius:4,maxBarThickness:64}]},
  options:{...FOPT,plugins:{legend:{display:false}}}});
}
/* HAUT : mensuel du groupe, point. Aucune branche de mode — la variable CM
   appartient désormais au bloc scopé du bas ; l'y laisser faisait rendre un
   waterfall ici (régression vue en prod). */
function draw(){
 if(CH)CH.destroy();
 CH=new Chart(document.getElementById('c'),{data:{labels:S.map(s=>s.period),datasets:[
  {type:'bar',label:${JSON.stringify(T.realBar)},data:S.map(s=>s.revenue??null),backgroundColor:'#2a78d6',borderRadius:4,maxBarThickness:26},
  {type:'line',label:${JSON.stringify(T.ebitdaLine)},data:S.map(s=>s.ebitda??null),borderColor:'#eb6834',borderWidth:2,pointRadius:0,tension:.3}]},options:OPT});
}
draw();
/* Le bloc scopé (Waterfall/Sankey) vit plus bas dans la page : au moment où
   ce script s'exécute, sa boîte n'existe pas encore. On attend le rendu
   complet — sinon le SVG se dessine dans une hauteur nulle et laisse un
   grand vide (régression vue en prod). */
window.addEventListener('load',function(){try{if(typeof draw2==='function')draw2();}catch(e){}});</script>` : ""}

<script>window.__KPIG=${JSON.stringify(Object.fromEntries(r.kpis.map(k => [k.id, k.value])))};window.__CCY=${JSON.stringify(CCY)};window.__FC=${JSON.stringify(r.forecast ?? null).replace(/</g, "\\u003c")};window.__EN=${JSON.stringify(r.entity_names ?? {})};window.__FT=${JSON.stringify({ hide: T.hide, project: T.project, old11: T.old11, global: T.global, entity: T.entity, bu: T.bu, blocked: T.blocked, obs: T.obs, fb: T.fb, recv: T.recv, pay: T.pay, methWc: T.methWc, methDefault: T.methDefault, realBar: T.realBar, projBar: T.projBar, ebitdaLine: T.ebitdaLine, projCash: T.projCash, noD: T.noD, noBudget: T.noBudget, total: T.total, byEntity: T.byEntity, byBU: (r.analytic_axis?.label ?? T.byBU), axisNoCash: T.axisNoCash, scopeNote: T.scopeNote, notInScope: T.notInScope, allEnt: T.allEnt, allAx: T.allAx, runout: T.runout, groupLevel: T.groupLevel, sankeyNA: T.sankeyNA, pies: T.pies, negEbitda: T.negEbitda, skRev: T.skRev, skCogs: T.skCogs, skGp: T.skGp, skOpex: T.skOpex, skEbitda: T.skEbitda, skBelow: T.skBelow, skNi: T.skNi, byLine: T.byLine, flCollect: T.flCollect, flPay: T.flPay, flPayroll: T.flPayroll, flOpex: T.flOpex, flTax: T.flTax, flInt: T.flInt }).replace(/</g, "\\u003c")};</script>
<script>
let FCON=false,CHD=null,CH2=null,DDIM='l';
/* Le périmètre pilote la page : il rescope tout ce que le résultat porte par
   périmètre (projection, méthodes DSO/DPO, décomposition). Les agrégats réels
   restent groupe tant que le moteur n'expose pas ses séries par périmètre —
   dit dans la barre plutôt que laissé deviner. */
/* Valeurs de groupe mémorisées au chargement : revenir sur « Global » doit
   restaurer EXACTEMENT ce que le moteur a calculé pour le groupe. */
var GROUPVALS=null;
function snapGroup(){
  if(GROUPVALS)return;GROUPVALS={};
  document.querySelectorAll('[data-kpi]').forEach(function(el,i){GROUPVALS[i]=el.innerHTML;});
}
function fmtKpi(v,unit){
  if(unit==='%')return v.toFixed(1)+' %';
  if(unit==='d')return Math.round(v)+' j';
  var a=Math.abs(v);
  return (a>=1e6?(v/1e6).toFixed(2)+' M':a>=1e3?(v/1e3).toFixed(0)+' k':String(Math.round(v)))+(window.__CCY?' '+window.__CCY:'');
}
/* Le périmètre pilote la page (SPEC v1.2 ①) : les KPI du périmètre viennent
   du MOTEUR — l'appel scopé a fait tourner runEngine sur ses seules lignes.
   Un KPI que le périmètre ne porte pas s'affiche « — », jamais la valeur
   groupe déguisée. */
function applyScopeKpis(v){
  snapGroup();
  v=v||window.__SCOPE||'g:';var parts=v.split(':');
  var sc=parts[0]==='e'?(window.__FC.by_entity||{})[parts[1]]:parts[0]==='b'?(window.__FC.by_bu||{})[parts[1]]:null;
  var k=sc&&sc.kpi;
  document.querySelectorAll('[data-kpi]').forEach(function(el,i){
    if(!k){el.innerHTML=GROUPVALS[i];el.style.opacity='';return;}
    var id=el.getAttribute('data-kpi'),unit=el.getAttribute('data-unit');
    if(k[id]!==undefined){el.textContent=fmtKpi(k[id],unit);el.style.opacity='';}
    else{el.textContent='—';el.style.opacity='.45';el.title=FT.notInScope;}
  });
}
/* Deux champs, un seul périmètre actif : le moteur scope par entité OU par
   valeur d'axe, pas encore les deux à la fois (croisement = SPEC v1.2 ②).
   Choisir dans un champ remet l'autre à « tous » — plutôt que d'afficher un
   croisement que personne n'a calculé. */
function scopeChanged(which){
  var se=document.getElementById('fcs'),sa=document.getElementById('fcax');
  if(which==='e'&&se.value!=='g:'&&sa)sa.value='g:';
  if(which==='b'&&sa&&sa.value!=='g:')se.value='g:';
  var v=(sa&&sa.value&&sa.value!=='g:')?sa.value:(se.value||'g:');
  window.__SCOPE=v;
  document.getElementById('scopenote').textContent=(v==='g:')?'':FT.scopeNote;
  /* L'historique est AU-DESSUS des filtres parce qu'il ne les suit pas ; le
     titre le rappelle dès qu'un périmètre est actif. */
  var gt=document.getElementById('grpTag');if(gt)gt.style.display=(v==='g:')?'none':'inline';
  if(typeof draw2==='function')draw2();
  applyScopeKpis(v);
  if(!FCON)fcpanel(); else fcdraw();
}
function ddim(d){DDIM=d;fcdraw();}
const EN=window.__EN||{};
/* Un code de société ne dit rien à un lecteur : on affiche le nom quand
   l'export le porte, le code sinon (demande fondateur). */
const nm=c=>EN[c]?EN[c]+' ('+c+')':c;
const fmtN=v=>{const a=Math.abs(v);return a>=1e6?(v/1e6).toFixed(2)+' M':a>=1e3?(v/1e3).toFixed(0)+' k':String(Math.round(v));};const FT=window.__FT;
const FOPT=(typeof OPT!=='undefined')?OPT:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#b7b5af',boxWidth:10}}},scales:{x:{ticks:{color:'#898781'},grid:{display:false}},y:{ticks:{color:'#898781'},grid:{color:'#232227'}}}};
function fcpanel(){
  FCON=!FCON;const p=document.getElementById('fcp');
  document.getElementById('bF').textContent=FCON?FT.hide:FT.project;
  if(!window.__FC){/* analyse antérieure à la v1.1 : le bouton EXISTE et explique (critère 6) */
    p.style.display=FCON?'block':'none';
    document.getElementById('fcblocked').style.display='block';
    document.getElementById('fcblocked').textContent='⚠ '+FT.old11;
    return;}
  if(!document.getElementById('fcs').options.length){
    const sel=document.getElementById('fcs');
    sel.add(new Option(FT.global,'g:'));
    for(const e of Object.keys(window.__FC.by_entity||{}))sel.add(new Option(FT.entity+' '+nm(e),'e:'+e));
    for(const b of Object.keys(window.__FC.by_bu||{}))sel.add(new Option(FT.bu+' '+b,'b:'+b));
    /* défaut = Entité si une seule, sinon Global (critère 2 : entité par défaut quand elle a un sens) */
    /* Dimension du drill : entités (défaut) ou BU — même graphique, même
       table, source différente. Le bouton BU disparaît si l'export n'a pas
       cet axe : jamais un sélecteur vide. */
    var _gs=(fcscope().series)||[];
    /* En mode « ligne de flux », la source est la série du PÉRIMÈTRE courant,
       décomposée par poste ; sinon ce sont les périmètres eux-mêmes. */
    const SRC=(DDIM==='l')?null:((DDIM==='b')?(window.__FC.by_bu||{}):(window.__FC.by_entity||{}));
    /* Un axe posé sur le seul P&L ne produit AUCUN flux de trésorerie : le
       bouton « par axe » n'a alors rien à montrer — on le retire au lieu de
       proposer une vue vide (retour fondateur : « remove By axis, it is KO »). */
    /* Lignes de flux du forecast — les postes que FC_PROJ produit réellement :
       encaissements clients, règlements fournisseurs, paie, charges
       d'exploitation, impôts, intérêts. C'est la lecture « par section »
       demandée ; la vue par entité reste disponible, mais n'est plus le
       défaut. (Capex et résultat financier détaillé viendront quand le
       moteur les exposera dans les lignes de projection.) */
    var FLOWS=[['collections',FT.flCollect,'#2a78d6',1],['payments',FT.flPay,'#eb6834',-1],
               ['payroll',FT.flPayroll,'#eda100',-1],['opex',FT.flOpex,'#9b6cd6',-1],
               ['tax',FT.flTax,'#d03b3b',-1],['interest',FT.flInt,'#28a3a3',-1]];
    var _bu=window.__FC.by_bu||{};
    var _axCash=Object.keys(_bu).some(function(k){return (_bu[k].series||[]).some(function(x){return (x.sales||x.collections||0)!==0;});});
    document.getElementById('dB').style.display=_axCash?'':'none';
    for(const b of ['dL','dE','dB']){var _b=document.getElementById(b);
      if(_b)_b.style.borderColor=(b==='dL'&&DDIM==='l')||(b==='dE'&&DDIM==='e')||(b==='dB'&&DDIM==='b')?'#898781':'#2c2b30';}
    if(!_axCash&&DDIM==='b')DDIM='l';
    document.getElementById('dE').style.borderColor=DDIM==='e'?'#898781':'#2c2b30';
    document.getElementById('dB').style.borderColor=DDIM==='b'?'#898781':'#2c2b30';
    const ents=SRC?Object.keys(SRC):[];
    if(ents.length===1)sel.value='e:'+ents[0];
  }
  p.style.display=FCON?'block':'none';
  document.getElementById('fcdrill').style.display=(FCON&&Object.keys(window.__FC.by_entity||{}).length>1)?'block':'none';
  if(FCON){fcdraw();}else if(typeof draw==='function'){draw();}
}
function fcscope(){const v=window.__SCOPE||'g:';const[k,id]=v.split(':');
  return k==='e'?window.__FC.by_entity[id]:k==='b'?window.__FC.by_bu[id]:window.__FC.global;}
function fcdraw(){
  const sc=fcscope(),v=window.__SCOPE||'g:',[kind,id]=v.split(':');
  const blk=document.getElementById('fcblocked');
  if(sc.blocked){blk.style.display='block';blk.textContent='⚠ '+FT.blocked+(sc.blocked.reason||JSON.stringify(sc.blocked));}
  else blk.style.display='none';
  /* cartes de méthodes : DSO/DPO OBSERVÉS GL du périmètre, provenance affichée (critère 3) */
  const m=window.__FC.methods||{},box=document.getElementById('fcmeth');
  const card=(t,b)=>'<div style="border:1px solid #2c2b30;border-radius:10px;padding:8px 12px;font-size:13px"><span class="mut" style="font-size:12px">'+t+'</span><br>'+b+'</div>';
  const src=s=>s==='gl_observed'?FT.obs:FT.fb;
 const okD=v=>typeof v==='number'&&isFinite(v)&&v>=0&&v<=365;
  let cards='';
  const dm=kind==='e'?m.dso_by_entity:kind==='b'?m.dso_by_bu:null;
  const pm=kind==='e'?m.dpo_by_entity:kind==='b'?m.dpo_by_bu:null;
  if(dm&&dm[id]&&okD(dm[id].value))cards+=card(FT.recv,'DSO '+dm[id].value+' j ('+src(dm[id].source)+', '+id+')');
  if(pm&&pm[id]&&okD(pm[id].value))cards+=card(FT.pay,'DPO '+pm[id].value+' j ('+src(pm[id].source)+', '+id+')');
  if(kind==='g'){const es=Object.entries(m.dso_by_entity||{});
    if(es.length)cards+=card(FT.recv,'DSO/entity: '+es.filter(e=>okD(e[1].value)).map(([e,x])=>nm(e)+' '+x.value+' j').join(' · '));
    const ps=Object.entries(m.dpo_by_entity||{});
    if(ps.length)cards+=card(FT.pay,'DPO/entity: '+ps.filter(e=>okD(e[1].value)).map(([e,x])=>e+' '+x.value+' j').join(' · '));}
  const rows=sc.series||[];
  if(rows.length&&rows[0].impliedDSO!==undefined)if(okD(rows[0].impliedDSO))cards+=card(FT.methWc,'impliedDSO '+Math.round(rows[0].impliedDSO)+' j · impliedDPO '+(rows[0].impliedDPO!==undefined?Math.round(rows[0].impliedDPO)+' j':'—')+' (dérivés du GL du périmètre)');
  box.innerHTML=cards||card('—',FT.methDefault);
  /* projection sur le graphique principal : ventes projetées en gris (données moteur, jamais recalculées) */
  if(typeof S!=='undefined'&&typeof draw==='function'){
    if(CHD){CHD.destroy();CHD=null;}
    const labels=S.map(s=>s.period).concat(rows.map(x=>x.period));
    const rev=S.map(s=>s.revenue??null).concat(rows.map(()=>null));
    const hasSales=rows.some(x=>(x.sales||0)>0);
    /* Doctrine moteur : « pas de budget, pas d'extrapolation » — sans budget
       le CA futur n'est pas inventé (sales=0) ; la projection déroule les
       créances/dettes en TRÉSORERIE. On trace ce que le moteur calcule. */
    const proj=S.map(()=>null).concat(rows.map(x=>hasSales?(x.sales??null):(x.collections??null)));
    const projLbl=hasSales?FT.projBar:FT.projCash;
    var dn=document.getElementById('fcdoc');
    if(dn){dn.style.display=hasSales?'none':'block';dn.textContent='ℹ '+FT.noBudget;}
    if(CH)CH.destroy();
    CH=new Chart(document.getElementById('c'),{data:{labels,datasets:[
      {type:'bar',label:FT.realBar,data:rev,backgroundColor:'#2a78d6',borderRadius:4,maxBarThickness:24},
      {type:'bar',label:projLbl+' ('+(kind==='g'?FT.global:id)+')',data:proj,backgroundColor:'rgba(137,135,129,0.45)',borderRadius:4,maxBarThickness:24},
      {type:'line',label:FT.ebitdaLine,data:S.map(s=>s.ebitda??null).concat(rows.map(()=>null)),borderColor:'#eb6834',borderWidth:2,pointRadius:0,tension:.3}
    ]},options:OPT});}
  /* drill : réel FY + projeté par entité, côte à côte (critère 4) */
  const dr=document.getElementById('fcdrill');
  if(dr.style.display!=='none'){
    /* Dimension du drill : entités (défaut) ou BU — même graphique, même
       table, source différente. Le bouton BU disparaît si l'export n'a pas
       cet axe : jamais un sélecteur vide. */
    var _gs=(fcscope().series)||[];
    /* En mode « ligne de flux », la source est la série du PÉRIMÈTRE courant,
       décomposée par poste ; sinon ce sont les périmètres eux-mêmes. */
    const SRC=(DDIM==='l')?null:((DDIM==='b')?(window.__FC.by_bu||{}):(window.__FC.by_entity||{}));
    /* Un axe posé sur le seul P&L ne produit AUCUN flux de trésorerie : le
       bouton « par axe » n'a alors rien à montrer — on le retire au lieu de
       proposer une vue vide (retour fondateur : « remove By axis, it is KO »). */
    /* Lignes de flux du forecast — les postes que FC_PROJ produit réellement :
       encaissements clients, règlements fournisseurs, paie, charges
       d'exploitation, impôts, intérêts. C'est la lecture « par section »
       demandée ; la vue par entité reste disponible, mais n'est plus le
       défaut. (Capex et résultat financier détaillé viendront quand le
       moteur les exposera dans les lignes de projection.) */
    var FLOWS=[['collections',FT.flCollect,'#2a78d6',1],['payments',FT.flPay,'#eb6834',-1],
               ['payroll',FT.flPayroll,'#eda100',-1],['opex',FT.flOpex,'#9b6cd6',-1],
               ['tax',FT.flTax,'#d03b3b',-1],['interest',FT.flInt,'#28a3a3',-1]];
    var _bu=window.__FC.by_bu||{};
    var _axCash=Object.keys(_bu).some(function(k){return (_bu[k].series||[]).some(function(x){return (x.sales||x.collections||0)!==0;});});
    document.getElementById('dB').style.display=_axCash?'':'none';
    for(const b of ['dL','dE','dB']){var _b=document.getElementById(b);
      if(_b)_b.style.borderColor=(b==='dL'&&DDIM==='l')||(b==='dE'&&DDIM==='e')||(b==='dB'&&DDIM==='b')?'#898781':'#2c2b30';}
    if(!_axCash&&DDIM==='b')DDIM='l';
    document.getElementById('dE').style.borderColor=DDIM==='e'?'#898781':'#2c2b30';
    document.getElementById('dB').style.borderColor=DDIM==='b'?'#898781':'#2c2b30';
    const ents=SRC?Object.keys(SRC):[];
    /* X = PÉRIODES (demande fondateur) : une série par entité, valeurs =
       CA projeté si budget, sinon encaissements projetés — même règle que
       le graphique principal. */
    const perSet=[];
    if(DDIM==='l'){for(const x of _gs)if(perSet.indexOf(x.period)<0)perSet.push(x.period);}
    else for(const e of ents)for(const x of (SRC[e].series||[]))if(perSet.indexOf(x.period)<0)perSet.push(x.period);
    perSet.sort();
    const PAL=['#2a78d6','#eb6834','#1baf7a','#eda100','#9b6cd6','#d03b3b','#28a3a3','#b7b5af'];
    var dsEnt;
    if(DDIM==='l'){
      dsEnt=FLOWS.map(function(f){
        var byP={};for(const x of _gs)byP[x.period]=(x[f[0]]||0)*f[3];
        return {label:f[1],data:perSet.map(p=>byP[p]??null),backgroundColor:f[2],borderRadius:3,maxBarThickness:26};
      }).filter(function(d){return d.data.some(function(v){return (v||0)!==0;});});
    } else dsEnt=ents.map(function(e,i){
      const byP={};for(const x of (SRC[e].series||[]))byP[x.period]=(x.sales||x.collections||0);
      return {label:DDIM==='b'?e:nm(e),data:perSet.map(p=>byP[p]??null),backgroundColor:PAL[i%PAL.length],borderRadius:3,maxBarThickness:22};
    });
        if(CHD)CHD.destroy();
    /* Table des valeurs du graphique : mêmes chiffres, lisibles et copiables
       (demande fondateur) — total par période et par entité. */
    (function(){
      var t='<table style="width:100%;font-size:13.5px"><tr><th style="text-align:left">'+FT.entity+'</th>'+
        perSet.map(function(p){return '<th class="r">'+p+'</th>';}).join('')+'<th class="r">'+FT.total+'</th></tr>';
      var colTot=perSet.map(function(){return 0;});
      dsEnt.forEach(function(d){
        var rowTot=0;
        t+='<tr><td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:'+d.backgroundColor+';margin-right:6px"></span>'+d.label+'</td>';
        d.data.forEach(function(v,i){var n=v||0;rowTot+=n;colTot[i]+=n;t+='<td class="r">'+fmtN(n)+'</td>';});
        t+='<td class="r" style="font-weight:600">'+fmtN(rowTot)+'</td></tr>';
      });
      t+='<tr style="border-top:1px solid #2c2b30"><td style="font-weight:600">'+FT.total+'</td>'+
        colTot.map(function(v){return '<td class="r" style="font-weight:600">'+fmtN(v)+'</td>';}).join('')+
        '<td class="r" style="font-weight:600">'+fmtN(colTot.reduce(function(a,b){return a+b;},0))+'</td></tr></table>';
      /* Projection d'axe intégralement nulle : ce n'est pas un bug d'affichage,
         c'est que l'axe ne porte pas les comptes de BILAN (créances, dettes,
         banque). Sans eux, il n'y a aucun flux à dérouler. On l'explique au
         lieu d'afficher une grille de zéros. */
      var anyVal=dsEnt.some(function(d){return d.data.some(function(v){return (v||0)!==0;});});
      /* Zéros de fin de série : les créances EXISTANTES ont fini d'être
         encaissées (DSO ~1-2 mois) et, sans budget, aucune vente nouvelle
         n'en crée d'autres. Le dire, sinon la table paraît cassée. */
      var lastNZ=-1;
      for(var ci=0;ci<perSet.length;ci++){var s=0;dsEnt.forEach(function(d){s+=Math.abs(d.data[ci]||0);});if(s>0)lastNZ=ci;}
      var runout=document.getElementById('fcrunout');
      if(runout){
        var show=lastNZ>=0&&lastNZ<perSet.length-1;
        runout.style.display=show?'block':'none';
        if(show)runout.textContent='ℹ '+FT.runout.replace('{n}',String(lastNZ+1));
      }
      document.getElementById('fctbl').innerHTML=anyVal?t:
        '<div style="border:1px solid #2c2b30;border-radius:10px;padding:14px;color:#b7b5af;font-size:13.5px">'+
        FT.axisNoCash+'</div>';
      document.getElementById('cd').parentNode.style.display=anyVal?'':'none';
    })();
    CHD=new Chart(document.getElementById('cd'),{type:'bar',data:{labels:perSet,datasets:dsEnt},
      options:{...FOPT,plugins:{legend:{labels:{color:'#b7b5af',boxWidth:10}}},scales:{...FOPT.scales,x:{...FOPT.scales.x,stacked:true},y:{...FOPT.scales.y,stacked:true}}}});}
}

/* Périmètres peuplés dès le chargement : la barre est utilisable sans
   ouvrir le panneau (le périmètre pilote la page). */
try{if(window.__FC){
  var _s=document.getElementById('fcs');
  if(_s&&!_s.options.length){_s.add(new Option(FT.allEnt,'g:'));for(const e of Object.keys(window.__FC.by_entity||{}))_s.add(new Option(nm(e),'e:'+e));}
  var _a=document.getElementById('fcax'),_bu=Object.keys(window.__FC.by_bu||{});
  if(_a&&!_a.options.length){
    if(!_bu.length){_a.style.display='none';var _l=document.getElementById('axlbl');if(_l)_l.style.display='none';}
    else{_a.add(new Option(FT.allAx,'g:'));for(const b of _bu)_a.add(new Option(b,'b:'+b));}
  }
}}catch(e){}
</script>
</div></body></html>`;
}
