import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  Sealer,
  StaticKeyProvider,
  SopsKeyProvider,
  digest,
  sha256,
} from "../agent/crypto/sealed.js";
import { SealedLog } from "../agent/store/sealed-log.js";
import { LeaseManager } from "../agent/pool/leases.js";
import { DockerRunner, InProcessRunner } from "../agent/pool/runners.js";
import { WorkerPool, type PoolJob } from "../agent/pool/worker-pool.js";
import { ApprovalInbox } from "../agent/approvals/inbox.js";
import {
  check,
  hasSecret,
  policyViolation,
  type Receipt,
} from "../agent/checker/checker.js";
import { isDone } from "../agent/checker/gate.js";
import {
  buildHandoff,
  fromV1,
  handoffSchema,
  toV1,
  RollingSummarizer,
} from "../agent/context/handoff.js";
import { FakeRouterClient } from "../agent/router/router-client.js";
import { DelegateTool } from "../agent/delegate/delegate-tool.js";
import { AgentMemory } from "../agent/memory/index.js";
import {
  classify,
  canAutoRun,
  autoRunDigest,
  type RiskStep,
} from "../agent/policy/risk.js";
import { AutoRunScheduler } from "../agent/scheduler/auto-run.js";
import { loadAgentConfig } from "../agent/config.js";
import { Coordinator } from "../agent/coordinator/coordinator.js";
import { InboxNotifier } from "../agent/notify/notifier.js";
import { NativeRouterClient } from "../agent/router/router-client.js";
import { agentRoutes } from "../agent/routes/agent.js";
import Fastify from "fastify";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AutoRouterDecisionSnapshot, UnifiedRequest } from "../types.js";
import type { AppConfig } from "../types.js";
import { buildServer } from "../server.js";

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agent-test-")),
    data = randomBytes(32),
    mac = randomBytes(32);
  const sealer = new Sealer(new StaticKeyProvider({ data }, mac)),
    log = new SealedLog(directory, sealer);
  return {
    directory,
    data,
    mac,
    sealer,
    log,
    close() {
      log.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Condition was not reached");
}
const spec = {
  role: "researcher",
  goal: "summarize fixtures",
  acceptance: [],
  tier: "R0",
  effect: "read",
  tools: [],
  budget: { maxCalls: 2, deadlineMs: 1000 },
};

test("agent sealed log: round trip, replay, encryption, locking and edits", () => {
  const f = fixture();
  try {
    const marker = `private-marker-${randomUUID()}`;
    f.log.append("task", "one", { marker });
    f.log.append("result", "one", { text: marker });
    assert.equal((f.log.read()[0]?.body as { marker: string }).marker, marker);
    assert.equal(f.log.verifyChain(), true);
    assert.equal(readFileSync(f.log.path, "utf8").includes(marker), false);
    assert.throws(() => new SealedLog(f.directory, f.sealer));
    f.log.close();
    const reopened = new SealedLog(f.directory, f.sealer);
    assert.equal(reopened.replay().length, 2);
    reopened.close();
    const lines = readFileSync(f.log.path, "utf8").trim().split("\n");
    lines.reverse();
    writeFileSync(f.log.path, `${lines.join("\n")}\n`);
    assert.throws(() => new SealedLog(f.directory, f.sealer));
    assert.throws(() => f.sealer.open(f.sealer.seal({ marker }, "a"), "b"));
  } finally {
    f.close();
  }
});

test("agent leases: independent keys, contention, expiry and fencing", async () => {
  let now = 0;
  const leases = new LeaseManager(() => now);
  const [a, b] = await Promise.all([
    Promise.resolve(leases.acquire("a", "one", 10)),
    Promise.resolve(leases.acquire("b", "two", 10)),
  ]);
  assert.ok(!("busy" in a) && !("busy" in b));
  assert.deepEqual(leases.acquire("a", "other", 10), { busy: true });
  now = 11;
  const next = leases.acquire("a", "other", 10);
  assert.ok(!("busy" in next));
  assert.equal(next.fencingToken, 2);
  assert.throws(() => leases.assertFence("a", 1));
  leases.assertFence("a", 2);
  const f = fixture();
  try {
    assert.throws(() =>
      f.log.appendFenced("write", "a", { value: "stale" }, leases, "a", 1),
    );
    f.log.appendFenced("write", "a", { value: "current" }, leases, "a", 2);
    assert.equal(f.log.read().length, 1);
  } finally {
    f.close();
  }
  assert.equal(leases.renew("a", next.leaseId, 10), true);
  assert.equal(leases.release("a", "wrong"), false);
  assert.equal(leases.release("a", next.leaseId), true);
});

test("agent pool: bounded parallelism, stop, timeout, retry and uncertain writes", async () => {
  let active = 0,
    maximum = 0;
  const releases: (() => void)[] = [];
  const runner = new InProcessRunner(async (_job, signal) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return "ok";
    } finally {
      active--;
    }
  });
  const pool = new WorkerPool(new LeaseManager(), runner, 2);
  const submit = (id: string, deadlineMs = 1000, write = false) =>
    pool.submit({
      jobId: id,
      owner: id,
      resourceKey: id,
      write,
      priority: 0,
      deadlineMs,
      payload: {},
    });
  try {
    submit("a");
    submit("b");
    submit("c");
    assert.equal(active, 2);
    assert.equal(pool.get("c").state, "queued");
    releases.shift()!();
    await eventually(() => pool.get("c").state === "running");
    assert.equal(maximum, 2);
    pool.stop("b");
    pool.stop("c");
    await eventually(
      () =>
        pool.get("b").state === "stopped" && pool.get("c").state === "stopped",
    );
    submit("timeout", 10);
    await eventually(() => pool.get("timeout").state === "failed");
    assert.equal(pool.get("timeout").failure, "timeout");
  } finally {
    pool.close();
  }
  const attempts = new Map<string, number>();
  const crashes = new WorkerPool(
    new LeaseManager(),
    new InProcessRunner(async (j) => {
      const n = (attempts.get(j.jobId) ?? 0) + 1;
      attempts.set(j.jobId, n);
      if (n === 1) throw Error("synthetic crash");
      return "retried";
    }),
    2,
  );
  try {
    for (const write of [false, true])
      crashes.submit({
        jobId: String(write),
        owner: "one",
        resourceKey: String(write),
        write,
        priority: 0,
        deadlineMs: 1000,
        payload: {},
      });
    await eventually(
      () =>
        crashes.get("false").state === "awaiting_check" &&
        crashes.get("true").state === "reconciliation_required",
    );
    assert.equal(attempts.get("false"), 2);
    assert.equal(attempts.get("true"), 1);
  } finally {
    crashes.close();
  }
});

test("agent delegate: start, status, summarize, stop and replay", async () => {
  const f = fixture();
  let delegate: DelegateTool | undefined;
  const router = new FakeRouterClient(["rolling summary"]);
  const pool = new WorkerPool(
    new LeaseManager(),
    new InProcessRunner(
      async (_j, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    ),
    1,
    1,
    3000,
    (j) => delegate?.onPoolEvent(j),
  );
  try {
    delegate = new DelegateTool(
      pool,
      f.log,
      new RollingSummarizer(router, f.log),
    );
    const started = delegate.start(spec);
    assert.equal(started.state, "queued");
    assert.equal(delegate.status({ jobId: started.jobId }).state, "running");
    assert.equal(
      (await delegate.summarize({ jobId: started.jobId })).rollingSummary,
      "rolling summary",
    );
    delegate.stop({ jobId: started.jobId, reason: "test" });
    await eventually(
      () => delegate!.status({ jobId: started.jobId }).state === "stopped",
    );
    assert.equal(delegate.log({ jobId: started.jobId }).untrusted, true);
    assert.equal(delegate.list({}).length, 1);
    const restored = new DelegateTool(
      pool,
      f.log,
      new RollingSummarizer(router, f.log),
    );
    assert.equal(restored.status({ jobId: started.jobId }).state, "stopped");
  } finally {
    pool.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.close();
  }
});

test("agent approvals: exact action, single use, expiry, replay", () => {
  const f = fixture();
  let now = 0;
  try {
    const inbox = new ApprovalInbox(f.log, 10, () => now);
    const action = { effect: "send" as const, args: { text: "fixture" } };
    const item = inbox.request(action);
    assert.equal(classify(action).tier, "R3");
    assert.equal(inbox.consume(item.actionDigest), false);
    inbox.approve(item.id);
    assert.equal(inbox.consume(item.actionDigest), true);
    assert.equal(inbox.consume(item.actionDigest), false);
    assert.notEqual(
      inbox.request({ ...action, args: { text: "changed" } }).actionDigest,
      item.actionDigest,
    );
    const expired = inbox.request({ effect: "write" });
    now = 11;
    assert.throws(() => inbox.approve(expired.id));
    assert.equal(inbox.consume(expired.actionDigest), false);
    assert.equal(
      new ApprovalInbox(f.log, 10, () => now)
        .list()
        .find((i) => i.id === item.id)?.state,
      "consumed",
    );
  } finally {
    f.close();
  }
});

test("agent checker: separate sealed CLI, MAC and artifact gates", async () => {
  const f = fixture();
  try {
    const artifact = {
        name: "result",
        content: "offline artifact",
        sha256: sha256("offline artifact"),
      },
      request = {
        jobId: randomUUID(),
        artifacts: [artifact],
        acceptance: ["offline"],
      };
    const child = spawn(
      process.execPath,
      [join(__dirname, "../agent/checker/cli.js")],
      { stdio: ["pipe", "pipe", "pipe"], shell: false },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    child.stdin.end(
      JSON.stringify({
        dataKey: f.data.toString("base64"),
        checkerKey: f.mac.toString("base64"),
        request: f.sealer.seal(request, "checker:request"),
      }),
    );
    assert.equal(await exited, 0);
    const receipt = f.sealer.open<Receipt>(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      "checker:receipt",
    );
    assert.equal(isDone(request, receipt, f.mac), true);
    assert.equal(isDone(request, undefined, f.mac), false);
    assert.equal(
      isDone(request, { ...receipt, mac: "00".repeat(32) }, f.mac),
      false,
    );
    assert.equal(
      isDone(
        { ...request, artifacts: [{ ...artifact, content: "tampered" }] },
        receipt,
        f.mac,
      ),
      false,
    );
    const secret = ["sk", randomBytes(24).toString("hex")].join("-");
    const bad = await check(
      {
        ...request,
        artifacts: [
          { name: "synthetic", content: secret, sha256: sha256(secret) },
        ],
      },
      f.mac,
    );
    assert.equal(bad.verdict, "fail");
    assert.equal(policyViolation("+gh pr merge 1"), true);
    assert.equal(policyViolation(" unchanged deploy"), false);
    assert.equal(hasSecret("harmless text"), false);
  } finally {
    f.close();
  }
});

test("agent handoff: schema, raw range digest and v1 round trips", () => {
  const f = fixture();
  try {
    const jobId = randomUUID();
    f.log.append("event", jobId, { text: "context" });
    const handoff = buildHandoff(
      {
        jobId,
        role: "researcher",
        goal: "offline",
        acceptance: [],
        constraints: {
          tier: "R0",
          allowTools: [],
          budget: { maxCalls: 1, deadlineMs: 1000 },
        },
      },
      f.log,
      "summary",
    );
    assert.ok(handoffSchema.safeParse(handoff).success);
    assert.equal(
      handoff.rawLog.digest,
      digest(f.log.read(handoff.rawLog.fromSeq, handoff.rawLog.toSeq)),
    );
    assert.deepEqual(fromV1(toV1(handoff)), handoff);
    const legacy = toV1(handoff);
    legacy.files = [];
    assert.deepEqual(toV1(fromV1(legacy)), legacy);
  } finally {
    f.close();
  }
});

test("agent memory: layers, budgets and promotion receipts", () => {
  const f = fixture();
  try {
    const memory = new AgentMemory(f.log);
    assert.throws(() =>
      memory.write({
        layer: "caller_profile",
        id: "caller",
        text: "prefers offline",
      }),
    );
    memory.write(
      { layer: "caller_profile", id: "caller", text: "prefers offline" },
      "approval-receipt",
    );
    memory.write(
      { layer: "agent_profile", id: "reader", text: "offline research" },
      "approval-receipt",
    );
    memory.write({
      layer: "journal",
      id: "2026-01-01",
      text: "offline result",
      provenance: { jobId: "job", receiptId: "receipt" },
    });
    memory.write({
      layer: "facts",
      id: "fact",
      text: "offline knowledge",
      status: "proposed",
      provenance: { jobId: "job" },
    });
    assert.throws(() => memory.promote("fact", ""));
    memory.promote("fact", "receipt");
    const result = new AgentMemory(f.log).retrieve("offline", 100);
    assert.ok(result.text.length <= 100);
    assert.ok(result.records.length);
    assert.equal(result.untrusted, true);
    assert.equal(
      readFileSync(f.log.path, "utf8").includes("offline knowledge"),
      false,
    );
  } finally {
    f.close();
  }
});

test("agent scheduler: due reads need matching autoRun digest, writes park", async () => {
  const f = fixture();
  let now = 0;
  const submitted: RiskStep[] = [];
  try {
    const inbox = new ApprovalInbox(f.log);
    const timer = {
      now: () => now,
      setInterval: () => 1,
      clearInterval: () => {},
    };
    const scheduler = new AutoRunScheduler(
      inbox,
      async (s) => {
        submitted.push(s);
      },
      timer,
    );
    const read: RiskStep = { effect: "read", tier: "R0", autoRun: true };
    assert.equal(canAutoRun(read), false);
    read.autoRunApprovalDigest = autoRunDigest(read);
    assert.equal(canAutoRun(read), true);
    scheduler.add("read", read, 10);
    scheduler.add("write", { effect: "write", tier: "R2" }, 10);
    now = 11;
    await scheduler.tick();
    assert.equal(submitted.length, 1);
    assert.equal(inbox.list().length, 1);
    assert.equal(canAutoRun({ ...read, goal: "changed" }), false);
    scheduler.start();
    scheduler.stop();
  } finally {
    f.close();
  }
});

test("agent docker argv is pinned and isolated; config defaults off", () => {
  const runner = new DockerRunner(),
    image = `worker@sha256:${"a".repeat(64)}`;
  assert.deepEqual(runner.buildArgs({ jobId: "job", image }), [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--user",
    "10001:10001",
    "--tmpfs",
    "/tmp:rw,size=256m,noexec",
    "--tmpfs",
    "/work:rw,size=1g",
    "-e",
    "AGENT_JOB_ID=job",
    "-i",
    image,
    "agent-worker",
  ]);
  assert.throws(() =>
    runner.buildArgs({ jobId: "job", image: "worker:latest" }),
  );
  assert.equal(loadAgentConfig({}).enabled, false);
  assert.equal(loadAgentConfig({}).poolMax, 4);
});

test("agent coordinator: router plan/steer/summary, R3 once, R4 fresh, replay and gate", async () => {
  const f = fixture();
  let delegate: DelegateTool | undefined;
  const steps = [
    { kind: "delegate", effect: "send", tier: "R3", spec },
    { kind: "delegate", effect: "deploy", tier: "R4", spec },
    { kind: "delegate", effect: "deploy", tier: "R4", spec },
    { kind: "finish", effect: "read", tier: "R0" },
  ];
  const router = new FakeRouterClient([
    JSON.stringify({ steps }),
    '{"action":"continue","reason":"healthy"}',
    "summary",
  ]);
  const pool = new WorkerPool(
    new LeaseManager(),
    new InProcessRunner(async () => "result"),
    2,
    2,
    3000,
    (j) => delegate?.onPoolEvent(j),
  );
  const inbox = new ApprovalInbox(f.log);
  delegate = new DelegateTool(
    pool,
    f.log,
    new RollingSummarizer(router, f.log),
  );
  const create = () =>
    new Coordinator(
      router,
      f.log,
      inbox,
      new InboxNotifier(f.log),
      delegate!,
      new AgentMemory(f.log),
      f.mac,
    );
  try {
    const coordinator = create();
    const budget = { maxCalls: 1, deadlineMs: 1000 };
    const job = await coordinator.submit({ goal: "offline plan", budget });
    assert.deepEqual(router.calls[0]?.budget, budget);
    assert.equal(job.state, "awaiting_approval");
    assert.equal(delegate.list().length, 0);
    let pending = inbox.list().find((i) => i.state === "pending")!;
    inbox.approve(pending.id);
    await coordinator.advance(job.jobId);
    assert.equal(delegate.list().length, 1);
    assert.deepEqual(delegate.list()[0]?.spec.budget, budget);
    assert.equal(inbox.consume(pending.actionDigest), false);
    await coordinator.advance(job.jobId);
    assert.equal(delegate.list().length, 1); // first R4 is still parked
    pending = inbox.list().find((i) => i.state === "pending")!;
    inbox.approve(pending.id);
    await coordinator.advance(job.jobId);
    assert.equal(delegate.list().length, 2);
    pending = inbox.list().find((i) => i.state === "pending")!;
    inbox.approve(pending.id);
    await coordinator.advance(job.jobId);
    assert.equal(delegate.list().length, 3);
    await eventually(() =>
      delegate!.list().every((j) => j.state === "awaiting_check"),
    );
    await coordinator.workerEvent(job.jobId);
    assert.deepEqual(
      router.calls.map((c) => c.kind),
      ["plan", "steer", "summarize"],
    );
    assert.equal(coordinator.finish(job.jobId, []), false);
    for (const child of delegate.list()) {
      const artifacts = child.artifacts ?? [];
      const request = { jobId: child.jobId, artifacts, acceptance: [] };
      assert.equal(
        delegate.acceptCheck(
          child.jobId,
          [],
          await check({ ...request, artifacts: [] }, f.mac),
          f.mac,
        ),
        false,
      );
      assert.equal(
        delegate.acceptCheck(
          child.jobId,
          artifacts,
          await check(request, f.mac),
          f.mac,
        ),
        true,
      );
    }
    const receipt = await check(
      { jobId: job.jobId, artifacts: [], acceptance: [] },
      f.mac,
    );
    assert.equal(coordinator.finish(job.jobId, [], receipt), true);
    assert.equal(create().status(job.jobId).state, "done");
  } finally {
    pool.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.close();
  }
});

test("agent restart: uncertain write delegate requires reconciliation", async () => {
  const f = fixture();
  let delegate: DelegateTool | undefined;
  const router = new FakeRouterClient();
  const pool = new WorkerPool(
    new LeaseManager(),
    new InProcessRunner(
      async (_job, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    ),
    1,
    1,
    3000,
    (j) => delegate?.onPoolEvent(j),
  );
  try {
    delegate = new DelegateTool(
      pool,
      f.log,
      new RollingSummarizer(router, f.log),
    );
    const job = delegate.start({ ...spec, tier: "R2", effect: "write" });
    const replay = new DelegateTool(
      pool,
      f.log,
      new RollingSummarizer(router, f.log),
    );
    assert.equal(
      replay.status({ jobId: job.jobId }).state,
      "reconciliation_required",
    );
  } finally {
    pool.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.close();
  }
});

test("agent routes: off is 404, authenticated enabled access and sealed submit", async () => {
  const off = Fastify();
  assert.equal(
    (await off.inject({ method: "GET", url: "/admin/agent/inbox" })).statusCode,
    404,
  );
  await off.close();
  const f = fixture();
  const adminApiKey = randomBytes(32).toString("hex");
  let delegate: DelegateTool | undefined;
  const router = new FakeRouterClient([
    '{"steps":[{"kind":"finish","effect":"read","tier":"R0"}]}',
  ]);
  const pool = new WorkerPool(
    new LeaseManager(),
    new InProcessRunner(async () => "result"),
    1,
    1,
    3000,
    (j) => delegate?.onPoolEvent(j),
  );
  const inbox = new ApprovalInbox(f.log);
  delegate = new DelegateTool(
    pool,
    f.log,
    new RollingSummarizer(router, f.log),
  );
  const coordinator = new Coordinator(
      router,
      f.log,
      inbox,
      new InboxNotifier(f.log),
      delegate,
      new AgentMemory(f.log),
      f.mac,
    ),
    app = Fastify();
  try {
    await app.register(agentRoutes, {
      prefix: "/admin/agent",
      adminApiKey,
      coordinator,
      delegate,
      inbox,
      sealer: f.sealer,
    });
    assert.equal(
      (await app.inject({ method: "GET", url: "/admin/agent/inbox" }))
        .statusCode,
      401,
    );
    const headers = { "x-admin-key": adminApiKey };
    for (const budget of [
      { maxCalls: 9, deadlineMs: 1000 },
      { maxCalls: 1, deadlineMs: 600001 },
      { maxCalls: 1, deadlineMs: 1000, extra: true },
      { maxCalls: 0, deadlineMs: 1000 },
      { maxCalls: 1.5, deadlineMs: 1000 },
      { maxCalls: 1, deadlineMs: 0 },
      { maxCalls: 1, deadlineMs: 1.5 },
    ]) {
      const rejected = await app.inject({
        method: "POST", url: "/admin/agent/submit", headers,
        payload: f.sealer.seal({ goal: "invalid budget", budget }, "agent:submit"),
      });
      assert.equal(rejected.statusCode, 400, JSON.stringify(budget));
    }
    assert.equal(router.calls.length, 0);
    assert.equal(coordinator.list().length, 0);
    assert.equal(
      (await app.inject({ method: "GET", url: "/admin/agent/inbox", headers }))
        .statusCode,
      200,
    );
    const submitted = await app.inject({
      method: "POST",
      url: "/admin/agent/submit",
      headers,
      payload: f.sealer.seal({ goal: "sealed input" }, "agent:submit"),
    });
    assert.equal(submitted.statusCode, 200);
    assert.equal(submitted.json().state, "awaiting_check");
    assert.equal(submitted.payload.includes("sealed input"), false);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/admin/agent/submit",
          headers,
          payload: { goal: "plaintext rejected" },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
    pool.close();
    f.close();
  }
});

test("agent native router: exclusions, digests and one JSON repair", async () => {
  const calls: { model: string; request: UnifiedRequest }[] = [];
  const candidates = [
    {
      modelId: "a",
      providerId: "worker",
      providerModel: "a",
      capabilities: ["text"],
      score: 2,
    },
    {
      modelId: "b",
      providerId: "checker",
      providerModel: "b",
      capabilities: ["text"],
      score: 1,
    },
  ];
  let outputs = ["invalid", '{"steps":[]}'];
  const registry = {
    explainAutoRouting: () =>
      ({ candidates }) as unknown as AutoRouterDecisionSnapshot,
    runModel: async (model: string, request: UnifiedRequest) => {
      calls.push({ model, request });
      return {
        outputText: outputs.shift() ?? "invalid",
        toolCalls: [],
        finishReason: "stop",
        resolvedModel: model,
      };
    },
  } as unknown as ProviderRegistry;
  const router = new NativeRouterClient(registry),
    input = {
      kind: "plan" as const,
      requestId: "test",
      messages: [{ role: "user" as const, content: "private prompt marker" }],
      excludeProviders: ["worker"],
      budget: { maxCalls: 2, deadlineMs: 1000 },
    };
  const decision = await router.decide(input);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.model === "b"));
  assert.equal(decision.needsReview, undefined);
  assert.equal(
    JSON.stringify(decision.receipt).includes("private prompt marker"),
    false,
  );
  outputs = ["invalid", "invalid"];
  assert.equal((await router.decide(input)).needsReview, true);
  assert.equal(calls.length, 4);
  await assert.rejects(() =>
    router.decide({ ...input, excludeProviders: ["worker", "checker"] }),
  );
});

test("agent SOPS provider: mocked spawn only, stdout stays in memory", async () => {
  const data = randomBytes(32),
    mac = randomBytes(32),
    calls: unknown[] = [];
  const spawnFn = ((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    queueMicrotask(() => {
      child.stdout.end(
        JSON.stringify(
          calls.length === 1
            ? { keys: { data: data.toString("base64") } }
            : { macKey: mac.toString("base64") },
        ),
      );
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof spawn;
  const previousAgeFile = process.env.SOPS_AGE_KEY_FILE;
  process.env.SOPS_AGE_KEY_FILE = "age-key-example.txt";
  let provider: SopsKeyProvider;
  try {
    provider = await SopsKeyProvider.load("data.sops.json", "checker.sops.json", spawnFn);
  } finally {
    if (previousAgeFile === undefined) delete process.env.SOPS_AGE_KEY_FILE;
    else process.env.SOPS_AGE_KEY_FILE = previousAgeFile;
  }
  assert.deepEqual(provider.getDataKey("data"), data);
  assert.deepEqual(provider.getMacKey(), mac);
  assert.equal(calls.length, 2);
  for (const call of calls)
    assert.equal((call as { options: { env: NodeJS.ProcessEnv } }).options.env.SOPS_AGE_KEY_FILE, "age-key-example.txt");
  assert.deepEqual((calls[0] as { args: string[] }).args, [
    "-d",
    "--output-type",
    "json",
    "data.sops.json",
  ]);
});

test("agent server registration is disabled by default and opt-in uses admin auth", async () => {
  const prior = process.env.AGENT_ENABLED;
  delete process.env.AGENT_ENABLED;
  const f = fixture(),
    adminApiKey = randomBytes(32).toString("hex");
  const config: AppConfig = {
    host: "",
    port: 0,
    n8nApiKeys: new Set([randomBytes(32).toString("hex")]),
    adminApiKey,
    frontendApiKeys: new Set(),
    frontendAllowedCwds: [],
    codexAgentAllowedWorkspaceRoots: [],
    remoteCliToolAuthScopes: new Set(["admin"]),
    providersPath: "",
    logLevel: "fatal",
    maxJobLogLines: 10,
    shutdownTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    rateLimitMax: 100,
    rateLimitWindowMs: 60000,
    maxRequestBodySize: 1048576,
    autoRouterBenchmarkOnStart: false,
    autoRouterBenchmarkTimeoutMs: 1000,
    autoRouterBenchmarkMaxModels: 0,
    autoRouterBenchmarkConcurrency: 1,
    autoRouterBenchmarkIntervalMs: 0,
    autoRouterBenchmarkEvaluateQuality: false,
    autoRouterBenchmarkQualityTimeoutMs: 1000,
  };
  const registry = {
    listProviders: () => [],
    listModels: () => [],
  } as unknown as ProviderRegistry;
  const router = new FakeRouterClient(),
    pool = new WorkerPool(
      new LeaseManager(),
      new InProcessRunner(async () => ({})),
      1,
    );
  const inbox = new ApprovalInbox(f.log),
    delegate = new DelegateTool(
      pool,
      f.log,
      new RollingSummarizer(router, f.log),
    );
  const coordinator = new Coordinator(
    router,
    f.log,
    inbox,
    new InboxNotifier(f.log),
    delegate,
    new AgentMemory(f.log),
    f.mac,
  );
  let initialized = 0;
  const factory = async () => {
    initialized++;
    return {
      coordinator,
      delegate,
      inbox,
      sealer: f.sealer,
      close: async () => {},
    };
  };
  try {
    const off = buildServer(config, registry, { agentRuntimeFactory: factory });
    try {
      assert.equal(
        (await off.app.inject({ method: "GET", url: "/admin/agent/inbox" }))
          .statusCode,
        404,
      );
      assert.equal(initialized, 0);
    } finally {
      await off.close();
    }
    process.env.AGENT_ENABLED = "true";
    const enabled = buildServer(config, registry, {
      agentRuntimeFactory: factory,
    });
    try {
      assert.equal(
        (await enabled.app.inject({ method: "GET", url: "/admin/agent/inbox" }))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await enabled.app.inject({
            method: "GET",
            url: "/admin/agent/inbox",
            headers: { "x-admin-key": adminApiKey },
          })
        ).statusCode,
        200,
      );
      assert.equal(initialized, 1);
    } finally {
      await enabled.close();
    }
  } finally {
    if (prior === undefined) delete process.env.AGENT_ENABLED;
    else process.env.AGENT_ENABLED = prior;
    pool.close();
    f.close();
  }
});
