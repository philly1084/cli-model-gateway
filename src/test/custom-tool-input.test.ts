import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { customToolInputArguments, ToolContractError } from "../utils/tool-contract.js";
import { parseToolCallFromRawItem } from "../scripts/codex-appserver-bridge.js";
import { ProviderRegistry } from "../providers/registry.js";
import { openAiRoutes } from "../routes/openai.js";
import { installRequestCompletionLogging } from "../utils/request-completion.js";

const text = "ZZTEST bpy text\n# ZZTEST placeholder";
const schema = { type: "object", properties: { script: { type: "string", maxLength: 65536 }, timeoutSeconds: { type: "number" } }, required: ["script"], additionalProperties: false };
const ambiguous = { type: "object", properties: { script: { type: "string" }, second: { type: "string" } }, required: ["script", "second"] };
const json = '{ "script": "ZZTEST", "timeoutSeconds": 1 }';
const issue = (code: string) => (error: unknown) => error instanceof ToolContractError && error.issue === code && !error.message.includes(text);

test("custom input selects single required string before optional fields", () => {
  assert.equal(customToolInputArguments(text, schema), JSON.stringify({ script: text }));
});
test("custom input preserves JSON object bytes and supports a sole optional string", () => {
  assert.equal(customToolInputArguments(json, undefined), json);
  assert.equal(customToolInputArguments(text, { type: "object", properties: { script: { type: "string" } } }), JSON.stringify({ script: text }));
  for (const input of ["null", "[]", '"ZZTEST"']) assert.equal(customToolInputArguments(input, schema), JSON.stringify({ script: input }));
});
test("custom input rejects ambiguous, unknown and non-string inputs without leaking text", () => {
  for (const parameters of [ambiguous, undefined, { type: "object", properties: { timeoutSeconds: { type: "number" } } }]) {
    assert.throws(() => customToolInputArguments(text, parameters), issue("custom_tool_input_unmappable"));
  }
  for (const input of [null, {}, 1, undefined]) assert.throws(() => customToolInputArguments(input, schema), issue("custom_tool_input_unmappable"));
});
test("custom input enforces maxLength in Unicode characters and 256 KB after encoding", () => {
  const bounded = { type: "object", properties: { script: { type: "string", maxLength: 6 } }, required: ["script"] };
  assert.equal(customToolInputArguments("ZZTEST", bounded), '{"script":"ZZTEST"}');
  assert.throws(() => customToolInputArguments("ZZTEST!", bounded), issue("custom_tool_input_too_long"));
  assert.equal(customToolInputArguments("ZZTEST😀", { ...bounded, properties: { script: { type: "string", maxLength: 7 } } }), '{"script":"ZZTEST😀"}');
  const unbounded = { type: "object", properties: { script: { type: "string" } } };
  assert.throws(() => customToolInputArguments("ZZTEST".repeat(44000), unbounded), issue("arguments_missing_or_oversized"));
  assert.throws(() => customToolInputArguments('ZZTEST\n'.repeat(33000), unbounded), issue("arguments_missing_or_oversized"));
});
test("raw function_call JSON bytes remain unchanged and invalid JSON stays strict", () => {
  assert.deepEqual(parseToolCallFromRawItem({ type: "function_call", name: "blender_build", call_id: "ZZTEST", arguments: json }), { id: "ZZTEST", name: "blender_build", arguments: json });
  assert.throws(() => parseToolCallFromRawItem({ type: "function_call", name: "blender_build", call_id: "ZZTEST", arguments: text }), issue("arguments_invalid_json"));
});

// Cross-platform fake app-server: only synthetic RPC, no provider credentials or inference.
const fake = `const readline = require('node:readline');
const send = o => process.stdout.write(JSON.stringify(o)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'ZZTEST-thread'}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'ZZTEST-turn'}}});
  send({method:'item/completed',params:{threadId:'ZZTEST-thread',turnId:'ZZTEST-turn',item:{type:'agentMessage',text:'ZZTEST progress'}}});
  send({method:'rawResponseItem/completed',params:{threadId:'ZZTEST-thread',turnId:'ZZTEST-turn',item:JSON.parse(process.env.ZZTEST_ITEM)}});
  send({method:'turn/completed',params:{threadId:'ZZTEST-thread',turn:{id:'ZZTEST-turn',status:'completed'}}});
 }
});`;

async function fixture(item: unknown, parameters: unknown) {
  const dir = await mkdtemp(join(resolve(), "ZZTEST-custom-tool-"));
  const cli = join(dir, process.platform === "win32" ? "ZZTEST-codex.cmd" : "ZZTEST-codex");
  await writeFile(join(dir, "ZZTEST-fake.cjs"), fake);
  await writeFile(cli, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "%~dp0ZZTEST-fake.cjs"\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "ZZTEST-fake.cjs")}"\n`, { mode: 0o700 });
  const env = { CODEX_EXECUTABLE: cli, ZZTEST_ITEM: JSON.stringify(item), CODEX_APPSERVER_DEBUG_RPC: "true" };
  const registry = await ProviderRegistry.create([{ id: "ZZTEST", type: "cli", models: [{ id: "ZZTEST", capabilities: ["chat", "responses", "tools", "streaming"] }], responseCommand: {
    executable: process.execPath, args: [resolve("dist/scripts/codex-appserver-bridge.js"), "ZZTEST"], env, input: "request_json_stdin", output: "json_contract", timeoutMs: 10000,
  } }]);
  const logs: Record<string, unknown>[] = [];
  const app = Fastify({ disableRequestLogging: true, logger: { level: "info", stream: new Writable({ write(value, _encoding, done) { logs.push(JSON.parse(String(value))); done(); } }) } });
  installRequestCompletionLogging(app);
  await app.register(openAiRoutes, { prefix: "/v1", registry, n8nApiKeys: new Set(["ZZTEST"]) });
  const tools = [{ type: "function", function: { name: "blender_build", parameters } }];
  return { dir, env, tools, app, logs, close: async () => { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}

for (const [label, type, input, parameters, name, code] of [
  ["single-required-string", "custom_tool_call", text, schema, "blender_build", undefined],
  ["JSON-object-string", "custom_tool_call", json, schema, "blender_build", undefined],
  ["ambiguous", "custom_tool_call", text, ambiguous, "blender_build", "custom_tool_input_unmappable"],
  ["unknown-tool", "custom_tool_call", text, schema, "ZZTEST_unknown", "custom_tool_input_unmappable"],
  ["function-JSON", "function_call", json, schema, "blender_build", undefined],
  ["function-invalid-JSON", "function_call", text, schema, "blender_build", "arguments_invalid_json"],
  ["maxLength", "custom_tool_call", text, { ...schema, properties: { script: { type: "string", maxLength: 1 } } }, "blender_build", "custom_tool_input_too_long"],
] as const) {
  test(`real bridge to gateway: ${label} ends cleanly for chat and Responses`, async () => {
    const item = { type, name, call_id: "ZZTEST-call", ...(type === "function_call" ? { arguments: input } : { input }) };
    const f = await fixture(item, parameters);
    try {
      if (code) {
        const child = spawn(process.execPath, [resolve("dist/scripts/codex-appserver-bridge.js"), "ZZTEST"], { env: { ...process.env, ...f.env }, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.stdin.end(JSON.stringify({ requestKind: "responses", stream: true, tools: f.tools, messages: [{ role: "user", content: "ZZTEST" }] }));
        const exitCode = await new Promise<number | null>((resolveExit, reject) => { child.on("error", reject); child.on("close", resolveExit); });
        assert.equal(exitCode, 0, stderr);
        const events = stdout.trim().split("\n").map(line => JSON.parse(line));
        assert.ok(["output_text_delta", "reasoning_delta"].includes(events[0].type));
        assert.deepEqual(events.at(-1), { type: "error", error: { message: `Provider tool contract rejected: ${code}.`, type: "provider_tool_contract_invalid", code, param: null, retryable: true } });
        assert.ok(!stdout.includes(text) && !stderr.includes(text));
      }
      for (const endpoint of ["chat/completions", "responses"]) {
        const response = await f.app.inject({ method: "POST", url: `/v1/${endpoint}`, headers: { authorization: "Bearer ZZTEST" }, payload: {
          model: "ZZTEST", stream: true, tools: f.tools,
          ...(endpoint === "responses" ? { input: "ZZTEST" } : { messages: [{ role: "user", content: "ZZTEST" }] }),
        } });
        assert.equal(response.statusCode, 200, response.body);
        const data = response.body.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6));
        assert.equal(data.at(-1), "[DONE]", response.body);
        const events = data.slice(0, -1).map(line => JSON.parse(line));
        if (code) {
          const error = events.find(event => event.error)?.error;
          assert.deepEqual(error, { message: `Provider tool contract rejected: ${code}.`, type: "provider_tool_contract_invalid", code, param: null, retryable: true });
          assert.ok(!response.body.includes(text));
          assert.ok(!response.body.includes("upstream_stream_failed"));
          assert.ok(!response.body.includes('"finish_reason":"tool_calls"'));
          if (endpoint === "chat/completions") {
            const completion = f.logs.find(log => log.msg === "request completed");
            assert.equal(completion?.errorType, "provider_tool_contract_invalid");
            assert.equal(completion?.stage, "mid_stream");
          }
          assert.ok(!JSON.stringify(f.logs).includes(text));
        } else if (endpoint === "chat/completions") {
          const tool = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? [])[0];
          assert.equal(tool.function.arguments, label === "single-required-string" ? JSON.stringify({ script: text }) : json);
          assert.equal(events.find(event => event.choices?.[0]?.finish_reason)?.choices[0].finish_reason, "tool_calls");
        } else {
          const completed = events.find(event => event.type === "response.completed");
          assert.equal(completed.response.output.find((entry: { type: string }) => entry.type === "function_call").arguments, label === "single-required-string" ? JSON.stringify({ script: text }) : json);
        }
      }
      if (code) {
        const response = await f.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer ZZTEST" }, payload: { model: "ZZTEST", tools: f.tools, messages: [{ role: "user", content: "ZZTEST" }] } });
        assert.equal(response.statusCode, 502, response.body);
        assert.equal(response.json().error.code, code);
        assert.ok(!response.body.includes(text));
      }
    } finally { await f.close(); }
  });
}
