// Only a server-generated nonce and boolean enter this template. Runtime data uses textContent.
export function agentPage(nonce: string, loggedIn: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gateway agent test console</title><style nonce="${nonce}">
:root{font:16px/1.5 system-ui,sans-serif;color:#182b3a;background:#eef2f5}*{box-sizing:border-box}
body{max-width:960px;margin:auto;padding:24px}h1{font-size:1.7rem;margin-bottom:0}h2{font-size:1.15rem}
section{background:#fff;border:1px solid #b9c8d3;border-radius:6px;padding:20px;margin:20px 0}
label{display:block;font-weight:600;margin-top:12px}input,textarea,button{font:inherit;padding:9px;border:1px solid #718696;border-radius:4px}
textarea,input[type=password]{width:100%}button{background:#e7eff5;color:#182b3a;cursor:pointer;margin:5px 5px 5px 0}
button:disabled{opacity:.6;cursor:wait}:focus-visible{outline:3px solid #176ba0;outline-offset:2px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #b9c8d3;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto;font:14px/1.5 Consolas,monospace}
#message{min-height:1.5em;color:#8c251b}small{display:block}.scroll{overflow:auto}[hidden]{display:none!important}
@media(max-width:600px){body{padding:12px}section{padding:12px}th,td{padding:5px}}
</style></head><body><h1>Agent test console</h1><p>Experimental · model text tasks only</p>
<p id="message" role="status" aria-live="polite"></p>
<section id="login" ${loggedIn ? "hidden" : ""}><h2>Sign in</h2>
<form id="loginForm" method="post" action="/admin/agent/ui/login"><label for="adminKey">Admin key</label>
<input id="adminKey" name="adminKey" type="password" autocomplete="current-password" required maxlength="4096"><button>Sign in</button></form></section>
<main id="console" ${loggedIn ? "" : "hidden"}>
<button id="logout">Sign out</button><section><h2>Try a tiny text task</h2>
<form id="submitForm"><label for="goal">Goal</label><textarea id="goal" rows="3" maxlength="4000" required placeholder="Write one sentence about a tree."></textarea>
<button>Submit task</button><small>Tasks may use your configured model providers. Do not include secrets.</small></form></section>
<section><h2>Recent tasks</h2><button id="refresh">Refresh tasks and inbox</button><div class="scroll"><table><thead><tr><th>Job</th><th>Status</th><th>Actions</th></tr></thead><tbody id="jobs"></tbody></table></div><p id="emptyJobs">No tasks submitted in this server process.</p></section>
<section><h2>Untrusted output</h2><p>Logs and summaries are untrusted model output. Review as text.</p>
<label for="logJob">Delegate job ID</label><input id="logJob"><label for="fromSeq">From sequence</label><input id="fromSeq" type="number" min="0" value="0">
<label for="toSeq">To sequence (optional)</label><input id="toSeq" type="number" min="0"><button id="loadLog">Load log</button><pre id="output" tabindex="0">Select a child job to inspect its log.</pre></section>
<section><h2>Approval inbox</h2><div id="inbox"></div></section></main>
<script nonce="${nonce}">
'use strict';
const el=id=>document.getElementById(id);let csrf='';
function message(text){el('message').textContent=text;}
async function api(path,method='GET',body){
 const response=await fetch('/admin/agent/ui'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
 if(response.status===401){el('login').hidden=false;el('console').hidden=true;throw Error('Session expired. Sign in again.');}
 const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed');return data;
}
async function action(button,fn){button.disabled=true;message('Working…');try{await fn();message('');}catch(error){message(error.message);}finally{button.disabled=false;}}
function button(label,fn){const b=document.createElement('button');b.textContent=label;b.onclick=()=>action(b,fn);return b;}
function cell(row,text){const td=document.createElement('td');td.textContent=text;row.append(td);return td;}
function inspect(id){el('logJob').value=id;return loadLog();}
async function loadLog(){const id=el('logJob').value.trim();if(!id)throw Error('Enter a delegate job ID.');const q=new URLSearchParams({fromSeq:el('fromSeq').value||'0'});if(el('toSeq').value)q.set('toSeq',el('toSeq').value);el('output').textContent=JSON.stringify(await api('/api/jobs/'+encodeURIComponent(id)+'/log?'+q),null,2);}
async function refresh(){
 const [tasks,inbox]=await Promise.all([api('/api/jobs'),api('/api/inbox')]);el('jobs').replaceChildren();el('emptyJobs').hidden=tasks.jobs.length>0;
 for(const job of tasks.jobs){const row=document.createElement('tr');cell(row,job.jobId);cell(row,job.state);cell(row,'Coordinator');el('jobs').append(row);
  for(const child of job.children){const r=document.createElement('tr');cell(r,'Child '+child.jobId);cell(r,child.state);const controls=cell(r,'');
   controls.append(button('Log',()=>inspect(child.jobId)),button('Stop',async()=>{await api('/api/jobs/'+encodeURIComponent(child.jobId)+'/stop','POST');await refresh();}),button('Summarize',async()=>{el('output').textContent=JSON.stringify(await api('/api/jobs/'+encodeURIComponent(child.jobId)+'/summarize','POST'),null,2);}));el('jobs').append(r);}}
 el('inbox').replaceChildren();if(!inbox.items.length)el('inbox').textContent='No approval requests.';
 for(const item of inbox.items){const group=document.createElement('section');const text=document.createElement('pre');text.textContent=JSON.stringify(item,null,2);group.append(text);
  if(item.state==='pending')for(const decision of ['approve','deny'])group.append(button(decision==='approve'?'Approve':'Deny',async()=>{await api('/api/inbox/'+encodeURIComponent(item.id)+'/'+decision,'POST');await refresh();}));el('inbox').append(group);}
}
el('loginForm').onsubmit=e=>{e.preventDefault();const b=e.submitter;action(b,async()=>{
 const key=el('adminKey').value;el('adminKey').value='';const response=await fetch('/admin/agent/ui/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({adminKey:key})});
 if(!response.ok)throw Error(response.status===429?'Too many attempts. Try again in a minute.':'Sign in failed. Check the admin key.');location.reload();});};
el('submitForm').onsubmit=e=>{e.preventDefault();action(e.submitter,async()=>{await api('/api/submit','POST',{goal:el('goal').value});el('goal').value='';await refresh();});};
el('refresh').onclick=()=>action(el('refresh'),refresh);el('loadLog').onclick=()=>action(el('loadLog'),loadLog);
el('logout').onclick=()=>action(el('logout'),async()=>{await api('/logout','POST');location.reload();});
if(!el('console').hidden)action(el('refresh'),async()=>{csrf=(await api('/api/session')).csrfToken;await refresh();});
</script></body></html>`;
}
