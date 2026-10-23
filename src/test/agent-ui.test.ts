import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { buildServer } from "../server.js";
import type { AppConfig } from "../types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { createAgentRuntime } from "../agent/runtime.js";
import { Sealer, StaticKeyProvider } from "../agent/crypto/sealed.js";
import { submitSchema } from "../agent/coordinator/coordinator.js";
import { secretMatches } from "../agent/routes/auth.js";

const adminApiKey = "sk-admin-example";
const config: AppConfig = {
  host: "", port: 0, n8nApiKeys: new Set(), adminApiKey,
  frontendApiKeys: new Set(), frontendAllowedCwds: [], codexAgentAllowedWorkspaceRoots: [],
  remoteCliToolAuthScopes: new Set(["admin"]), providersPath: "", logLevel: "fatal",
  maxJobLogLines: 10, shutdownTimeoutMs: 1000, requestTimeoutMs: 1000,
  rateLimitMax: 100, rateLimitWindowMs: 60000, maxRequestBodySize: 1048576,
  autoRouterBenchmarkOnStart: false, autoRouterBenchmarkTimeoutMs: 1000,
  autoRouterBenchmarkMaxModels: 0, autoRouterBenchmarkConcurrency: 1,
  autoRouterBenchmarkIntervalMs: 0, autoRouterBenchmarkEvaluateQuality: false,
  autoRouterBenchmarkQualityTimeoutMs: 1000,
};
const registry = { listProviders: () => [], listModels: () => [] } as unknown as ProviderRegistry;
async function fixture(enabled: string | null = "true") {
  const previous = process.env.AGENT_ENABLED;
  if (enabled === null) delete process.env.AGENT_ENABLED;
  else process.env.AGENT_ENABLED = enabled;
  const sealer = new Sealer(new StaticKeyProvider({ data: Buffer.alloc(32, 1) }, Buffer.alloc(32, 2)));
  const calls: { submitted: unknown[]; sealed: unknown[]; stopped: string[]; summarized: string[]; advanced: string[] } =
    { submitted: [], sealed: [], stopped: [], summarized: [], advanced: [] };
  const seal = sealer.seal.bind(sealer);
  sealer.seal = (input, aad) => { calls.sealed.push({ input, aad }); return seal(input, aad); };
  const spec = submitSchema.parse({ goal: "tiny task" });
  const job = { jobId: "parent", spec, state: "awaiting_check", children: ["child"] };
  let initialized = 0;
  const runtime = {
    sealer,
    coordinator: {
      submit: async (input: unknown) => { calls.submitted.push(submitSchema.parse(input)); return job; },
      status: (id: string) => { assert.equal(id, "parent"); return job; },
      advance: async (id: string) => { calls.advanced.push(id); return job; },
    },
    delegate: {
      status: () => ({ jobId: "child", state: "running", lastEventSeq: 4 }),
      log: (input: unknown) => ({ untrusted: true, entries: [{ input, text: '<script>untrusted</script>' }] }),
      stop: ({ jobId }: { jobId: string }) => { calls.stopped.push(jobId); return { jobId, state: "stopping" }; },
      summarize: async ({ jobId }: { jobId: string }) => { calls.summarized.push(jobId); return { rollingSummary: "untrusted summary" }; },
    },
    inbox: {
      list: () => [{ id: "approval", state: "pending", action: { jobId: "parent" } }],
      approve: (id: string) => ({ id, state: "approved", action: { jobId: "parent" } }),
      deny: (id: string) => ({ id, state: "denied" }),
    }, close: async () => {},
  } as unknown as Awaited<ReturnType<typeof createAgentRuntime>>;
  const server = buildServer(config, registry, { agentRuntimeFactory: async () => { initialized++; return runtime; } });
  try { await server.app.ready(); }
  finally {
    if (previous === undefined) delete process.env.AGENT_ENABLED;
    else process.env.AGENT_ENABLED = previous;
  }
  return { ...server, calls, initialized };
}
async function login(app: Awaited<ReturnType<typeof fixture>>["app"], headers: Record<string, string> = {}) {
  const response = await app.inject({ method: "POST", url: "/admin/agent/ui/login", headers, payload: { adminKey: adminApiKey } });
  assert.equal(response.statusCode, 303);
  const setCookie = String(response.headers["set-cookie"]);
  const cookie = setCookie.split(";")[0]!;
  const session = await app.inject({ url: "/admin/agent/ui/api/session", headers: { ...headers, cookie } });
  assert.equal(session.statusCode, 200);
  return { cookie, "x-csrf-token": session.json().csrfToken as string, setCookie };
}

test("agent admin helper rejects mismatch, unequal lengths and missing configuration", () => {
  assert.equal(secretMatches(adminApiKey, adminApiKey), true);
  for (const actual of ["wrong", "", "a".repeat(1000), undefined, [adminApiKey]]) assert.equal(secretMatches(actual, adminApiKey), false);
  assert.equal(secretMatches("", ""), false);
  assert.equal(secretMatches(adminApiKey, undefined), false);
});

for (const enabled of [undefined, "false", "TRUE", "1"]) test(`agent and UI do no startup work when flag is ${enabled}`, async () => {
  const f = await fixture(enabled ?? null);
  try {
    for (const url of ["/admin/agent/inbox", "/admin/agent/ui", "/admin/agent/ui/api/inbox"])
      assert.equal((await f.app.inject({ url })).statusCode, 404);
    assert.equal((await f.app.inject({ method: "POST", url: "/admin/agent/ui/login", payload: { adminKey: adminApiKey } })).statusCode, 404);
    assert.equal(f.initialized, 0);
  } finally { await f.close(); }
});

test("agent and UI API require auth; page has nonce CSP and no external assets", async () => {
  const f = await fixture();
  try {
    for (const url of ["/admin/agent/inbox", "/admin/agent/ui/api/inbox", "/admin/agent/ui/api/session"])
      assert.equal((await f.app.inject({ url })).statusCode, 401);
    for (const headers of [{ "x-admin-key": adminApiKey }, { authorization: `Bearer ${adminApiKey}` }])
      assert.equal((await f.app.inject({ url: "/admin/agent/inbox", headers })).statusCode, 200);
    const page = await f.app.inject({ url: "/admin/agent/ui" });
    assert.equal(page.statusCode, 200);
    const csp = String(page.headers["content-security-policy"]);
    for (const directive of ["default-src 'none'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'self'", "script-src 'nonce-"]) assert.ok(csp.includes(directive));
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
    assert.ok(page.body.includes(`<script nonce="${nonce}">`));
    assert.doesNotThrow(() => new Script(/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(page.body)![1]!));
    assert.ok(!/https?:\/\/|<script[^>]+src=|innerHTML|onerror=/i.test(page.body));
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
  } finally { await f.close(); }
});

test("login failures are limited and cross-site login is rejected", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await f.app.inject({ method: "POST", url: "/admin/agent/ui/login", payload: { adminKey: "wrong" } })).statusCode, 401);
    const limited = await f.app.inject({ method: "POST", url: "/admin/agent/ui/login", payload: { adminKey: adminApiKey } });
    assert.equal(limited.statusCode, 429);
    assert.ok(limited.headers["retry-after"]);
    assert.equal((await f.app.inject({ method: "POST", url: "/admin/agent/ui/login", headers: { "sec-fetch-site": "cross-site" }, payload: { adminKey: adminApiKey } })).statusCode, 403);
  } finally { await f.close(); }
});

test("login sets scoped flags, HTTPS adds Secure, and remote plaintext is denied", async () => {
  const f = await fixture();
  try {
    const plain = await login(f.app);
    for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/admin/agent", "Max-Age=28800"]) assert.ok(plain.setCookie.includes(flag));
    assert.ok(!plain.setCookie.includes("Secure"));
    const tls = await login(f.app, { "x-forwarded-proto": "https" });
    assert.ok(tls.setCookie.includes("Secure"));
    assert.notEqual(plain.cookie, tls.cookie);
    assert.equal((await f.app.inject({ url: "/admin/agent/ui", remoteAddress: "203.0.113.10", headers: { host: "gateway.example.com" } })).statusCode, 403);
  } finally { await f.close(); }
});

test("session mutations require CSRF; submit seals the real task server-side; controls use delegate ids", async () => {
  const f = await fixture();
  try {
    const auth = await login(f.app);
    const payload = { goal: "Write a tiny sentence.", budget: { maxCalls: 1, deadlineMs: 1000 } };
    for (const headers of [{ cookie: auth.cookie }, { cookie: auth.cookie, "x-csrf-token": "wrong" }, { "x-admin-key": adminApiKey }])
      assert.equal((await f.app.inject({ method: "POST", url: "/admin/agent/ui/api/submit", headers, payload })).statusCode, 403);
    const response = await f.app.inject({ method: "POST", url: "/admin/agent/ui/api/submit", headers: auth, payload });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { jobId: "parent", state: "awaiting_check" });
    assert.deepEqual(f.calls.submitted, [{ ...payload, acceptance: [], effect: "read", tier: "R0" }]);
    assert.deepEqual(f.calls.sealed, [{ input: f.calls.submitted[0], aad: "agent:submit" }]);
    assert.ok(!/envelope|macKey|\bct\b|\bkid\b|keys/.test(response.body));
    const jobs = await f.app.inject({ url: "/admin/agent/ui/api/jobs", headers: auth });
    assert.equal(jobs.json().jobs[0].children[0].jobId, "child");
    assert.equal((await f.app.inject({ url: "/admin/agent/ui/api/jobs/parent/status", headers: auth })).statusCode, 200);
    const log = await f.app.inject({ url: "/admin/agent/ui/api/jobs/child/log?fromSeq=1&toSeq=4", headers: auth });
    assert.equal(log.json().untrusted, true);
    assert.deepEqual(log.json().entries[0].input, { jobId: "child", fromSeq: 1, toSeq: 4 });
    for (const path of ["jobs/child/stop", "jobs/child/summarize", "inbox/approval/approve", "inbox/approval/deny"])
      assert.equal((await f.app.inject({ method: "POST", url: `/admin/agent/ui/api/${path}`, headers: auth })).statusCode, 200);
    assert.deepEqual(f.calls.stopped, ["child"]);
    assert.deepEqual(f.calls.summarized, ["child"]);
    assert.deepEqual(f.calls.advanced, ["parent"]);
    assert.equal((await f.app.inject({ method: "POST", url: "/admin/agent/ui/api/submit", headers: auth, payload: { goal: "x".repeat(4001) } })).statusCode, 400);
  } finally { await f.close(); }
});

test("UI submit rejects over-limit, non-integer and unknown budget fields before sealing", async () => {
  const f = await fixture();
  try {
    const auth = await login(f.app);
    for (const budget of [
      { maxCalls: 9, deadlineMs: 1000 },
      { maxCalls: 1, deadlineMs: 600001 },
      { maxCalls: 1, deadlineMs: 1000, extra: true },
      { maxCalls: 0, deadlineMs: 1000 },
      { maxCalls: 1.5, deadlineMs: 1000 },
      { maxCalls: 1, deadlineMs: 0 },
      { maxCalls: 1, deadlineMs: 1.5 },
    ]) {
      const response = await f.app.inject({
        method: "POST", url: "/admin/agent/ui/api/submit", headers: auth,
        payload: { goal: "invalid budget", budget },
      });
      assert.equal(response.statusCode, 400, JSON.stringify(budget));
    }
    assert.deepEqual(f.calls.sealed, []);
    assert.deepEqual(f.calls.submitted, []);
  } finally { await f.close(); }
});

test("logout requires CSRF and invalidates the session", async () => {
  const f = await fixture();
  try {
    const auth = await login(f.app);
    assert.equal((await f.app.inject({ method: "POST", url: "/admin/agent/ui/logout", headers: { cookie: auth.cookie } })).statusCode, 403);
    const response = await f.app.inject({ method: "POST", url: "/admin/agent/ui/logout", headers: auth });
    assert.equal(response.statusCode, 200);
    assert.ok(String(response.headers["set-cookie"]).includes("Max-Age=0"));
    assert.equal((await f.app.inject({ url: "/admin/agent/ui/api/inbox", headers: auth })).statusCode, 401);
  } finally { await f.close(); }
});

test("header-authenticated clients obtain a session and CSRF before mutations", async () => {
  const f = await fixture();
  try {
    const r = await f.app.inject({ url: "/admin/agent/ui/api/session", headers: { "x-admin-key": adminApiKey } });
    assert.equal(r.statusCode, 200);
    assert.equal((await f.app.inject({ method: "POST", url: "/admin/agent/ui/api/submit", headers: {
      "x-admin-key": adminApiKey, cookie: String(r.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": r.json().csrfToken,
    }, payload: { goal: "tiny task" } })).statusCode, 200);
  } finally { await f.close(); }
});

test("sessions enforce idle and absolute expiry", async () => {
  const f = await fixture();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const idle = await login(f.app);
    now += 30 * 60 * 1000;
    assert.equal((await f.app.inject({ url: "/admin/agent/ui/api/inbox", headers: idle })).statusCode, 401);
    const absolute = await login(f.app);
    for (let i = 0; i < 16; i++) {
      now += 29 * 60 * 1000;
      assert.equal((await f.app.inject({ url: "/admin/agent/ui/api/inbox", headers: absolute })).statusCode, 200);
    }
    now += 16 * 60 * 1000;
    assert.equal((await f.app.inject({ url: "/admin/agent/ui/api/inbox", headers: absolute })).statusCode, 401);
  } finally { Date.now = realNow; await f.close(); }
});

test("session count is capped, evicting the oldest session", async () => {
  const f = await fixture();
  try {
    const first = await login(f.app);
    let last = first;
    for (let i = 0; i < 128; i++) last = await login(f.app);
    assert.equal((await f.app.inject({ url: "/admin/agent/ui/api/inbox", headers: first })).statusCode, 401);
    assert.equal((await f.app.inject({ url: "/admin/agent/ui/api/inbox", headers: last })).statusCode, 200);
  } finally { await f.close(); }
});

test("Windows key generator refuses a Git work tree without crypto tools", t => {
  if (process.platform !== "win32") return t.skip("Windows PowerShell unavailable");
  const r = spawnSync("powershell", ["-NoProfile", "-File", resolve("scripts/agent-keys/generate-agent-keys.ps1"), "-OutputDir", resolve("rejected.agent-keys"), "-ValidateOnly"], { encoding: "utf8" });
  assert.ifError(r.error);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Refusing output inside a git work tree/);
  assert.equal(existsSync("rejected.agent-keys"), false);
});

test("Bash key generator refuses a Git work tree in validation mode", t => {
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const probe = spawnSync(bash, ["-c", "command -v python3; command -v git"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("Bash, python3 or git unavailable");
  const r = spawnSync(bash, ["scripts/agent-keys/generate-agent-keys.sh", "--output-dir", "rejected.agent-keys", "--validate-only"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Refusing output inside a git work tree/);
  assert.equal(existsSync("rejected.agent-keys"), false);
});

test("key scripts document the provider shapes and ignore generated outputs", () => {
  const ignore = readFileSync(".gitignore", "utf8");
  for (const pattern of ["*.agent-keys/", "agent-keys/", "*.sops.json", "*.age", "age-key.txt", "keys.json", "checker.json"]) assert.ok(ignore.includes(pattern));
  for (const ext of ["sh", "ps1"]) {
    const script = readFileSync(`scripts/agent-keys/generate-agent-keys.${ext}`, "utf8");
    assert.ok(script.includes("macKey"));
    assert.ok(script.includes("--input-type json --output-type json"));
  }
});
