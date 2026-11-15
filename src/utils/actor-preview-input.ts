import { createHash } from "node:crypto";
import type { ChatMessage } from "../types.js";

export const ACTOR_PREVIEW_FLAG = "GATEWAY_BRAIN_SCENE_ACTOR_IMAGES";
export const actorPreviewLimits = Object.freeze({ images: 4, imageBytes: 300000, totalBytes: 600000 });
export type ActorPreviewScope = { version: 1; role: "actor"; source: "scene_preview"; images: Array<{ sha256: string; bytes: number; mime: string }> };
const reject = (code: string): never => { throw Object.assign(new Error(code), { code, statusCode: 400 }); };
export function actorPreviewScope(value: unknown): ActorPreviewScope {
  const scope = value as ActorPreviewScope | undefined;
  if (!scope || scope.version !== 1 || scope.role !== "actor" || scope.source !== "scene_preview" || !Array.isArray(scope.images) || !scope.images.length || scope.images.length > actorPreviewLimits.images) return reject("ACTOR_PREVIEW_SCOPE_INVALID");
  return scope;
}
export function actorPreviewInput(content: unknown, role: string, scopeValue: unknown, enabled = process.env[ACTOR_PREVIEW_FLAG] === "1") {
  if (!enabled) return reject("ACTOR_PREVIEW_DISABLED");
  const scope = actorPreviewScope(scopeValue);
  if (role !== "user" || !Array.isArray(content)) return reject("ACTOR_PREVIEW_ROLE_INVALID");
  const parts = content.filter(p => p?.type === "image_url" || p?.type === "input_image");
  if (parts.length > actorPreviewLimits.images) return reject("ACTOR_PREVIEW_COUNT_INVALID");
  return parts.map(part => {
    const url: unknown = part?.type === "image_url" ? part.image_url?.url : undefined;
    if (typeof url !== "string" || url.length > 400030) return reject("ACTOR_PREVIEW_IMAGE_INVALID");
    const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match) return reject("ACTOR_PREVIEW_IMAGE_INVALID");
    const mediaType = match[1] as "image/jpeg" | "image/png", data = match[2]!, bytes = Buffer.from(data, "base64");
    if (bytes.length < 4 || bytes.length > actorPreviewLimits.imageBytes || bytes.toString("base64") !== data) return reject("ACTOR_PREVIEW_SIZE_INVALID");
    const valid = mediaType === "image/jpeg" ? bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9
      : bytes.length >= 45 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii",12,16) === "IHDR" && bytes.toString("ascii",bytes.length-8,bytes.length-4) === "IEND";
    if (!valid) return reject("ACTOR_PREVIEW_MIME_INVALID");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!scope.images.some(p => p.sha256 === sha256 && p.bytes === bytes.length && p.mime === mediaType)) return reject("ACTOR_PREVIEW_PROVENANCE_INVALID");
    return { mediaType, data };
  });
}
export function validateActorPreviewMessages(messages: ChatMessage[], scopeValue: unknown) {
  const scope = actorPreviewScope(scopeValue), images = messages.flatMap(m => m.inputImages ?? []);
  if (images.length < 1 || images.length > actorPreviewLimits.images || images.length !== scope.images.length || images.reduce((n,i)=>n+Buffer.byteLength(i.data,"base64"),0) > actorPreviewLimits.totalBytes) return reject("ACTOR_PREVIEW_COUNT_INVALID");
  for (const message of messages) if (message.inputImages?.length) actorPreviewInput(message.inputImages.map(i=>({type:"image_url",image_url:{url:`data:${i.mediaType};base64,${i.data}`}})),message.role,scope);
  return images;
}
