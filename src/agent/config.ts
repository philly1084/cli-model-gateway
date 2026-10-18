import { z } from "zod";
const schema = z.object({
  enabled: z.boolean(),
  dataDir: z.string().min(1),
  poolMax: z.coerce.number().int().positive(),
  keysSopsFile: z.string().optional(),
  checkerKeySopsFile: z.string().optional(),
  approvalTtlMs: z.coerce.number().int().positive(),
});
export type AgentConfig = z.infer<typeof schema>;
export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  return schema.parse({
    enabled: env.AGENT_ENABLED === "true",
    dataDir: env.AGENT_DATA_DIR ?? "agent-data",
    poolMax: env.AGENT_POOL_MAX ?? 4,
    keysSopsFile: env.AGENT_KEYS_SOPS_FILE,
    checkerKeySopsFile: env.AGENT_CHECKER_KEY_SOPS_FILE,
    approvalTtlMs: env.AGENT_APPROVAL_TTL_MS ?? 86400000,
  });
}
