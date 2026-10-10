import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The fake executable uses a POSIX shebang. CI runs these checks on Linux.
const protocolTest = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn);

// Real bridge process with a fake app-server, offline and credential-free.
const fake = `#!/usr/bin/env node
const readline = require('node:readline');
const send = o => process.stdout.write(JSON.stringify(o)+'\\n');
const event = (method, params) => send({method,params});
const done = () => event('turn/completed',{threadId:'t',turn:{id:'u',status:'completed'}});
const call = (id='c1') => ({method:'item/tool/call',id:10,params:{callId:id,tool:'exec_command',arguments:{cmd:'echo complete'}}});
const scenario = process.env.FAKE_SCENARIO;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') { if(scenario==='alias') { process.stderr.write('MODEL:'+m.params.model+'\\n'); if(m.params.model==='codex-latest') { send({id:m.id,error:{message:'codex-latest not supported for ChatGPT account'}}); return; } } send({id:m.id,result:{thread:{id:'t'}}}); }
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'u'}}});
  setTimeout(()=>{
   if(scenario==='alias') { event('item/completed',{threadId:'t',turnId:'u',item:{type:'agentMessage',text:'alias fixture answer'}});done(); }
   if(scenario==='idle'||scenario==='cancel') { if(scenario==='idle') send(call()); }
   if(scenario==='multiple') {send(call());setTimeout(()=>send(call('c2')),500);}
   if(scenario==='partial'||scenario==='partial-second') {if(scenario==='partial-second') send(call());const s=JSON.stringify(call(scenario==='partial-second'?'c2':'c1'))+'\\n';process.stdout.write(s.slice(0,60));setTimeout(()=>process.stdout.write(s.slice(60)),2500);}
   if(scenario==='raw') event('rawResponseItem/completed',{threadId:'t',turnId:'u',item:{type:'function_call',call_id:'c1',name:'exec_command',arguments:'{"cmd":"echo complete"}'}});
   if(scenario==='text') setTimeout(()=>{event('item/completed',{threadId:'t',turnId:'u',item:{type:'agentMessage',text:'complete answer'}});done();},2500);
   if(scenario==='error') {event('error',{turnId:'u',willRetry:false,error:{message:'synthetic provider failure'}});event('turn/completed',{threadId:'t',turn:{id:'u',status:'failed'}});}
   if(scenario==='incomplete') {process.stdout.write('{"method":"item/tool/call","params":');setTimeout(()=>process.exit(0),100);}
  },30);
 }
});
process.stdin.on('end',()=>process.exit(0));
`;

async function run(scenario, stream = false, metadata) {
 const dir=mkdtempSync(join(tmpdir(),'bridge-preflight-'));
 const cli=join(dir,'fake-codex');
 writeFileSync(cli,fake,{mode:0o700});
 const started=Date.now();
 const child=spawn(process.execPath,[resolve(process.env.BRIDGE_TEST_PATH || 'dist/scripts/codex-appserver-bridge.js'),scenario==='alias'?'codex-latest':'offline-test-model'],{
  detached:true,env:{PATH:process.env.PATH,HOME:dir,CODEX_EXECUTABLE:cli,FAKE_SCENARIO:scenario,CODEX_APPSERVER_TIMEOUT_MS:'6500'},stdio:['pipe','pipe','pipe']
 });
 let stdout='',stderr='';
 child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const killGroup=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
 const safety=setTimeout(killGroup,9000);
 let cancelError;
 const cancel=scenario==='cancel'?setTimeout(()=>{try{if(!child.kill('SIGTERM')) cancelError='signal-not-delivered';}catch(e){cancelError=e.code;}},500):null;
 child.stdin.end(JSON.stringify({requestKind:'responses',metadata,messages:[{role:'user',content:'offline protocol test'}],tools:scenario==='text'?[]:[{type:'function',function:{name:'exec_command',parameters:{type:'object'}}}],stream}));
 try {
  const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
  return {...result,stdout,stderr,cancelError,elapsed:Date.now()-started};
 } finally {clearTimeout(safety);clearTimeout(cancel);killGroup();rmSync(dir,{recursive:true,force:true});}
}

for(const scenario of ['idle','raw','multiple','partial','partial-second']) protocolTest(scenario+' returns complete delegated calls before overall deadline', async()=>{
 const r=await run(scenario);assert.equal(r.code,0,r.stderr);assert.ok(r.elapsed<6200,String(r.elapsed));
 const body=JSON.parse(r.stdout);assert.equal(body.finish_reason,'tool_calls');
 assert.equal(body.tool_calls.length,scenario==='multiple'||scenario==='partial-second'?2:1);
 for(const c of body.tool_calls) assert.deepEqual(JSON.parse(c.arguments),{cmd:'echo complete'});
 if(scenario==='partial') assert.ok(r.elapsed>=2500,'must wait for complete JSON-RPC line');
});
protocolTest('no-tool streaming response waits for late complete text',async()=>{
 const r=await run('text',true);assert.equal(r.code,0,r.stderr);assert.ok(r.elapsed>=2500);
 const events=r.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(events.at(-1).type,'done');assert.equal(events.at(-1).output_text,'complete answer');assert.equal(events.at(-1).finish_reason,'stop');
});
protocolTest('streaming tool response emits complete call and done',async()=>{
 const r=await run('idle',true);assert.equal(r.code,0,r.stderr);
 const events=r.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(e=>e.type==='tool_call').length,1);assert.equal(events.at(-1).finish_reason,'tool_calls');
 assert.deepEqual(JSON.parse(events.find(e=>e.type==='tool_call').tool_call.arguments),{cmd:'echo complete'});
});
protocolTest('provider failure exits nonzero without success output',async()=>{
 const r=await run('error');assert.equal(r.code,1);assert.match(r.stderr,/synthetic provider failure/);assert.equal(r.stdout,'');
});
protocolTest('incomplete RPC line never becomes a tool call',async()=>{
 const r=await run('incomplete');assert.doesNotMatch(r.stdout,/"tool_calls"\s*:/);
});
protocolTest('bridge process cancellation yields no completed response',async()=>{
 const r=await run('cancel');assert.equal(r.cancelError,undefined,'child signal must succeed');assert.equal(r.signal,'SIGTERM');assert.equal(r.stdout,'');assert.ok(r.elapsed<2000);
});

protocolTest('bounded policies disable hidden Codex alias fallback; unbounded compatibility remains',async()=>{
 for(const allowFallback of [false,true]) { const r=await run('alias',false,{gateway_policy:{operationId:'alias-fixture',allowFallback,maxAttempts:2,maxLatencyMs:5000}});assert.equal(r.code,1);assert.equal((r.stderr.match(/MODEL:/g)||[]).length,1);assert.equal(r.stdout,''); }
 const legacy=await run('alias');assert.equal(legacy.code,0,legacy.stderr);assert.match(JSON.parse(legacy.stdout).output_text,/alias fixture answer/);
});
