import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { ProviderConfig, UnifiedRequest } from "./types.js";
import { RequestCapabilityError } from "./utils/request-capability.js";

const regex = z.string().max(512).refine(value => {
  try { new RegExp(value, "i"); return true; } catch { return false; }
}, "Invalid regular expression");
const milliseconds = z.number().int().positive();
export const providerProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  type: z.enum(["cli", "openai"]),
  baseUrl: z.string().url().optional(),
  endpoint: z.string().startsWith("/").optional(),
  auth: z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }).strict(),
  command: z.object({
    executable: z.string().min(1), args: z.array(z.string()),
    input: z.enum(["prompt_stdin", "request_json_stdin"]),
    output: z.enum(["text", "text_plain", "text_contract_final_line", "json_contract"]),
  }).strict().optional(),
  stream_format: z.enum(["openai-sse", "cli-jsonl", "buffered-json", "anthropic-json"]),
  quirks: z.object({
    duplicate_finish_trailer: z.boolean(), json_array_errors: z.boolean(),
    unsupported_model_patterns: z.array(regex), refusal_patterns: z.array(regex),
    retry_on: z.array(z.number().int().min(400).max(599)),
    backoff_ms: z.number().int().nonnegative(), auth_fail_fast: z.boolean(),
    timeouts: z.object({ first_token: milliseconds, total: milliseconds }).strict(),
  }).strict(),
  capabilities: z.object({
    tools: z.boolean(), json_mode: z.boolean(),
    system_prompt: z.enum(["native", "prepend_to_user", "cli_flag"]),
    system_flag: z.string().min(1).optional(),
  }).strict(),
  normalization: z.object({ strip_think: z.boolean().default(true), strip_fence: z.boolean().default(false) }).strict(),
}).strict().superRefine((profile, ctx) => {
  if (profile.type === "cli" && !profile.command) ctx.addIssue({ code: "custom", message: "CLI profile requires command" });
  if (profile.type === "openai" && (!profile.baseUrl || !profile.endpoint)) ctx.addIssue({ code: "custom", message: "API profile requires baseUrl and endpoint" });
  if (profile.capabilities.system_prompt === "cli_flag" && (profile.type !== "cli" || !profile.command || !profile.capabilities.system_flag)) ctx.addIssue({ code: "custom", message: "cli_flag requires a CLI command and system_flag" });
  if (profile.type === "cli" && !["cli-jsonl", "buffered-json"].includes(profile.stream_format)) ctx.addIssue({ code: "custom", message: "Invalid CLI stream format" });
  if (profile.type === "openai" && profile.stream_format === "cli-jsonl") ctx.addIssue({ code: "custom", message: "Invalid API stream format" });
});

export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export function loadProviderProfiles(directory = path.resolve(__dirname, "../config/provider-profiles")): Map<string, ProviderProfile> {
  const profiles = new Map<string, ProviderProfile>();
  for (const filename of readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).sort()) {
    const profile = providerProfileSchema.parse(YAML.parse(readFileSync(path.join(directory, filename), "utf8")));
    if (profiles.has(profile.id)) throw Error(`Duplicate provider profile: ${profile.id}`);
    profiles.set(profile.id, profile);
  }
  return profiles;
}

let defaultProfiles: Map<string, ProviderProfile> | undefined;

export function resolveProviderProfile(config: Pick<ProviderConfig, "id" | "type" | "profile"> & { baseUrl?: string; responseCommand?: { args: string[] } }, profiles = (defaultProfiles ??= loadProviderProfiles())): ProviderProfile | undefined {
  let id = config.profile;
  if (!id) {
    if (config.type === "cli") {
      const command = config.responseCommand?.args.join(" ") ?? "";
      id = /codex-appserver-bridge/.test(command) ? "codex-cli" : /kimi-acp-bridge/.test(command) ? "kimi-code-cli" : undefined;
    } else {
      const host = new URL(config.baseUrl!).hostname;
      id = host === "api.kimi.com" ? (config.id === "kimi-api" ? "kimi-api" : "kimi-code-api")
        : host === "api.moonshot.ai" || host === "api.moonshot.cn" ? "kimi-api"
        : host === "openrouter.ai" ? "openrouter" : host === "api.deepseek.com" ? "deepseek"
        : host === "generativelanguage.googleapis.com" ? "gemini-api" : undefined;
    }
  }
  if (!id) return undefined;
  const profile = profiles.get(id);
  if (!profile) throw Error(`Unknown provider profile: ${id}`);
  if (profile.type !== config.type) throw Error(`Provider profile type mismatch: ${id}`);
  return profile;
}

// Explicit profiles opt into transport/capability defaults. Inference never replaces
// existing endpoints, commands, model capabilities or request policies.
export function applyProviderProfile(config: ProviderConfig): ProviderConfig {
  const profile = resolveProviderProfile(config);
  if (!config.profile || !profile) return config;
  return config.type === "cli"
    ? { ...config, responseCommand: { ...config.responseCommand, timeoutMs: config.responseCommand.timeoutMs ?? profile.quirks.timeouts.total } }
    : { ...config, timeoutMs: config.timeoutMs ?? profile.quirks.timeouts.total };
}

export function prepareProfileRequest(config: ProviderConfig, request: UnifiedRequest, profiles?: Map<string, ProviderProfile>): UnifiedRequest {
  if (!config.profile) return request;
  const profile = resolveProviderProfile(config, profiles)!;
  if (request.tools.length && !profile.capabilities.tools) throw new RequestCapabilityError(`Provider profile ${profile.id} does not support tools.`);
  if (request.metadata?.response_format && !profile.capabilities.json_mode) throw new RequestCapabilityError(`Provider profile ${profile.id} does not support JSON mode.`);
  if (profile.capabilities.system_prompt !== "prepend_to_user") return request;
  const system = request.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  if (!system) return request;
  const messages = request.messages.filter(m => m.role !== "system").map(m => ({ ...m }));
  const first = messages.find(m => m.role === "user");
  if (first) first.content = `${system}\n\n${first.content}`;
  else messages.unshift({ role: "user", content: system });
  return { ...request, messages };
}
