import { z } from "zod";
import { REASONING_EFFORT_VALUES } from "./types";

// Chat message validation
const chatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

const chatMessageSchema = z.object({
  role: chatRoleSchema,
  content: z.unknown().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.unknown().optional(),
  tool_call: z.unknown().optional(),
  function_call: z.unknown().optional(),
}).passthrough();

// Tool definition validation - flexible schema to allow various tool formats
// The actual normalization happens in the route handlers
const toolDefinitionSchema = z.object({
  type: z.literal("function").optional(),
  function: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      parameters: z.unknown().optional(),
    })
    .passthrough()
    .optional(),
  // Allow other properties that the normalization logic handles
  name: z.string().optional(),
  description: z.string().optional(),
  parameters: z.unknown().optional(),
}).passthrough();

const reasoningEffortSchema = z.enum(REASONING_EFFORT_VALUES);

const reasoningConfigSchema = z.object({
  effort: reasoningEffortSchema.optional(),
}).passthrough();

// Chat completions request schema
export const chatCompletionsRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  messages: z.array(chatMessageSchema).min(1, "messages must include at least one item"),
  tools: z.array(toolDefinitionSchema).optional(),
  functions: z.array(z.unknown()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().optional(),
  top_p: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  user: z.string().optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  reasoning: reasoningConfigSchema.optional(),
}).passthrough();

// Responses API input item schema - very permissive for n8n compatibility
// Accepts strings, objects, or null/undefined items
const responseInputItemSchema = z.union([
  z.string(),
  z.object({}).passthrough(), // Accept any object with passthrough
  z.null(),
  z.undefined(),
]);

// Responses API request schema
export const responsesRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  input: z.union([z.string(), responseInputItemSchema, z.array(responseInputItemSchema)]).optional(),
  instructions: z.string().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  functions: z.array(z.unknown()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().optional(),
  top_p: z.number().optional(),
  user: z.string().optional(),
  tool_choice: z.unknown().optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  reasoning: reasoningConfigSchema.optional(),
}).passthrough();

// Image generations request schema
export const imageGenerationsRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  prompt: z.unknown(),
  n: z.number().int().min(1).max(10).optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  style: z.string().optional(),
  user: z.string().optional(),
}).passthrough();

export const documentGenerationsRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  prompt: z.unknown(),
  n: z.number().int().min(1).max(10).optional(),
  file_type: z.string().optional(),
  filename: z.string().optional(),
  title: z.string().optional(),
  template: z.string().optional(),
  theme: z.string().optional(),
  style: z.string().optional(),
  audience: z.string().optional(),
  page_count: z.number().int().min(1).optional(),
  slide_count: z.number().int().min(1).optional(),
  user: z.string().optional(),
}).passthrough();

// Audio speech (TTS) request schema
export const audioSpeechRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  input: z.string().min(1, "input is required"),
  voice: z.string().optional(),
  response_format: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
  user: z.string().optional(),
});

// Audio transcriptions (STT) request schema
export const audioTranscriptionsRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  file: z.string().min(1, "file path is required"),
  language: z.string().optional(),
  prompt: z.string().optional(),
  response_format: z.enum(["json", "text", "srt", "verbose_json", "vtt"]).optional(),
  temperature: z.number().min(0).max(1).optional(),
  user: z.string().optional(),
});

// Audio translations request schema
export const audioTranslationsRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  file: z.string().min(1, "file path is required"),
  prompt: z.string().optional(),
  response_format: z.enum(["json", "text", "srt", "verbose_json", "vtt"]).optional(),
  temperature: z.number().min(0).max(1).optional(),
  user: z.string().optional(),
});

export const providerSessionCreateRequestSchema = z.object({
  providerId: z.string().min(1, "providerId is required"),
  mode: z.enum(["interactive", "login"]).default("interactive"),
  model: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  cols: z.number().int().min(20).max(400).default(120),
  rows: z.number().int().min(5).max(200).default(40),
}).passthrough();

export const providerSessionInputRequestSchema = z.object({
  data: z.string().min(1, "data is required"),
}).passthrough();

export const providerSessionResizeRequestSchema = z.object({
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200),
}).passthrough();

export const providerSessionSignalRequestSchema = z.object({
  signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]).default("SIGINT"),
}).passthrough();

const remoteAgentHandoffFileSchema = z.object({
  filename: z.string().min(1).max(160),
  mimeType: z.string().min(1).max(256),
  sizeBytes: z.number().int().positive().max(4 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  contentBase64: z.string().min(4),
  source: z.string().max(64).optional(),
  sourceUrl: z.string().max(2048).optional(),
  artifactId: z.string().max(256).optional(),
  description: z.string().max(2000).optional(),
}).strict();

export const remoteAgentHandoffSchema = z.object({
  version: z.literal("RemoteAgentHandoff/v1"),
  operationId: z.string().regex(/^[a-z0-9][a-z0-9-]{7,79}$/i),
  runDirectory: z.string().min(1),
  contextDirectory: z.string().min(1),
  manifestPath: z.string().min(1),
  sourceArtifactIds: z.array(z.string().min(1).max(256)).max(12),
  files: z.array(remoteAgentHandoffFileSchema).max(12),
  output: z.object({
    version: z.literal("RemoteAgentResultFiles/v1"),
    enabled: z.boolean(),
    directory: z.string().min(1),
    filesDirectory: z.string().min(1),
    manifestPath: z.string().min(1),
    requestedGlobs: z.array(z.string().min(1).max(512)).max(12),
    maxFiles: z.literal(12),
    maxFileBytes: z.literal(4 * 1024 * 1024),
    maxTotalBytes: z.literal(6 * 1024 * 1024),
  }).strict(),
}).strict();

export const remoteAgentTaskCreateRequestSchema = z.object({
  providerId: z.string().min(1, "providerId is required"),
  targetId: z.string().min(1, "targetId is required"),
  task: z.string().min(1, "task is required"),
  sessionId: z.string().min(1).max(256).optional(),
  cwd: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  cols: z.number().int().min(20).max(400).default(120),
  rows: z.number().int().min(5).max(200).default(40),
  handoff: remoteAgentHandoffSchema.optional(),
}).passthrough();

export const codexAgentRunRequestSchema = z.object({
  workspacePath: z.string().min(1, "workspacePath is required"),
  issue: z.object({
    id: z.string().optional(),
    identifier: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    state: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }).passthrough().optional(),
  prompt: z.string().min(1, "prompt is required"),
  attempt: z.unknown().optional().nullable(),
  continuation: z.boolean().optional(),
  threadId: z.string().min(1).optional(),
  config: z.object({
    approvalPolicy: z.string().optional(),
    threadSandbox: z.string().optional(),
    turnSandboxPolicy: z.unknown().optional(),
    turnTimeoutMs: z.number().int().positive().optional(),
    stallTimeoutMs: z.number().int().positive().optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
  }).passthrough().optional(),
  handoff: remoteAgentHandoffSchema.optional(),
}).passthrough();

export type ChatCompletionsRequest = z.infer<typeof chatCompletionsRequestSchema>;
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type ImageGenerationsRequest = z.infer<typeof imageGenerationsRequestSchema>;
export type DocumentGenerationsRequest = z.infer<typeof documentGenerationsRequestSchema>;
export type AudioSpeechRequest = z.infer<typeof audioSpeechRequestSchema>;
export type AudioTranscriptionsRequest = z.infer<typeof audioTranscriptionsRequestSchema>;
export type AudioTranslationsRequest = z.infer<typeof audioTranslationsRequestSchema>;
export type ProviderSessionCreateRequest = z.infer<typeof providerSessionCreateRequestSchema>;
export type ProviderSessionInputRequest = z.infer<typeof providerSessionInputRequestSchema>;
export type ProviderSessionResizeRequest = z.infer<typeof providerSessionResizeRequestSchema>;
export type ProviderSessionSignalRequest = z.infer<typeof providerSessionSignalRequestSchema>;
export type RemoteAgentTaskCreateRequest = z.infer<typeof remoteAgentTaskCreateRequestSchema>;
export type CodexAgentRunRequest = z.infer<typeof codexAgentRunRequestSchema>;
export type RemoteAgentHandoff = z.infer<typeof remoteAgentHandoffSchema>;
