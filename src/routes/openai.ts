import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LruMap } from "../utils/lru-map";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProviderRegistry } from "../providers/registry";
import type {
  AssistantPhase,
  ChatMessage,
  ProviderResult,
  ReasoningEffort,
  UnifiedToolDefinition,
} from "../types";
import { makeId } from "../utils/ids";
import { extractTextContent, extractTextContentOrJson } from "../utils/prompt";
import { resolveReasoningEffort } from "../utils/reasoning";
import {
  isSyntheticAssistantOutputText,
  normalizeAssistantResult,
  parseAssistantPayloadText,
} from "../utils/assistant-output";
import {
  chatCompletionsRequestSchema,
  responsesRequestSchema,
  imageGenerationsRequestSchema,
  documentGenerationsRequestSchema,
  audioSpeechRequestSchema,
  audioTranscriptionsRequestSchema,
} from "../validation";
import {
  buildChatUsage,
  buildResponsesUsage,
  mergeProviderUsage,
} from "../utils/usage";

// Cache tool definitions for sessions. n8n occasionally drops them on subsequent turns.
const multiTurnToolsCache = new LruMap<string, UnifiedToolDefinition[]>(100);
const responseStore = new LruMap<string, StoredResponseRecord>(250);

type ResponseMessageRole = "user" | "assistant" | "system" | "developer" | "tool";
type ResponseItemStatus = "completed";

interface ResponseTextContent {
  type: "input_text" | "output_text";
  text: string;
}

interface ResponseMessageItem {
  id: string;
  type: "message";
  role: ResponseMessageRole;
  phase?: AssistantPhase;
  status: ResponseItemStatus;
  content: ResponseTextContent[];
}

interface ResponseFunctionCallItem {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: ResponseItemStatus;
}

interface ResponseFunctionCallOutputItem {
  id: string;
  type: "function_call_output";
  call_id: string;
  output: string;
  status: ResponseItemStatus;
}

interface ResponseReasoningItem {
  id: string;
  type: "reasoning";
  text: string;
  status: ResponseItemStatus;
}

type StoredResponseInputItem = ResponseMessageItem | ResponseFunctionCallOutputItem;
type StoredResponseOutputItem = ResponseMessageItem | ResponseFunctionCallItem | ResponseReasoningItem;

interface ResponseOutputItemIds {
  messageId?: string;
  reasoningId?: string;
  toolCallItemIds?: Map<string, string>;
}

interface StoredResponseRecord {
  id: string;
  createdAt: number;
  completedAt: number;
  model: string;
  instructions?: string;
  previousResponseId?: string;
  conversationId: string;
  inputItems: StoredResponseInputItem[];
  outputItems: StoredResponseOutputItem[];
  outputText: string;
  usage?: ProviderResult["usage"];
}

export function getSessionSignature(
  messages: ChatMessage[],
  metadata?: Record<string, unknown>,
): string {
  const explicitSessionId = findSessionIdentifier(metadata);
  const firstSystem = messages.find((m) => m.role === "system")?.content || "";
  const firstUser = messages.find((m) => m.role === "user")?.content || "";
  const user = findMetadataString(metadata, ["user"]) || "";
  const content = explicitSessionId
    ? `session=${explicitSessionId}|user=${user}`
    : `${typeof firstSystem === "string" ? firstSystem : JSON.stringify(firstSystem)}|${typeof firstUser === "string" ? firstUser : JSON.stringify(firstUser)}|user=${user}`;
  return createHash("sha256").update(content).digest("hex");
}

function findSessionIdentifier(metadata?: Record<string, unknown>): string | undefined {
  const conversationId = findConversationId(metadata);
  if (conversationId) {
    return conversationId;
  }

  return findMetadataString(metadata, [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
    "previous_response_id",
    "previousResponseId",
    "response_id",
    "responseId",
  ]);
}

function findMetadataString(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const nestedMetadata =
    metadata.metadata && typeof metadata.metadata === "object"
      ? (metadata.metadata as Record<string, unknown>)
      : undefined;
  if (!nestedMetadata) {
    return undefined;
  }

  for (const key of keys) {
    const value = nestedMetadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function findPreviousResponseId(metadata?: Record<string, unknown>): string | undefined {
  return findMetadataString(metadata, ["previous_response_id", "previousResponseId"]);
}

function findConversationId(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const conversation = metadata.conversation;
  if (typeof conversation === "string" && conversation.trim()) {
    return conversation.trim();
  }
  if (conversation && typeof conversation === "object") {
    const record = conversation as Record<string, unknown>;
    if (typeof record.id === "string" && record.id.trim()) {
      return record.id.trim();
    }
  }

  return findMetadataString(metadata, [
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
    "session_id",
    "sessionId",
  ]);
}

function resolveConversationId(
  metadata: Record<string, unknown> | undefined,
  previousResponseId: string | undefined,
): string {
  const explicitConversationId = findConversationId(metadata);
  if (explicitConversationId) {
    return explicitConversationId;
  }

  if (previousResponseId) {
    const previous = responseStore.get(previousResponseId);
    if (previous?.conversationId) {
      return previous.conversationId;
    }
  }

  return makeId("conv");
}

function shouldHydratePreviousResponses(
  previousResponseId: string | undefined,
  inputMessages: ChatMessage[],
): previousResponseId is string {
  if (!previousResponseId) {
    return false;
  }

  return !inputMessages.some((message) =>
    message.role === "assistant" ||
    message.role === "tool" ||
    message.role === "system",
  );
}

function hydrateMessagesFromPreviousResponse(previousResponseId: string): ChatMessage[] {
  const chain: StoredResponseRecord[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = previousResponseId;

  while (currentId && !seen.has(currentId) && chain.length < 100) {
    seen.add(currentId);
    const record = responseStore.get(currentId);
    if (!record) {
      break;
    }
    chain.push(record);
    currentId = record.previousResponseId;
  }

  return chain
    .reverse()
    .flatMap((record) => [
      ...record.inputItems.flatMap(responseInputItemToChatMessages),
      ...record.outputItems.flatMap(responseOutputItemToChatMessages),
    ]);
}

function responseInputItemToChatMessages(item: StoredResponseInputItem): ChatMessage[] {
  if (item.type === "function_call_output") {
    return [
      buildChatMessage("tool", normalizeResponseText(item.output), {
        tool_call_id: item.call_id,
      }),
    ];
  }

  const role = normalizeResponseMessageRole(item.role);
  if (!role) {
    return [];
  }

  return [
    buildChatMessage(role, extractResponseMessageText(item.content), {
      phase: item.phase,
    }),
  ];
}

function responseOutputItemToChatMessages(item: StoredResponseOutputItem): ChatMessage[] {
  if (item.type === "function_call") {
    return [
      buildChatMessage("assistant", extractToolCallContext({
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      }), {
        phase: "commentary",
      }),
    ];
  }

  if (item.type === "reasoning") {
    return [];
  }

  const role = normalizeResponseMessageRole(item.role);
  if (!role) {
    return [];
  }

  return [
    buildChatMessage(role, extractResponseMessageText(item.content), {
      phase: item.phase,
    }),
  ];
}

function normalizeResponseMessageRole(
  role: ResponseMessageRole,
): ChatMessage["role"] | undefined {
  if (role === "developer") {
    return "system";
  }
  return asRole(role);
}

function extractResponseMessageText(content: ResponseTextContent[]): string {
  return content
    .map((item) => normalizeResponseText(item.text))
    .filter(Boolean)
    .join("\n\n");
}

function normalizeResponseText(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAssistantPhase(value: unknown): AssistantPhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function buildChatMessage(
  role: ChatMessage["role"],
  content: string,
  options: {
    phase?: AssistantPhase;
    reasoningContent?: unknown;
    tool_call_id?: string;
  } = {},
): ChatMessage {
  const message: ChatMessage = {
    role,
    content,
  };

  if (options.phase) {
    message.phase = options.phase;
  }
  if (options.reasoningContent !== undefined) {
    message.reasoningContent = options.reasoningContent;
  }
  if (options.tool_call_id) {
    message.tool_call_id = options.tool_call_id;
  }

  return message;
}

export function buildResponseInputItems(messages: ChatMessage[]): StoredResponseInputItem[] {
  const items: StoredResponseInputItem[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      items.push({
        id: makeId("fco"),
        type: "function_call_output",
        call_id: message.tool_call_id || makeId("call"),
        output: message.content,
        status: "completed",
      });
      continue;
    }

    items.push({
      id: makeId("msg"),
      type: "message",
      role: message.role,
      phase: message.role === "assistant" ? message.phase : undefined,
      status: "completed",
      content: buildResponseTextContent("input_text", message.content),
    });
  }

  return items;
}

export function buildResponseOutputItems(
  result: ProviderResult,
  ids: ResponseOutputItemIds = {},
): StoredResponseOutputItem[] {
  const items: StoredResponseOutputItem[] = [];

  if (result.outputText) {
    items.push({
      id: ids.messageId || makeId("msg"),
      type: "message",
      role: "assistant",
      phase: result.finishReason === "tool_calls" ? "commentary" : "final_answer",
      status: "completed",
      content: buildResponseTextContent("output_text", result.outputText),
    });
  }

  if (result.reasoningText) {
    items.push({
      id: ids.reasoningId || makeId("rsn"),
      type: "reasoning",
      text: normalizeResponseText(result.reasoningText),
      status: "completed",
    });
  }

  for (const call of result.toolCalls) {
    items.push({
      id: ids.toolCallItemIds?.get(call.id) || makeId("fc"),
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    });
  }

  return items;
}

function buildResponseTextContent(
  type: ResponseTextContent["type"],
  text: string,
): ResponseTextContent[] {
  const normalized = normalizeResponseText(text);
  if (!normalized) {
    return [];
  }

  return [{
    type,
    text: normalized,
  }];
}

function storeResponseRecord(record: StoredResponseRecord): StoredResponseRecord {
  responseStore.set(record.id, record);
  return record;
}

function buildStoredResponse(
  record: StoredResponseRecord,
): Record<string, unknown> {
  return {
    id: record.id,
    object: "response",
    created_at: record.createdAt,
    completed_at: record.completedAt,
    status: "completed",
    model: record.model,
    conversation: {
      id: record.conversationId,
    },
    previous_response_id: record.previousResponseId,
    instructions: record.instructions,
    input: record.inputItems,
    output_text: record.outputText,
    output: record.outputItems,
    usage: buildResponsesUsage(record.usage),
  };
}

function buildChatCompletionToolCalls(result: ProviderResult): Array<Record<string, unknown>> {
  return result.toolCalls.map((call) => ({
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.arguments,
    },
  }));
}

function buildChatCompletionMessage(result: ProviderResult): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.outputText || null,
    tool_calls: buildChatCompletionToolCalls(result),
  };
  if (result.reasoningText) {
    message.reasoning = result.reasoningText;
  }
  if (result.reasoningContent !== undefined) {
    message.reasoning_content = result.reasoningContent;
  }
  return message;
}

function resolveReturnedModel(requestedModel: string, result?: ProviderResult): string {
  return result?.resolvedModel || requestedModel;
}

function startSseStream(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  if (typeof reply.raw.flushHeaders === "function") {
    reply.raw.flushHeaders();
  }
  reply.raw.write(": stream-open\n\n");
}

function writeSseData(reply: FastifyReply, payload: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function computeMonotonicDelta(previousText: string, nextText: string): string {
  if (!nextText) {
    return "";
  }
  if (!previousText) {
    return nextText;
  }
  if (!nextText.startsWith(previousText)) {
    return "";
  }
  return nextText.slice(previousText.length);
}

function resolveFrontendToolAllowlist(metadata?: Record<string, unknown>): Set<string> {
  const candidateItems = collectFrontendToolCandidateItems(metadata, [
    "toolCandidates",
    "candidateTools",
    "candidate_tools",
    "allowedTools",
    "allowed_tools",
  ]);

  const allowedNames = new Set<string>();
  for (const item of candidateItems) {
    const name = extractFrontendToolCandidateName(item);
    if (name) {
      allowedNames.add(name.toLowerCase());
    }
  }

  return allowedNames;
}

function collectFrontendToolCandidateItems(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): unknown[] {
  if (!metadata || typeof metadata !== "object") {
    return [];
  }

  const directItems = collectFrontendToolCandidateItemsFromRecord(metadata, keys);
  if (directItems.length > 0) {
    return directItems;
  }

  const nestedMetadata =
    metadata.metadata && typeof metadata.metadata === "object"
      ? (metadata.metadata as Record<string, unknown>)
      : undefined;
  if (!nestedMetadata) {
    return [];
  }

  return collectFrontendToolCandidateItemsFromRecord(nestedMetadata, keys);
}

function collectFrontendToolCandidateItemsFromRecord(
  record: Record<string, unknown>,
  keys: string[],
): unknown[] {
  for (const key of keys) {
    const value = record[key];
    const items = normalizeFrontendToolCandidateItems(value);
    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

function normalizeFrontendToolCandidateItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.tools)) {
    return record.tools;
  }
  if (Array.isArray(record.functions)) {
    return record.functions;
  }
  if (Array.isArray(record.items)) {
    return record.items;
  }
  if (Array.isArray(record.candidates)) {
    return record.candidates;
  }

  return [];
}

function extractFrontendToolCandidateName(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const fnRecord =
    record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : undefined;
  const nestedToolRecord =
    record.tool && typeof record.tool === "object"
      ? (record.tool as Record<string, unknown>)
      : undefined;

  return firstNonEmptyString(
    record.name,
    record.functionName,
    record.function_name,
    record.toolName,
    record.tool_name,
    fnRecord?.name,
    nestedToolRecord?.name,
  );
}

function filterToolsByFrontendAllowlist(
  tools: UnifiedToolDefinition[],
  allowedToolNames: Set<string>,
  logWarn: (payload: Record<string, unknown>, message: string) => void,
  model: string,
  route: string,
  source: "request" | "cache",
): UnifiedToolDefinition[] {
  if (allowedToolNames.size === 0 || tools.length === 0) {
    return tools;
  }

  const filteredTools: UnifiedToolDefinition[] = [];
  const droppedToolNames: string[] = [];

  for (const tool of tools) {
    const toolName = tool.function.name;
    if (allowedToolNames.has(toolName.toLowerCase())) {
      filteredTools.push(tool);
      continue;
    }
    droppedToolNames.push(toolName);
  }

  if (droppedToolNames.length > 0) {
    logWarn(
      {
        model,
        route,
        source,
        allowedToolNames: [...allowedToolNames],
        droppedToolNames,
      },
      "Filtered tools against frontend allowlist.",
    );
  }

  return filteredTools;
}

interface OpenAiRoutesOptions {
  registry: ProviderRegistry;
  n8nApiKeys: Set<string>;
  defaultReasoningEffort?: ReasoningEffort;
}

export const openAiRoutes: FastifyPluginAsync<OpenAiRoutesOptions> = async (
  app,
  options,
) => {
  app.addHook("preHandler", async (request, reply) => {
    if (!isAuthorized(request, options.n8nApiKeys)) {
      sendOpenAiError(reply, 401, "Invalid API key.", "invalid_api_key");
      return reply;
    }
  });

  app.get("/models", async () => ({
    object: "list",
    data: options.registry.listModels().map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.providerId,
      description: model.description,
      provider_model: model.providerModel,
      fallback_models: model.fallbackModels,
      capabilities: model.capabilities,
      benchmark: model.benchmark,
    })),
  }));

  app.get("/responses/:responseId", async (request, reply) => {
    const responseId =
      typeof (request.params as { responseId?: string }).responseId === "string"
        ? (request.params as { responseId: string }).responseId
        : "";
    const stored = responseStore.get(responseId);
    if (!stored) {
      return sendOpenAiError(reply, 404, `Unknown response: ${responseId}`, "not_found");
    }
    return buildStoredResponse(stored);
  });

  app.get("/responses/:responseId/input_items", async (request, reply) => {
    const responseId =
      typeof (request.params as { responseId?: string }).responseId === "string"
        ? (request.params as { responseId: string }).responseId
        : "";
    const stored = responseStore.get(responseId);
    if (!stored) {
      return sendOpenAiError(reply, 404, `Unknown response: ${responseId}`, "not_found");
    }

    const query = (request.query ?? {}) as Record<string, unknown>;
    const limitValue = typeof query.limit === "number"
      ? query.limit
      : typeof query.limit === "string"
        ? Number.parseInt(query.limit, 10)
        : 20;
    const limit = Number.isFinite(limitValue)
      ? Math.max(1, Math.min(100, Math.trunc(limitValue)))
      : 20;
    const order = query.order === "asc" ? "asc" : "desc";
    const after = typeof query.after === "string" && query.after.trim()
      ? query.after.trim()
      : undefined;

    let items = [...stored.inputItems];
    if (order === "desc") {
      items.reverse();
    }
    if (after) {
      const afterIndex = items.findIndex((item) => item.id === after);
      if (afterIndex >= 0) {
        items = items.slice(afterIndex + 1);
      }
    }

    const data = items.slice(0, limit);
    return {
      object: "list",
      data,
      first_id: data[0]?.id,
      last_id: data[data.length - 1]?.id,
      has_more: items.length > data.length,
    };
  });

  app.post("/chat/completions", async (request, reply) => {
    const validationResult = validateBody(request.body, chatCompletionsRequestSchema);
    if (!validationResult.success) {
      request.log.warn(
        {
          error: validationResult.error,
          body: typeof request.body === "object" ? JSON.stringify(request.body).slice(0, 2000) : String(request.body)
        },
        "Chat completions validation failed"
      );
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }
    return await handleChatCompletionsRequest(
      validationResult.data,
      reply,
      options.registry,
      options.defaultReasoningEffort,
    );
  });

  app.post("/messages", async (request, reply) => {
    const validationResult = validateBody(request.body, chatCompletionsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }
    return await handleChatCompletionsRequest(
      validationResult.data,
      reply,
      options.registry,
      options.defaultReasoningEffort,
    );
  });

  app.post("/message", async (request, reply) => {
    const validationResult = validateBody(request.body, chatCompletionsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }
    return await handleChatCompletionsRequest(
      validationResult.data,
      reply,
      options.registry,
      options.defaultReasoningEffort,
    );
  });

  app.post("/responses", async (request, reply) => {
    const validationResult = validateBody(request.body, responsesRequestSchema);
    if (!validationResult.success) {
      // Log the failing request body for debugging
      request.log.warn(
        {
          error: validationResult.error,
          body: typeof request.body === "object" ? JSON.stringify(request.body).slice(0, 2000) : String(request.body)
        },
        "Responses API validation failed"
      );
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;

    // We do support a basic pseudo-stream now
    const isStream = Boolean(body.stream);

    const inputMessages = normalizeResponsesInput(body.input);
    const instructions = sanitizeInstructions(body.instructions);
    const previousResponseId = findPreviousResponseId(body as Record<string, unknown>);
    const priorMessages = shouldHydratePreviousResponses(previousResponseId, inputMessages)
      ? hydrateMessagesFromPreviousResponse(previousResponseId)
      : [];

    const messages: ChatMessage[] = [];
    messages.push(...priorMessages);
    if (instructions) {
      messages.push({
        role: "system",
        content: instructions,
      });
    }
    messages.push(...inputMessages);

    if (messages.length === 0) {
      return sendOpenAiError(reply, 400, "input or instructions must be provided.");
    }

    const rawTools = body.tools ?? body.functions ?? [];
    const frontendAllowedToolNames = resolveFrontendToolAllowlist(
      body as Record<string, unknown>,
    );
    let tools = filterToolsByFrontendAllowlist(
      normalizeTools(rawTools),
      frontendAllowedToolNames,
      app.log.warn.bind(app.log),
      body.model,
      "/responses",
      "request",
    );
    if (tools.length === 0 && rawTools.length > 0) {
      app.log.warn(
        {
          model: body.model,
          tool_payload_type: "array",
        },
        "No tools normalized from /responses request payload.",
      );
    }

    const sessionSig = getSessionSignature(messages, body as Record<string, unknown>);
    if (tools.length > 0) {
      multiTurnToolsCache.set(sessionSig, tools);
    } else if (messages.length > 2) {
      const cachedTools = multiTurnToolsCache.get(sessionSig);
      if (cachedTools && cachedTools.length > 0) {
        tools.push(
          ...filterToolsByFrontendAllowlist(
            cachedTools,
            frontendAllowedToolNames,
            app.log.warn.bind(app.log),
            body.model,
            "/responses",
            "cache",
          ),
        );
        app.log.debug(
          { model: body.model, sessionSig, cachedToolsCount: cachedTools.length },
          "Restored multi-turn tools from cache for /responses request.",
        );
      }
    }

    // Debug: trace when tools are missing on multi-turn responses requests
    if (tools.length === 0) {
      const hasToolResults = inputMessages.some(m => m.role === "tool" || m.tool_call_id);
      if (hasToolResults || inputMessages.some(m => m.role === "assistant")) {
        app.log.debug(
          {
            model: body.model,
            messageCount: inputMessages.length + messages.length,
            hasToolResults,
            rawToolsLength: rawTools.length,
          },
          "Multi-turn /responses request has no tools defined — tool calls from provider will pass through un-normalized.",
        );
      }
    }

    try {
      const reasoningEffort = resolveReasoningEffort(body, options.defaultReasoningEffort);
      const createdAt = Math.floor(Date.now() / 1000);
      const conversationId = resolveConversationId(
        body as Record<string, unknown>,
        previousResponseId,
      );
      const inputItems = buildResponseInputItems(inputMessages);
      const responseId = makeId("resp");
      const runRequest = {
        requestId: makeId("req"),
        messages,
        tools,
        stream: isStream,
        requestKind: "responses",
        reasoningEffort,
        metadata: body as Record<string, unknown>,
      };

      if (isStream && options.registry.canStreamModel(body.model)) {
        const streamedResult: ProviderResult = {
          outputText: "",
          reasoningText: "",
          toolCalls: [],
          finishReason: "stop",
        };
        const responseStreamIds = {
          messageId: makeId("msg"),
          reasoningId: makeId("rsn"),
          toolCallItemIds: new Map<string, string>(),
        };
        let sequenceNumber = 0;
        const writeResponseStreamEvent = (
          payload: Record<string, unknown>,
          status: "in_progress" | "completed" = "in_progress",
        ): void => {
          sequenceNumber += 1;
          writeSseData(reply, {
            id: responseId,
            object: "response.chunk",
            created_at: createdAt,
            status,
            model: body.model,
            previous_response_id: previousResponseId,
            conversation: {
              id: conversationId,
            },
            sequence_number: sequenceNumber,
            ...payload,
          });
        };
        startSseStream(reply);
        writeResponseStreamEvent({
          type: "response.created",
          response: {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "in_progress",
            model: body.model,
            previous_response_id: previousResponseId,
            conversation: {
              id: conversationId,
            },
          },
        });
        try {
          for await (const event of options.registry.runModelStream(body.model, runRequest)) {
            if (event.type === "output_text_delta") {
              streamedResult.outputText += event.delta;
              writeResponseStreamEvent({
                type: "response.output_text.delta",
                item_id: responseStreamIds.messageId,
                output_index: 0,
                content_index: 0,
                delta: event.delta,
                output_text_delta: event.delta,
              });
              continue;
            }
            if (event.type === "reasoning_delta") {
              streamedResult.reasoningText = `${streamedResult.reasoningText || ""}${event.delta}`;
              writeResponseStreamEvent({
                type: "response.reasoning_summary_text.delta",
                item_id: responseStreamIds.reasoningId,
                output_index: streamedResult.outputText ? 1 : 0,
                summary_index: 0,
                delta: event.delta,
                reasoning_delta: event.delta,
              });
              continue;
            }
            if (event.type === "tool_call") {
              const toolCallItemId = makeId("fc");
              responseStreamIds.toolCallItemIds.set(event.toolCall.id, toolCallItemId);
              const outputIndex =
                (streamedResult.outputText ? 1 : 0) +
                (streamedResult.reasoningText ? 1 : 0) +
                streamedResult.toolCalls.length;
              streamedResult.toolCalls.push(event.toolCall);
              writeResponseStreamEvent({
                type: "response.output_item.done",
                output_index: outputIndex,
                item_id: toolCallItemId,
                item: {
                  id: toolCallItemId,
                  type: "function_call",
                  call_id: event.toolCall.id,
                  name: event.toolCall.name,
                  arguments: event.toolCall.arguments,
                  status: "completed",
                },
                output: [
                  {
                    id: toolCallItemId,
                    type: "function_call",
                    call_id: event.toolCall.id,
                    name: event.toolCall.name,
                    arguments: event.toolCall.arguments,
                    status: "completed",
                  },
                ],
              });
              continue;
            }
            if (event.type === "done") {
              if (typeof event.reasoningText === "string") {
                const delta = computeMonotonicDelta(streamedResult.reasoningText || "", event.reasoningText);
                if (delta) {
                  streamedResult.reasoningText = event.reasoningText;
                  writeResponseStreamEvent({
                    type: "response.reasoning_summary_text.delta",
                    item_id: responseStreamIds.reasoningId,
                    output_index: streamedResult.outputText ? 1 : 0,
                    summary_index: 0,
                    delta,
                    reasoning_delta: delta,
                  });
                } else {
                  streamedResult.reasoningText = event.reasoningText;
                }
              }
              if (typeof event.outputText === "string") {
                const delta = computeMonotonicDelta(streamedResult.outputText, event.outputText);
                if (delta) {
                  streamedResult.outputText = event.outputText;
                  writeResponseStreamEvent({
                    type: "response.output_text.delta",
                    item_id: responseStreamIds.messageId,
                    output_index: 0,
                    content_index: 0,
                    delta,
                    output_text_delta: delta,
                  });
                } else {
                  streamedResult.outputText = event.outputText;
                }
              }
              streamedResult.finishReason = event.finishReason;
              streamedResult.usage = event.usage;
              continue;
            }
          }
        } catch (error) {
          writeResponseStreamEvent({
            type: "error",
            object: "error",
            error: error instanceof Error ? error.message : String(error),
          });
          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          return reply;
        }

        const returnedModel = resolveReturnedModel(body.model, streamedResult);
        logBlankAssistantResult(app.log.warn.bind(app.log), returnedModel, streamedResult, "/responses");
        if (streamedResult.outputText) {
          writeResponseStreamEvent({
            type: "response.output_text.done",
            item_id: responseStreamIds.messageId,
            output_index: 0,
            content_index: 0,
            text: streamedResult.outputText,
          });
        }
        if (streamedResult.reasoningText) {
          writeResponseStreamEvent({
            type: "response.reasoning_summary_text.done",
            item_id: responseStreamIds.reasoningId,
            output_index: streamedResult.outputText ? 1 : 0,
            summary_index: 0,
            text: streamedResult.reasoningText,
          });
        }
        const outputItems = buildResponseOutputItems(streamedResult, responseStreamIds);
        const storedResponse = storeResponseRecord({
          id: responseId,
          createdAt,
          completedAt: createdAt,
          model: returnedModel,
          instructions: instructions || undefined,
          previousResponseId,
          conversationId,
          inputItems,
          outputItems,
          outputText: streamedResult.outputText,
          usage: streamedResult.usage,
        });
        const responsePayload = buildStoredResponse(storedResponse);
        writeResponseStreamEvent({
          type: "response.completed",
          response: responsePayload,
          ...responsePayload,
        }, "completed");
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      }

      const result = normalizeAssistantResult(await options.registry.runModel(body.model, runRequest));
      const returnedModel = resolveReturnedModel(body.model, result);
      logBlankAssistantResult(app.log.warn.bind(app.log), returnedModel, result, "/responses");
      const outputItems = buildResponseOutputItems(result);

      for (const call of result.toolCalls) {
        app.log.debug(
          {
            tool_call_id: call.id,
            tool_name: call.name,
            tool_arguments: call.arguments.slice(0, 500),
          },
          "Returning tool call"
        );
      }

      const storedResponse = storeResponseRecord({
        id: responseId,
        createdAt,
        completedAt: createdAt,
        model: returnedModel,
        instructions: instructions || undefined,
        previousResponseId,
        conversationId,
        inputItems,
        outputItems,
        outputText: result.outputText,
        usage: result.usage,
      });
      const responsePayload = buildStoredResponse(storedResponse);

      if (isStream) {
        startSseStream(reply);

        const chunkData = {
          id: responseId,
          object: "response.chunk",
          created_at: createdAt,
          status: "completed",
          model: returnedModel,
          previous_response_id: previousResponseId,
          conversation: {
            id: conversationId,
          },
          output_text: result.outputText,
          output: outputItems,
        };

        reply.raw.write(`data: ${JSON.stringify(chunkData)}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      }

      return responsePayload;
    } catch (error) {
      return handleModelError(reply, error);
    }
  });

  app.post("/images/generations", async (request, reply) => {
    const validationResult = validateBody(request.body, imageGenerationsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;
    const prompt = extractTextContent(body.prompt);

    if (!prompt.trim()) {
      return sendOpenAiError(reply, 400, "prompt is required.");
    }

    const n = Math.min(body.n ?? 1, 10);
    const effectiveModel =
      options.registry.resolvePreferredImageGenerationModel(body.model) ?? body.model;

    try {
      if (effectiveModel !== body.model) {
        app.log.info(
          {
            requestedModel: body.model,
            effectiveModel,
          },
          "Routed image generation request through preferred Codex-backed model.",
        );
      }

      const images: OpenAiImageItem[] = [];
      const providerResults: ProviderResult[] = [];

      for (let imageIndex = 0; imageIndex < n && images.length < n; imageIndex += 1) {
        const result = await options.registry.runModel(effectiveModel, {
          requestId: makeId("req"),
          messages: [{ role: "user", content: prompt }],
          tools: [],
          requestKind: "images_generations",
          metadata: {
            ...(body as Record<string, unknown>),
            n: 1,
            requested_count: n,
            image_index: imageIndex,
            requested_model: body.model,
            effective_model: effectiveModel,
          },
        });

        providerResults.push(result);
        const parsedImages = parseImageGenerationsFromResult(result);
        if (parsedImages.length === 0) {
          request.log.warn(
            {
              requestedModel: body.model,
              effectiveModel,
              requestedCount: n,
              imageIndex,
              providerResult: summarizeProviderImageResult(result),
            },
            "Provider returned no parseable image data.",
          );
          return sendOpenAiError(
            reply,
            500,
            "Provider returned no parseable image data.",
            "provider_error",
          );
        }

        images.push(...parsedImages.slice(0, n - images.length));
      }

      request.log.info(
        {
          requestedModel: body.model,
          effectiveModel,
          requestedCount: n,
          parsedCount: images.length,
          providerCallCount: providerResults.length,
          returnedCount: images.length,
          images: summarizeImageItemsForLog(images),
        },
        "Image generation response parsed.",
      );

      return {
        created: Math.floor(Date.now() / 1000),
        model: effectiveModel,
        requested_model: body.model,
        provider_call_count: providerResults.length,
        usage: buildResponsesUsage(mergeProviderUsage(providerResults.map((item) => item.usage))),
        data: images,
      };
    } catch (error) {
      return handleModelError(reply, error);
    }
  });

  const handleDocumentGenerations = async (request: FastifyRequest, reply: FastifyReply) => {
    const validationResult = validateBody(request.body, documentGenerationsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;
    const prompt = extractTextContent(body.prompt);

    if (!prompt.trim()) {
      return sendOpenAiError(reply, 400, "prompt is required.");
    }

    const n = Math.min(body.n ?? 1, 10);

    try {
      const result = normalizeAssistantResult(await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages: [{ role: "user", content: prompt }],
        tools: [],
        requestKind: "documents_generations",
        metadata: body as Record<string, unknown>,
      }));

      const documents = parseDocumentGenerations(result.outputText, {
        fileType: body.file_type,
        filename: body.filename,
      });
      if (documents.length === 0) {
        return sendOpenAiError(
          reply,
          500,
          "Provider returned no parseable document data.",
          "provider_error",
        );
      }

      return {
        created: Math.floor(Date.now() / 1000),
        data: documents.slice(0, n),
      };
    } catch (error) {
      return handleModelError(reply, error);
    }
  };

  app.post("/documents/generations", handleDocumentGenerations);
  app.post("/files/generations", handleDocumentGenerations);
  app.post("/presentations/generations", handleDocumentGenerations);

  // Audio Speech (TTS) endpoint
  app.post("/audio/speech", async (request, reply) => {
    const validationResult = validateBody(request.body, audioSpeechRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;

    try {
      const result = await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages: [{ role: "user", content: body.input }],
        tools: [],
        requestKind: "audio_speech",
        metadata: body as Record<string, unknown>,
      });

      const audioData = parseAudioResponse(result.outputText);
      if (!audioData) {
        return sendOpenAiError(
          reply,
          500,
          "Provider returned no parseable audio data.",
          "provider_error",
        );
      }

      // Return audio data as binary or JSON depending on format
      if (audioData.format === "json") {
        return reply.type("application/json").send({
          audio: audioData.audio,
          format: audioData.format_type || "wav",
        });
      }

      const contentType = getAudioContentType(audioData.format_type || "wav");
      return reply
        .type(contentType)
        .header("Content-Disposition", `inline; filename="speech.${audioData.format_type || "wav"}"`)
        .send(Buffer.from(audioData.audio, "base64"));
    } catch (error) {
      return handleModelError(reply, error);
    }
  });

  // Audio Transcriptions (STT) endpoint
  app.post("/audio/transcriptions", async (request, reply) => {
    const validationResult = validateBody(request.body, audioTranscriptionsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;

    try {
      const result = await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages: [{ role: "user", content: body.file }],
        tools: [],
        requestKind: "audio_transcriptions",
        metadata: body as Record<string, unknown>,
      });

      const transcription = extractTranscriptionText(result.outputText);
      const format = body.response_format || "json";

      if (format === "text") {
        return reply.type("text/plain").send(transcription);
      }

      return {
        text: transcription,
      };
    } catch (error) {
      return handleModelError(reply, error);
    }
  });

  // Audio Translations endpoint
  app.post("/audio/translations", async (request, reply) => {
    const validationResult = validateBody(request.body, audioTranscriptionsRequestSchema);
    if (!validationResult.success) {
      return sendOpenAiError(reply, 400, validationResult.error, "invalid_request_error");
    }

    const body = validationResult.data;

    try {
      const result = await options.registry.runModel(body.model, {
        requestId: makeId("req"),
        messages: [{ role: "user", content: body.file }],
        tools: [],
        requestKind: "audio_translations",
        metadata: { ...body, task: "translate" } as Record<string, unknown>,
      });

      const transcription = extractTranscriptionText(result.outputText);
      const format = body.response_format || "json";

      if (format === "text") {
        return reply.type("text/plain").send(transcription);
      }

      return {
        text: transcription,
      };
    } catch (error) {
      return handleModelError(reply, error);
    }
  });
};

interface ValidationResult<T> {
  success: true;
  data: T;
}

interface ValidationError {
  success: false;
  error: string;
}

function validateBody<T>(
  body: unknown,
  schema: z.ZodSchema<T>,
): ValidationResult<T> | ValidationError {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    });
    return { success: false, error: issues.join("; ") };
  }
  return { success: true, data: result.data };
}

async function handleChatCompletionsRequest(
  body: z.infer<typeof chatCompletionsRequestSchema>,
  reply: FastifyReply,
  registry: ProviderRegistry,
  defaultReasoningEffort?: ReasoningEffort,
) {
  const isStream = Boolean(body.stream);

  const messages = normalizeChatMessages(body.messages);
  if (messages.length === 0) {
    return sendOpenAiError(reply, 400, "messages must include at least one item.");
  }

  const rawTools = body.tools ?? body.functions ?? [];
  const frontendAllowedToolNames = resolveFrontendToolAllowlist(
    body as Record<string, unknown>,
  );
  let tools = filterToolsByFrontendAllowlist(
    normalizeTools(rawTools),
    frontendAllowedToolNames,
    reply.log.warn.bind(reply.log),
    body.model,
    "/chat/completions",
    "request",
  );
  if (tools.length === 0 && rawTools.length > 0) {
    reply.log.warn(
      {
        model: body.model,
        tool_payload_type: "array",
      },
      "No tools normalized from chat request payload.",
    );
  }
  const sessionSig = getSessionSignature(messages, body as Record<string, unknown>);
  if (tools.length > 0) {
    multiTurnToolsCache.set(sessionSig, tools);
  } else if (messages.length > 2) {
    const cachedTools = multiTurnToolsCache.get(sessionSig);
    if (cachedTools && cachedTools.length > 0) {
      tools.push(
        ...filterToolsByFrontendAllowlist(
          cachedTools,
          frontendAllowedToolNames,
          reply.log.warn.bind(reply.log),
          body.model,
          "/chat/completions",
          "cache",
        ),
      );
      reply.log.debug(
        { model: body.model, sessionSig, cachedToolsCount: cachedTools.length },
        "Restored multi-turn tools from cache for /chat/completions request.",
      );
    }
  }

  // Debug: trace when tools are missing on multi-turn requests that contain
  // tool results, which is often the signal that n8n is not re-sending tools.
  if (tools.length === 0) {
    const hasToolMessages = messages.some(m => m.role === "tool" || m.tool_call_id);
    const hasAssistantMessages = messages.some(m => m.role === "assistant");
    if (hasToolMessages || hasAssistantMessages) {
      reply.log.debug(
        {
          model: body.model,
          messageCount: messages.length,
          hasToolMessages,
          hasAssistantMessages,
          rawToolsLength: rawTools.length,
        },
        "Multi-turn chat request has no tools defined - tool calls from provider will pass through un-normalized.",
      );
    }
  }

  try {
    const reasoningEffort = resolveReasoningEffort(body, defaultReasoningEffort);
    const runRequest = {
      requestId: makeId("req"),
      messages,
      tools,
      stream: isStream,
      requestKind: "chat_completions",
      reasoningEffort,
      metadata: body as Record<string, unknown>,
    };

    if (isStream && registry.canStreamModel(body.model)) {
      const respId = makeId("chatcmpl");
      const created = Math.floor(Date.now() / 1000);
      const streamedResult: ProviderResult = {
        outputText: "",
        reasoningText: "",
        toolCalls: [],
        finishReason: "stop",
      };
      startSseStream(reply);
      writeSseData(reply, {
        id: respId,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
            },
            finish_reason: null,
          },
        ],
      });
      try {
        for await (const event of registry.runModelStream(body.model, runRequest)) {
          if (event.type === "output_text_delta") {
            streamedResult.outputText += event.delta;
            writeSseData(reply, {
              id: respId,
              object: "chat.completion.chunk",
              created,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: event.delta,
                  },
                  finish_reason: null,
                },
              ],
            });
            continue;
          }
          if (event.type === "reasoning_delta") {
            streamedResult.reasoningText = `${streamedResult.reasoningText || ""}${event.delta}`;
            writeSseData(reply, {
              id: respId,
              object: "chat.completion.chunk",
              created,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    reasoning: event.delta,
                  },
                  finish_reason: null,
                },
              ],
            });
            continue;
          }
          if (event.type === "tool_call") {
            const toolCallIndex = streamedResult.toolCalls.length;
            streamedResult.toolCalls.push(event.toolCall);
            writeSseData(reply, {
              id: respId,
              object: "chat.completion.chunk",
              created,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolCallIndex,
                        id: event.toolCall.id,
                        type: "function",
                        function: {
                          name: event.toolCall.name,
                          arguments: event.toolCall.arguments,
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            });
            continue;
          }
          if (event.type === "done") {
            if (typeof event.reasoningText === "string") {
              const delta = computeMonotonicDelta(streamedResult.reasoningText || "", event.reasoningText);
              if (delta) {
                streamedResult.reasoningText = event.reasoningText;
                writeSseData(reply, {
                  id: respId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        reasoning: delta,
                      },
                      finish_reason: null,
                    },
                  ],
                });
              } else {
                streamedResult.reasoningText = event.reasoningText;
              }
            }
            if (typeof event.outputText === "string") {
              const delta = computeMonotonicDelta(streamedResult.outputText, event.outputText);
              if (delta) {
                streamedResult.outputText = event.outputText;
                writeSseData(reply, {
                  id: respId,
                  object: "chat.completion.chunk",
                  created,
                  model: body.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: delta,
                      },
                      finish_reason: null,
                    },
                  ],
                });
              } else {
                streamedResult.outputText = event.outputText;
              }
            }
            streamedResult.finishReason = event.finishReason;
            streamedResult.usage = event.usage;
            continue;
          }
        }
      } catch (error) {
        writeSseData(reply, {
          object: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      }

      writeSseData(reply, {
        id: respId,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason:
              streamedResult.toolCalls.length > 0 ? "tool_calls" : streamedResult.finishReason,
          },
        ],
        usage: buildChatUsage(streamedResult.usage),
      });
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return reply;
    }

    const result = normalizeAssistantResult(await registry.runModel(body.model, runRequest));
    const returnedModel = resolveReturnedModel(body.model, result);
    logBlankAssistantResult(reply.log.warn.bind(reply.log), returnedModel, result, "/chat/completions");

    // Log tool calls for debugging
    if (result.toolCalls.length > 0) {
      for (const call of result.toolCalls) {
        reply.log.debug(
          {
            tool_call_id: call.id,
            tool_name: call.name,
            tool_arguments: call.arguments.slice(0, 500),
          },
          "Returning chat completion tool call"
        );
      }
    }

    if (isStream) {
      startSseStream(reply);

      const respId = makeId("chatcmpl");
      const created = Math.floor(Date.now() / 1000);

      const chunkData = {
        id: respId,
        object: "chat.completion.chunk",
        created,
        model: returnedModel,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: result.outputText || null,
              reasoning: result.reasoningText,
              tool_calls: buildChatCompletionToolCalls(result),
            },
            finish_reason: result.toolCalls.length > 0 ? "tool_calls" : result.finishReason,
          },
        ],
        usage: buildChatUsage(result.usage),
      };

      reply.raw.write(`data: ${JSON.stringify(chunkData)}\n\n`);
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return reply;
    }

      return {
        id: makeId("chatcmpl"),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: returnedModel,
        choices: [
          {
            index: 0,
            message: buildChatCompletionMessage(result),
            finish_reason:
              result.toolCalls.length > 0 ? "tool_calls" : result.finishReason,
          },
        ],
      usage: buildChatUsage(result.usage),
    };
  } catch (error) {
    return handleModelError(reply, error);
  }
}

function normalizeTools(raw: unknown[]): UnifiedToolDefinition[] {
  const items = normalizeToolItems(raw);
  if (items.length === 0) {
    return [];
  }

  const tools: UnifiedToolDefinition[] = [];
  const seenNames = new Set<string>();
  for (const item of items) {
    const parsed = parseToolDefinition(item);
    if (!parsed) {
      continue;
    }
    const dedupeKey = parsed.name.toLowerCase();
    if (seenNames.has(dedupeKey)) {
      continue;
    }
    seenNames.add(dedupeKey);
    tools.push({
      type: "function",
      function: {
        name: parsed.name,
        description: parsed.description,
        parameters: parsed.parameters,
      },
    });
  }

  return tools;
}

function normalizeToolItems(raw: unknown[]): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.tools)) {
    return record.tools;
  }
  if (Array.isArray(record.functions)) {
    return record.functions;
  }

  return [];
}

function parseToolDefinition(
  value: unknown,
): { name: string; description?: string; parameters?: unknown } | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const fnRecord =
    record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : undefined;
  const nestedToolRecord =
    record.tool && typeof record.tool === "object"
      ? (record.tool as Record<string, unknown>)
      : undefined;

  const name = firstNonEmptyString(
    record.name,
    record.functionName,
    record.function_name,
    record.toolName,
    record.tool_name,
    typeof record.function === "string" ? record.function : undefined,
    fnRecord?.name,
    nestedToolRecord?.name,
  );
  if (!name) {
    return null;
  }

  const description = firstNonEmptyString(
    record.description,
    fnRecord?.description,
    nestedToolRecord?.description,
  );

  const parameters = firstDefined(
    fnRecord?.parameters,
    fnRecord?.input_schema,
    fnRecord?.inputSchema,
    record.parameters,
    record.input_schema,
    record.inputSchema,
    nestedToolRecord?.parameters,
    nestedToolRecord?.input_schema,
    nestedToolRecord?.inputSchema,
  );

  return {
    name,
    description,
    parameters,
  };
}

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function firstDefined(...candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

export function normalizeChatMessages(raw: unknown[]): ChatMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const role = asRole(record.role);
    if (!role) {
      continue;
    }

    const content = normalizeMessageContentForRole(
      role,
      record.content,
      record.tool_calls ?? record.tool_call ?? record.function_call,
    );
    if (
      shouldDropSyntheticAssistantHistoryMessage(
        role,
        content,
        record.tool_calls ?? record.tool_call ?? record.function_call,
      )
    ) {
      continue;
    }
    const message: ChatMessage = {
      role,
      content,
    };
    if (typeof record.name === "string") {
      message.name = record.name;
    }
    if (typeof record.tool_call_id === "string") {
      message.tool_call_id = record.tool_call_id;
    }
    const reasoningContent = firstDefined(
      record.reasoning_content,
      record.reasoningContent,
      record.reasoning,
    );
    if (reasoningContent !== undefined) {
      message.reasoningContent = reasoningContent;
    }
    messages.push(message);
  }
  return messages;
}

export function normalizeResponsesInput(raw: unknown, depth = 0): ChatMessage[] {
  if (depth > 10) return [];

  if (typeof raw === "string") {
    return [{ role: "user", content: raw }];
  }

  if (raw === null || raw === undefined) {
    return [];
  }

  if (Array.isArray(raw)) {
    const out: ChatMessage[] = [];
    for (const item of raw) {
      out.push(...normalizeResponsesInput(item, depth + 1));
    }
    return out;
  }

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const record = raw as Record<string, unknown>;
  const role = inferResponsesRole(record);

  if (record.type === "input_text" && typeof record.text === "string") {
    return [{ role: "user", content: record.text }];
  }

  if (record.type === "function_call_output") {
    const callId =
      typeof record.call_id === "string"
        ? record.call_id
        : typeof record.tool_call_id === "string"
          ? record.tool_call_id
          : typeof record.id === "string"
            ? record.id
            : undefined;
    const outputText = extractTextContentOrJson(
      record.output ?? record.content ?? record.text ?? "",
    );
    return [
      buildChatMessage("tool", outputText, { tool_call_id: callId }),
    ];
  }

  if (record.type === "function_call") {
    const callId =
      typeof record.call_id === "string"
        ? record.call_id
        : typeof record.tool_call_id === "string"
          ? record.tool_call_id
          : typeof record.id === "string"
            ? record.id
            : undefined;
    const toolCallText = extractToolCallContext({
      id: callId,
      name: record.name,
      arguments: record.arguments ?? record.input,
    });
    if (!toolCallText) {
      return [];
    }
    return [
      buildChatMessage("assistant", toolCallText, { phase: "commentary" }),
    ];
  }

  if (record.type === "reasoning") {
    return [];
  }

  // Handle tool role directly (n8n sometimes sends this)
  if (role === "tool" || record.type === "tool_result") {
    const callId =
      typeof record.tool_call_id === "string"
        ? record.tool_call_id
        : typeof record.call_id === "string"
          ? record.call_id
          : typeof record.id === "string"
            ? record.id
            : undefined;
    const outputText = extractTextContentOrJson(
      record.content ?? record.output ?? record.text ?? "",
    );
    return [
      {
        role: "tool",
        content: outputText,
        tool_call_id: callId,
      },
    ];
  }

  if (record.type === "message") {
    const content = normalizeMessageContentForRole(
      role,
      record.content,
      record.tool_calls ?? record.tool_call ?? record.function_call,
    );
    if (
      shouldDropSyntheticAssistantHistoryMessage(
        role,
        content,
        record.tool_calls ?? record.tool_call ?? record.function_call,
      )
    ) {
      return [];
    }
    return [
      buildChatMessage(role, content, {
        phase: role === "assistant" ? normalizeAssistantPhase(record.phase) : undefined,
        reasoningContent: role === "assistant" ? extractReasoningContentField(record) : undefined,
      }),
    ];
  }

  if ("content" in record) {
    const content = normalizeMessageContentForRole(
      role,
      record.content,
      record.tool_calls ?? record.tool_call ?? record.function_call,
    );
    if (
      shouldDropSyntheticAssistantHistoryMessage(
        role,
        content,
        record.tool_calls ?? record.tool_call ?? record.function_call,
      )
    ) {
      return [];
    }
    return [
      buildChatMessage(role, content, {
        phase: role === "assistant" ? normalizeAssistantPhase(record.phase) : undefined,
        reasoningContent: role === "assistant" ? extractReasoningContentField(record) : undefined,
      }),
    ];
  }

  if (typeof record.text === "string") {
    return [{ role: "user", content: record.text }];
  }

  return [];
}

function asRole(value: unknown): ChatMessage["role"] | undefined {
  if (
    value === "system" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool"
  ) {
    return value;
  }

  return undefined;
}

function extractReasoningContentField(record: Record<string, unknown>): unknown {
  return firstDefined(
    record.reasoning_content,
    record.reasoningContent,
    record.reasoning,
  );
}

function inferResponsesRole(record: Record<string, unknown>): ChatMessage["role"] {
  if (record.role === "developer") {
    return "system";
  }

  const explicitRole = asRole(record.role);
  if (explicitRole) {
    return explicitRole;
  }

  if (record.type === "function_call_output" || record.type === "tool_result") {
    return "tool";
  }

  if (record.type === "function_call") {
    return "assistant";
  }

  if (
    hasToolContext(record.tool_calls ?? record.tool_call ?? record.function_call) ||
    looksLikeAssistantResponseContent(record.content)
  ) {
    return "assistant";
  }

  return "user";
}

function mergeMessageContent(content: string, extra: string): string {
  const base = content.trim();
  const appended = extra.trim();
  if (!base) {
    return appended;
  }
  if (!appended) {
    return base;
  }
  return `${base}\n\n${appended}`;
}

function shouldDropSyntheticAssistantHistoryMessage(
  role: ChatMessage["role"],
  content: string,
  toolContext: unknown,
): boolean {
  if (role !== "assistant") {
    return false;
  }

  if (hasToolContext(toolContext)) {
    return false;
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return true;
  }

  return isSyntheticAssistantOutputText(trimmed);
}

function normalizeMessageContentForRole(
  role: ChatMessage["role"],
  content: unknown,
  toolContext: unknown,
): string {
  const explicitToolCalls = normalizeToolCallContext(toolContext);
  const baseContent =
    role === "tool"
      ? extractTextContentOrJson(content)
      : extractTextContent(content);
  if (role !== "assistant") {
    return mergeMessageContent(baseContent, renderToolCallContext(explicitToolCalls));
  }

  const parsed = parseAssistantPayloadText(extractTextContent(content));
  const combinedToolCalls = dedupeToolCallContext([
    ...parsed.toolCalls,
    ...explicitToolCalls,
  ]);
  return mergeMessageContent(parsed.outputText, renderToolCallContext(combinedToolCalls));
}

function hasToolContext(value: unknown): boolean {
  return normalizeToolCallContext(value).length > 0;
}

function looksLikeAssistantResponseContent(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => looksLikeAssistantResponseContent(item, depth + 1));
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (
    type === "output_text" ||
    type === "text" ||
    type === "message" ||
    type === "output_message"
  ) {
    return true;
  }

  if (
    (typeof record.text === "string" && record.text.trim()) ||
    (typeof record.output_text === "string" && record.output_text.trim()) ||
    (typeof record.content === "string" && record.content.trim())
  ) {
    return true;
  }

  return [record.text, record.output_text, record.content].some((item) =>
    looksLikeAssistantResponseContent(item, depth + 1),
  );
}

function extractToolCallContext(value: unknown): string {
  const normalized = normalizeToolCallContext(value);
  return renderToolCallContext(normalized);
}

function renderToolCallContext(
  normalized: Array<{ id?: string; name: string; arguments: string }>,
): string {
  if (normalized.length === 0) {
    return "";
  }
  return `TOOL_CALLS:\n${JSON.stringify(normalized)}`;
}

function normalizeToolCallContext(
  value: unknown,
): Array<{ id?: string; name: string; arguments: string }> {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const out: Array<{ id?: string; name: string; arguments: string }> = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : undefined;

    const name =
      firstNonEmptyString(
        record.name,
        record.tool_name,
        record.toolName,
        fn?.name,
      ) ?? "";
    if (!name) {
      continue;
    }

    const id = firstNonEmptyString(record.id, record.call_id, record.tool_call_id);
    const argsRaw =
      firstDefined(
        record.arguments,
        record.args,
        record.parameters,
        record.input,
        fn?.arguments,
        fn?.args,
      ) ?? {};
    out.push({
      id,
      name,
      arguments: stringifyToolContextArguments(argsRaw),
    });
  }

  return out;
}

function dedupeToolCallContext(
  toolCalls: Array<{ id?: string; name: string; arguments: string }>,
): Array<{ id?: string; name: string; arguments: string }> {
  const out: Array<{ id?: string; name: string; arguments: string }> = [];
  const seen = new Set<string>();

  for (const call of toolCalls) {
    const name = typeof call.name === "string" ? call.name.trim() : "";
    if (!name) {
      continue;
    }
    const id = typeof call.id === "string" ? call.id.trim() : "";
    const argumentsText = typeof call.arguments === "string" ? call.arguments : "{}";
    const key = `${id}|${name}|${argumentsText}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      id: id || undefined,
      name,
      arguments: argumentsText,
    });
  }

  return out;
}

function stringifyToolContextArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function isAuthorized(request: FastifyRequest, allowedKeys: Set<string>): boolean {
  const xApiKey = request.headers["x-api-key"];
  const xApiKeyValue = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  if (typeof xApiKeyValue === "string" && allowedKeys.has(xApiKeyValue.trim())) {
    return true;
  }

  const header = request.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return false;
  }
  const token = header.slice("bearer ".length).trim();
  return allowedKeys.has(token);
}

function sendOpenAiError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  type = "invalid_request_error",
): FastifyReply {
  return reply.status(statusCode).send({
    error: {
      message,
      type,
      code: statusCode,
    },
  });
}

function handleModelError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof Error && error.message.startsWith("Unknown model:")) {
    return sendOpenAiError(reply, 404, error.message, "invalid_model");
  }

  const message =
    error instanceof Error ? error.message : "Unexpected provider execution error.";
  return sendOpenAiError(reply, 500, message, "provider_error");
}

type OpenAiImageItem = {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
};

type OpenAiDocumentItem = {
  filename?: string;
  mime_type?: string;
  b64_data?: string;
  download_url?: string;
  title?: string;
  summary?: string;
  text?: string;
  markdown?: string;
  html?: string;
  page_count?: number;
  slide_count?: number;
  theme?: string;
  template?: string;
  design_style?: string;
  preview_url?: string;
  preview_b64_json?: string;
  slides?: Array<{
    title?: string;
    subtitle?: string;
    text?: string;
    notes?: string;
    bullets?: string[];
    image_url?: string;
  }>;
};

function parseImageGenerations(text: string): OpenAiImageItem[] {
  const direct = normalizeImagePayload(text.trim());
  if (direct.length > 0) {
    return direct;
  }

  for (const candidate of extractJsonCandidates(text)) {
    const parsed = normalizeImagePayload(candidate);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [];
}

function parseImageGenerationsFromResult(result: ProviderResult): OpenAiImageItem[] {
  const fromText = parseImageGenerations(result.outputText);
  if (fromText.length > 0) {
    return fromText;
  }

  if (result.raw !== undefined) {
    return normalizeImagePayload(result.raw);
  }

  return [];
}

function extractJsonCandidates(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    out.push(trimmed);
  };

  push(input);

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(input)) !== null) {
    push(match[1] ?? "");
  }

  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start !== -1 && end > start) {
    push(input.slice(start, end + 1));
  }

  return out;
}

const IMAGE_NESTED_PAYLOAD_KEYS = [
  "data",
  "images",
  "image",
  "inline_data",
  "inlineData",
  "output",
  "outputs",
  "content",
  "contentItems",
  "candidates",
  "parts",
  "items",
  "attachments",
  "artifact",
  "artifacts",
  "file",
  "files",
] as const;

function normalizeImagePayload(raw: unknown, depth = 0): OpenAiImageItem[] {
  if (depth > 8) {
    return [];
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    const parsed = tryParseJson(trimmed);
    if (parsed !== null) {
      return normalizeImagePayload(parsed, depth + 1);
    }

    const dataUrlMatch = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(trimmed);
    if (dataUrlMatch && dataUrlMatch[1]) {
      return [{ b64_json: dataUrlMatch[1] }];
    }

    const localImage = normalizeLocalImageFileUrl(trimmed);
    if (localImage) {
      return [localImage];
    }

    const markdownImageMatch = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i.exec(trimmed);
    if (markdownImageMatch && markdownImageMatch[1]) {
      const url = normalizeImageUrlString(markdownImageMatch[1]);
      return url ? [{ url }] : [];
    }

    const url = normalizeImageUrlString(trimmed);
    if (url) {
      return [{ url }];
    }

    const normalizedBase64 = normalizeBase64ImageData(trimmed);
    if (normalizedBase64) {
      return [{ b64_json: normalizedBase64 }];
    }

    return [];
  }

  if (Array.isArray(raw)) {
    return dedupeImageItems(
      raw.flatMap((item) => normalizeImagePayload(item, depth + 1)).filter(isImageItem),
    );
  }

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const obj = raw as Record<string, unknown>;
  const items: OpenAiImageItem[] = [];
  const single = normalizeImageItem(obj, depth + 1);
  if (single) {
    items.push(single);
  }

  for (const key of IMAGE_NESTED_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      continue;
    }
    items.push(...normalizeImagePayload(obj[key], depth + 1));
  }

  return dedupeImageItems(items.filter(isImageItem));
}

function normalizeImageItem(raw: unknown, depth = 0): OpenAiImageItem | null {
  if (typeof raw === "string") {
    return normalizeImagePayload(raw, depth + 1)[0] ?? null;
  }

  if (!raw || typeof raw !== "object") {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const imageRef = normalizeImageReferenceValue(
    obj.url ??
      obj.image_url ??
      obj.imageUrl ??
      obj.output_url ??
      obj.outputUrl ??
      obj.download_url ??
      obj.downloadUrl ??
      obj.uri,
  );
  const resultImage = normalizeResultImageValue(obj.result, depth + 1);
  const inlineImage = normalizeInlineImageValue(obj.inline_data ?? obj.inlineData, depth + 1);
  const dataImage =
    typeof obj.data === "string" && isLikelyImageRecord(obj)
      ? normalizeImagePayload(obj.data, depth + 1)[0]
      : undefined;
  const b64 =
    typeof obj.b64_json === "string"
      ? obj.b64_json.trim()
      : typeof obj.base64 === "string"
        ? obj.base64.trim()
        : typeof obj.b64 === "string"
          ? obj.b64.trim()
          : typeof obj.b64_data === "string"
            ? obj.b64_data.trim()
            : typeof obj.base64_data === "string"
              ? obj.base64_data.trim()
              : typeof obj.image_base64 === "string"
                ? obj.image_base64.trim()
                : typeof obj.imageBase64 === "string"
                  ? obj.imageBase64.trim()
                  : resultImage.b64_json ?? "";
  const directB64Image = b64 ? normalizeImagePayload(b64, depth + 1)[0] : undefined;
  const revisedPrompt =
    typeof obj.revised_prompt === "string"
      ? obj.revised_prompt
      : typeof obj.revisedPrompt === "string"
        ? obj.revisedPrompt
        : undefined;

  const url = imageRef.url || resultImage.url || inlineImage.url || directB64Image?.url || "";
  const normalizedB64 =
    imageRef.b64_json ||
    resultImage.b64_json ||
    inlineImage.b64_json ||
    dataImage?.b64_json ||
    directB64Image?.b64_json ||
    b64;

  if (!url && !normalizedB64) {
    return null;
  }

  return {
    url: url || undefined,
    b64_json: normalizedB64 || undefined,
    revised_prompt: revisedPrompt,
  };
}

function isImageItem(value: OpenAiImageItem | null): value is OpenAiImageItem {
  return Boolean(value && (value.url || value.b64_json));
}

function dedupeImageItems(items: OpenAiImageItem[]): OpenAiImageItem[] {
  const out: OpenAiImageItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.url ? `url:${item.url}` : `b64:${item.b64_json}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

function summarizeImageItemsForLog(items: OpenAiImageItem[]): Array<Record<string, unknown>> {
  return items.map((item) => ({
    transport: item.b64_json ? "b64_json" : "url",
    b64Length: item.b64_json ? item.b64_json.length : undefined,
    url: item.url ? summarizeUrlForLog(item.url) : undefined,
    hasRevisedPrompt: Boolean(item.revised_prompt),
  }));
}

function summarizeProviderImageResult(result: ProviderResult): Record<string, unknown> {
  return {
    finishReason: result.finishReason,
    outputText: summarizeTextForLog(result.outputText),
    toolCallCount: result.toolCalls.length,
    hasRaw: result.raw !== undefined,
    raw: summarizeRawImagePayloadForLog(result.raw),
  };
}

function summarizeRawImagePayloadForLog(value: unknown, depth = 0): unknown {
  if (value === undefined) {
    return { type: "undefined" };
  }
  if (value === null) {
    return { type: "null" };
  }

  if (typeof value === "string") {
    return {
      type: "string",
      ...summarizeTextForLog(value),
    };
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return { type: typeof value, value };
  }

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: depth >= 3
        ? undefined
        : value.slice(0, 3).map((item) => summarizeRawImagePayloadForLog(item, depth + 1)),
    };
  }

  if (typeof value !== "object") {
    return { type: typeof value };
  }

  const record = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    type: "object",
    keys: Object.keys(record).slice(0, 16),
  };

  if (depth >= 3) {
    return summary;
  }

  for (const key of [
    "data",
    "images",
    "image",
    "inline_data",
    "inlineData",
    "output",
    "outputs",
    "content",
    "contentItems",
    "candidates",
    "parts",
    "items",
    "attachments",
    "artifact",
    "artifacts",
    "file",
    "files",
    "result",
    "url",
    "image_url",
    "imageUrl",
    "b64_json",
    "b64_data",
    "base64",
    "base64_data",
    "image_base64",
    "imageBase64",
    "b64",
  ]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      summary[key] = summarizeRawImagePayloadForLog(record[key], depth + 1);
    }
  }

  return summary;
}

function summarizeTextForLog(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  const compact = trimmed.replace(/\s+/g, " ");
  const looksLikeImageData =
    /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(trimmed) ||
    normalizeBase64ImageData(trimmed) !== null;
  const preview = looksLikeImageData
    ? "<image-data>"
    : redactImageDataFromLogPreview(compact.slice(0, 240));

  return {
    length: value.length,
    preview,
    redacted: looksLikeImageData || undefined,
  };
}

function redactImageDataFromLogPreview(value: string): string {
  return value
    .replace(
      /(data:image\/[a-zA-Z0-9.+-]+;base64,)[A-Za-z0-9+/=]{32,}/gi,
      "$1<image-data>",
    )
    .replace(
      /("(?:b64_json|base64|b64)"\s*:\s*")[A-Za-z0-9+/=]{32,}/gi,
      "$1<image-data>",
    );
}

function summarizeUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    const queryMarker = url.search ? "?..." : "";
    return `${url.protocol}//${url.host}${url.pathname}${queryMarker}`;
  } catch {
    return value.slice(0, 160);
  }
}

function normalizeImageUrlString(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed) || /[<>]/.test(trimmed)) {
    return "";
  }
  return isPlaceholderImageUrl(trimmed) ? "" : trimmed;
}

function isPlaceholderImageUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "example.com" ||
      hostname === "www.example.com" ||
      hostname === "example.net" ||
      hostname === "www.example.net" ||
      hostname === "example.org" ||
      hostname === "www.example.org" ||
      hostname.endsWith(".example")
    );
  } catch {
    return true;
  }
}

function normalizeLocalImageFileUrl(value: string): OpenAiImageItem | null {
  if (!/^file:\/\//i.test(value)) {
    return null;
  }

  let filePath = "";
  try {
    filePath = fileURLToPath(value);
  } catch {
    return null;
  }

  if (!isAllowedLocalImageArtifactPath(filePath)) {
    return null;
  }

  try {
    const bytes = readFileSync(filePath);
    if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024 || !isSupportedImageBytes(bytes)) {
      return null;
    }
    return { b64_json: bytes.toString("base64") };
  } catch {
    return null;
  }
}

function isAllowedLocalImageArtifactPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/.codex/generated_images/") ||
    normalized.includes("/.codex/artifacts/")
  );
}

function isSupportedImageBytes(bytes: Buffer): boolean {
  return (
    bufferStartsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ||
    bufferStartsWith(bytes, [0xff, 0xd8, 0xff]) ||
    bufferStartsWith(bytes, [0x47, 0x49, 0x46, 0x38]) ||
    (bufferStartsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP") ||
    bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase().startsWith("<svg")
  );
}

function bufferStartsWith(bytes: Buffer, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function normalizeImageReferenceValue(value: unknown): OpenAiImageItem {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return normalizeImagePayload(trimmed)[0] ?? {};
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return normalizeImageReferenceValue(record.url ?? record.image_url ?? record.imageUrl);
  }

  return {};
}

function normalizeResultImageValue(value: unknown, depth = 0): OpenAiImageItem {
  const direct = normalizeImagePayload(value, depth + 1)[0];
  return direct ?? {};
}

function normalizeInlineImageValue(value: unknown, depth = 0): OpenAiImageItem {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    return normalizeImagePayload(value, depth + 1)[0] ?? {};
  }

  if (typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  const data = firstNonEmptyString(
    record.data,
    record.b64_json,
    record.base64,
    record.b64,
    record.b64_data,
    record.base64_data,
  );
  if (!data) {
    return normalizeImagePayload(record, depth + 1)[0] ?? {};
  }

  const normalized = normalizeImagePayload(data, depth + 1)[0];
  return normalized ?? { b64_json: data.replace(/\s/g, "") };
}

function normalizeBase64ImageData(value: string): string | null {
  const normalized = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]{100,}={0,2}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function isLikelyImageRecord(record: Record<string, unknown>): boolean {
  const type = firstNonEmptyString(record.type)?.toLowerCase() ?? "";
  const mimeType = firstNonEmptyString(record.mime_type, record.mimeType)?.toLowerCase() ?? "";
  return (
    type.includes("image") ||
    mimeType.startsWith("image/") ||
    "inline_data" in record ||
    "inlineData" in record ||
    "b64_json" in record ||
    "b64_data" in record ||
    "base64" in record ||
    "base64_data" in record ||
    "image_base64" in record ||
    "imageBase64" in record ||
    "image_url" in record ||
    "imageUrl" in record ||
    "image" in record ||
    "result" in record
  );
}

export function parseDocumentGenerations(
  text: string,
  defaults?: { fileType?: string; filename?: string },
): OpenAiDocumentItem[] {
  const direct = normalizeDocumentPayload(text.trim(), defaults);
  if (direct.length > 0) {
    return direct;
  }

  for (const candidate of extractJsonCandidates(text)) {
    const parsed = normalizeDocumentPayload(candidate, defaults);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [];
}

function normalizeDocumentPayload(
  raw: unknown,
  defaults?: { fileType?: string; filename?: string },
): OpenAiDocumentItem[] {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    const parsed = tryParseJson(trimmed);
    if (parsed !== null) {
      return normalizeDocumentPayload(parsed, defaults);
    }

    const dataUrlMatch = /^data:([^;]+);base64,(.+)$/i.exec(trimmed);
    if (dataUrlMatch && dataUrlMatch[1] && dataUrlMatch[2]) {
      return [{
        filename: normalizeDocumentFilename(defaults?.filename, defaults?.fileType, dataUrlMatch[1]),
        mime_type: dataUrlMatch[1],
        b64_data: dataUrlMatch[2],
      }];
    }

    const compact = trimmed.replace(/\s/g, "");
    if (/^[A-Za-z0-9+/]{100,}={0,2}$/.test(compact)) {
      const mimeType = inferDocumentMimeType(defaults?.fileType, defaults?.filename);
      return [{
        filename: normalizeDocumentFilename(defaults?.filename, defaults?.fileType, mimeType),
        mime_type: mimeType,
        b64_data: compact,
      }];
    }

    return [];
  }

  if (Array.isArray(raw)) {
    return raw.flatMap((item) => normalizeDocumentItem(item, defaults)).filter(isDocumentItem);
  }

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.data)) {
    return obj.data.flatMap((item) => normalizeDocumentItem(item, defaults)).filter(isDocumentItem);
  }

  if (Array.isArray(obj.items)) {
    return obj.items.flatMap((item) => normalizeDocumentItem(item, defaults)).filter(isDocumentItem);
  }

  if (Array.isArray(obj.documents)) {
    return obj.documents.flatMap((item) => normalizeDocumentItem(item, defaults)).filter(isDocumentItem);
  }

  if (Array.isArray(obj.files)) {
    return obj.files.flatMap((item) => normalizeDocumentItem(item, defaults)).filter(isDocumentItem);
  }

  if (Array.isArray(obj.artifacts)) {
    return obj.artifacts.flatMap((item) => normalizeDocumentItem(item, defaults)).filter(isDocumentItem);
  }

  const single = normalizeDocumentItem(obj, defaults);
  return single ? [single] : [];
}

function normalizeDocumentItem(
  raw: unknown,
  defaults?: { fileType?: string; filename?: string },
): OpenAiDocumentItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const base64ValueRaw =
    typeof obj.b64_data === "string"
      ? obj.b64_data.trim()
      : typeof obj.b64_json === "string"
        ? obj.b64_json.trim()
        : typeof obj.base64 === "string"
          ? obj.base64.trim()
          : typeof obj.data === "string"
            ? extractBase64FromDataUrl(obj.data.trim()) ?? obj.data.trim()
            : "";
  const base64Value = base64ValueRaw.replace(/\s/g, "");
  const normalizedBase64 = isLikelyBase64(base64Value) ? base64Value : undefined;

  const downloadUrl =
    typeof obj.download_url === "string"
      ? obj.download_url.trim()
      : typeof obj.downloadUrl === "string"
        ? obj.downloadUrl.trim()
        : typeof obj.url === "string" && /^https?:\/\//i.test(obj.url.trim())
          ? obj.url.trim()
          : "";

  const mimeType =
    typeof obj.mime_type === "string"
      ? obj.mime_type.trim()
      : typeof obj.mimeType === "string"
        ? obj.mimeType.trim()
        : typeof obj.content_type === "string"
          ? obj.content_type.trim()
          : typeof obj.contentType === "string"
            ? obj.contentType.trim()
            : inferDocumentMimeType(defaults?.fileType, typeof obj.filename === "string" ? obj.filename : typeof obj.name === "string" ? obj.name : defaults?.filename);

  const filename =
    typeof obj.filename === "string"
      ? obj.filename.trim()
        : typeof obj.name === "string"
          ? obj.name.trim()
          : normalizeDocumentFilename(defaults?.filename, defaults?.fileType, mimeType);

  const title = firstDocumentString(
    obj.title,
    obj.document_title,
    obj.documentTitle,
    obj.name,
  );
  const summary = firstDocumentString(
    obj.summary,
    obj.description,
    obj.abstract,
    obj.excerpt,
  );
  const text = normalizeDocumentText(
    firstDefinedDocumentValue(
      obj.text,
      obj.content_text,
      obj.contentText,
      obj.plain_text,
      obj.plainText,
      !normalizedBase64 ? obj.data : undefined,
    ),
  );
  const markdown = normalizeDocumentText(
    firstDefinedDocumentValue(
      obj.markdown,
      obj.md,
      obj.content_markdown,
      obj.contentMarkdown,
    ),
  );
  const html = normalizeDocumentText(
    firstDefinedDocumentValue(
      obj.html,
      obj.content_html,
      obj.contentHtml,
    ),
  );
  const pageCount = normalizePositiveInteger(
    firstDefinedDocumentValue(obj.page_count, obj.pageCount),
  );
  const slideCount = normalizePositiveInteger(
    firstDefinedDocumentValue(obj.slide_count, obj.slideCount, obj.slides_count, obj.slidesCount),
  );
  const theme = firstDocumentString(obj.theme);
  const template = firstDocumentString(obj.template, obj.template_name, obj.templateName);
  const designStyle = firstDocumentString(obj.design_style, obj.designStyle, obj.style);
  const previewUrl = firstDocumentString(
    obj.preview_url,
    obj.previewUrl,
    obj.thumbnail_url,
    obj.thumbnailUrl,
  );
  const previewB64Json = normalizePreviewBase64(
    firstDefinedDocumentValue(
      obj.preview_b64_json,
      obj.previewB64Json,
      obj.thumbnail_b64,
      obj.thumbnailB64,
    ),
  );
  const slides = normalizeDocumentSlides(
    firstDefinedDocumentValue(obj.slides, obj.pages, obj.outline),
  );

  if (
    !normalizedBase64 &&
    !downloadUrl &&
    !title &&
    !summary &&
    !text &&
    !markdown &&
    !html &&
    !previewUrl &&
    !previewB64Json &&
    slides.length === 0
  ) {
    return null;
  }

  return {
    filename,
    mime_type: mimeType,
    b64_data: normalizedBase64,
    download_url: downloadUrl || undefined,
    title,
    summary,
    text,
    markdown,
    html,
    page_count: pageCount,
    slide_count: slideCount,
    theme,
    template,
    design_style: designStyle,
    preview_url: previewUrl,
    preview_b64_json: previewB64Json,
    slides: slides.length > 0 ? slides : undefined,
  };
}

function isDocumentItem(value: OpenAiDocumentItem | null): value is OpenAiDocumentItem {
  return Boolean(
    value &&
      (
        value.b64_data ||
        value.download_url ||
        value.text ||
        value.markdown ||
        value.html ||
        value.title ||
        value.summary ||
        value.preview_url ||
        value.preview_b64_json ||
        (value.slides && value.slides.length > 0)
      ),
  );
}

function extractBase64FromDataUrl(value: string): string | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(value);
  return match && match[2] ? match[2] : null;
}

function isLikelyBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]{100,}={0,2}$/.test(value);
}

function normalizePreviewBase64(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const extracted = extractBase64FromDataUrl(trimmed) ?? trimmed;
  const compact = extracted.replace(/\s/g, "");
  return isLikelyBase64(compact) ? compact : undefined;
}

function normalizeDocumentText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeDocumentSlides(
  value: unknown,
): Array<{
  title?: string;
  subtitle?: string;
  text?: string;
  notes?: string;
  bullets?: string[];
  image_url?: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: Array<{
    title?: string;
    subtitle?: string;
    text?: string;
    notes?: string;
    bullets?: string[];
    image_url?: string;
  }> = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const bullets = normalizeSlideBullets(
      firstDefinedDocumentValue(obj.bullets, obj.points, obj.items),
    );
    const slide = {
      title: firstDocumentString(obj.title, obj.heading),
      subtitle: firstDocumentString(obj.subtitle, obj.subheading),
      text: normalizeDocumentText(firstDefinedDocumentValue(obj.text, obj.content, obj.body)),
      notes: normalizeDocumentText(firstDefinedDocumentValue(obj.notes, obj.speaker_notes, obj.speakerNotes)),
      bullets: bullets.length > 0 ? bullets : undefined,
      image_url: firstDocumentString(obj.image_url, obj.imageUrl, obj.url),
    };
    if (
      slide.title ||
      slide.subtitle ||
      slide.text ||
      slide.notes ||
      slide.image_url ||
      slide.bullets
    ) {
      out.push(slide);
    }
  }

  return out;
}

function normalizeSlideBullets(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => Boolean(item));
}

function firstDocumentString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function firstDefinedDocumentValue(...candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeDocumentFilename(
  filename: string | undefined,
  fileType: string | undefined,
  mimeType: string | undefined,
): string {
  const trimmedFilename = typeof filename === "string" ? filename.trim() : "";
  if (trimmedFilename) {
    return trimmedFilename;
  }

  const extension = inferDocumentExtension(fileType, mimeType);
  return `document.${extension}`;
}

function inferDocumentMimeType(fileType?: string, filename?: string): string {
  const extension = inferDocumentExtension(fileType, undefined, filename);
  const mimeTypes: Record<string, string> = {
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pdf: "application/pdf",
    txt: "text/plain",
    html: "text/html",
    csv: "text/csv",
    json: "application/json",
  };
  return mimeTypes[extension] || "application/octet-stream";
}

function inferDocumentExtension(
  fileType?: string,
  mimeType?: string,
  filename?: string,
): string {
  const fromFileType = typeof fileType === "string" ? fileType.trim().toLowerCase().replace(/^\./, "") : "";
  if (fromFileType) {
    return fromFileType;
  }

  const fromFilename =
    typeof filename === "string" && filename.includes(".")
      ? filename.slice(filename.lastIndexOf(".") + 1).trim().toLowerCase()
      : "";
  if (fromFilename) {
    return fromFilename;
  }

  const fromMimeType = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  if (fromMimeType.includes("presentationml.presentation")) {
    return "pptx";
  }
  if (fromMimeType.includes("wordprocessingml.document")) {
    return "docx";
  }
  if (fromMimeType.includes("spreadsheetml.sheet")) {
    return "xlsx";
  }
  if (fromMimeType.includes("/pdf")) {
    return "pdf";
  }
  if (fromMimeType.includes("/html")) {
    return "html";
  }
  if (fromMimeType.includes("/csv")) {
    return "csv";
  }
  if (fromMimeType.includes("/json")) {
    return "json";
  }
  if (fromMimeType.includes("/plain")) {
    return "txt";
  }

  return "bin";
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Sanitizes the instructions field to prevent injection attacks.
 * - Trims whitespace
 * - Limits length to 10000 characters
 * - Removes null bytes
 */
function sanitizeInstructions(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();

  // Remove null bytes
  const noNulls = trimmed.replace(/\x00/g, "");

  // Limit length to prevent abuse
  const maxLength = 10000;
  if (noNulls.length > maxLength) {
    return noNulls.slice(0, maxLength);
  }

  return noNulls;
}

// Audio response parsing types
interface AudioResponse {
  audio: string;
  format: "base64" | "json";
  format_type?: string;
}

function parseAudioResponse(text: string): AudioResponse | null {
  const trimmed = text.trim();

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.audio === "string") {
      return {
        audio: parsed.audio,
        format: "base64",
        format_type: parsed.format || "wav",
      };
    }
  } catch {
    // Not valid JSON, try other formats
  }

  // Check if it's a data URL
  const dataUrlMatch = /^data:audio\/([a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(trimmed);
  if (dataUrlMatch && dataUrlMatch[1] && dataUrlMatch[2]) {
    return {
      audio: dataUrlMatch[2],
      format: "base64",
      format_type: dataUrlMatch[1],
    };
  }

  // Check if it's raw base64 (at least 100 chars to avoid false positives)
  if (/^[A-Za-z0-9+/]{100,}={0,2}$/.test(trimmed.replace(/\s/g, ""))) {
    return {
      audio: trimmed.replace(/\s/g, ""),
      format: "base64",
      format_type: "wav",
    };
  }

  return null;
}

function getAudioContentType(format: string): string {
  const mimeTypes: Record<string, string> = {
    mp3: "audio/mpeg",
    opus: "audio/opus",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    pcm: "audio/pcm",
    ogg: "audio/ogg",
    webm: "audio/webm",
  };
  return mimeTypes[format.toLowerCase()] || "audio/wav";
}

function extractTranscriptionText(text: string): string {
  const trimmed = text.trim();

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    // Not JSON, return as-is
  }

  return trimmed;
}

function logBlankAssistantResult(
  warn: (obj: Record<string, unknown>, msg?: string) => void,
  model: string,
  result: ProviderResult,
  endpoint: string,
): void {
  if (result.outputText || result.toolCalls.length > 0) {
    return;
  }

  const debug = extractProviderDebugData(result.raw);
  warn(
    {
      endpoint,
      model,
      normalized_finish_reason: result.finishReason,
      provider_response_id: debug.responseId,
      provider_finish_reason: debug.finishReason,
      provider_message: debug.message,
      provider_message_content_shape: debug.messageContentShape,
      provider_executed_tools: debug.executedTools,
      provider_reasoning: debug.reasoning,
      provider_x_groq: debug.xGroq,
      provider_payload_keys: debug.payloadKeys,
    },
    "Provider returned a blank assistant completion.",
  );
}

function extractProviderDebugData(payload: unknown): {
  responseId?: string;
  finishReason?: string;
  message?: Record<string, unknown>;
  messageContentShape?: unknown;
  xGroq?: Record<string, unknown>;
  executedTools?: unknown[];
  reasoning?: unknown;
  payloadKeys?: string[];
} {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const record = payload as Record<string, unknown>;
  const choice =
    Array.isArray(record.choices) && record.choices[0] && typeof record.choices[0] === "object"
      ? (record.choices[0] as Record<string, unknown>)
      : undefined;
  const message =
    choice?.message && typeof choice.message === "object"
      ? (choice.message as Record<string, unknown>)
      : undefined;
  const xGroq =
    record.x_groq && typeof record.x_groq === "object"
      ? (record.x_groq as Record<string, unknown>)
      : undefined;
  const executedTools = Array.isArray(message?.executed_tools)
    ? message.executed_tools
    : undefined;
  const reasoning =
    extractProviderReasoningValue(message) ??
    extractProviderReasoningValue(choice) ??
    extractProviderReasoningValue(record);

  return {
    responseId: typeof record.id === "string" ? record.id : undefined,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    message,
    messageContentShape: summarizeContentShape(message?.content),
    xGroq,
    executedTools,
    reasoning,
    payloadKeys: Object.keys(record).slice(0, 20),
  };
}

function extractProviderReasoningValue(record?: Record<string, unknown>): unknown {
  if (!record) {
    return undefined;
  }

  const candidates = [
    record.reasoning,
    record.reasoning_content,
    record.reasoningContent,
    record.reasoning_text,
    record.reasoningText,
    record.summary,
    record.summary_text,
    record.summaryText,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }

  if (!Array.isArray(record.content)) {
    return undefined;
  }

  const parts = record.content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      const part = item as Record<string, unknown>;
      const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
      if (
        !type.includes("reason") &&
        !type.includes("summary") &&
        !type.includes("thinking")
      ) {
        return "";
      }

      return extractTextContent(part).trim();
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function summarizeContentShape(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return "string";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => summarizeContentShape(item));
  }

  if (!value || typeof value !== "object") {
    return typeof value;
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "object";
  const keys = Object.keys(record).slice(0, 10);
  return {
    type,
    keys,
  };
}
