import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { kimiAcpCommand } from "../scripts/kimi-acp-bridge.js";
import { loadProvidersFile } from "../config.js";

async function bridge(mode: string) {
  mkdirSync(".scratch", { recursive: true });
  const home = mkdtempSync(path.resolve(".scratch/kimi-code-"));
  const env: NodeJS.ProcessEnv = { ...process.env, KIMI_CODE_HOME: path.join(home, "new-home"), KIMI_ACP_COMMAND:
    `"${process.execPath}" "${path.resolve("src/test/fixtures/kimi-code-agent.cjs")}" ${mode}` };
  delete env.KIMI_CODE_BASE_URL;
  if (mode !== "legacy") env.KIMI_CODE_API_KEY = process.execPath;
  else delete env.KIMI_CODE_API_KEY;
  const started = Date.now();
  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string; elapsed: number }>((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/scripts/kimi-acp-bridge.js", "--model", mode === "legacy" ? "k3" : mode], { env });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => stdout += chunk);
      child.stderr.on("data", chunk => stderr += chunk);
      child.on("error", reject);
      child.on("close", code => resolve({ code, stdout, stderr, elapsed: Date.now() - started }));
      child.stdin.end(JSON.stringify({ prompt: "Reply OK" }));
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("Kimi defaults to the replacement CLI without probing legacy kimi", () => {
  const old = process.env.KIMI_ACP_COMMAND;
  try {
    delete process.env.KIMI_ACP_COMMAND;
    assert.equal(kimiAcpCommand(), "kimi-code acp");
    process.env.KIMI_ACP_COMMAND = "kimi acp";
    assert.equal(kimiAcpCommand(), "kimi acp");
  } finally { if (old === undefined) delete process.env.KIMI_ACP_COMMAND; else process.env.KIMI_ACP_COMMAND = old; }
});

for (const model of ["k3", "kimi-for-coding", "legacy"]) test(`Kimi fake ACP handles ${model} configOptions and notifications`, { timeout: 10000 }, async () => {
  const result = await bridge(model);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { output_text: "ACP OK", finish_reason: "stop" });
  assert.equal(result.stderr, "");
});

test("Kimi does not classify ordinary ACP answer text as an EOL diagnostic", { timeout: 10000 }, async () => {
  const result = await bridge("eol-content");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).output_text, "kimi-cli is no longer maintained");
});

for (const mode of ["eol-out", "eol-err", "exit"]) test(`Kimi fails fast on ${mode}`, { timeout: 10000 }, async () => {
  const result = await bridge(mode);
  assert.equal(result.code, 1);
  assert.ok(result.elapsed < 5000);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, mode === "exit" ? /process exited/ : /EOL stub/);
  assert.doesNotMatch(result.stderr, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Kimi image keeps gateway on Node 20 and installs a pinned standalone Node 22 CLI", () => {
  const docker = readFileSync("Dockerfile", "utf8");
  assert.match(docker, /FROM node:22-bookworm-slim AS kimi-code/);
  assert.match(docker, /ARG KIMI_CODE_VERSION=2\.3\.0/);
  assert.match(docker, /--omit=optional --ignore-scripts @moonshot-ai\/kimi-code@\$\{KIMI_CODE_VERSION\}/);
  assert.match(docker, /node:20-bookworm-slim AS runtime/);
  assert.match(docker, /exec \/opt\/node22\/bin\/node \/opt\/kimi-code\/node_modules\/@moonshot-ai\/kimi-code\/dist\/main.mjs "\$@"/);
  const config = loadProvidersFile(path.resolve("config/providers.example.yaml"));
  const provider = config.providers.find(p => p.id === "kimi-code-cli");
  assert.ok(provider?.type === "cli");
  assert.match(provider.auth!.statusCommand!.args.join(" "), /KIMI_CODE_API_KEY/);
  assert.match(provider.auth!.statusCommand!.args.join(" "), /kimi-code/);
});
