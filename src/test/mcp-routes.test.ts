import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { mcpRoutes } from "../routes/mcp";
import { buildRemoteOpenCodeLaunch, RemoteCliToolManager } from "../jobs/remote-cli-tool-manager";
import type { RemoteCliToolAuthScope, RemoteCliTargetConfig } from "../types";

const TARGET: RemoteCliTargetConfig = {
  targetId: "prod",
  host: "server.example.com",
  allowedCwds: ["/srv/apps"],
  defaultCwd: "/srv/apps/repo",
};

test("mcp tools/list allows frontend/admin by default and rejects n8n when not enabled", async () => {
  const app = createMcpTestApp(new Set(["frontend", "admin"]));

  try {
    const frontend = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer frontend-key" },
      payload: rpc("tools/list"),
    });
    assert.equal(frontend.statusCode, 200);
    assert.match(frontend.payload, /remote_code_run/);

    const admin = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "x-api-key": "admin-key" },
      payload: rpc("tools/list"),
    });
    assert.equal(admin.statusCode, 200);

    const n8n = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer n8n-key" },
      payload: rpc("tools/list"),
    });
    assert.equal(n8n.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("mcp tools/list permits n8n only when configured", async () => {
  const app = createMcpTestApp(new Set(["frontend", "admin", "n8n"]));

  try {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer n8n-key" },
      payload: rpc("tools/list"),
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { result: { tools: Array<{ name: string }> } };
    assert.equal(body.result.tools.some((tool) => tool.name === "remote_code_run"), true);
  } finally {
    await app.close();
  }
});

test("mcp remote_code_run rejects raw command fields before spawning ssh", async () => {
  let spawnCount = 0;
  const app = createMcpTestApp(new Set(["frontend", "admin", "n8n"]), () => {
    spawnCount += 1;
    return createFakeChild();
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer n8n-key" },
      payload: rpc("tools/call", {
        name: "remote_code_run",
        arguments: {
          targetId: "prod",
          task: "do work",
          command: "rm",
        },
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(spawnCount, 0);
    assert.match(response.payload, /does not accept raw command field/);
  } finally {
    await app.close();
  }
});

test("mcp remote_code_run returns structured job output", async () => {
  const app = createMcpTestApp(new Set(["frontend", "admin", "n8n"]), () => {
    const child = createFakeChild();
    setTimeout(() => {
      (child.stdout as PassThrough).write(
        '{"sessionId":"sess_456","summary":"done","text":"WHAT_CHANGED=done\\nVERIFY_COMMANDS=remote smoke\\nVERIFY_RESULTS=passed\\nPUBLIC_URL=https://example.com\\nBLOCKER=none"}\n',
      );
      child.emit("close", 0);
    }, 5);
    return child;
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer n8n-key" },
      payload: rpc("tools/call", {
        name: "remote_code_run",
        arguments: {
          targetId: "prod",
          task: "fix bug",
          waitMs: 500,
        },
      }),
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      result: {
        structuredContent: {
          status: string;
          sessionId?: string;
          summary?: string;
          proof?: {
            complete: boolean;
            markers: Record<string, string[]>;
          };
        };
      };
    };
    assert.equal(body.result.structuredContent.status, "completed");
    assert.equal(body.result.structuredContent.sessionId, "sess_456");
    assert.equal(body.result.structuredContent.summary, "done");
    assert.equal(body.result.structuredContent.proof?.complete, true);
    assert.equal(body.result.structuredContent.proof?.markers.PUBLIC_URL?.[0], "https://example.com");
  } finally {
    await app.close();
  }
});

test("remote_code_run forwards adminMode as Codex sandbox selection for codex targets", () => {
  const targets = new Map<string, RemoteCliTargetConfig>([
    ["prod", {
      ...TARGET,
      opencodeExecutable: "/usr/local/bin/codex-remote-run",
    }],
  ]);

  const adminLaunch = buildRemoteOpenCodeLaunch({
    targetId: "prod",
    task: "deploy and verify live",
    adminMode: true,
  }, targets);
  assert.match(adminLaunch.remoteCommand, /--sandbox danger-full-access/);

  const normalLaunch = buildRemoteOpenCodeLaunch({
    targetId: "prod",
    task: "inspect source only",
  }, targets);
  assert.match(normalLaunch.remoteCommand, /--sandbox workspace-write/);
});

function createMcpTestApp(
  authScopes: Set<RemoteCliToolAuthScope>,
  spawnFn?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams,
) {
  const app = Fastify({ logger: false });
  const manager = new RemoteCliToolManager([TARGET], {
    sshExecutable: "fake-ssh",
    spawnFn: spawnFn ?? (() => createFakeChild()),
  });
  void app.register(mcpRoutes, {
    manager,
    adminApiKey: "admin-key",
    frontendApiKeys: new Set(["frontend-key"]),
    n8nApiKeys: new Set(["n8n-key"]),
    authScopes,
  });
  return app;
}

function rpc(method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id: "1",
    method,
    params,
  };
}

function createFakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
  child.kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
  return child;
}
