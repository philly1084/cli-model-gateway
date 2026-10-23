import test from "node:test";
import assert from "node:assert/strict";
import { CliProvider } from "../providers/cli-provider.js";
import type { ProviderStreamEvent, UnifiedRequest } from "../types";

// Mirrors the codex app-server bridge: stream=true in the request JSON switches the
// output to JSONL stream events, otherwise a single JSON contract is printed.
const bridge = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);
if(r.stream===true){process.stdout.write(JSON.stringify({type:"output_text_delta",delta:"pong"})+"\\n"+JSON.stringify({type:"done",output_text:"pong",finish_reason:"stop"})+"\\n");}
else process.stdout.write(JSON.stringify({output_text:"pong",finish_reason:"stop"}));});`;

const provider = () => new CliProvider({ id: "fixture", type: "cli", models: [{ id: "fixture" }], responseCommand: {
  executable: process.execPath, args: ["-e", bridge], input: "request_json_stdin", output: "json_contract", timeoutMs: 5000 } });
const request = (stream: boolean): UnifiedRequest => ({ requestId: "zztest", model: "fixture", providerModel: "fixture",
  messages: [{ role: "user", content: "ZZTEST reply pong" }], tools: [], stream, requestKind: "chat_completions" });

test("non-streaming run ignores a client stream flag (auto + stream:true regression)", async () => {
  const result = await provider().run(request(true));
  assert.equal(result.outputText, "pong");
  assert.equal(result.finishReason, "stop");
});

test("non-streaming run without stream flag is unchanged", async () => {
  assert.equal((await provider().run(request(false))).outputText, "pong");
});

test("runStream still asks the bridge for stream events", async () => {
  const p = provider(); p.supportsStreaming = () => true;
  const events: ProviderStreamEvent[] = [];
  for await (const e of p.runStream(request(false))) events.push(e);
  assert.deepEqual(events.map(e => e.type), ["output_text_delta", "done"]);
});
