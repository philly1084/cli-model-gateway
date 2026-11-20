import { routeAdmits } from "./route-table.js";
import { reviewerRouteAllowed, validateReviewerMessages, privateSceneTurn } from "./scene-review-input.js";
import { createHash } from "node:crypto";
import type { ChatMessage, UnifiedRequest } from "../types.js";
import { validateActorPreviewMessages } from "./actor-preview-input.js";

export const IMAGE_INPUT_FLAG = "GATEWAY_KIMI_IMAGE_INPUT";
export const ANTHROPIC_IMAGE_INPUT_FLAG = "GATEWAY_ANTHROPIC_IMAGE_INPUT";
/** Each direct image adapter has its own opt-in, so enabling one never opens another. */
const IMAGE_PROVIDER_FLAGS: Record<string, string> = { "kimi-code-api": IMAGE_INPUT_FLAG, "anthropic-api": ANTHROPIC_IMAGE_INPUT_FLAG };
export const imageProviderEnabled = (providerId: string | undefined) => Boolean(providerId && IMAGE_PROVIDER_FLAGS[providerId] && process.env[IMAGE_PROVIDER_FLAGS[providerId]] === "1");
const anyImageProviderEnabled = () => Object.values(IMAGE_PROVIDER_FLAGS).some(flag => process.env[flag] === "1");
export type InputImage = { mediaType: "image/jpeg" | "image/png"; data: string };
const reject = (code: string): never => { throw Object.assign(new Error(code), { code, statusCode: 400 }); };

/** Data-only media: no URL fetch, filesystem access, source text or credentials. */
export function imageInput(content: unknown, role: string, enabled = anyImageProviderEnabled()): InputImage[] {
  if (!Array.isArray(content)) return [];
  const parts = content.filter(p => p?.type === "image_url" || p?.type === "input_image");
  if (!parts.length) return [];
  if (!enabled) return reject("IMAGE_INPUT_DISABLED");
  if (role !== "user" || parts.length > 3) return reject("IMAGE_INPUT_INVALID");
  return parts.map(part => {
    const url = part?.type === "image_url" ? part.image_url?.url : undefined;
    if (typeof url !== "string" || url.length > 64023 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) return reject("IMAGE_INPUT_INVALID");
    const data = url.slice(23), bytes = Buffer.from(data, "base64");
    if (bytes.length < 4 || bytes.length > 48000 || bytes.toString("base64") !== data || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return reject("IMAGE_INPUT_INVALID");
    return { mediaType: "image/jpeg", data };
  });
}

export const hasImageInput = (messages: ChatMessage[]) => messages.some(m => Boolean(m.inputImages?.length));

/** Direct image adapters: the configured Kimi API binding and the Anthropic Messages API. */
export function imageRequest(request: Omit<UnifiedRequest, "model" | "providerModel">, providerId: string | undefined, modelId?: string) {
  if (request.metadata?.brain_scene_knowledge !== undefined) {
    privateSceneTurn(request.metadata);
    if(!routeAdmits(providerId,modelId,"knowledge")||request.stream||request.requestKind!=="chat_completions")return reject("KNOWLEDGE_TRANSPORT_UNSUPPORTED");
    const metadata={...request.metadata};delete metadata.messages;
    const previous=metadata.gateway_policy as Record<string,unknown>|undefined;
    request={...request,metadata:{...metadata,gateway_policy:{...previous,operationId:previous?.operationId??request.requestId,allowFallback:false,maxAttempts:1,maxLatencyMs:Math.min(typeof previous?.maxLatencyMs==="number"?previous.maxLatencyMs:150000,180000)}}};
  }
  if (request.metadata?.brain_scene_review !== undefined) {
    const images=validateReviewerMessages(request.messages,request.metadata.brain_scene_review);
    if(request.metadata.brain_scene_preview!==undefined||request.metadata.brain_scene_knowledge!==undefined||request.stream||request.requestKind!=="chat_completions")return reject("REVIEWER_ROUTE_UNSUPPORTED");
    if(!reviewerRouteAllowed(providerId,modelId)&&!(providerId==="kimi-code-api"&&process.env[IMAGE_INPUT_FLAG]==="1"))return reject("REVIEWER_ROUTE_UNSUPPORTED");
    if(providerId!=="codex-cli"&&providerId!=="kimi-code-api")return reject("REVIEWER_ROUTE_UNSUPPORTED");
    const metadata={...request.metadata};delete metadata.messages;
    const previous=metadata.gateway_policy as Record<string,unknown>|undefined;
    request.receipt?.({type:"gateway.reviewer_image_input/v1",requestId:request.requestId,images:images.length,contentSha256:createHash("sha256").update(JSON.stringify(images)).digest("hex"),fallback:false});
    const latencyCap=providerId==="kimi-code-api"?120000:180000;
    return {...request,metadata:{...metadata,gateway_policy:{...previous,operationId:previous?.operationId??request.requestId,allowFallback:false,maxAttempts:1,maxLatencyMs:Math.min(typeof previous?.maxLatencyMs==="number"?previous.maxLatencyMs:150000,latencyCap)}}};
  }
  if (!hasImageInput(request.messages)) return request;
  if (request.metadata?.brain_scene_preview !== undefined) {
    if (!routeAdmits(providerId,modelId,"actorPreview") || request.stream || request.requestKind !== "chat_completions") return reject("ACTOR_PREVIEW_ROUTE_UNSUPPORTED");
    const images = validateActorPreviewMessages(request.messages, request.metadata.brain_scene_preview);
    const previous = request.metadata.gateway_policy as Record<string, unknown> | undefined;
    request.receipt?.({type:"gateway.actor_preview_input/v1",requestId:request.requestId,images:images.length,bytes:images.reduce((n,i)=>n+Buffer.byteLength(i.data,"base64"),0),fallback:false});
    // Raw API messages must not be duplicated in metadata or provider logs.
    const metadata = { ...request.metadata }; delete metadata.messages;
    return {...request,metadata:{...metadata,gateway_policy:{...previous,operationId:previous?.operationId??request.requestId,allowFallback:false,maxAttempts:1,maxLatencyMs:Math.min(typeof previous?.maxLatencyMs === "number"?previous.maxLatencyMs:120000,120000)}}};
  }
  if (!anyImageProviderEnabled()) return reject("IMAGE_INPUT_DISABLED");
  if (!providerId || !IMAGE_PROVIDER_FLAGS[providerId] || request.stream || request.requestKind !== "chat_completions") return reject("IMAGE_ROUTE_UNSUPPORTED");
  if (!imageProviderEnabled(providerId)) return reject("IMAGE_INPUT_DISABLED");
  const images = request.messages.flatMap(m => m.inputImages ?? []);
  if (images.length > 3 || request.messages.some(m => m.inputImages?.length && m.role !== "user")) return reject("IMAGE_INPUT_INVALID");
  for (const img of images) imageInput([{ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } }], "user", true);
  const previous = request.metadata?.gateway_policy as Record<string, unknown> | undefined;
  const maxLatencyMs = Math.min(typeof previous?.maxLatencyMs === "number" ? previous.maxLatencyMs : 120000, 120000);
  request.receipt?.({ type: "gateway.image_input/v1", requestId: request.requestId, images: images.length,
    contentSha256: createHash("sha256").update(JSON.stringify(images)).digest("hex"), source: "inline-jpeg", fallback: false });
  return { ...request, metadata: { ...request.metadata, gateway_policy: { ...previous,
    operationId: previous?.operationId ?? request.requestId, allowFallback: false, maxAttempts: 1, maxLatencyMs } } };
}
