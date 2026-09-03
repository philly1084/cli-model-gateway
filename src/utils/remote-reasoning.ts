import type { ReasoningEffort, SessionCommandConfig } from "../types";
import { parseReasoningEffort } from "./reasoning";

export const REMOTE_REASONING_ENV = "GATEWAY_REMOTE_REASONING_EFFORT";
const RECEIPT_PREFIX = "GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=";

export function supportsRemoteReasoning(session: SessionCommandConfig): boolean {
  const args = session.args ?? [];
  const providerIndex = args.indexOf("--provider");
  return args.some((arg) => /(?:^|[/\\])remote-agent-session-bridge\.js$/.test(arg))
    && providerIndex >= 0 && args[providerIndex + 1] === "codex";
}

export function requireRemoteReasoning(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = parseReasoningEffort(typeof value === "string" && value.trim().toLowerCase() === "max" ? "xhigh" : value);
  if (!parsed) throw new Error("Unsupported remote reasoning effort.");
  return parsed;
}

// Receipt means the wrapper applied an override to its argv, not model-internal proof.
// Only unframed whole lines qualify; JSON output containing this text cannot qualify.
export function createRemoteReasoningFilter(onApplied: (effort: ReasoningEffort) => void) {
  let pending = "";
  let longLine = false;
  const filterLine = (line: string): string => {
    const match = line.match(/^GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=(none|minimal|low|medium|high|xhigh)\r?\n$/);
    if (!match) return line;
    onApplied(match[1] as ReasoningEffort);
    return "";
  };
  return {
    write(chunk: string): string {
      pending += chunk;
      let output = "";
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        output += longLine ? line : filterLine(line);
        longLine = false;
      }
      // Keep partial marker lines only; other output must remain realtime.
      if (pending && (longLine || (!RECEIPT_PREFIX.startsWith(pending)
        && !pending.startsWith(RECEIPT_PREFIX)) || pending.length > 256)) {
        output += pending;
        pending = "";
        longLine = true;
      }
      return output;
    },
    flush(): string {
      const output = pending;
      pending = "";
      return output;
    },
  };
}
