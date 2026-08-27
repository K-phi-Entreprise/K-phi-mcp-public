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
const refCell = (k: Kpi): string => {
  if (k.threshold !== undefined) return `seuil ${k.threshold} <span style="color:#898781">(covenant)</span>`;
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
.mbtn{background:#1b1a1e;color:#b7b5af;border:1px solid #2c2b30;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}
.ctah{background:#e8e6e1;color:#111013;font-weight:600;border-radius:9px;padding:8px 14px;text-decoration:none;font-size:13px;white-space:nowrap}
.chartbox{height:250px;position:relative;margin-top:6px}
h2{font-size:14px;color:#b7b5af;margin:22px 0 4px}
</style></head><body><div class="wrap">
<div class="hd"><h1>K-Φ — Analyse ${esc(r.detected.period)}</h1>
<span class="mut" style="margin-left:auto">${esc(r.detected.format)} · ${esc(r.detected.genre ?? "")} · ${esc(r.detected.currency)} · ${r.detected.entries.toLocaleString("fr-FR")} écritures · lien 24 h</span>
<a class="ctah" href="/a/${esc(analysisId)}/open">Ouvrir dans K-Φ →</a></div>
${caveats.length ? `<div class="cav">⚠ <b>Réserves de lecture</b> — ${caveats.map(esc).join(" ")} Le forecast et les ratios en héritent.</div>` : ""}
<div class="tiles">${tiles.map(k => `<details class="tile"><summary style="cursor:pointer;list-style:none"><div class="l">${esc(k.label)}</div><div class="v" style="color:${color(k)}">${fmtV(k)}</div></summary><div class="mut" style="font-size:11px;margin-top:6px">${esc(k.formula ?? "Voir le détail dans K-Φ")} · réf. ${refCell(k).replace(/<[^>]+>/g, "")}</div></details>`).join("")}</div>
${series.length > 1 ? `<h2 style="display:flex;justify-content:space-between;align-items:center">Chiffre d'affaires &amp; EBITDA
<span><button class="mbtn" id="bM" onclick="cmode('M')">Mensuel</button> <button class="mbtn" id="bW" onclick="cmode('W')">Waterfall</button></span></h2>
<div class="chartbox"><canvas id="c"></canvas></div>` : ""}
${covs.length ? `<h2>Covenants</h2><div class="covrow">${covs.map(k =>
  `<span class="cov">${k.status === "ok" ? "✅" : "⛔"} ${esc(k.label)} ${fmtV(k)} <span class="mut">seuil ${k.threshold}</span></span>`).join("")}</div>` : ""}
${r.alerts.length ? `<h2>Points d'attention</h2>${r.alerts.map(a => `<div class="cav">⚠ ${esc(a)}</div>`).join("")}` : ""}
<h2>KPI</h2>
${GROUPS.map(([title, ids]) => {
  const rows = ids.map(id => byId.get(id)).filter((k): k is Kpi => !!k);
  if (!rows.length) return "";
  return `<div style="color:#b7b5af;font-weight:600;margin:14px 0 8px">${title}</div>
  <div class="tiles" style="margin:0 0 4px">${rows.map(k =>
    `<div class="tile"><div class="l">${esc(k.label)}</div>
     <div class="v" style="color:${color(k)}">${fmtV(k)}${trendArrow(k.id, series)}</div>
     <div style="margin-top:5px">${gauge(k)} <span class="r mut" style="font-size:11px">${refCell(k)}</span></div></div>`).join("")}</div>`;
}).join("")}
${(() => { const gd = new Set(GROUPS.flatMap(g => g[1])); const rest = r.kpis.filter(k => !gd.has(k.id));
  return rest.length ? `<div style="color:#b7b5af;font-weight:600;margin:14px 0 8px">Autres</div><div class="tiles">` +
    rest.map(k => `<div class="tile"><div class="l">${esc(k.label)}</div><div class="v" style="color:${color(k)}">${fmtV(k)}</div><div style="margin-top:5px">${gauge(k)} <span class="r mut" style="font-size:11px">${refCell(k)}</span></div></div>`).join("") + `</div>` : ""; })()}
<div class="mut" style="font-size:12px;margin-top:6px">Références génériques mid-market, tous secteurs — un secteur ne se déduit pas fiablement d'un grand livre seul. Précisez le vôtre dans K-Φ pour des bandes sectorielles, ou passez vos seuils réels en covenants : ils remplacent la référence.</div>
<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:18px">
<a class="cta" style="margin-top:0" href="/a/${esc(analysisId)}/open">Ouvrir l'analyse détaillée dans K-Φ →</a>
<span class="mut">Bilan · P&amp;L · Flux · drill par entité et BU · 30 j gratuits en confirmant votre email.</span>
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
<div style="display:flex;justify-content:flex-end;margin-top:14px">
<button class="mbtn" id="bF" style="border-color:#898781;font-size:13px;padding:8px 14px" onclick="fcpanel()">Projeter →</button>
</div>
<div id="fcp" style="display:none;margin-top:8px">
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
    <span class="mut">Périmètre</span>
    <select id="fcs" onchange="fcdraw()" style="background:#1b1a1e;color:#e8e6e1;border:1px solid #2c2b30;border-radius:8px;padding:6px 10px"></select>
    <span class="mut" style="margin-left:auto">projection moteur K-Φ · horizon ${(r.forecast?.horizon_months ?? 6)} mois</span>
  </div>
  <div id="fcblocked" class="cav" style="display:none"></div>
  <div id="fcmeth" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;margin-bottom:8px"></div>
  <div id="fcdrill" style="display:none;margin-top:10px"><div class="mut" style="margin-bottom:6px">Décomposition par entité — réel (exercice) et projeté (horizon)</div><div style="position:relative;height:210px"><canvas id="cd"></canvas></div></div>
</div>
<script>window.__FC=${JSON.stringify(r.forecast ?? null).replace(/</g, "\\u003c")};</script>
<script>
let FCON=false,CHD=null;
const FOPT=(typeof OPT!=='undefined')?OPT:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#b7b5af',boxWidth:10}}},scales:{x:{ticks:{color:'#898781'},grid:{display:false}},y:{ticks:{color:'#898781'},grid:{color:'#232227'}}}};
function fcpanel(){
  FCON=!FCON;const p=document.getElementById('fcp');
  document.getElementById('bF').textContent=FCON?'Masquer la projection':'Projeter →';
  if(!window.__FC){/* analyse antérieure à la v1.1 : le bouton EXISTE et explique (critère 6) */
    p.style.display=FCON?'block':'none';
    document.getElementById('fcblocked').style.display='block';
    document.getElementById('fcblocked').textContent='⚠ Projection non disponible sur cette analyse (antérieure au contrat 1.1) — relancez l\'analyse pour l\'obtenir.';
    return;}
  if(FCON&&!document.getElementById('fcs').options.length){
    const sel=document.getElementById('fcs');
    sel.add(new Option('Global','g:'));
    for(const e of Object.keys(window.__FC.by_entity||{}))sel.add(new Option('Entité '+e,'e:'+e));
    for(const b of Object.keys(window.__FC.by_bu||{}))sel.add(new Option('BU '+b,'b:'+b));
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
  if(sc.blocked){blk.style.display='block';blk.textContent='⚠ Projection bloquée par le moteur pour ce périmètre : '+(sc.blocked.reason||JSON.stringify(sc.blocked));}
  else blk.style.display='none';
  /* cartes de méthodes : DSO/DPO OBSERVÉS GL du périmètre, provenance affichée (critère 3) */
  const m=window.__FC.methods||{},box=document.getElementById('fcmeth');
  const card=(t,b)=>'<div style="border:1px solid #2c2b30;border-radius:10px;padding:8px 12px;font-size:13px"><span class="mut" style="font-size:12px">'+t+'</span><br>'+b+'</div>';
  const src=s=>s==='gl_observed'?'observé GL':'repli';
  let cards='';
  const dm=kind==='e'?m.dso_by_entity:kind==='b'?m.dso_by_bu:null;
  const pm=kind==='e'?m.dpo_by_entity:kind==='b'?m.dpo_by_bu:null;
  if(dm&&dm[id])cards+=card('Créances','DSO '+dm[id].value+' j ('+src(dm[id].source)+', '+id+')');
  if(pm&&pm[id])cards+=card('Fournisseurs','DPO '+pm[id].value+' j ('+src(pm[id].source)+', '+id+')');
  if(kind==='g'){const es=Object.entries(m.dso_by_entity||{});
    if(es.length)cards+=card('Créances','DSO par entité : '+es.map(([e,x])=>e+' '+x.value+' j').join(' · '));
    const ps=Object.entries(m.dpo_by_entity||{});
    if(ps.length)cards+=card('Fournisseurs','DPO par entité : '+ps.map(([e,x])=>e+' '+x.value+' j').join(' · '));}
  const rows=sc.series||[];
  if(rows.length&&rows[0].impliedDSO!==undefined)cards+=card('Mécanique BFR','impliedDSO '+Math.round(rows[0].impliedDSO)+' j · impliedDPO '+(rows[0].impliedDPO!==undefined?Math.round(rows[0].impliedDPO)+' j':'—')+' (dérivés du GL du périmètre)');
  box.innerHTML=cards||card('Méthodes','Projection moteur (tendance + BFR) — détail dans K-Φ');
  /* projection sur le graphique principal : ventes projetées en gris (données moteur, jamais recalculées) */
  if(typeof S!=='undefined'&&typeof draw==='function'){
    if(CHD){CHD.destroy();CHD=null;}
    const labels=S.map(s=>s.period).concat(rows.map(x=>x.period));
    const rev=S.map(s=>s.revenue??null).concat(rows.map(()=>null));
    const proj=S.map(()=>null).concat(rows.map(x=>x.sales??null));
    if(CH)CH.destroy();
    CH=new Chart(document.getElementById('c'),{data:{labels,datasets:[
      {type:'bar',label:'CA réel',data:rev,backgroundColor:'#2a78d6',borderRadius:4,maxBarThickness:24},
      {type:'bar',label:'CA projeté ('+(kind==='g'?'global':id)+')',data:proj,backgroundColor:'rgba(137,135,129,0.45)',borderRadius:4,maxBarThickness:24},
      {type:'line',label:'EBITDA réel',data:S.map(s=>s.ebitda??null).concat(rows.map(()=>null)),borderColor:'#eb6834',borderWidth:2,pointRadius:0,tension:.3}
    ]},options:OPT});}
  /* drill : réel FY + projeté par entité, côte à côte (critère 4) */
  const dr=document.getElementById('fcdrill');
  if(dr.style.display!=='none'){
    const ents=Object.keys(window.__FC.by_entity||{});
    const projByEnt=ents.map(e=>(window.__FC.by_entity[e].series||[]).reduce((a,x)=>a+(x.sales||0),0));
    const dsoE=(window.__FC.methods||{}).dso_by_entity||{};
    const realByEnt=ents.map(e=>dsoE[e]&&dsoE[e].basis!==undefined?dsoE[e].basis:null);
    if(CHD)CHD.destroy();
    CHD=new Chart(document.getElementById('cd'),{type:'bar',data:{labels:ents,datasets:[
      {label:'CA réel (exercice)',data:realByEnt,backgroundColor:'#2a78d6',borderRadius:3},
      {label:'CA projeté (horizon)',data:projByEnt,backgroundColor:'rgba(137,135,129,0.5)',borderRadius:3},
    ]},options:{...FOPT,plugins:{legend:{labels:{color:'#b7b5af',boxWidth:10}}}}});}
}
</script>
</div></body></html>`;
}
