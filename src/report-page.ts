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
        pdf: "Download PDF", total: "Total", chart: "Revenue & EBITDA", monthly: "Monthly", waterfall: "Waterfall", project: "Project forecast →",
        hide: "Hide projection", scope: "Scope", global: "Global", entity: "Entity", bu: "BU",
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
        pdf: "Télécharger en PDF", total: "Total", chart: "Chiffre d'affaires & EBITDA", monthly: "Mensuel", waterfall: "Waterfall", project: "Projeter →",
        hide: "Masquer la projection", scope: "Périmètre", global: "Global", entity: "Entité", bu: "BU",
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
table{font-size:15px;width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
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
.chartbox{height:250px;position:relative;margin-top:6px}
h2{font-size:14px;color:#b7b5af;margin:22px 0 4px}
</style></head><body><div class="wrap">
<div class="hd"><h1>K-Φ — ${T.title} ${esc(r.detected.period)}</h1>
<span class="mut" style="margin-left:auto">${esc(r.detected.format)} · ${esc(r.detected.genre ?? "")} ${CCY ? ` · ${esc(CCY)}` : ""} · ${r.detected.entries.toLocaleString("fr-FR")} ${r.locale === "fr" ? "écritures" : "entries"} · ${T.link24}</span>
<button class="mbtn" onclick="window.print()" style="margin-right:8px">${T.pdf}</button><a class="ctah" href="/a/${esc(analysisId)}/open">${T.open}</a></div>
${caveats.length ? `<div class="cav">⚠ <b>${T.caveats}</b> — ${caveats.map(esc).join(" ")} ${T.caveatTail}</div>` : ""}
<div class="tiles">${tiles.map(k => `<details class="tile"><summary style="cursor:pointer;list-style:none"><div class="l">${esc(lbl(k))}</div><div class="v" style="color:${color(k)}">${fmtV(k, CCY)}</div></summary><div class="mut" style="font-size:11px;margin-top:6px">${esc(k.formula ?? (r.locale === "fr" ? "Voir le détail dans K-Φ" : "Details in K-Φ"))} · réf. ${refCell(k, r.locale).replace(/<[^>]+>/g, "")}</div></details>`).join("")}</div>
<h2 style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">${T.chart}
<span>${series.length > 1 ? `<button class="mbtn" id="bM" onclick="cmode('M')">${T.monthly}</button> <button class="mbtn" id="bW" onclick="cmode('W')">${T.waterfall}</button> ` : ""}<button class="mbtn" id="bF" style="border-color:#898781" onclick="fcpanel()">${T.project}</button></span></h2>
${series.length > 1 ? `<div class="chartbox"><canvas id="c"></canvas></div>` : ""}
<div id="fcp" style="display:none;margin-top:8px">
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
    <span class="mut">${T.scope}</span>
    <select id="fcs" onchange="fcdraw()" style="background:#1b1a1e;color:#e8e6e1;border:1px solid #2c2b30;border-radius:8px;padding:6px 10px"></select>
    <span class="mut" style="margin-left:auto">${T.horizon} ${(r.forecast?.horizon_months ?? 6)} ${T.months}</span>
  </div>
  <div id="fcblocked" class="cav" style="display:none"></div>
  <div id="fcdoc" style="display:none;background:#1b1a1e;border:1px solid #2c2b30;color:#b7b5af;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:8px"></div>
  <div id="fcmeth" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;margin-bottom:8px"></div>
  <div id="fcdrill" style="display:none;margin-top:10px"><div class="mut" style="margin-bottom:6px">${T.drillP}</div><div style="position:relative;height:210px"><canvas id="cd"></canvas></div>
  <div id="fctbl" style="overflow-x:auto;margin-top:12px"></div></div>
</div>
${covs.length ? `<h2>${T.covs}</h2><div class="covrow">${covs.map(k =>
  `<span class="cov">${k.status === "ok" ? "✅" : "⛔"} ${esc(lbl(k))} ${fmtV(k, CCY)} <span class="mut">${T.threshold} ${k.threshold}</span></span>`).join("")}</div>` : ""}
${r.alerts.length ? `<h2>${T.alerts}</h2>${r.alerts.map(a => `<div class="cav">⚠ ${esc(a)}</div>`).join("")}` : ""}
<h2>${T.kpi}</h2>
${(() => {
  const ids0 = GROUPS[0][1];
  const rows0 = ids0.map(id => byId.get(id)).filter((k): k is Kpi => !!k);
  const tiles0 = rows0.length ? `<div style="color:#b7b5af;font-weight:600;margin:14px 0 8px">${T.sections[0]}</div>
  <div class="tiles" style="margin:0 0 4px">${rows0.map(k =>
    `<div class="tile"><div class="l">${esc(lbl(k))}</div>
     <div class="v" style="color:${color(k)}">${fmtV(k, CCY)}${trendArrow(k.id, series)}</div>
     <div style="margin-top:5px">${gauge(k)} <span class="r mut" style="font-size:11px">${refCell(k, r.locale)}</span></div></div>`).join("")}</div>` : "";
  const grouped = new Set(GROUPS.flatMap(g => g[1]));
  const rest = r.kpis.filter(k => !grouped.has(k.id));
  const row = (k: Kpi) => `<tr><td>${esc(lbl(k))}</td><td class="r" style="color:${color(k)};font-weight:600">${fmtV(k, CCY)}</td><td class="r">${gauge(k)}</td><td class="r mut">${refCell(k, r.locale)}</td></tr>`;
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
const S=${JSON.stringify(series)};let CM='M',CH;
const FYr=S.reduce((a,s)=>a+(s.revenue||0),0),FYe=S.reduce((a,s)=>a+(s.ebitda||0),0);
const OPT={responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#b7b5af',boxWidth:10}}},scales:{x:{ticks:{color:'#898781'},grid:{display:false}},y:{ticks:{color:'#898781'},grid:{color:'#232227'}}}};
function cmode(m){CM=m;draw();}
function draw(){if(CH)CH.destroy();
 document.getElementById('bM').style.borderColor=CM==='M'?'#898781':'#2c2b30';
 document.getElementById('bW').style.borderColor=CM==='W'?'#898781':'#2c2b30';
 CH=CM==='M'?new Chart(document.getElementById('c'),{data:{labels:S.map(s=>s.period),datasets:[
  {type:'bar',label:'CA',data:S.map(s=>s.revenue??null),backgroundColor:'#2a78d6',borderRadius:4,maxBarThickness:26},
  {type:'line',label:'EBITDA',data:S.map(s=>s.ebitda??null),borderColor:'#eb6834',borderWidth:2,pointRadius:0,tension:.3}]},options:OPT})
 :new Chart(document.getElementById('c'),{type:'bar',data:{labels:['CA exercice','Charges','EBITDA'],datasets:[{data:[[0,FYr],[FYr,FYe],[0,FYe]],backgroundColor:['#2a78d6','#eb6834',FYe<0?'#d03b3b':'#1baf7a'],borderRadius:4,maxBarThickness:60}]},options:{...OPT,plugins:{legend:{display:false}}}});}
draw();</script>` : ""}

<script>window.__FC=${JSON.stringify(r.forecast ?? null).replace(/</g, "\\u003c")};window.__FT=${JSON.stringify({ hide: T.hide, project: T.project, old11: T.old11, global: T.global, entity: T.entity, bu: T.bu, blocked: T.blocked, obs: T.obs, fb: T.fb, recv: T.recv, pay: T.pay, methWc: T.methWc, methDefault: T.methDefault, realBar: T.realBar, projBar: T.projBar, ebitdaLine: T.ebitdaLine, projCash: T.projCash, noD: T.noD, noBudget: T.noBudget, total: T.total }).replace(/</g, "\\u003c")};</script>
<script>
let FCON=false,CHD=null;
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
  if(FCON&&!document.getElementById('fcs').options.length){
    const sel=document.getElementById('fcs');
    sel.add(new Option(FT.global,'g:'));
    for(const e of Object.keys(window.__FC.by_entity||{}))sel.add(new Option(FT.entity+' '+e,'e:'+e));
    for(const b of Object.keys(window.__FC.by_bu||{}))sel.add(new Option(FT.bu+' '+b,'b:'+b));
    /* défaut = Entité si une seule, sinon Global (critère 2 : entité par défaut quand elle a un sens) */
    const ents=Object.keys(window.__FC.by_entity||{});
    if(ents.length===1)sel.value='e:'+ents[0];
  }
  p.style.display=FCON?'block':'none';
  document.getElementById('fcdrill').style.display=(FCON&&Object.keys(window.__FC.by_entity||{}).length>1)?'block':'none';
  if(FCON){fcdraw();}else if(typeof draw==='function'){draw();}
}
function fcscope(){const v=document.getElementById('fcs').value||'g:';const[k,id]=v.split(':');
  return k==='e'?window.__FC.by_entity[id]:k==='b'?window.__FC.by_bu[id]:window.__FC.global;}
function fcdraw(){
  const sc=fcscope(),v=document.getElementById('fcs').value||'g:',[kind,id]=v.split(':');
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
    if(es.length)cards+=card(FT.recv,'DSO/entity: '+es.filter(e=>okD(e[1].value)).map(([e,x])=>e+' '+x.value+' j').join(' · '));
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
    const ents=Object.keys(window.__FC.by_entity||{});
    /* X = PÉRIODES (demande fondateur) : une série par entité, valeurs =
       CA projeté si budget, sinon encaissements projetés — même règle que
       le graphique principal. */
    const perSet=[];for(const e of ents)for(const x of (window.__FC.by_entity[e].series||[]))if(perSet.indexOf(x.period)<0)perSet.push(x.period);
    perSet.sort();
    const PAL=['#2a78d6','#eb6834','#1baf7a','#eda100','#9b6cd6','#d03b3b','#28a3a3','#b7b5af'];
    const dsEnt=ents.map(function(e,i){
      const byP={};for(const x of (window.__FC.by_entity[e].series||[]))byP[x.period]=(x.sales||x.collections||0);
      return {label:e,data:perSet.map(p=>byP[p]??null),backgroundColor:PAL[i%PAL.length],borderRadius:3,maxBarThickness:22};
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
      document.getElementById('fctbl').innerHTML=t;
    })();
    CHD=new Chart(document.getElementById('cd'),{type:'bar',data:{labels:perSet,datasets:dsEnt},
      options:{...FOPT,plugins:{legend:{labels:{color:'#b7b5af',boxWidth:10}}},scales:{...FOPT.scales,x:{...FOPT.scales.x,stacked:true},y:{...FOPT.scales.y,stacked:true}}}});}
}
</script>
</div></body></html>`;
}
