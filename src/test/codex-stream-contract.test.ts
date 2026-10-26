import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProviderRegistry } from "../providers/registry.js";
import { openAiRoutes } from "../routes/openai.js";

const markdown = "ZZTEST bench build completed; validation passed.\n\n[Preview](/api/3d/agent-builds/zz/v1/preview.png)";
const tools = [{ type: "function" as const, function: { name: "ZZTEST", parameters: { type: "object", properties: {} } } }];
const messages = [
  { role: "user", content: "ZZTEST build" },
  { role: "assistant", content: "", tool_calls: [{ id: "call_ZZTEST_prior", type: "function", function: { name: "ZZTEST", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_ZZTEST_prior", content: "ZZTEST validation passed" },
];

async function fixture(text: string, options: { rawTool?: boolean; gated?: boolean; completedOnly?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ZZTEST-stream-contract-"));
  const app = Fastify();
  try {
    const script = join(dir, "ZZTEST-fake.cjs");
    const cli = join(dir, process.platform === "win32" ? "ZZTEST-codex.cmd" : "ZZTEST-codex");
    await writeFile(script, `
const send = o => process.stdout.write(JSON.stringify(o) + '\\n');
const text = ${JSON.stringify(text)};
const params = {threadId:'ZZTEST-thread',turnId:'ZZTEST-turn',itemId:'ZZTEST-message'};
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:params.threadId}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:params.turnId}}});
  const finish = () => {
   if(${Boolean(options.rawTool)}) send({method:'rawResponseItem/completed',params:{...params,item:{type:'function_call',call_id:'call_ZZTEST_next',name:'ZZTEST',arguments:'{}'}}});
   send({method:'item/completed',params:{...params,item:{id:params.itemId,type:'agentMessage',text}}});
   send({method:'turn/completed',params:{threadId:params.threadId,turn:{id:params.turnId,status:'completed'}}});
  };
  if(${Boolean(options.completedOnly)}) { finish(); return; }
  // Single-character fragments split JSON keys, strings, escapes and Unicode.
  const chunks = ${Boolean(options.gated)} ? ['ZZTEST', ' plain stream'] : Array.from(text);
  send({method:'item/agentMessage/delta',params:{...params,delta:chunks.shift() || ''}});
  const rest = () => { for(const delta of chunks) send({method:'item/agentMessage/delta',params:{...params,delta}}); finish(); };
  if(${Boolean(options.gated)}) {
   const timer = setInterval(() => { if(require('node:fs').existsSync(${JSON.stringify(join(dir, "ZZTEST-release"))})) { clearInterval(timer); rest(); } }, 10);
  } else rest();
 }
});`);
    await writeFile(cli, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0ZZTEST-fake.cjs" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o700 });
    const registry = await ProviderRegistry.create([{
      id: "ZZTEST", type: "cli", models: [{ id: "ZZTEST", capabilities: ["chat", "responses", "tools", "streaming"] }],
      responseCommand: {
        executable: process.execPath, args: [resolve("dist/scripts/codex-appserver-bridge.js"), "ZZTEST"],
        input: "request_json_stdin", output: "json_contract", timeoutMs: 10000,
        env: { CODEX_HOME: dir, CODEX_EXECUTABLE: cli, CODEX_APPSERVER_MODEL_PROVIDER: "ZZTEST", CODEX_APPSERVER_TIMEOUT_MS: "5000" },
      },
    }]);
    await app.register(openAiRoutes, { prefix: "/v1", registry, n8nApiKeys: new Set(["ZZTEST"]) });
    return { app, registry, release: () => writeFile(join(dir, "ZZTEST-release"), "ZZTEST"),
      close: async () => { await app.close(); await rm(dir, { recursive: true, force: true }); } };
  } catch (error) { await app.close(); await rm(dir, { recursive: true, force: true }); throw error; }
}

function events(payload: string): any[] {
  return payload.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));
}

for (const endpoint of ["chat/completions", "responses"]) {
  for (const [name, text, expected, extra] of [
    ["fragmented envelope", JSON.stringify({ output_text: markdown, finish_reason: "stop" }), markdown, {}],
    ["escaped JSON string fragments", JSON.stringify({ output_text: markdown + '\nZZTEST "quoted" \\ path 😀', finish_reason: "stop" }), markdown + '\nZZTEST "quoted" \\ path 😀', {}],
    ["completed agent message", JSON.stringify({ output_text: markdown, finish_reason: "stop" }), markdown, { completedOnly: true }],
    ["partial envelope", '{"output_text":"ZZTEST partial', '{"output_text":"ZZTEST partial', {}],
    ["invalid envelope", '{"output_text":ZZTEST}', '{"output_text":ZZTEST}', {}],
    ["ordinary JSON", '{"ZZTEST":true}', '{"ZZTEST":true}', {}],
  ] as const) {
    test(`ZZTEST ${endpoint} ${name}`, async () => {
      const f = await fixture(text, extra);
      try {
        const response = await f.app.inject({ method: "POST", url: `/v1/${endpoint}`, headers: { authorization: "Bearer ZZTEST" },
          payload: { model: "ZZTEST", stream: true, tools, ...(endpoint === "responses"
            ? { input: [{ role: "user", content: "ZZTEST build" }, { type: "function_call", call_id: "call_ZZTEST_prior", name: "ZZTEST", arguments: "{}" }, { type: "function_call_output", call_id: "call_ZZTEST_prior", output: "ZZTEST validation passed" }] }
            : { messages }) } });
        assert.equal(response.statusCode, 200, response.payload);
        const data = events(response.payload);
        assert.equal(data.some(e => e.error), false, response.payload);
        const content = data.map(e => endpoint === "responses" ? (e.type === "response.output_text.delta" ? e.delta : "") : e.choices?.[0]?.delta?.content ?? "").join("");
        assert.equal(content, expected);
        if (expected === markdown) assert.equal(content.includes('{"output_text"'), false);
        if (endpoint === "chat/completions") assert.equal(data.at(-1)?.choices?.[0]?.finish_reason, "stop");
        else assert.ok(data.some(e => e.type === "response.completed"));
      } finally { await f.close(); }
    });
  }
}

test("ZZTEST plain text reaches the client before the producer can finish", async () => {
  const f = await fixture("ZZTEST plain stream", { gated: true });
  const controller = new AbortController();
  const stream = f.registry.getProvider("ZZTEST")!.runStream!({ requestId: "ZZTEST", model: "ZZTEST", providerModel: "ZZTEST", requestKind: "chat_completions", messages: [{ role: "user", content: "ZZTEST" }], tools, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
  const iterator = stream[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    assert.equal(first.value?.type, "output_text_delta");
    assert.equal(first.value?.type === "output_text_delta" && first.value.delta, "ZZTEST");
    await f.release();
    const rest = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value);
    assert.equal(rest.filter(e => e.type === "output_text_delta").map(e => e.delta).join(""), " plain stream");
    assert.equal(rest.at(-1)?.type, "done");
  } finally { controller.abort(); await iterator.return?.(); await f.close(); }
});

for (const rawTool of [false, true]) {
  test(`ZZTEST tool stream preserves IDs, arguments and finish reason raw=${rawTool}`, async () => {
    const call = { id: "call_ZZTEST_next", name: "ZZTEST", arguments: "{}" };
    const f = await fixture(rawTool ? "" : JSON.stringify({ output_text: "", tool_calls: [call], finish_reason: "tool_calls" }), { rawTool });
    try {
      const result = [];
      for await (const event of f.registry.getProvider("ZZTEST")!.runStream!({ requestId: "ZZTEST", model: "ZZTEST", providerModel: "ZZTEST", requestKind: "chat_completions", messages: [{ role: "user", content: "ZZTEST" }], tools })) result.push(event);
      assert.deepEqual(result.filter(e => e.type === "tool_call").map(e => e.toolCall), [call]);
      assert.equal(result.some(e => e.type === "output_text_delta"), false);
      const done = result.at(-1);
      assert.equal(done?.type === "done" && done.finishReason, "tool_calls");
    } finally { await f.close(); }
  });
}

test("ZZTEST non-stream contract parsing is unchanged after a tool result", async () => {
  const f = await fixture(JSON.stringify({ output_text: markdown, finish_reason: "stop" }));
  try {
    const response = await f.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer ZZTEST" }, payload: { model: "ZZTEST", stream: false, tools, messages } });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().choices[0].message.content, markdown);
    assert.equal(response.json().choices[0].finish_reason, "stop");
  } finally { await f.close(); }
});
