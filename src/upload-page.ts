/**
 * Page d'upload servie sur GET /upload/:token — le lien est envoyé à des
 * HUMAINS par les relais ("drop your file there") ; un clic navigateur fait
 * un GET, qui répondait « Cannot GET » (capture fondateur 2026-08-27).
 *
 * Contrats :
 * - le token à usage unique n'est PAS consommé ici (seul le PUT le consomme) ;
 * - le token n'est JAMAIS injecté dans le HTML (le script lit
 *   location.pathname) : zéro surface XSS, la page est un template constant ;
 * - l'upload utilise XMLHttpRequest pour la barre de progression (fetch n'a
 *   pas de progression d'envoi) ; les erreurs serveur (410 lien expiré,
 *   501 stockage absent, 4xx) sont affichées telles quelles.
 */
export function uploadPageHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>K-Φ — Secure upload</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#141317;color:#e8e6e1;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:40px 28px 64px}
header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;border-bottom:1px solid #2c2b30;padding-bottom:18px}
h1{font-size:30px;margin:0;letter-spacing:-.5px}
.sub{color:#898781;font-size:15px}
.steps{list-style:none;display:flex;gap:10px;padding:0;margin:22px 0 0;font-size:14px;flex-wrap:wrap}
.steps li{flex:1 1 210px;display:flex;align-items:center;color:#65635e;border-top:3px solid #2c2b30;padding-top:10px;min-height:38px}
.steps li b{flex:none;display:inline-block;width:21px;height:21px;line-height:21px;text-align:center;border-radius:50%;background:#2c2b30;color:#898781;font-size:12px;margin-right:7px}
.steps li.cur{color:#e8e6e1;border-top-color:#e8e03c}.steps li.cur b{background:#e8e03c;color:#141317}
.steps li.done{color:#898781;border-top-color:#4a6b46}.steps li.done b{background:#4a6b46;color:#e8e6e1}
.cols{display:grid;grid-template-columns:1.55fr 1fr;gap:26px;margin-top:26px}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
.drop{display:block;width:100%;border:2px dashed #2c2b30;border-radius:16px;padding:72px 24px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s;background:#18171b}
.drop:hover{border-color:#4a4941}.drop.on{border-color:#e8e03c;background:#1f1e18}
.drop .ic{font-size:52px;display:block;margin-bottom:12px;line-height:1}
.drop .big{display:block;font-size:20px;font-weight:600}
.drop .mut{display:block;color:#898781;font-size:14px;margin-top:8px}
.drop input{display:none}
.panel{background:#18171b;border:1px solid #2c2b30;border-radius:16px;padding:22px}
.panel h2{font-size:14px;text-transform:uppercase;letter-spacing:.9px;color:#898781;margin:0 0 12px}
.panel ul{margin:0 0 18px;padding-left:18px}.panel li{margin-bottom:7px;font-size:14.5px}
.k{color:#e8e03c}
.bar{height:12px;background:#2c2b30;border-radius:6px;overflow:hidden;display:none;margin-top:22px}
.bar b{display:block;height:12px;width:0;background:#e8e03c;transition:width .15s}
.btn{margin-top:22px;width:100%;padding:17px;border:0;border-radius:12px;background:#e8e03c;color:#141317;font-size:17px;font-weight:700;cursor:pointer}
.btn:disabled{opacity:.35;cursor:default}
.ok{color:#1baf7a;font-weight:600}
/* Attente : barre indéterminée + étapes réelles. Pas de fausse progression
   en pourcentage — le serveur ne renvoie pas d'avancement, inventer une
   jauge qui monte serait mentir sur ce qu'on sait. */
.ind{height:8px;background:#2c2b30;border-radius:4px;overflow:hidden;margin:16px 0 12px;position:relative}
.ind:after{content:"";position:absolute;left:-40%;width:40%;height:100%;background:#e8e03c;border-radius:4px;animation:sl 1.15s ease-in-out infinite}
@keyframes sl{0%{left:-40%}100%{left:100%}}
.spin{display:inline-block;width:15px;height:15px;border:2px solid #2c2b30;border-top-color:#e8e03c;border-radius:50%;animation:rot .8s linear infinite;vertical-align:-3px;margin-right:8px}
@keyframes rot{to{transform:rotate(360deg)}}
.phase{color:#898781;font-size:14px;margin-top:2px}
.phase b{color:#e8e6e1;font-weight:500}
@media(prefers-reduced-motion:reduce){.ind:after,.spin{animation:none}.ind:after{left:0;width:100%;opacity:.4}}.err{color:#d03b3b}
#msg{margin-top:22px;font-size:16px}
.done-box{background:#18171b;border:1px solid #4a6b46;border-radius:16px;padding:26px;margin-top:22px}
.done-box .h{font-size:20px;margin-bottom:10px}
kbd{background:#2c2b30;border-radius:5px;padding:2px 8px;font-family:ui-monospace,monospace;font-size:14px}
</style></head><body><div class="wrap">
<header><h1>K-Φ — Secure upload</h1><span class="sub">Single-use link · valid 15 minutes · the file goes straight to the K-Φ engine, not through Claude</span></header>
<ol class="steps"><li id="s1" class="cur"><b>1</b> Select your export</li><li id="s2"><b>2</b> Send it to K-Φ</li><li id="s3"><b>3</b> Open your dashboard — or reply “done” in Claude</li></ol>
<div class="cols">
<div style="min-width:0;display:flex;flex-direction:column">
<label class="drop" id="dz"><span class="ic">📄</span><span class="big" id="dzl">Drop your ledger export here</span><span class="mut">or click to browse — up to 500 MB</span><input type="file" id="f"></label>
<button class="btn" id="go" disabled>Send to K-Φ</button>
<div class="bar" id="bar"><b id="pct"></b></div>
<div id="msg"></div>
</div>
<aside class="panel">
<h2>What to send</h2>
<ul>
<li><span class="k">General ledger</span>, trial balance or FEC export</li>
<li>CSV or TSV — from <span class="k">SAP, Sage, Cegid, QuickBooks, Xero, Odoo, Pennylane, Netsuite…</span></li>
<li>Raw export is best: <b>no manual cleanup needed</b>, K-Φ detects the columns itself</li>
<li>All entities and all months in one file — per-entity views stay in local currency</li>
</ul>
<h2>What K-Φ returns</h2>
<ul>
<li>Financial statements + <span class="k">30 KPIs</span> (EBITDA, margins, DSO/DPO/DIO, liquidity, leverage)</li>
<li>Bank <span class="k">covenants</span> tested against your thresholds</li>
<li>A <span class="k">forecast</span> per entity or BU, using the DSO/DPO observed in your own ledger</li>
<li>An interactive dashboard, valid 24 h — <b>it opens right here</b> as soon as the analysis is ready</li>
</ul>
<h2>Useful to mention in the chat</h2>
<ul>
<li>Your covenant thresholds, if any (DSCR, net debt/EBITDA, gearing)</li>
<li>Your period-end date, if it isn't obvious from the file</li>
</ul>
<div class="sub" lang="fr" style="font-size:13px;border-top:1px solid #2c2b30;padding-top:12px">Export comptable brut (grand livre, balance, FEC) — CSV/TSV, jusqu'à 500 Mo. Aucun nettoyage préalable : K-Φ détecte les colonnes. Lien à usage unique, 15 min.</div>
</aside>
</div></div>
<script>
(function(){
"use strict";
var f=document.getElementById('f'),dz=document.getElementById('dz'),go=document.getElementById('go'),
    msg=document.getElementById('msg'),bar=document.getElementById('bar'),pct=document.getElementById('pct'),
    dzl=document.getElementById('dzl'),file=null;
function step(n){['s1','s2','s3'].forEach(function(id,i){var e=document.getElementById(id);e.className=i+1<n?'done':(i+1===n?'cur':'');});}
function pick(x){file=x;if(!file)return;dzl.textContent=file.name;
  dz.querySelector('.mut').textContent=(file.size/1048576).toFixed(1)+' MB — ready to send';
  go.disabled=false;msg.textContent='';step(2);}
f.addEventListener('change',function(){pick(f.files[0]);});
['dragover','dragenter'].forEach(function(e){dz.addEventListener(e,function(ev){ev.preventDefault();dz.classList.add('on');});});
['dragleave','drop'].forEach(function(e){dz.addEventListener(e,function(ev){ev.preventDefault();dz.classList.remove('on');});});
dz.addEventListener('drop',function(ev){if(ev.dataTransfer.files.length)pick(ev.dataTransfer.files[0]);});
go.addEventListener('click',function(){
  if(!file)return;go.disabled=true;bar.style.display='block';msg.textContent='';step(2);
  var x=new XMLHttpRequest();
  x.open('PUT',location.pathname);
  x.upload.onprogress=function(e){if(e.lengthComputable)pct.style.width=Math.round(100*e.loaded/e.total)+'%';};
  x.onload=function(){
    if(x.status===202||x.status===200){
      pct.style.width='100%';step(3);
      dz.style.display='none';go.style.display='none';bar.style.display='none';
      var id='';try{id=JSON.parse(x.responseText).analysis_id||'';}catch(_){}
      msg.innerHTML='<div class="done-box" id="db"><div class="h"><span class="ok">✅ File received by K-Φ.</span></div>'+
        '<div id="wait"><div class="ind"></div>'+
        '<div><span class="spin"></span><b id="ph">Reading and mapping your columns…</b></div>'+
        '<div class="phase" id="phsub">Large exports take a little longer — this page updates by itself. '+
        '<span lang="fr">Cette page se met à jour toute seule.</span></div></div></div>';
      /* Étapes réelles du moteur, dans l'ordre où elles se produisent : le
         texte suit le temps écoulé, il ne prétend pas connaître un
         pourcentage que le serveur ne fournit pas. */
      var PH=[[0,'Reading and mapping your columns…'],[4,'Classifying accounts and building statements…'],
              [10,'Computing KPIs and covenants…'],[18,'Projecting cash flows per entity…'],
              [30,'Almost there — finalising your dashboard…']];
      var t0=Date.now();
      var phTimer=setInterval(function(){
        var el=document.getElementById('ph');if(!el){clearInterval(phTimer);return;}
        var s=(Date.now()-t0)/1000,lab=PH[0][1];
        for(var i=0;i<PH.length;i++)if(s>=PH[i][0])lab=PH[i][1];
        el.textContent=lab;
      },1000);
      /* On ne renvoie plus l'utilisateur au chat pour SAVOIR : la page suit
         l'analyse et ouvre le dashboard dès qu'il existe. Le retour au chat
         sert alors à ramener les chiffres dans la conversation, pas à
         attendre. (Demande fondateur : « quel avantage… c'est pénible ».) */
      if(id){
        var tries=0;
        var poll=setInterval(function(){
          tries++;
          fetch('/a/'+id+'/status').then(function(r){return r.json();}).then(function(j){
            if(j.status==='ready'){
              clearInterval(poll);clearInterval(phTimer);
              document.getElementById('wait').innerHTML=
                '<b>Your dashboard is ready.</b><br><br>'+
                '<a class="btn" style="display:block;text-align:center;text-decoration:none;padding:15px" href="/a/'+id+'">Open the K-Φ dashboard →</a>'+
                '<div style="margin-top:16px">To bring the figures back into your conversation, reply <kbd>done</kbd> in Claude.</div>'+
                '<div class="sub" lang="fr" style="margin-top:12px">Tableau de bord prêt. Pour ramener les chiffres dans la conversation, répondez <kbd>done</kbd> dans Claude.</div>';
            } else if(j.status==='error'||tries>40){
              clearInterval(poll);clearInterval(phTimer);
              document.getElementById('wait').innerHTML=
                'Upload complete. Reply <kbd>done</kbd> in your Claude conversation to get the analysis.'+
                '<div class="sub" lang="fr" style="margin-top:10px">Fichier reçu : répondez <kbd>done</kbd> dans Claude.</div>';
            }
          }).catch(function(){});
        },3000);
      } else {
        document.getElementById('wait').innerHTML='Reply <kbd>done</kbd> in your Claude conversation to get the analysis.';
      }
    }else{
      var e;try{e=JSON.parse(x.responseText).error;}catch(_){e=x.status+' '+x.statusText;}
      msg.innerHTML='<span class="err">⚠ '+String(e).replace(/[<>&]/g,function(c){return{'<':'&lt;','>':'&gt;','&':'&amp;'}[c];})+'</span>';
      go.disabled=false;
    }
  };
  x.onerror=function(){msg.innerHTML='<span class="err">⚠ Network error — try again.</span>';go.disabled=false;};
  x.send(file);
});
})();
</script></body></html>`;
}
