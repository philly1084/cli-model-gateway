import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  assertProviderTaskModel,
  createPlan,
  loadConfig,
  parseArgs,
  runLiveCanary,
  verifyLiveAuthFailClosed,
} from './canary-remote-agent-handoff.mjs';

const ENV_KEYS = [
  'CANARY_KIMI_MODEL',
  'CANARY_KIMI_PROVIDER_ID',
  'GATEWAY_API_KEY',
  'GATEWAY_BEARER_TOKEN',
  'GATEWAY_BASE_URL',
];

function withCleanEnv(callback) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('Kimi dry-run defaults to an explicit k3 task model', () => withCleanEnv(() => {
  const options = parseArgs(['--dry-run', '--mode', 'kimi']);
  const config = loadConfig({ dryRun: true, modes: options.modes });
  const plan = createPlan('kimi', config);
  assert.equal(config.kimiModel, 'k3');
  assert.equal(plan.providerId, 'kimi-code-cli');
  assert.equal(plan.body.model, 'k3');
}));

test('Kimi canary refuses every requested model except exact k3', () => withCleanEnv(() => {
  process.env.CANARY_KIMI_MODEL = 'kimi-for-coding';
  assert.throws(
    () => loadConfig({ dryRun: true, modes: ['kimi'] }),
    /CANARY_KIMI_MODEL must be exactly k3/,
  );
}));

test('Kimi canary refuses every provider except the release-gated kimi-code-cli provider', () => withCleanEnv(() => {
  process.env.CANARY_KIMI_PROVIDER_ID = 'not-the-release-gated-provider';
  assert.throws(
    () => loadConfig({ dryRun: true, modes: ['kimi'] }),
    /CANARY_KIMI_PROVIDER_ID must be exactly kimi-code-cli/,
  );
}));

test('Kimi canary accepts a returned provider task only when task.model is k3', () => withCleanEnv(() => {
  const config = loadConfig({ dryRun: true, modes: ['kimi'] });
  const plan = createPlan('kimi', config);
  assert.doesNotThrow(() => assertProviderTaskModel({ model: 'k3' }, plan));
  assert.throws(
    () => assertProviderTaskModel({ model: 'kimi-for-coding' }, plan),
    /did not attest task.model as k3/,
  );
  assert.throws(
    () => assertProviderTaskModel({}, plan),
    /did not attest task.model as k3/,
  );
}));

test('non-Kimi lanes do not claim a Kimi model attestation', () => {
  assert.doesNotThrow(() => assertProviderTaskModel({}, { mode: 'grok', body: {} }));
});

test('live auth preflight proves missing and invalid credentials fail closed before accepting the configured key', async () => {
  const requests = [];
  await withHttpServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push({
      method: request.method,
      path: request.url,
      credential: request.headers['x-api-key'] ?? '',
      body,
    });
    const accepted = request.headers['x-api-key'] === 'valid-canary-key';
    sendJson(response, accepted ? 400 : 401, accepted
      ? { error: 'Invalid request body.' }
      : { error: 'Unauthorized' });
  }, async (baseUrl) => {
    const result = await verifyLiveAuthFailClosed({
      baseUrl,
      authHeaders: { 'x-api-key': 'valid-canary-key' },
      authConfigured: true,
      modes: ['codex', 'kimi', 'grok'],
      requestTimeoutMs: 2_000,
    });

    assert.deepEqual(result, {
      failClosed: true,
      protectedMutationRoutes: 2,
      probes: 6,
    });
  });

  assert.equal(requests.length, 6);
  assert.equal(requests.every((entry) => entry.method === 'POST'), true);
  assert.equal(requests.every((entry) => JSON.stringify(entry.body) === '{}'), true);
  assert.equal(requests.filter((entry) => !entry.credential).length, 2);
  assert.equal(requests.filter((entry) => entry.credential === 'invalid-remote-agent-canary-credential').length, 2);
  assert.equal(requests.filter((entry) => entry.credential === 'valid-canary-key').length, 2);
  assert.deepEqual(
    [...new Set(requests.map((entry) => entry.path))].sort(),
    ['/admin/remote-agent-tasks', '/api/codex-agent/run'],
  );
});

test('a live auth failure aborts before any agent start request', async () => {
  let agentStartRequests = 0;
  await withHttpServer(async (request, response) => {
    if (request.url === '/healthz') {
      sendJson(response, 200, {
        ok: true,
        contracts: { remoteAgentHandoff: 'RemoteAgentHandoff/v1' },
      });
      return;
    }
    const body = await readJsonBody(request);
    if (body?.prompt || body?.task) {
      agentStartRequests += 1;
    }
    // Simulate a dangerously open mutation route: validation ran before auth.
    sendJson(response, 400, { error: 'Invalid request body.' });
  }, async (baseUrl) => {
    const config = {
      baseUrl,
      authHeaders: { 'x-api-key': 'valid-canary-key' },
      authConfigured: true,
      modes: ['codex'],
      requestTimeoutMs: 2_000,
      timeoutMs: 15_000,
      pollIntervalMs: 250,
      codexWorkspace: '/tmp/canary-workspace',
      codexModel: '',
    };
    const plan = createPlan('codex', config);
    await assert.rejects(
      runLiveCanary(config, [plan]),
      /auth preflight expected HTTP 401.*received 400/,
    );
  });

  assert.equal(agentStartRequests, 0);
});

async function withHttpServer(handler, callback) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await callback(new URL(`http://127.0.0.1:${address.port}/`));
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
