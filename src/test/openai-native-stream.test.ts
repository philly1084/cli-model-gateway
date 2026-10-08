import test from "node:test";
import assert from "node:assert/strict";
import { parseOpenAiStream } from "../utils/openai-stream";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible-provider";
import type { ProviderStreamEvent, UnifiedRequest } from "../types";
const sse = (x: unknown) => `data: ${typeof x === "string" ? x : JSON.stringify(x)}\r\n\r\n`;
const delta = (content: unknown, finish_reason: unknown = null) => ({ model: "test", choices: [{ index: 0, delta: content, finish_reason }] });
const collect = async (stream: AsyncIterable<ProviderStreamEvent>) => { const events: ProviderStreamEvent[] = []; for await (const e of stream) events.push(e); return events; };
function response(source: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(source); let offset = 0;
  return new Response(new ReadableStream({ pull(c) { if (offset >= bytes.length) { c.close(); return; } c.enqueue(bytes.slice(offset, offset += chunkSize)); } }), { headers: { "content-type": "text/event-stream" } });
}
const parse = (source: string) => collect(parseOpenAiStream(response(source, 1), new AbortController().signal));
test("fragmented UTF8, CRLF, comments, usage and completion preserve real deltas", async () => {
  const events = await parse(': keepalive\r\n\r\n' + sse(delta({ content: "Hello 🌱" })) + sse(delta({ content: " world" }, "stop")) + sse({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }) + sse('[DONE]'));
  assert.deepEqual(events.slice(0, 2), [{ type: "output_text_delta", delta: "Hello 🌱" }, { type: "output_text_delta", delta: " world" }]);
  assert.equal(events.at(-1)?.type, "done"); const last = events.at(-1); if (last?.type === 'done') assert.equal(last.usage?.totalTokens, 5);
});
test("first delta arrives before provider closes; iterator return cancels body", async () => {
  let cancelled = false;
  const r = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse(delta({ content: "first" })))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  const it = parseOpenAiStream(r, new AbortController().signal); assert.deepEqual((await it.next()).value, { type: 'output_text_delta', delta: 'first' }); await it.return(undefined); assert.equal(cancelled, true);
});
test("fragments assemble tools only after terminal confirmation", async () => {
  const events = await parse(sse(delta({ tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'calculate', arguments: '{"a":' } }] })) + sse(delta({ tool_calls: [{ index: 0, function: { arguments: '6}' } }] }, 'tool_calls')) + sse('[DONE]'));
  assert.deepEqual(events[0], { type: 'tool_call', toolCall: { id: 'call1', name: 'calculate', arguments: '{"a":6}' } }); assert.equal(events[1]?.type, 'done');
});
for (const [name, source] of Object.entries({ missing_done: sse(delta({ content: 'partial' }, 'stop')), missing_finish: sse(delta({ content: 'partial' })) + sse('[DONE]'), upstream_error: sse({ error: { message: 'not forwarded' } }), changed_model: sse(delta({ content: 'a' })) + sse({ ...delta({ content: 'b' }), model: 'other' }), invalid_json: 'data: {\n\n', oversized: sse(delta({ content: 'x'.repeat(262145) })), unfinished_tool: sse(delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'x', arguments: '{' } }] }, 'tool_calls')) + sse('[DONE]') })) {
  test(`stream rejects ${name} without releasing tools`, async () => { const events: ProviderStreamEvent[] = []; await assert.rejects(async () => { for await (const e of parseOpenAiStream(response(source, 2048), new AbortController().signal)) events.push(e); }); assert.equal(events.some(e => e.type === 'tool_call' || e.type === 'done'), false); });
}
test("abort cancels blocked upstream body promptly", async () => { let cancelled = false; const controller = new AbortController(); const r = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }); const task = collect(parseOpenAiStream(r, controller.signal)); controller.abort(); await assert.rejects(task); assert.equal(cancelled, true); });
test("provider uses same request policy for native stream and preserves continuation; no error replay", async () => {
  const original = globalThis.fetch, previous = process.env.STREAM_TEST_KEY; process.env.STREAM_TEST_KEY = 'synthetic'; const bodies: Record<string, unknown>[] = []; let fail = false;
  globalThis.fetch = (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); if (fail) return new Response('', { status: 503 }); return response(sse(delta({ content: '42' }, 'stop')) + sse('[DONE]')); }) as typeof fetch;
  try { const provider = await OpenAiCompatibleProvider.create({ id: 'test', type: 'openai', baseUrl: 'https://example.invalid/v1', apiKeyEnv: 'STREAM_TEST_KEY', models: [{ id: 'test' }] }); const req: UnifiedRequest = { requestId: 'test', model: 'test', providerModel: 'test', messages: [{ role: 'user', content: '6*7' }, { role: 'assistant', content: '\n\nTOOL_CALLS:\n[{"id":"c","name":"calculate","arguments":"{}"}]' }, { role: 'tool', content: '42', tool_call_id: 'c' }], tools: [], metadata: { temperature: 0.2, max_tokens: 50 } }; await collect(provider.runStream(req)); assert.equal(bodies[0]?.stream, true); assert.equal(bodies[0]?.temperature, 0.2); assert.equal(bodies[0]?.max_tokens, 50); const messages = bodies[0]?.messages as Array<Record<string, unknown>>; assert.equal(messages.at(-1)?.tool_call_id, 'c'); fail = true; await assert.rejects(collect(provider.runStream(req)), /503/); assert.equal(bodies.length, 2); } finally { globalThis.fetch = original; if (previous === undefined) delete process.env.STREAM_TEST_KEY; else process.env.STREAM_TEST_KEY = previous; }
});
test("Gemini complete unindexed tools normalize without accepting ambiguous fragments", async () => {
 const complete={id:'gemini-call',type:'function',function:{name:'multiply',arguments:'{"a":6,"b":7}'}};
 const events=await parse(sse(delta({tool_calls:[complete]},'tool_calls'))+sse('[DONE]'));
 assert.deepEqual(events[0],{type:'tool_call',toolCall:{id:'gemini-call',name:'multiply',arguments:'{"a":6,"b":7}'}});
 await assert.rejects(parse(sse(delta({tool_calls:[{...complete,function:{name:'multiply',arguments:'{"a":'}}]},'tool_calls'))+sse('[DONE]')));
 await assert.rejects(parse(sse(delta({tool_calls:[complete,complete]},'tool_calls'))+sse('[DONE]')));
});
