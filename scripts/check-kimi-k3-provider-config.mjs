#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

const MAX_PROVIDERS_CONFIG_BYTES = 2 * 1024 * 1024;
const KIMI_PROVIDER_ID = 'kimi-code-cli';
const KIMI_MODEL_ID = 'k3';
const KIMI_SESSION_EXECUTABLE = 'node';
const KIMI_SESSION_ARGS = [
  'dist/scripts/remote-agent-session-bridge.js',
  '--provider',
  'kimi',
];

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function fail(sourceName, message) {
  throw new Error(`${sourceName}: ${message}`);
}

export function checkKimiK3ProviderConfig(source, options = {}) {
  const sourceName = options.sourceName || 'providers.yaml';
  if (typeof source !== 'string' || source.length === 0) {
    fail(sourceName, 'providers.yaml is empty.');
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_PROVIDERS_CONFIG_BYTES) {
    fail(sourceName, `providers.yaml exceeds ${MAX_PROVIDERS_CONFIG_BYTES} bytes.`);
  }

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

  const providers = root.providers.filter((entry) => asRecord(entry)?.id === KIMI_PROVIDER_ID);
  if (providers.length !== 1) {
    fail(sourceName, `expected exactly one ${KIMI_PROVIDER_ID} provider; found ${providers.length}.`);
  }

  const provider = asRecord(providers[0]);
  if (!provider || provider.type !== 'cli') {
    fail(sourceName, `${KIMI_PROVIDER_ID} must be a CLI provider.`);
  }
  if (!Array.isArray(provider.models)) {
    fail(sourceName, `${KIMI_PROVIDER_ID}.models must be an array.`);
  }

  const models = provider.models.filter((entry) => asRecord(entry)?.id === KIMI_MODEL_ID);
  if (models.length !== 1) {
    fail(sourceName, `expected exactly one ${KIMI_PROVIDER_ID} model with id ${KIMI_MODEL_ID}; found ${models.length}.`);
  }
  const model = asRecord(models[0]);
  if (!model || model.providerModel !== KIMI_MODEL_ID) {
    fail(sourceName, `${KIMI_PROVIDER_ID} model ${KIMI_MODEL_ID} must set providerModel: ${KIMI_MODEL_ID}.`);
  }
  if (Object.prototype.hasOwnProperty.call(model, 'fallbackModels')) {
    fail(sourceName, `${KIMI_PROVIDER_ID} model ${KIMI_MODEL_ID} must not declare fallbackModels.`);
  }

  const sessionCommand = asRecord(provider.sessionCommand);
  if (!sessionCommand) {
    fail(sourceName, `${KIMI_PROVIDER_ID} must define sessionCommand.`);
  }
  if (sessionCommand.executable !== KIMI_SESSION_EXECUTABLE
    || !Array.isArray(sessionCommand.args)
    || JSON.stringify(sessionCommand.args) !== JSON.stringify(KIMI_SESSION_ARGS)) {
    fail(
      sourceName,
      `${KIMI_PROVIDER_ID}.sessionCommand must invoke the bounded Kimi remote-agent session bridge.`,
    );
  }
  if (sessionCommand.supportsModelSelection !== true) {
    fail(sourceName, `${KIMI_PROVIDER_ID}.sessionCommand.supportsModelSelection must be true.`);
  }
  if (sessionCommand.modelFlag !== '--model') {
    fail(sourceName, `${KIMI_PROVIDER_ID}.sessionCommand.modelFlag must be --model.`);
  }

  return {
    providerId: KIMI_PROVIDER_ID,
    modelId: KIMI_MODEL_ID,
    providerModel: KIMI_MODEL_ID,
    sessionExecutable: KIMI_SESSION_EXECUTABLE,
    sessionArgs: [...KIMI_SESSION_ARGS],
    modelFlag: '--model',
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
  if (!details.isFile()) {
    throw new Error(`${file} is not a regular file.`);
  }
  if (details.size > MAX_PROVIDERS_CONFIG_BYTES) {
    throw new Error(`${file} exceeds ${MAX_PROVIDERS_CONFIG_BYTES} bytes.`);
  }
  return readFile(file, 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || ['--help', '-h'].includes(args[0])) {
    console.error('Usage: node scripts/check-kimi-k3-provider-config.mjs <providers.yaml|--stdin>');
    process.exitCode = 2;
    return;
  }

  const sourceName = args[0] === '--stdin' ? 'stdin providers.yaml' : path.resolve(args[0]);
  const source = args[0] === '--stdin'
    ? await readBoundedStdin()
    : await readBoundedFile(sourceName);
  const result = checkKimiK3ProviderConfig(source, { sourceName });
  console.log(
    `Kimi K3 provider preflight passed: provider=${result.providerId} `
      + `model=${result.modelId} providerModel=${result.providerModel} modelFlag=${result.modelFlag}`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
