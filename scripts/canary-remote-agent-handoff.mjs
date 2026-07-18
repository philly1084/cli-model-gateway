#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HANDOFF_VERSION = 'RemoteAgentHandoff/v1';
const RESULT_VERSION = 'RemoteAgentResultFiles/v1';
const MAX_FILES = 12;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const TERMINAL_CODEX = new Set(['completed', 'failed', 'cancelled', 'input_required']);
const TERMINAL_PROVIDER = new Set(['completed', 'failed', 'terminated', 'timed_out']);
const SUPPORTED_MODES = ['codex', 'kimi', 'grok'];

class CanaryTimeoutError extends Error {}

function usage() {
  return `RemoteAgentHandoff/v1 live canary

Usage:
  node scripts/canary-remote-agent-handoff.mjs --dry-run [--mode codex|kimi|grok|all]
  node scripts/canary-remote-agent-handoff.mjs --run --mode codex|kimi|grok|all

Network access is disabled unless --run is present. Base URL and authentication
are accepted only through GATEWAY_BASE_URL plus GATEWAY_API_KEY or
GATEWAY_BEARER_TOKEN. See README.md for the remaining environment variables.`;
}

export function parseArgs(argv) {
  let action = null;
  let mode = 'all';
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--dry-run' || arg === '--run') {
      if (action && action !== arg) {
        throw new Error('Choose exactly one of --dry-run or --run.');
      }
      action = arg;
    } else if (arg === '--mode') {
      mode = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (help || argv.length === 0) {
    return { help: true, action: null, modes: [] };
  }
  if (!action) {
    throw new Error('Refusing network access without --run; use --dry-run to preview.');
  }
  const modes = mode === 'all' ? [...SUPPORTED_MODES] : mode.split(',').map((value) => value.trim());
  if (modes.length === 0 || modes.some((value) => !SUPPORTED_MODES.includes(value))) {
    throw new Error(`--mode must be one of ${SUPPORTED_MODES.join(', ')}, or all.`);
  }
  return { help: false, action, modes: [...new Set(modes)] };
}

function boundedInteger(value, fallback, label, minimum, maximum) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

export function loadConfig({ dryRun, modes }) {
  const apiKey = process.env.GATEWAY_API_KEY?.trim() || '';
  const bearerToken = process.env.GATEWAY_BEARER_TOKEN?.trim() || '';
  if (apiKey && bearerToken) {
    throw new Error('Set only one of GATEWAY_API_KEY or GATEWAY_BEARER_TOKEN.');
  }

  const baseUrlText = process.env.GATEWAY_BASE_URL?.trim() || '';
  let baseUrl = null;
  if (baseUrlText) {
    baseUrl = new URL(baseUrlText);
    if (!['http:', 'https:'].includes(baseUrl.protocol)
      || baseUrl.username
      || baseUrl.password
      || baseUrl.search
      || baseUrl.hash
      || !['', '/'].includes(baseUrl.pathname)) {
      throw new Error('GATEWAY_BASE_URL must be an http(s) URL without credentials, query, or fragment.');
    }
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname);
    if (baseUrl.protocol !== 'https:' && !loopback) {
      throw new Error('GATEWAY_BASE_URL must use HTTPS unless it targets loopback development.');
    }
  }

  const config = {
    dryRun,
    modes,
    baseUrl,
    authHeaders: apiKey
      ? { 'x-api-key': apiKey }
      : bearerToken
        ? { authorization: `Bearer ${bearerToken}` }
        : {},
    authConfigured: Boolean(apiKey || bearerToken),
    codexWorkspace: process.env.CANARY_CODEX_WORKSPACE?.trim() || '[required:CANARY_CODEX_WORKSPACE]',
    codexModel: process.env.CANARY_CODEX_MODEL?.trim() || '',
    remoteTargetId: process.env.CANARY_REMOTE_TARGET_ID?.trim() || '[required:CANARY_REMOTE_TARGET_ID]',
    remoteCwd: process.env.CANARY_REMOTE_CWD?.trim() || '[required:CANARY_REMOTE_CWD]',
    kimiProviderId: process.env.CANARY_KIMI_PROVIDER_ID?.trim() || 'kimi-code-cli',
    grokProviderId: process.env.CANARY_GROK_PROVIDER_ID?.trim() || 'grok-build-cli',
    kimiModel: process.env.CANARY_KIMI_MODEL?.trim() || 'k3',
    grokModel: process.env.CANARY_GROK_MODEL?.trim() || '',
    timeoutMs: boundedInteger(process.env.CANARY_TIMEOUT_MS, 240_000, 'CANARY_TIMEOUT_MS', 15_000, 900_000),
    pollIntervalMs: boundedInteger(process.env.CANARY_POLL_INTERVAL_MS, 2_000, 'CANARY_POLL_INTERVAL_MS', 250, 10_000),
    requestTimeoutMs: boundedInteger(process.env.CANARY_REQUEST_TIMEOUT_MS, 15_000, 'CANARY_REQUEST_TIMEOUT_MS', 1_000, 60_000),
  };

  if (modes.includes('kimi') && config.kimiModel !== 'k3') {
    throw new Error('CANARY_KIMI_MODEL must be exactly k3 for the Kimi artifact handoff canary.');
  }
  if (modes.includes('kimi') && config.kimiProviderId !== 'kimi-code-cli') {
    throw new Error('CANARY_KIMI_PROVIDER_ID must be exactly kimi-code-cli for the Kimi artifact handoff canary.');
  }

  if (!dryRun) {
    if (!config.baseUrl) {
      throw new Error('GATEWAY_BASE_URL is required with --run.');
    }
    if (!config.authConfigured) {
      throw new Error('GATEWAY_API_KEY or GATEWAY_BEARER_TOKEN is required with --run.');
    }
    if (modes.includes('codex') && config.codexWorkspace.startsWith('[required:')) {
      throw new Error('CANARY_CODEX_WORKSPACE is required for Codex mode.');
    }
    if (modes.some((mode) => mode !== 'codex')) {
      if (config.remoteTargetId.startsWith('[required:')) {
        throw new Error('CANARY_REMOTE_TARGET_ID is required for Kimi/Grok mode.');
      }
      if (config.remoteCwd.startsWith('[required:')) {
        throw new Error('CANARY_REMOTE_CWD is required for Kimi/Grok mode.');
      }
      if (!config.remoteCwd.startsWith('/')) {
        throw new Error('CANARY_REMOTE_CWD must be an absolute POSIX path.');
      }
    }
  }
  return config;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function inputFile(filename, mimeType, buffer, description) {
  return {
    filename,
    mimeType,
    sizeBytes: buffer.length,
    sha256: sha256(buffer),
    contentBase64: buffer.toString('base64'),
    source: 'handoff-canary',
    description,
  };
}

function createHandoff(mode) {
  const operationId = `canary-${mode}-${randomUUID()}`;
  const xml = Buffer.from([
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<kimibuilt-handoff-canary version="1" operationId="${operationId}">`,
    '  <purpose>Verify byte-identical XML artifact transfer.</purpose>',
    '  <safe>true</safe>',
    '</kimibuilt-handoff-canary>',
    '',
  ].join('\n'), 'utf8');
  const svg = Buffer.from([
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80" role="img">',
    '  <title>KimiBuilt artifact handoff canary</title>',
    '  <rect width="320" height="80" rx="12" fill="#172033"/>',
    '  <text x="160" y="47" text-anchor="middle" fill="#f4f7fb" font-family="sans-serif" font-size="18">Artifact handoff canary</text>',
    '</svg>',
    '',
  ].join('\n'), 'utf8');
  const files = [
    inputFile('design-canary.xml', 'application/xml', xml, 'Harmless byte-identical XML canary.'),
    inputFile('design-canary.svg', 'image/svg+xml', svg, 'Harmless byte-identical SVG canary.'),
  ];
  const runDirectory = `.kimibuilt/agent-runs/${operationId}`;
  const handoff = {
    version: HANDOFF_VERSION,
    operationId,
    runDirectory,
    contextDirectory: `${runDirectory}/input`,
    manifestPath: `${runDirectory}/input/manifest.json`,
    sourceArtifactIds: [],
    files,
    output: {
      version: RESULT_VERSION,
      enabled: true,
      directory: `${runDirectory}/output`,
      filesDirectory: `${runDirectory}/output/files`,
      manifestPath: `${runDirectory}/output/manifest.json`,
      requestedGlobs: ['*.xml', '*.svg'],
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
    },
  };
  assertValidHandoff(handoff);
  return { handoff, expectedFiles: new Map([[files[0].filename, xml], [files[1].filename, svg]]) };
}

function assertValidHandoff(handoff) {
  const root = `.kimibuilt/agent-runs/${handoff.operationId}`;
  const expectedPaths = {
    runDirectory: root,
    contextDirectory: `${root}/input`,
    manifestPath: `${root}/input/manifest.json`,
  };
  for (const [key, expected] of Object.entries(expectedPaths)) {
    if (handoff[key] !== expected) {
      throw new Error(`Canary generated an invalid ${key}.`);
    }
  }
  if (handoff.version !== HANDOFF_VERSION
    || handoff.output.version !== RESULT_VERSION
    || handoff.output.maxFiles !== MAX_FILES
    || handoff.output.maxFileBytes !== MAX_FILE_BYTES
    || handoff.output.maxTotalBytes !== MAX_TOTAL_BYTES
    || handoff.files.length > MAX_FILES) {
    throw new Error('Canary generated a handoff with a mismatched version or limit.');
  }
  let totalBytes = 0;
  for (const file of handoff.files) {
    const buffer = decodeBase64Strict(file.contentBase64, file.filename);
    if (buffer.length !== file.sizeBytes
      || buffer.length < 1
      || buffer.length > MAX_FILE_BYTES
      || sha256(buffer) !== file.sha256) {
      throw new Error(`Canary generated an invalid file attestation for ${file.filename}.`);
    }
    totalBytes += buffer.length;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('Canary input exceeds the handoff total-byte limit.');
  }
}

function createAgentPrompt(handoff) {
  const entries = handoff.files.map((file) => ({
    path: `${handoff.output.filesDirectory}/${file.filename}`,
    role: 'canary',
    mimeType: file.mimeType,
    description: `Byte-identical return of ${file.filename}.`,
  }));
  return [
    'Run only this bounded artifact-transfer canary.',
    `Operation: ${handoff.operationId}`,
    `Read the staged inputs listed in ${handoff.manifestPath}.`,
    `Copy ${handoff.files.map((file) => file.filename).join(' and ')} byte-for-byte from ${handoff.contextDirectory} into ${handoff.output.filesDirectory}, preserving each basename.`,
    'Verify each copy is byte-identical. Do not rewrite, reformat, render, optimize, or regenerate either file.',
    `Write this exact result manifest shape to ${handoff.output.manifestPath}:`,
    JSON.stringify({ version: RESULT_VERSION, files: entries }),
    `Finish with RESULT_FILES_MANIFEST=${handoff.output.manifestPath}.`,
    'Do not edit project files, use git, install packages, deploy anything, call kubectl, or change cluster state.',
    'For provider-agent mode, use only the configured SSH target; do not contact any other network service.',
    'Report REMOTE_AGENT_RESULT: success only after the copies and manifest are complete.',
  ].join('\n');
}

export function createPlan(mode, config) {
  const { handoff, expectedFiles } = createHandoff(mode);
  const prompt = createAgentPrompt(handoff);
  if (mode === 'codex') {
    return {
      mode,
      operationId: handoff.operationId,
      handoff,
      expectedFiles,
      startPath: '/api/codex-agent/run',
      body: {
        workspacePath: config.codexWorkspace,
        prompt,
        continuation: false,
        config: {
          approvalPolicy: 'never',
          threadSandbox: 'workspace-write',
          turnTimeoutMs: config.timeoutMs,
          stallTimeoutMs: Math.min(60_000, Math.max(15_000, Math.floor(config.timeoutMs / 2))),
          ...(config.codexModel ? { model: config.codexModel } : {}),
        },
        handoff,
      },
    };
  }
  const providerId = mode === 'kimi' ? config.kimiProviderId : config.grokProviderId;
  const model = mode === 'kimi' ? config.kimiModel : config.grokModel;
  return {
    mode,
    operationId: handoff.operationId,
    handoff,
    expectedFiles,
    providerId,
    startPath: '/admin/remote-agent-tasks',
    body: {
      providerId,
      targetId: config.remoteTargetId,
      cwd: config.remoteCwd,
      task: prompt,
      cols: 120,
      rows: 40,
      ...(model ? { model } : {}),
      handoff,
    },
  };
}

function redactedPlan(plan, config) {
  const handoff = {
    ...plan.handoff,
    files: plan.handoff.files.map(({ contentBase64, ...file }) => ({
      ...file,
      contentBase64: `[redacted ${contentBase64.length} base64 characters]`,
    })),
  };
  const body = {
    ...plan.body,
    ...(plan.mode === 'codex'
      ? { prompt: '[bounded byte-identical XML/SVG canary prompt]' }
      : { task: '[bounded byte-identical XML/SVG canary prompt]' }),
    handoff,
  };
  return {
    mode: plan.mode,
    network: false,
    baseUrl: config.baseUrl ? '[configured]' : '[not configured]',
    authentication: config.authConfigured ? '[configured]' : '[not configured]',
    startPath: plan.startPath,
    request: body,
  };
}

function createHttpClient(config) {
  const origin = config.baseUrl.origin;

  async function request(pathOrUrl, { method = 'GET', body, responseType = 'json', timeoutMs } = {}) {
    const url = new URL(pathOrUrl, config.baseUrl);
    if (url.origin !== origin) {
      throw new Error(`Refusing cross-origin canary request to ${url.origin}.`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs ?? config.requestTimeoutMs));
    timer.unref();
    let response;
    let text;
    try {
      response = await fetch(url, {
        method,
        redirect: 'error',
        headers: {
          accept: responseType === 'text' ? 'text/event-stream' : 'application/json',
          ...config.authHeaders,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Request timed out: ${method} ${url.pathname}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (responseType === 'status') {
      return response.status;
    }
    if (!response.ok) {
      throw new Error(`Gateway returned HTTP ${response.status} for ${method} ${url.pathname}: ${safeErrorText(text)}`);
    }
    if (responseType === 'text') {
      return text;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Gateway returned non-JSON for ${method} ${url.pathname}.`);
    }
  }

  return {
    json: (path, options) => request(path, { ...options, responseType: 'json' }),
    text: (path, options) => request(path, { ...options, responseType: 'text' }),
    status: (path, options) => request(path, { ...options, responseType: 'status' }),
    exactResultPath(returnedPath, expectedPath) {
      if (typeof returnedPath !== 'string' || !returnedPath) {
        throw new Error('Start response did not include resultFilesUrl.');
      }
      const returned = new URL(returnedPath, config.baseUrl);
      const expected = new URL(expectedPath, config.baseUrl);
      if (returned.origin !== origin
        || returned.pathname !== expected.pathname
        || returned.search
        || returned.hash) {
        throw new Error('Start response returned an unexpected result-files URL.');
      }
      return returned.pathname;
    },
  };
}

function safeErrorText(text) {
  try {
    const parsed = JSON.parse(text);
    const message = typeof parsed?.error === 'string'
      ? parsed.error
      : typeof parsed?.error?.message === 'string'
        ? parsed.error.message
        : 'gateway request failed';
    return message.slice(0, 500);
  } catch {
    return text.replace(/\s+/g, ' ').slice(0, 500) || 'gateway request failed';
  }
}

function assertExactAcknowledgement(actual, handoff) {
  const expected = {
    accepted: true,
    version: HANDOFF_VERSION,
    operationId: handoff.operationId,
    inputManifestPath: handoff.manifestPath,
    resultManifestPath: handoff.output.manifestPath,
  };
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    throw new Error('Gateway did not acknowledge the handoff.');
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
    || expectedKeys.some((key) => actual[key] !== expected[key])) {
    throw new Error('Gateway returned a mismatched handoff acknowledgement.');
  }
}

function parseSseEvents(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data) {
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {
      throw new Error('Codex events endpoint returned malformed SSE JSON.');
    }
  }
  return events;
}

function nextDelay(deadline, interval) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new CanaryTimeoutError('Canary exceeded its bounded terminal-status timeout.');
  }
  return Math.min(interval, remaining);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCodex(client, runId, config, onStatus) {
  const deadline = Date.now() + config.timeoutMs;
  let cursor = 0;
  let eventCount = 0;
  while (true) {
    const status = await client.json(`/api/codex-agent/runs/${encodeURIComponent(runId)}`);
    onStatus(status?.status);
    const eventText = await client.text(`/api/codex-agent/runs/${encodeURIComponent(runId)}/events?after=${cursor}&follow=false`);
    const events = parseSseEvents(eventText);
    eventCount += events.length;
    for (const event of events) {
      if (Number.isInteger(event?.cursor) && event.cursor > cursor) {
        cursor = event.cursor;
      }
    }
    if (TERMINAL_CODEX.has(status?.status)) {
      if (status.status !== 'completed') {
        throw new Error(`Codex canary ended with status ${status.status}.`);
      }
      return { status: status.status, eventCount };
    }
    await delay(nextDelay(deadline, config.pollIntervalMs));
  }
}

export function assertProviderTaskModel(task, plan) {
  if (plan.mode !== 'kimi') {
    return;
  }
  if (plan.body?.model !== 'k3') {
    throw new Error('Kimi canary plan is not pinned to model k3.');
  }
  if (!task || typeof task !== 'object' || task.model !== 'k3') {
    throw new Error('Kimi provider task did not attest task.model as k3.');
  }
}

async function pollProvider(client, taskId, plan, config, onStatus) {
  const deadline = Date.now() + config.timeoutMs;
  let cursor = 0;
  let eventCount = 0;
  while (true) {
    const task = await client.json(`/admin/remote-agent-tasks/${encodeURIComponent(taskId)}`);
    assertProviderTaskModel(task, plan);
    onStatus(task?.status);
    const transcript = await client.json(`/admin/remote-agent-tasks/${encodeURIComponent(taskId)}/transcript?after=${cursor}`);
    if (!Array.isArray(transcript?.data)) {
      throw new Error('Provider transcript endpoint returned an invalid envelope.');
    }
    eventCount += transcript.data.length;
    for (const event of transcript.data) {
      if (Number.isInteger(event?.cursor) && event.cursor > cursor) {
        cursor = event.cursor;
      }
    }
    if (TERMINAL_PROVIDER.has(task?.status)) {
      if (task.status !== 'completed') {
        throw new Error(`Provider canary ended with status ${task.status}.`);
      }
      return { status: task.status, eventCount };
    }
    await delay(nextDelay(deadline, config.pollIntervalMs));
  }
}

function decodeBase64Strict(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} has no base64 content.`);
  }
  const compact = value.replace(/\s+/g, '');
  if (!compact
    || compact.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error(`${label} contains invalid base64.`);
  }
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.toString('base64') !== compact) {
    throw new Error(`${label} contains non-canonical base64.`);
  }
  return buffer;
}

function verifyResultEnvelope(result, plan) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.gatewayVerified !== true
    || result.version !== RESULT_VERSION
    || result.operationId !== plan.operationId
    || result.manifestPath !== plan.handoff.output.manifestPath
    || !Array.isArray(result.files)) {
    throw new Error(`${plan.mode} returned an invalid gateway-verified result envelope.`);
  }
  if (result.files.length !== plan.expectedFiles.size || result.files.length > MAX_FILES) {
    throw new Error(`${plan.mode} returned an unexpected number of canary files.`);
  }
  let totalBytes = 0;
  const verified = [];
  const seen = new Set();
  for (const file of result.files) {
    const expected = plan.expectedFiles.get(file?.filename);
    const expectedPath = `${plan.handoff.output.filesDirectory}/${file?.filename}`;
    if (!expected || seen.has(file.filename) || file.path !== expectedPath) {
      throw new Error(`${plan.mode} returned an unexpected result path or filename.`);
    }
    const buffer = decodeBase64Strict(file.contentBase64, file.filename);
    const computedSha = sha256(buffer);
    if (!Number.isInteger(file.sizeBytes)
      || file.sizeBytes !== buffer.length
      || buffer.length < 1
      || buffer.length > MAX_FILE_BYTES
      || typeof file.sha256 !== 'string'
      || file.sha256 !== computedSha
      || computedSha !== sha256(expected)
      || !buffer.equals(expected)) {
      throw new Error(`${plan.mode} failed the byte-identical checksum canary for ${file.filename}.`);
    }
    totalBytes += buffer.length;
    seen.add(file.filename);
    verified.push({ filename: file.filename, sizeBytes: buffer.length, sha256: computedSha });
  }
  if (totalBytes > MAX_TOTAL_BYTES || seen.size !== plan.expectedFiles.size) {
    throw new Error(`${plan.mode} result files exceeded limits or omitted a canary.`);
  }
  return verified.sort((left, right) => left.filename.localeCompare(right.filename));
}

async function verifyHealth(client) {
  const health = await client.json('/healthz');
  if (health?.ok !== true || health?.contracts?.remoteAgentHandoff !== HANDOFF_VERSION) {
    throw new Error(`Gateway does not advertise ${HANDOFF_VERSION}.`);
  }
}

const AUTH_MUTATION_PROBES = Object.freeze([
  Object.freeze({ path: '/api/codex-agent/run', body: Object.freeze({}) }),
  Object.freeze({ path: '/admin/remote-agent-tasks', body: Object.freeze({}) }),
]);

export async function verifyLiveAuthFailClosed(config) {
  if (!config?.authConfigured || !config?.authHeaders || Object.keys(config.authHeaders).length !== 1) {
    throw new Error('Live auth preflight requires exactly one configured gateway credential.');
  }
  const usesBearer = Object.prototype.hasOwnProperty.call(config.authHeaders, 'authorization');
  const probes = [
    {
      label: 'missing credential',
      expectedStatus: 401,
      client: createHttpClient({ ...config, authHeaders: {} }),
    },
    {
      label: 'invalid credential',
      expectedStatus: 401,
      client: createHttpClient({
        ...config,
        authHeaders: usesBearer
          ? { authorization: 'Bearer invalid-remote-agent-canary-credential' }
          : { 'x-api-key': 'invalid-remote-agent-canary-credential' },
      }),
    },
    {
      label: 'configured credential',
      expectedStatus: 400,
      client: createHttpClient(config),
    },
  ];

  for (const probe of probes) {
    for (const mutation of AUTH_MUTATION_PROBES) {
      const status = await probe.client.status(mutation.path, {
        method: 'POST',
        body: mutation.body,
      });
      if (status !== probe.expectedStatus) {
        throw new Error(
          `Gateway auth preflight expected HTTP ${probe.expectedStatus} for ${probe.label} at ${mutation.path}; received ${status}.`,
        );
      }
    }
  }
  return {
    failClosed: true,
    protectedMutationRoutes: AUTH_MUTATION_PROBES.length,
    probes: AUTH_MUTATION_PROBES.length * probes.length,
  };
}

async function bestEffortCancel(client, mode, id) {
  const path = mode === 'codex'
    ? `/api/codex-agent/runs/${encodeURIComponent(id)}/cancel`
    : `/admin/remote-agent-tasks/${encodeURIComponent(id)}/cancel`;
  try {
    await client.json(path, { method: 'POST' });
  } catch {
    // Preserve the original canary failure without printing response data.
  }
}

async function executePlan(client, plan, config) {
  const startedAt = Date.now();
  let id = '';
  let latestStatus = 'starting';
  let resultPath = '';
  try {
    const start = await client.json(plan.startPath, { method: 'POST', body: plan.body });
    if (plan.mode === 'codex') {
      id = typeof start?.runId === 'string' ? start.runId : '';
      if (!id || start?.ok !== true) {
        throw new Error('Codex start response did not include a valid runId.');
      }
      latestStatus = start.status;
      assertExactAcknowledgement(start.handoff, plan.handoff);
      resultPath = client.exactResultPath(start.resultFilesUrl, `/api/codex-agent/runs/${id}/result-files`);
      var terminal = await pollCodex(client, id, config, (status) => { latestStatus = status; });
    } else {
      id = typeof start?.task?.id === 'string' ? start.task.id : '';
      if (!id || start?.task?.providerId !== plan.providerId) {
        throw new Error(`${plan.mode} start response did not include the expected provider task.`);
      }
      assertProviderTaskModel(start.task, plan);
      latestStatus = start.task.status;
      assertExactAcknowledgement(start.task.handoff, plan.handoff);
      resultPath = client.exactResultPath(start.resultFilesUrl, `/admin/remote-agent-tasks/${id}/result-files`);
      terminal = await pollProvider(client, id, plan, config, (status) => { latestStatus = status; });
    }
    const result = await client.json(resultPath);
    const files = verifyResultEnvelope(result, plan);
    return {
      mode: plan.mode,
      operationId: plan.operationId,
      status: terminal.status,
      ...(plan.body?.model ? { model: plan.body.model } : {}),
      observedEvents: terminal.eventCount,
      elapsedMs: Date.now() - startedAt,
      files,
    };
  } catch (error) {
    const terminalSet = plan.mode === 'codex' ? TERMINAL_CODEX : TERMINAL_PROVIDER;
    if (id && !terminalSet.has(latestStatus)) {
      await bestEffortCancel(client, plan.mode, id);
    }
    throw new Error(`${plan.mode} canary failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runLiveCanary(config, plans) {
  const client = createHttpClient(config);
  await verifyHealth(client);
  const authPreflight = await verifyLiveAuthFailClosed(config);
  const results = [];
  for (const plan of plans) {
    results.push(await executePlan(client, plan, config));
  }
  return {
    ok: true,
    contract: HANDOFF_VERSION,
    authPreflight,
    results,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const config = loadConfig({ dryRun: options.action === '--dry-run', modes: options.modes });
  const plans = options.modes.map((mode) => createPlan(mode, config));
  if (config.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      networkRequestsMade: 0,
      plans: plans.map((plan) => redactedPlan(plan, config)),
    }, null, 2));
    return;
  }

  console.log(JSON.stringify(await runLiveCanary(config, plans), null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
