#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { checkKimiK3ProviderConfig } from './check-kimi-k3-provider-config.mjs';

const MAX_PROVIDERS_CONFIG_BYTES = 2 * 1024 * 1024;
const CODEX_PROVIDER_ID = 'codex-cli';
const CODEX_SESSION = Object.freeze({
  executable: 'node',
  args: [
    'dist/scripts/remote-agent-session-bridge.js',
    '--provider',
    'codex',
    '--session',
    '{{session_id}}',
  ],
  supportsModelSelection: true,
  modelFlag: '--model',
  supportsWorkingDirectory: true,
  closeInputAfterWrite: true,
  idleTimeoutMs: 1_800_000,
  maxLifetimeMs: 14_400_000,
  ptyMode: 'pipe',
});

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function fail(sourceName, message) {
  throw new Error(`${sourceName}: ${message}`);
}

export function checkRemoteAgentProviderConfig(source, options = {}) {
  const sourceName = options.sourceName || 'providers.yaml';
  const kimi = checkKimiK3ProviderConfig(source, { sourceName });
  const document = parseDocument(source, {
    maxAliasCount: 100,
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail(sourceName, `invalid YAML: ${document.errors.map((error) => error.message).join('; ')}`);
  }
  const root = asRecord(document.toJS({ maxAliasCount: 100 }));
  if (!root || !Array.isArray(root.providers)) {
    fail(sourceName, 'top-level providers must be an array.');
  }
  const providers = root.providers.filter((entry) => asRecord(entry)?.id === CODEX_PROVIDER_ID);
  if (providers.length !== 1) {
    fail(sourceName, `expected exactly one ${CODEX_PROVIDER_ID} provider; found ${providers.length}.`);
  }
  const provider = asRecord(providers[0]);
  if (!provider || provider.type !== 'cli') {
    fail(sourceName, `${CODEX_PROVIDER_ID} must be a CLI provider.`);
  }
  const session = asRecord(provider.sessionCommand);
  if (!session) {
    fail(sourceName, `${CODEX_PROVIDER_ID} must define the host-side remote-agent sessionCommand.`);
  }
  for (const [key, expected] of Object.entries(CODEX_SESSION)) {
    if (JSON.stringify(session[key]) !== JSON.stringify(expected)) {
      fail(sourceName, `${CODEX_PROVIDER_ID}.sessionCommand.${key} does not match the release contract.`);
    }
  }
  return {
    kimi,
    codex: {
      providerId: CODEX_PROVIDER_ID,
      sessionExecutable: CODEX_SESSION.executable,
      sessionArgs: [...CODEX_SESSION.args],
      modelFlag: CODEX_SESSION.modelFlag,
    },
  };
}

async function readBoundedStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PROVIDERS_CONFIG_BYTES) {
      throw new Error(`stdin exceeds ${MAX_PROVIDERS_CONFIG_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBoundedFile(file) {
  const details = await stat(file);
  if (!details.isFile() || details.size > MAX_PROVIDERS_CONFIG_BYTES) {
    throw new Error(`${file} is not a bounded regular file.`);
  }
  return readFile(file, 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || ['--help', '-h'].includes(args[0])) {
    console.error('Usage: node scripts/check-remote-agent-provider-config.mjs <providers.yaml|--stdin>');
    process.exitCode = 2;
    return;
  }
  const sourceName = args[0] === '--stdin' ? 'stdin providers.yaml' : path.resolve(args[0]);
  const source = args[0] === '--stdin' ? await readBoundedStdin() : await readBoundedFile(sourceName);
  const result = checkRemoteAgentProviderConfig(source, { sourceName });
  console.log(
    `Remote-agent provider preflight passed: codex=${result.codex.providerId} `
      + `kimi=${result.kimi.providerId} model=${result.kimi.modelId}`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
