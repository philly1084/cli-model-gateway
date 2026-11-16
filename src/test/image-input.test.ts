import test from "node:test";
import assert from "node:assert/strict";
import { imageInput, imageRequest, IMAGE_INPUT_FLAG } from "../utils/image-input.js";
import { normalizeChatMessages } from "../routes/openai.js";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible-provider.js";
import type { UnifiedRequest } from "../types.js";

// Synthetic byte fixture for transport tests only; never visual/autonomy evidence.
const data = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const image = { type: "image_url", image_url: { url: "data:image/jpeg;base64," + data } };
const input = (): Omit<UnifiedRequest, "model" | "providerModel"> => ({ requestId: "image_fixture", requestKind: "chat_completions", tools: [], messages: [{ role: "user", content: "Fixture", inputImages: [{ mediaType: "image/jpeg", data }] }] });

test("image input is gated, bounded, user-only and data-only", () => {
  assert.throws(() => imageInput([image], "user", false), /IMAGE_INPUT_DISABLED/);
  assert.throws(() => imageInput([image], "assistant", true), /IMAGE_INPUT_INVALID/);
  assert.throws(() => imageInput(Array(4).fill(image), "user", true), /IMAGE_INPUT_INVALID/);
  for (const url of ["https://example.invalid/private", "file:///private", "data:image/png;base64," + data, "data:image/jpeg;base64,AAAA", "data:image/jpeg;base64," + "A".repeat(64004)]) {
    assert.throws(() => imageInput([{ type: "image_url", image_url: { url } }], "user", true), /IMAGE_INPUT_INVALID/);
  }
  assert.deepEqual(imageInput([image], "user", true), [{ mediaType: "image/jpeg", data }]);
});

test("ordinary text remains identical and image normalization fails visibly when closed", t => {
  const prior = process.env[IMAGE_INPUT_FLAG]; delete process.env[IMAGE_INPUT_FLAG];
  t.after(() => { if (prior === undefined) delete process.env[IMAGE_INPUT_FLAG]; else process.env[IMAGE_INPUT_FLAG] = prior; });
  assert.deepEqual(normalizeChatMessages([{ role: "user", content: "Plain text" }]), [{ role: "user", content: "Plain text" }]);
  assert.throws(() => normalizeChatMessages([{ role: "user", content: [image] }]), /IMAGE_INPUT_DISABLED/);
  process.env[IMAGE_INPUT_FLAG] = "1";
  assert.throws(() => normalizeChatMessages([{ role: "assistant", content: [image] }]), /IMAGE_INPUT_INVALID/);
  assert.deepEqual(normalizeChatMessages([{ role: "user", content: [{ type: "text", text: "Inspect" }, image] }]), [{ role: "user", content: "Inspect", inputImages: [{ mediaType: "image/jpeg", data }] }]);
});

test("image route pins the configured provider and one attempt without extending a deadline", t => {
  const prior = process.env[IMAGE_INPUT_FLAG]; process.env[IMAGE_INPUT_FLAG] = "1";
  t.after(() => { if (prior === undefined) delete process.env[IMAGE_INPUT_FLAG]; else process.env[IMAGE_INPUT_FLAG] = prior; });
  assert.throws(() => imageRequest(input(), "other-provider"), /IMAGE_ROUTE_UNSUPPORTED/);
  assert.throws(() => imageRequest({ ...input(), stream: true }, "kimi-code-api"), /IMAGE_ROUTE_UNSUPPORTED/);
  assert.throws(() => imageRequest({ ...input(), requestKind: "responses" }, "kimi-code-api"), /IMAGE_ROUTE_UNSUPPORTED/);
  const events: unknown[] = [];
  const request = imageRequest({ ...input(), receipt: row => events.push(row), metadata: { gateway_policy: { operationId: "fixture", allowFallback: true, maxAttempts: 8, maxLatencyMs: 5000 } } }, "kimi-code-api");
  assert.deepEqual(request.metadata?.gateway_policy, { operationId: "fixture", allowFallback: false, maxAttempts: 1, maxLatencyMs: 5000 });
  assert.doesNotMatch(JSON.stringify(events), new RegExp(data.replace(/[+]/g, "\\+")));
  assert.equal((events[0] as { images: number }).images, 1);
  assert.throws(() => imageRequest({ ...input(), messages: Array(4).fill(input().messages[0]) }, "kimi-code-api"), /IMAGE_INPUT_INVALID/);
});

test("actual Kimi adapter receives identical normalized JPEG bytes in Anthropic image blocks", async t => {
  const prior = process.env[IMAGE_INPUT_FLAG], priorKey = process.env.IMAGE_UNIT_KEY, originalFetch = globalThis.fetch;
  process.env[IMAGE_INPUT_FLAG] = "1"; process.env.IMAGE_UNIT_KEY = "unit-test-only";
  t.after(() => { globalThis.fetch = originalFetch; if (prior === undefined) delete process.env[IMAGE_INPUT_FLAG]; else process.env[IMAGE_INPUT_FLAG] = prior; if (priorKey === undefined) delete process.env.IMAGE_UNIT_KEY; else process.env.IMAGE_UNIT_KEY = priorKey; });
  let captured: Record<string, any> = {}, count = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)); count++;
    return new Response(JSON.stringify({ type: "message", id: "synthetic", model: "k3", role: "assistant", content: [{ type: "text", text: "Fixture only" }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const provider = await OpenAiCompatibleProvider.create({ id: "kimi-code-api", type: "openai", baseUrl: "https://api.kimi.com/coding/v1", apiKeyEnv: "IMAGE_UNIT_KEY", models: [{ id: "kimi-k3", providerModel: "k3" }], discovery: { enabled: false } });
  const messages = normalizeChatMessages([{ role: "user", content: [{ type: "text", text: "Inspect" }, image] }]);
  const result = await provider.run({ ...input(), messages, model: "kimi-k3", providerModel: "k3" });
  assert.equal(count, 1); assert.equal(result.outputText, "Fixture only");
  assert.deepEqual(captured.messages[0].content, [{ type: "text", text: "Inspect" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data } }]);
});

import {REVIEWER_IMAGE_ROUTES,privateSceneTurn} from '../utils/scene-review-input.js';
import {actorPreviewTurnInput} from '../scripts/codex-appserver-bridge.js';
import {ProviderRegistry} from '../providers/registry.js';
import {UpstreamError} from '../utils/upstream-error.js';
const reviewScope={version:1,role:'verifier',source:'scene_review'};
test('review admission is closed by default, route scoped, bounded and suppresses caller fallback',t=>{
 const old=process.env[REVIEWER_IMAGE_ROUTES],kimi=process.env[IMAGE_INPUT_FLAG];delete process.env[REVIEWER_IMAGE_ROUTES];delete process.env[IMAGE_INPUT_FLAG];
 t.after(()=>{if(old===undefined)delete process.env[REVIEWER_IMAGE_ROUTES];else process.env[REVIEWER_IMAGE_ROUTES]=old;if(kimi===undefined)delete process.env[IMAGE_INPUT_FLAG];else process.env[IMAGE_INPUT_FLAG]=kimi;});
 const request={...input(),metadata:{brain_scene_review:reviewScope,messages:['PRIVATE'],gateway_policy:{operationId:'review-test',allowFallback:true,maxAttempts:8,maxLatencyMs:4000}}};
 assert.throws(()=>imageRequest(request,'codex-cli','gpt-6-astra'));
 process.env[REVIEWER_IMAGE_ROUTES]=JSON.stringify([{provider:'codex-cli',model:'gpt-6-astra'}]);
 const result=imageRequest(request,'codex-cli','gpt-6-astra');assert.equal(result.metadata?.messages,undefined);assert.deepEqual(result.metadata?.gateway_policy,{operationId:'review-test',allowFallback:false,maxAttempts:1,maxLatencyMs:4000});
 assert.equal(actorPreviewTurnInput(result).length,1);
 assert.throws(()=>imageRequest(request,'codex-cli','other'));assert.throws(()=>imageRequest(input(),'codex-cli','gpt-6-astra'));
 assert.throws(()=>imageRequest({...request,stream:true},'codex-cli','gpt-6-astra'));
 assert.throws(()=>imageRequest({...request,messages:Array(4).fill(input().messages[0])},'codex-cli','gpt-6-astra'));
 assert.throws(()=>imageRequest({...request,messages:[]},'codex-cli','gpt-6-astra'));
 assert.throws(()=>normalizeChatMessages([{role:'user',content:[image]}],undefined,{...reviewScope,role:'actor'}));
 assert.equal(normalizeChatMessages([{role:'user',content:[image]}],undefined,reviewScope)[0]?.inputImages?.length,1);
 const knowledge={...input(),messages:[{role:'user' as const,content:'synthetic private reference'}],metadata:{brain_scene_knowledge:{version:1,role:'actor',source:'scene_knowledge'},messages:['PRIVATE']}};
 const ephemeral=imageRequest(knowledge,'codex-cli','gpt-6-astra');assert.equal(ephemeral.metadata?.messages,undefined);assert.equal(privateSceneTurn(ephemeral.metadata),true);assert.equal(actorPreviewTurnInput(ephemeral).length,0);
 assert.throws(()=>imageRequest(knowledge,'other','gpt-6-astra'));
});
for(const provider of ['codex-cli','kimi-code-api'])for(const status of [429,503])test(`review ${provider} suppresses profile retry_on and fallback on ${status}`,async t=>{
 const old=process.env[REVIEWER_IMAGE_ROUTES];process.env[REVIEWER_IMAGE_ROUTES]=JSON.stringify([{provider,model:'chosen'}]);t.after(()=>{if(old===undefined)delete process.env[REVIEWER_IMAGE_ROUTES];else process.env[REVIEWER_IMAGE_ROUTES]=old;});
 const models=[{id:'chosen',fallbackModels:['fallback']},{id:'fallback'}];
 const registry=await ProviderRegistry.create([provider==='codex-cli'?{id:provider,type:'cli',profile:provider,models,responseCommand:{executable:process.execPath,args:[],input:'request_json_stdin',output:'json_contract',timeoutMs:1000}}:{id:provider,type:'openai',profile:provider,models,baseUrl:'https://api.kimi.com/coding/v1',apiKeyEnv:'REVIEW_FIXTURE_UNUSED',discovery:{enabled:false}}]);
 let calls=0;registry.getProvider(provider)!.run=async()=>{calls++;throw new UpstreamError(status,{});};
 await assert.rejects(registry.runModel('chosen',{...input(),metadata:{brain_scene_review:reviewScope,gateway_policy:{operationId:'retry-test',allowFallback:true,maxAttempts:8,maxLatencyMs:1000}}}));assert.equal(calls,1);
});
