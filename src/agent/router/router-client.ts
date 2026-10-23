import { z } from "zod";
import type { ProviderRegistry } from "../../providers/registry.js";
import type {
  AutoRouterDecisionSnapshot,
  ChatMessage,
  ProviderResult,
  ReasoningEffort,
  UnifiedRequest,
  UnifiedToolDefinition,
} from "../../types.js";
import { digest } from "../crypto/sealed.js";
import { effectSchema, tierSchema } from "../policy/risk.js";
export const planSchema = z
  .object({
    steps: z.array(
      z
        .object({
          kind: z.enum(["delegate", "ask_caller", "finish"]),
          effect: effectSchema,
          tier: tierSchema,
          spec: z.record(z.unknown()).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const steerSchema = z
  .object({
    action: z.enum(["continue", "stop", "retry", "replan", "ask_caller"]),
    reason: z.string(),
  })
  .strict();
export interface DecisionInput {
  kind: "plan" | "steer" | "summarize" | "check" | "code" | "chat";
  messages: ChatMessage[];
  tools?: UnifiedToolDefinition[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  excludeProviders?: string[];
  signal?: AbortSignal;
  budget: { maxCalls: number; deadlineMs: number };
  requestId: string;
}
export interface DecisionReceipt {
  requestId: string;
  kind: string;
  requestedModel: string;
  resolvedModel?: string;
  candidatesTop3: string[];
  inputDigest: string;
  outputDigest: string;
  startedAt: number;
  endedAt: number;
}
export interface RouterDecision extends ProviderResult {
  receipt: DecisionReceipt;
  needsReview?: boolean;
}
export interface RouterClient {
  decide(input: DecisionInput): Promise<RouterDecision>;
  explain(input: DecisionInput): AutoRouterDecisionSnapshot | undefined;
}
export class NativeRouterClient implements RouterClient {
  constructor(private registry: ProviderRegistry) {}
  private request(input: DecisionInput): UnifiedRequest {
    return {
      requestId: input.requestId,
      model: input.model ?? "auto",
      providerModel: input.model ?? "auto",
      messages: input.messages,
      tools: input.tools ?? [],
      signal: input.signal,
      reasoningEffort: input.reasoningEffort,
      requestKind: input.kind,
      metadata: {
        agentKind: input.kind,
        gateway_policy: {
          operationId: input.requestId,
          allowFallback: !input.excludeProviders?.length,
          maxAttempts: Math.min(8, input.budget.maxCalls),
          maxLatencyMs: Math.min(600000, input.budget.deadlineMs),
        },
      },
    };
  }
  explain(input: DecisionInput) {
    return this.registry.explainAutoRouting(this.request(input));
  }
  async decide(input: DecisionInput): Promise<RouterDecision> {
    if (input.budget.maxCalls < 1 || input.budget.deadlineMs <= 0)
      throw Error("Decision budget exhausted");
    const startedAt = Date.now(),
      explanation = this.explain(input);
    let model = input.model ?? "auto";
    if (input.excludeProviders?.length) {
      const candidate = explanation.candidates.find(
        (c) => !input.excludeProviders!.includes(c.providerId),
      );
      if (!candidate) throw Error("No independent provider available");
      model = candidate.modelId;
    }
    const schema =
      input.kind === "plan"
        ? planSchema
        : input.kind === "steer"
          ? steerSchema
          : undefined;
    let output: ProviderResult | undefined;
    let remaining = input.budget.maxCalls;
    for (
      let attempt = 0;
      attempt < Math.min(schema ? 2 : 1, input.budget.maxCalls);
      attempt++
    ) {
      const deadlineMs = input.budget.deadlineMs - (Date.now() - startedAt);
      if (remaining < 1 || deadlineMs <= 0) break;
      const request = this.request({
        ...input,
        model,
        budget: {
          maxCalls: schema && !attempt ? Math.max(1, remaining - 1) : remaining,
          deadlineMs,
        },
      });
      const before = remaining;
      request.receipt = (receipt) => {
        if (receipt.type === "gateway.execution.attempt") remaining--;
      };
      if (attempt)
        request.messages = [
          ...input.messages,
          { role: "assistant", content: output?.outputText ?? "" },
          {
            role: "system",
            content: `Repair your response as valid JSON matching: ${input.kind === "plan" ? '{"steps":[{"kind":"delegate|ask_caller|finish","effect":"read|write|execute|send|spend|delete|deploy|dns|merge|contact","tier":"R0|R1|R2|R3|R4","spec":{}}]}' : '{"action":"continue|stop|retry|replan|ask_caller","reason":"text"}'}`,
          },
        ];
      output = await this.registry.runModel(model, request);
      if (before === remaining) remaining--;
      try {
        if (schema) schema.parse(JSON.parse(output.outputText));
        return {
          ...output,
          receipt: this.receipt(input, output, explanation, startedAt),
        };
      } catch {
        /* One bounded schema repair. */
      }
    }
    if (!output) throw Error("No decision");
    return {
      ...output,
      needsReview: true,
      receipt: this.receipt(input, output, explanation, startedAt),
    };
  }
  private receipt(
    input: DecisionInput,
    result: ProviderResult,
    explanation: AutoRouterDecisionSnapshot,
    startedAt: number,
  ): DecisionReceipt {
    return {
      requestId: input.requestId,
      kind: input.kind,
      requestedModel: input.model ?? "auto",
      resolvedModel: result.resolvedModel,
      candidatesTop3: explanation.candidates
        .slice(0, 3)
        .map((c) => digest({ model: c.modelId, provider: c.providerId })),
      inputDigest: digest(input),
      outputDigest: digest(result.outputText),
      startedAt,
      endedAt: Date.now(),
    };
  }
}
export class FakeRouterClient implements RouterClient {
  readonly calls: DecisionInput[] = [];
  constructor(
    private readonly responses: (
      | string
      | ((input: DecisionInput) => string)
    )[] = [],
  ) {}
  explain(_input: DecisionInput): undefined {
    return undefined;
  }
  async decide(input: DecisionInput): Promise<RouterDecision> {
    this.calls.push(structuredClone(input));
    const next = this.responses.shift();
    if (next === undefined) throw Error("Fake script exhausted");
    const outputText = typeof next === "function" ? next(input) : next;
    return {
      outputText,
      toolCalls: [],
      finishReason: "stop",
      receipt: {
        requestId: input.requestId,
        kind: input.kind,
        requestedModel: input.model ?? "auto",
        candidatesTop3: [],
        inputDigest: digest(input),
        outputDigest: digest(outputText),
        startedAt: 0,
        endedAt: 0,
      },
    };
  }
}
