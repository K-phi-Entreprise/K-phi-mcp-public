/**
 * Dashboard /a/:id — la maquette « wrap-up » validée, rendue serveur depuis
 * le résultat d'analyse persisté. Zéro dépendance build : HTML autonome,
 * Chart.js via CDN. Le bouton « Ouvrir dans K-Φ » garde le comptage de
 * conversion (redirige via /a/:id/open). Les réserves conso/FX sont en
 * bandeau, conditionnelles aux faits (multi-entités, multi-devises).
 */
import type { AnalysisResult, Kpi } from "./engine.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtV = (k: Kpi) => {
  if (k.unit === "%") return `${k.value.toFixed(1)} %`;
  if (k.unit === "x") return `${k.value.toFixed(2)}x`;
  if (k.unit === "days") return `${Math.round(k.value)} j`;
  const a = Math.abs(k.value);
  const n = a >= 1e6 ? `${(k.value / 1e6).toFixed(2)} M` : a >= 1e3 ? `${(k.value / 1e3).toFixed(0)} k` : k.value.toFixed(0);
  return `${n} ${k.unit}`;
};
const BANDS: Record<string, [number, number, boolean]> = {
  ebitda_margin: [15, 5, true], net_margin: [8, 2, true], roe: [10, 5, true],
  dso: [45, 75, false], dio: [60, 100, false], ccc: [60, 100, false],
  net_debt_ebitda: [2, 3.5, false], debt_to_equity: [1, 2, false],
  dscr: [1.5, 1.2, true], interest_coverage: [4, 2, true],
  current_ratio: [1.5, 1.0, true], quick_ratio: [1.0, 0.7, true],
};
const color = (k: Kpi) => {
  if (k.status === "breach") return "#d03b3b";
  const b = BANDS[k.id]; if (!b) return "#e8e6e1";
  const [g, w, up] = b;
  const ok = up ? k.value >= g : k.value <= g;
  const warn = up ? k.value >= w : k.value <= w;
  return ok ? "#1baf7a" : warn ? "#fab219" : "#d03b3b";
};

export function renderReport(analysisId: string, r: AnalysisResult): string {
  const byId = new Map(r.kpis.map(k => [k.id, k]));
  const tiles = ["revenue", "ebitda_margin", "dso", "net_debt_ebitda"]
    .map(id => byId.get(id)).filter((k): k is Kpi => !!k);
  const covs = r.kpis.filter(k => k.status);
  const multiCcy = /,/.test(r.detected.currency ?? "");
  const consoNote = r.notes.find(n => /multi-entités/.test(n));
  const series = (r.series ?? []).filter(s => s.revenue !== undefined);
  const caveats: string[] = [];
  if (consoNote) caveats.push("Conso = somme simple des entités, flux intercos non éliminés.");
  if (multiCcy) caveats.push(`Plusieurs devises détectées (${esc(r.detected.currency)}) : montants agrégés sans conversion de groupe.`);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>K-Φ — Rapport ${esc(analysisId)}</title>
<style>
body{margin:0;background:#111013;color:#e8e6e1;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:24px 20px 48px}
.hd{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px}
.hd h1{font-size:19px;font-weight:600;margin:0}.mut{color:#898781;font-size:13px}
.cav{background:#2e2410;color:#fab219;border-radius:10px;padding:10px 14px;margin:14px 0;font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.tile{background:#1b1a1e;border-radius:10px;padding:12px 14px}
.tile .l{font-size:12px;color:#898781}.tile .v{font-size:23px;font-weight:600}
.covrow{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
.cov{border:1px solid #2c2b30;border-radius:10px;padding:7px 11px;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
th{color:#898781;font-weight:500;text-align:left;padding:6px 8px;font-size:12px}
td{padding:7px 8px;border-top:1px solid #232227}.r{text-align:right}
.cta{display:inline-block;background:#e8e6e1;color:#111013;font-weight:600;border-radius:10px;padding:11px 18px;text-decoration:none;margin-top:18px}
.ctah{background:#e8e6e1;color:#111013;font-weight:600;border-radius:9px;padding:8px 14px;text-decoration:none;font-size:13px;white-space:nowrap}
.chartbox{height:250px;position:relative;margin-top:6px}
h2{font-size:14px;color:#b7b5af;margin:22px 0 4px}
</style></head><body><div class="wrap">
<div class="hd"><h1>K-Φ — Analyse ${esc(r.detected.period)}</h1>
<span class="mut" style="margin-left:auto">${esc(r.detected.format)} · ${esc(r.detected.genre ?? "")} · ${esc(r.detected.currency)} · ${r.detected.entries.toLocaleString("fr-FR")} écritures · lien 24 h</span>
<a class="ctah" href="/a/${esc(analysisId)}/open">Ouvrir dans K-Φ →</a></div>
${caveats.length ? `<div class="cav">⚠ <b>Réserves de lecture</b> — ${caveats.map(esc).join(" ")} Le forecast et les ratios en héritent.</div>` : ""}
<div class="tiles">${tiles.map(k => `<div class="tile"><div class="l">${esc(k.label)}</div><div class="v" style="color:${color(k)}">${fmtV(k)}</div>${k.formula ? `<div class="mut" style="font-size:11px">${esc(k.formula).slice(0, 60)}</div>` : ""}</div>`).join("")}</div>
${series.length > 1 ? `<h2>Chiffre d'affaires &amp; EBITDA par mois</h2><div class="chartbox"><canvas id="c"></canvas></div>` : ""}
${covs.length ? `<h2>Covenants</h2><div class="covrow">${covs.map(k =>
  `<span class="cov">${k.status === "ok" ? "✅" : "⛔"} ${esc(k.label)} ${fmtV(k)} <span class="mut">seuil ${k.threshold}</span></span>`).join("")}</div>` : ""}
${r.alerts.length ? `<h2>Points d'attention</h2>${r.alerts.map(a => `<div class="cav">⚠ ${esc(a)}</div>`).join("")}` : ""}
<h2>KPI</h2><table><tr><th>Indicateur</th><th class="r">Valeur</th><th class="r">Seuil</th></tr>
${r.kpis.map(k => `<tr><td>${esc(k.label)}</td><td class="r" style="color:${color(k)};font-weight:600">${fmtV(k)}</td><td class="r mut">${k.threshold ?? "—"}</td></tr>`).join("")}
</table>
<a class="cta" href="/a/${esc(analysisId)}/open">Ouvrir l'analyse détaillée dans K-Φ →</a>
<div class="mut" style="margin-top:8px">Bilan · P&amp;L · Flux · drill par entité et BU · 30 j gratuits en confirmant votre email.</div>
${series.length > 1 ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>new Chart(document.getElementById('c'),{data:{labels:${JSON.stringify(series.map(s => s.period))},datasets:[
{type:'bar',label:'CA',data:${JSON.stringify(series.map(s => s.revenue ?? null))},backgroundColor:'#2a78d6',borderRadius:4,maxBarThickness:26},
{type:'line',label:'EBITDA',data:${JSON.stringify(series.map(s => s.ebitda ?? null))},borderColor:'#eb6834',borderWidth:2,pointRadius:0,tension:.3}
]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#b7b5af',boxWidth:10}}},scales:{x:{ticks:{color:'#898781'},grid:{display:false}},y:{ticks:{color:'#898781'},grid:{color:'#232227'}}}}});</script>` : ""}
</div></body></html>`;
}
