import { z } from "zod";
import {
  remoteAgentHandoffSchema,
  type RemoteAgentHandoff,
} from "../../validation.js";
import { digest, sha256 } from "../crypto/sealed.js";
import type { SealedLog } from "../store/sealed-log.js";
import type { RouterClient } from "../router/router-client.js";
import { tierSchema } from "../policy/risk.js";
export const handoffSchema = z
  .object({
    version: z.literal("AgentHandoff/v2"),
    jobId: z.string(),
    parentJobId: z.string().optional(),
    role: z.string(),
    goal: z.string(),
    acceptance: z.array(z.string()),
    constraints: z.object({
      tier: tierSchema,
      allowTools: z.array(z.string()),
      budget: z.object({
        maxCalls: z.number().int().positive(),
        deadlineMs: z.number().int().positive(),
      }),
    }),
    rollingSummary: z.object({
      text: z.string().max(4000),
      asOfSeq: z.number().int(),
      digest: z.string(),
    }),
    rawLog: z.object({
      logId: z.string(),
      fromSeq: z.number().int(),
      toSeq: z.number().int(),
      digest: z.string(),
      access: z.string(),
    }),
    memory: z.object({
      callerProfileDigest: z.string(),
      facts: z.array(
        z.object({ id: z.string(), text: z.string(), source: z.string() }),
      ),
    }),
    artifacts: z.array(z.object({ name: z.string(), sha256: z.string() })),
    legacy: remoteAgentHandoffSchema.optional(),
  })
  .strict();
export type AgentHandoff = z.infer<typeof handoffSchema>;
export type HandoffJob = Pick<
  AgentHandoff,
  "jobId" | "parentJobId" | "role" | "goal" | "acceptance" | "constraints"
>;
export function buildHandoff(
  job: HandoffJob,
  log: SealedLog,
  summary: string,
): AgentHandoff {
  const records = log.read().filter((r) => r.id === job.jobId),
    fromSeq = records.at(0)?.seq ?? 0,
    toSeq = records.at(-1)?.seq ?? -1;
  const text = summary.slice(0, 4000);
  return handoffSchema.parse({
    ...job,
    version: "AgentHandoff/v2",
    rollingSummary: { text, asOfSeq: toSeq, digest: digest(text) },
    rawLog: {
      logId: log.logId,
      fromSeq,
      toSeq,
      digest: digest(log.read(fromSeq, toSeq)),
      access: "read via delegate.log",
    },
    memory: { callerProfileDigest: digest({}), facts: [] },
    artifacts: [],
  });
}
export class RollingSummarizer {
  private counts = new Map<string, number>();
  constructor(
    private router: RouterClient,
    private log: SealedLog,
    private every = 10,
  ) {}
  async update(jobId: string, force = false): Promise<string | undefined> {
    const count = (this.counts.get(jobId) ?? 0) + 1;
    this.counts.set(jobId, count);
    if (!force && count % this.every) return;
    const decision = await this.router.decide({
      kind: "summarize",
      requestId: jobId,
      budget: { maxCalls: 1, deadlineMs: 30000 },
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            untrusted: true,
            events: this.log.read().filter((r) => r.id === jobId),
          }),
        },
      ],
    });
    const text = decision.outputText.slice(0, 4000);
    this.log.append("summary", jobId, { text, receipt: decision.receipt });
    return text;
  }
}
export function fromV1(input: RemoteAgentHandoff): AgentHandoff {
  const legacy = remoteAgentHandoffSchema.parse(input);
  const file = legacy.files.find((f) => f.filename === "agent-handoff-v2.json");
  if (file) {
    if (sha256(Buffer.from(file.contentBase64, "base64")) !== file.sha256)
      throw Error("Handoff artifact digest mismatch");
    const decoded: unknown = JSON.parse(
      Buffer.from(file.contentBase64, "base64").toString("utf8"),
    );
    return handoffSchema.parse(decoded);
  }
  return handoffSchema.parse({
    version: "AgentHandoff/v2",
    jobId: legacy.operationId,
    role: "worker",
    goal: "Imported handoff",
    acceptance: [],
    constraints: {
      tier: "R3",
      allowTools: [],
      budget: { maxCalls: 1, deadlineMs: 30000 },
    },
    rollingSummary: { text: "", asOfSeq: -1, digest: digest("") },
    rawLog: {
      logId: legacy.operationId,
      fromSeq: 0,
      toSeq: -1,
      digest: digest([]),
      access: "legacy files",
    },
    memory: { callerProfileDigest: digest({}), facts: [] },
    artifacts: [],
    legacy,
  });
}
export function toV1(input: AgentHandoff): RemoteAgentHandoff {
  if (input.legacy) return remoteAgentHandoffSchema.parse(input.legacy);
  const content = Buffer.from(JSON.stringify(input));
  return remoteAgentHandoffSchema.parse({
    version: "RemoteAgentHandoff/v1",
    operationId: input.jobId,
    runDirectory: "run",
    contextDirectory: "run/context",
    manifestPath: "run/manifest.json",
    sourceArtifactIds: [],
    files: [
      {
        filename: "agent-handoff-v2.json",
        contentBase64: content.toString("base64"),
        sizeBytes: content.length,
        sha256: sha256(content),
        mimeType: "application/json",
      },
    ],
    output: {
      version: "RemoteAgentResultFiles/v1",
      enabled: false,
      directory: "run/output",
      filesDirectory: "run/output/files",
      manifestPath: "run/output/manifest.json",
      requestedGlobs: [],
      maxFiles: 12,
      maxFileBytes: 4194304,
      maxTotalBytes: 6291456,
    },
  });
}
