import { createHash } from "node:crypto";
import type { ChatMessage, UnifiedRequest } from "../types.js";

export const IMAGE_INPUT_FLAG = "GATEWAY_KIMI_IMAGE_INPUT";
export type InputImage = { mediaType: "image/jpeg"; data: string };
const reject = (code: string): never => { throw Object.assign(new Error(code), { code, statusCode: 400 }); };

/** Data-only media: no URL fetch, filesystem access, source text or credentials. */
export function imageInput(content: unknown, role: string, enabled = process.env[IMAGE_INPUT_FLAG] === "1"): InputImage[] {
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

/** The initial supported adapter is the existing configured Kimi API binding. */
export function imageRequest(request: Omit<UnifiedRequest, "model" | "providerModel">, providerId: string | undefined) {
  if (!hasImageInput(request.messages)) return request;
  if (process.env[IMAGE_INPUT_FLAG] !== "1") return reject("IMAGE_INPUT_DISABLED");
  if (providerId !== "kimi-code-api" || request.stream || request.requestKind !== "chat_completions") return reject("IMAGE_ROUTE_UNSUPPORTED");
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
