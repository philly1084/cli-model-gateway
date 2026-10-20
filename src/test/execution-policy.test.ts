import Fastify from "fastify";
import { openAiRoutes } from "../routes/openai";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible-provider";
import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionPolicy, type ExecutionReceipt } from "../utils/execution-policy";
import { ProviderRegistry } from "../providers/registry";
import { controlledCommand } from "../utils/controlled-command";
import type { UnifiedRequest } from "../types";
import { Writable } from "node:stream";
import { installRequestCompletionLogging } from "../utils/request-completion.js";
const policy = { operationId: "offline-policy-test", allowFallback: false, maxAttempts: 1, maxLatencyMs: 1000 };
async function fixture() {
  const registry = await ProviderRegistry.create([{id:"fixture",type:"cli",models:[{id:"chosen",fallbackModels:["fallback"]},{id:"fallback"}],responseCommand:{executable:process.execPath,args:[],timeoutMs:1000,input:"request_json_stdin",output:"json_contract"}}]);
  const provider = registry.getProvider("fixture")!;
  const receipts: ExecutionReceipt[] = [];
  const request = { requestId: "request-fixture", messages:[{role:"user" as const,content:"synthetic only"}], tools:[],metadata:{gateway_policy:policy},receipt:(value:ExecutionReceipt)=>receipts.push(value) };
  return {registry,provider,receipts,request};
}

async function streamFixture() {
  const f = await fixture();
  const logs: Record<string, any>[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) {
    logs.push(JSON.parse(String(chunk)));
    done();
  } });
  const app = Fastify({ disableRequestLogging: true, logger: { level: "info", stream: sink } });
  installRequestCompletionLogging(app);
  await app.register(openAiRoutes, { registry: f.registry, n8nApiKeys: new Set(["fixture-key"]) });
  f.provider.supportsStreaming = () => true;
  const payload = { model: "chosen", stream: true, gateway_policy: policy, messages: f.request.messages };
  const inject = () => app.inject({ method: "POST", url: "/chat/completions", headers: { authorization: "Bearer fixture-key" }, payload });
  return { ...f, app, logs, payload, inject };
}

for (const partial of [false, true]) {
  for (const failure of ["throw", "terminal_failure", "missing_terminal", "deadline"] as const) {
    test(`HTTP stream ${failure} logs failure and ends with an SSE error (partial=${partial})`, async () => {
      const f = await streamFixture();
      f.provider.runStream = async function* (request) {
        request.execution?.dispatch();
        if (partial) yield { type: "output_text_delta", delta: "partial text" };
        if (failure === "throw") throw Error("synthetic provider failure");
        if (failure === "terminal_failure") yield { type: "done", finishReason: "error" };
        if (failure === "deadline") await new Promise(resolve => setTimeout(resolve, 60));
      };
      if (failure === "deadline") f.payload.gateway_policy = { ...policy, maxLatencyMs: 30 };
      try {
        const response = await f.inject();
        assert.equal(response.statusCode, 200);
        assert.doesNotMatch(response.body, /\[DONE\]/);
        const events = response.body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
        assert.deepEqual(events.at(-1), { error: {
          message: "Upstream stream failed.", type: "upstream_stream_failed", code: "upstream_stream_failed",
        } });
        const completions = f.logs.filter(log => log.msg === "request completed");
        assert.equal(completions.length, 1);
        const log = completions[0]!;
        assert.equal(log.level, 50);
        assert.equal(log.outcome, "stream_failed");
        assert.equal(log.httpStatus, 200);
        assert.equal(log.errorType, failure === "deadline" ? "deadline_exceeded" : "upstream_stream_failed");
        assert.equal(log.stage, partial ? "mid_stream" : "before_first_token");
        assert.equal(log.bytesSent, Buffer.byteLength(response.body));
        assert.ok(log.latencyMs >= 0);
        assert.equal(log.requestedModel, "chosen");
        assert.equal(log.selectedModel, "chosen");
      } finally { await f.app.close(); }
    });
  }
}

test("successful HTTP stream logs ok and retains DONE", async () => {
  const f = await streamFixture();
  f.provider.runStream = async function* () {
    yield { type: "output_text_delta", delta: "complete" };
    yield { type: "done", finishReason: "stop" };
  };
  try {
    const response = await f.inject();
    assert.match(response.body, /data: \[DONE\]\n\n$/);
    const completions = f.logs.filter(log => log.msg === "request completed");
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.outcome, "ok");
    assert.equal(completions[0]!.level, 30);
    assert.equal(completions[0]!.bytesSent, Buffer.byteLength(response.body));
    assert.equal(completions[0]!.errorType, undefined);
  } finally { await f.app.close(); }
});

for (const fail of [false, true]) test(`real HTTP stream closes with the correct outcome (fail=${fail})`, async () => {
  const f = await streamFixture();
  f.provider.runStream = async function* () {
    yield { type: "output_text_delta", delta: "partial" };
    if (fail) throw Error("synthetic provider failure");
    yield { type: "done", finishReason: "stop" };
  };
  try {
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const address = f.app.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer fixture-key", "content-type": "application/json", connection: "close" },
      body: JSON.stringify(f.payload), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    if (fail) {
      assert.match(body, /"type":"upstream_stream_failed"/);
      assert.doesNotMatch(body, /\[DONE\]|synthetic provider failure/);
    } else assert.match(body, /data: \[DONE\]\n\n$/);
    const completions = f.logs.filter(log => log.msg === "request completed");
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.outcome, fail ? "stream_failed" : "ok");
    assert.equal(completions[0]!.level, fail ? 50 : 30);
    assert.equal(completions[0]!.bytesSent, Buffer.byteLength(body));
  } finally { await f.app.close(); }
});

test("HTTP stream disconnect logs cancellation once and aborts the provider", async () => {
  const f = await streamFixture();
  let aborted = false;
  f.provider.runStream = async function* (request) {
    request.execution?.dispatch();
    yield { type: "output_text_delta", delta: "partial" };
    await new Promise<void>(resolve => {
      const cancel = () => { aborted = true; resolve(); };
      request.signal!.addEventListener("abort", cancel, { once: true });
      if (request.signal!.aborted) cancel();
    });
  };
  try {
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const address = f.app.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer fixture-key", "content-type": "application/json" }, body: JSON.stringify(f.payload),
    });
    const reader = response.body!.getReader();
    while (true) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      if (new TextDecoder().decode(value).includes("partial")) break;
    }
    await reader.cancel();
    for (let i = 0; i < 100 && (!aborted || !f.logs.some(log => log.outcome === "stream_failed")); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(aborted, true);
    const completions = f.logs.filter(log => log.msg === "request completed");
    assert.equal(completions.length, 1);
    assert.equal(completions[0]!.level, 50);
    assert.equal(completions[0]!.errorType, "cancelled");
    assert.equal(completions[0]!.stage, "mid_stream");
    assert.equal(completions[0]!.httpStatus, 200);
    assert.ok(completions[0]!.bytesSent > 0);
  } finally { await f.app.close(); }
});
test("no-fallback and maxAttempts suppress configured substitutions; explicit model remains selected",async()=>{
 for(const p of [{...policy},{...policy,allowFallback:true,maxAttempts:1}]){const f=await fixture(),seen:string[]=[];f.provider.run=async r=>{seen.push(r.model);throw Error("fixture failure");};await assert.rejects(f.registry.runModel("chosen",{...f.request,metadata:{gateway_policy:p}}));assert.deepEqual(seen,["chosen"]);assert.equal(f.receipts.filter(x=>x.type==="gateway.execution.terminal").length,1);}
 const f=await fixture(),seen:string[]=[];f.provider.run=async r=>{seen.push(r.model);if(r.model==="chosen")throw Error("known fixture failure");return {outputText:"ok",toolCalls:[],finishReason:"stop"};};assert.equal((await f.registry.runModel("chosen",{...f.request,metadata:{gateway_policy:{...policy,allowFallback:true,maxAttempts:2}}})).resolvedModel,"fallback");assert.deepEqual(seen,["chosen","fallback"]);
});
test("arrival-based budget includes queue/startup time and prevents an already-expired dispatch",async()=>{
 const f=await fixture();let calls=0;f.provider.run=async()=>{calls++;return {outputText:"unexpected",toolCalls:[],finishReason:"stop"};};await assert.rejects(f.registry.runModel("chosen",{...f.request,receivedAt:Date.now()-2000}));assert.equal(calls,0);assert.equal(f.receipts[0]?.status,"deadline_exceeded");assert.equal(f.receipts.find(x=>x.type==="gateway.execution.terminal")?.providerOutcome,"not_started");
 let now=100;const e=new ExecutionPolicy({requestId:"x",model:"chosen",metadata:{gateway_policy:{...policy,maxLatencyMs:100}},receivedAt:50,clock:()=>now});try{now=151;assert.throws(()=>e.attempt());}finally{e.finish(false);}
});
test("uncooperative late provider remains uncertain, gets no retry and cannot emit a second terminal receipt",async()=>{
 const f=await fixture();let resolve!: (value:{outputText:string;toolCalls:[];finishReason:"stop"})=>void,calls=0;
 f.provider.run=async r=>{calls++;r.execution?.dispatch();return new Promise(done=>{resolve=done;});};
 await assert.rejects(f.registry.runModel("chosen",{...f.request,metadata:{gateway_policy:{...policy,allowFallback:true,maxAttempts:2,maxLatencyMs:30}}}));assert.equal(calls,1);assert.equal(f.receipts.find(x=>x.type==="gateway.execution.terminal")?.providerOutcome,"unknown");assert.equal(f.receipts.find(x=>x.type==="gateway.execution.terminal")?.replaySafe,false);resolve({outputText:"late",toolCalls:[],finishReason:"stop"});await new Promise(r=>setImmediate(r));assert.equal(f.receipts.filter(x=>x.type==="gateway.execution.terminal").length,1);
});
test("cancel before execution has zero attempts and invalid policy is rejected",async()=>{
 const f=await fixture(),controller=new AbortController();controller.abort();let calls=0;f.provider.run=async()=>{calls++;throw Error("must not run");};await assert.rejects(f.registry.runModel("chosen",{...f.request,signal:controller.signal}));assert.equal(calls,0);assert.equal(f.receipts[0]?.attempts,0);await assert.rejects(f.registry.runModel("chosen",{...f.request,metadata:{gateway_policy:{...policy,maxAttempts:0}}}));
});
test("stream completion requires terminal evidence; stream cancellation signals provider",async()=>{
 const f=await fixture();f.provider.supportsStreaming=()=>true;f.provider.runStream=async function*(r:UnifiedRequest){r.execution?.dispatch();yield {type:"output_text_delta",delta:"partial"};};await assert.rejects(async()=>{for await(const _ of f.registry.runModelStream("chosen",f.request)){void _;}});assert.equal(f.receipts.find(x=>x.type==="gateway.execution.terminal")?.providerOutcome,"unknown");
});
test("actual controlled fixture process stops on cancellation and records only local cleanup evidence",async()=>{
 const controller=new AbortController();let cleanup:boolean|undefined,ready=false;
 await assert.rejects(async()=>{for await(const event of controlledCommand({executable:process.execPath,args:["-e","process.stdout.write('READY');setInterval(()=>{},1000)"],timeoutMs:5000},undefined,controller.signal,value=>{cleanup=value;})){if(event.chunk.includes("READY")){ready=true;controller.abort();}}},/uncertain/);
 assert.equal(ready,true);assert.equal(cleanup,process.platform!=="win32");
});
test("controlled request budget expires during CLI startup and cannot fall back",async()=>{
 const registry=await ProviderRegistry.create([{id:"fixture",type:"cli",models:[{id:"chosen",fallbackModels:["fallback"]},{id:"fallback"}],responseCommand:{executable:process.execPath,args:["-e","setTimeout(()=>process.stdout.write(JSON.stringify({output_text:'too late'})),3000)"],timeoutMs:600000,input:"request_json_stdin",output:"json_contract"}}]);const receipts:ExecutionReceipt[]=[];
 await assert.rejects(registry.runModel("chosen",{requestId:"startup-fixture",messages:[{role:"user",content:"fixture"}],tools:[],metadata:{gateway_policy:{...policy,maxLatencyMs:80}},receipt:r=>receipts.push(r)}));assert.equal(receipts.find(x=>x.type==="gateway.execution.terminal")?.attempts,1);assert.equal(receipts.find(x=>x.type==="gateway.execution.terminal")?.status,"deadline_exceeded");await new Promise(r=>setTimeout(r,100));
});

for (const endpoint of ["/chat/completions", "/responses"]) test(`real ${endpoint} buffered HTTP disconnect reaches provider and keeps auth/policy rejection`,async()=>{
 const f=await fixture(),app=Fastify();await app.register(openAiRoutes,{registry:f.registry,n8nApiKeys:new Set(["fixture-key"])});let started!:()=>void;const begun=new Promise<void>(resolve=>{started=resolve;});let aborted=false,calls=0;
 f.provider.run=async request=>{calls++;request.execution?.dispatch();started();await new Promise<void>(resolve=>{request.signal!.addEventListener("abort",()=>{aborted=true;resolve();},{once:true});});throw Error("fixture stopped");};
 try{await app.listen({host:"127.0.0.1",port:0});const addr=app.server.address();assert.ok(addr&&typeof addr!=="string");const url=`http://127.0.0.1:${addr.port}${endpoint}`,body={model:"chosen",stream:false,gateway_policy:policy,...(endpoint==="/responses"?{input:"synthetic"}:{messages:[{role:"user",content:"synthetic"}]})};
 assert.equal((await app.inject({method:"POST",url:endpoint,payload:body})).statusCode,401);assert.equal((await app.inject({method:"POST",url:endpoint,headers:{authorization:"Bearer fixture-key"},payload:{...body,gateway_policy:{...policy,maxAttempts:0}}})).statusCode,400);assert.equal(calls,0);
 const controller=new AbortController();const pending=fetch(url,{method:"POST",headers:{authorization:"Bearer fixture-key","content-type":"application/json"},body:JSON.stringify(body),signal:controller.signal});await begun;controller.abort();await assert.rejects(pending);for(let n=0;n<100&&!aborted;n++)await new Promise(r=>setTimeout(r,5));assert.equal(aborted,true);assert.equal(calls,1);
 }finally{await app.close();}
});
test("buffered OpenAI fetch receives cancellation; provider request does not contain internal execution objects",async()=>{
 const previous=globalThis.fetch,old=process.env.FIXTURE_POLICY_KEY;process.env.FIXTURE_POLICY_KEY="fixture-key";
 try{let started!:()=>void;const begun=new Promise<void>(r=>{started=r;});let cancelled=false;globalThis.fetch=(async(_url,init)=>{assert.ok(!String(init?.body).includes("execution"));started();return new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener("abort",()=>{cancelled=true;reject(Error("fixture fetch aborted"));},{once:true});});}) as typeof fetch;
 const provider=await OpenAiCompatibleProvider.create({id:"http-fixture",type:"openai",baseUrl:"https://fixture.invalid/v1",apiKeyEnv:"FIXTURE_POLICY_KEY",models:[{id:"chosen"}],timeoutMs:600000});const controller=new AbortController();const task=provider.run({requestId:"http-fixture",model:"chosen",providerModel:"chosen",messages:[{role:"user",content:"synthetic"}],tools:[],signal:controller.signal});await begun;controller.abort();await assert.rejects(task);assert.equal(cancelled,true);
 }finally{globalThis.fetch=previous;if(old===undefined)delete process.env.FIXTURE_POLICY_KEY;else process.env.FIXTURE_POLICY_KEY=old;}
});

test("uncertain HTTP transport failure suppresses fallback even when a bounded fallback was allowed",async()=>{
 const previous=globalThis.fetch,old=process.env.FIXTURE_POLICY_KEY;process.env.FIXTURE_POLICY_KEY="fixture-key";let calls=0;
 try{globalThis.fetch=(async()=>{calls++;throw TypeError("fixture connection lost after dispatch");}) as typeof fetch;
 const registry=await ProviderRegistry.create([{id:"http-fixture",type:"openai",baseUrl:"https://fixture.invalid/v1",apiKeyEnv:"FIXTURE_POLICY_KEY",discovery:{enabled:false},models:[{id:"chosen",fallbackModels:["fallback"]},{id:"fallback"}],timeoutMs:600000}]);const receipts:ExecutionReceipt[]=[];
 await assert.rejects(registry.runModel("chosen",{requestId:"uncertain-http",messages:[{role:"user",content:"synthetic"}],tools:[],metadata:{gateway_policy:{...policy,allowFallback:true,maxAttempts:2}},receipt:r=>receipts.push(r)}));assert.equal(calls,1);assert.equal(receipts.find(r=>r.type==="gateway.execution.terminal")?.providerOutcome,"unknown");assert.equal(receipts.find(r=>r.type==="gateway.execution.terminal")?.attempts,1);
 }finally{globalThis.fetch=previous;if(old===undefined)delete process.env.FIXTURE_POLICY_KEY;else process.env.FIXTURE_POLICY_KEY=old;}
});
