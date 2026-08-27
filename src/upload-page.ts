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
body{margin:0;background:#141317;color:#e8e6e1;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#1b1a1e;border:1px solid #2c2b30;border-radius:14px;padding:28px;max-width:480px;width:92%}
h1{font-size:18px;margin:0 0 4px}.mut{color:#898781;font-size:13px}
.drop{margin:18px 0;border:2px dashed #2c2b30;border-radius:12px;padding:34px 16px;text-align:center;cursor:pointer;transition:border-color .15s}
.drop.on{border-color:#e8e03c;background:#1f1e18}.drop input{display:none}
.bar{height:8px;background:#2c2b30;border-radius:4px;overflow:hidden;display:none;margin-top:14px}
.bar b{display:block;height:8px;width:0;background:#e8e03c;transition:width .15s}
.steps{list-style:none;display:flex;gap:6px;padding:0;margin:16px 0 0;font-size:12px;flex-wrap:wrap}
.steps li{flex:1;min-width:120px;color:#65635e;border-top:2px solid #2c2b30;padding-top:7px}
.steps li b{display:inline-block;width:17px;height:17px;line-height:17px;text-align:center;border-radius:50%;background:#2c2b30;color:#898781;font-size:11px;margin-right:5px}
.steps li.cur{color:#e8e6e1;border-top-color:#e8e03c}.steps li.cur b{background:#e8e03c;color:#141317}
.steps li.done{color:#898781;border-top-color:#4a6b46}.steps li.done b{background:#4a6b46;color:#e8e6e1}
.ok{color:#1baf7a}.err{color:#d03b3b;white-space:pre-wrap}
.btn{margin-top:14px;width:100%;padding:11px;border:0;border-radius:10px;background:#e8e03c;color:#141317;font-size:15px;font-weight:600;cursor:pointer}
.btn:disabled{opacity:.5;cursor:default}
</style></head><body><div class="card">
<h1>K-Φ — Secure upload</h1>
<ol class="steps"><li id="s1" class="cur"><b>1</b> Select your export</li><li id="s2"><b>2</b> Send it to K-Φ</li><li id="s3"><b>3</b> Reply “done” in Claude</li></ol>
<div class="mut">General ledger, trial balance or FEC export — CSV/TSV, up to 500&nbsp;MB. Single-use link, valid 15&nbsp;minutes. The file goes straight to the K-Φ engine. <span lang="fr">· Export comptable, lien à usage unique (15&nbsp;min).</span></div>
<label class="drop" id="dz">📄 <span id="dzl">Click or drop your file here</span><input type="file" id="f"></label>
<button class="btn" id="go" disabled>Upload to K-Φ</button>
<div class="bar" id="bar"><b id="pct"></b></div>
<div id="msg" style="margin-top:14px;font-size:14px"></div>
</div><script>
(function(){
"use strict";
var f=document.getElementById('f'),dz=document.getElementById('dz'),go=document.getElementById('go'),
    msg=document.getElementById('msg'),bar=document.getElementById('bar'),pct=document.getElementById('pct'),
    dzl=document.getElementById('dzl'),file=null;
function step(n){['s1','s2','s3'].forEach(function(id,i){var e=document.getElementById(id);e.className=i+1<n?'done':(i+1===n?'cur':'');});}
function pick(x){file=x;if(!file)return;dzl.textContent=file.name+' — '+(file.size/1048576).toFixed(1)+' MB';go.disabled=false;msg.textContent='';step(2);}
f.addEventListener('change',function(){pick(f.files[0]);});
['dragover','dragenter'].forEach(function(e){dz.addEventListener(e,function(ev){ev.preventDefault();dz.classList.add('on');});});
['dragleave','drop'].forEach(function(e){dz.addEventListener(e,function(ev){ev.preventDefault();dz.classList.remove('on');});});
dz.addEventListener('drop',function(ev){if(ev.dataTransfer.files.length)pick(ev.dataTransfer.files[0]);});
go.addEventListener('click',function(){
  if(!file)return;go.disabled=true;bar.style.display='block';step(2);msg.textContent='';
  var x=new XMLHttpRequest();
  x.open('PUT',location.pathname);
  x.upload.onprogress=function(e){if(e.lengthComputable)pct.style.width=Math.round(100*e.loaded/e.total)+'%';};
  x.onload=function(){
    if(x.status===202||x.status===200){
      pct.style.width='100%';
      msg.innerHTML='<span class="ok">✅ File received — nothing else to do here, you can close this tab.</span><br><br><b>Next step:</b> switch back to your Claude conversation (the tab where you got this link) and simply reply <b>“done”</b>. Claude will fetch the analysis. <span class="mut" lang="fr">· Fichier reçu, vous pouvez fermer cet onglet. Retournez dans votre conversation Claude et répondez simplement «&nbsp;done&nbsp;» — l\\'analyse sera récupérée.</span>';
      dz.style.display='none';go.style.display='none';step(3);
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
