#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { checkKimiK3ProviderConfig } from './check-kimi-k3-provider-config.mjs';
import { checkRemoteAgentProviderConfig } from './check-remote-agent-provider-config.mjs';

const MAX_CONFIGMAP_JSON_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDERS_CONFIG_BYTES = 2 * 1024 * 1024;
const KIMI_PROVIDER_ID = 'kimi-code-cli';
const KIMI_MODEL_ID = 'k3';
const KIMI_SESSION_EXECUTABLE = 'node';
const KIMI_SESSION_ARGS = [
  'dist/scripts/remote-agent-session-bridge.js',
  '--provider',
  'kimi',
];
const CODEX_PROVIDER_ID = 'codex-cli';
const DEFAULT_NAMESPACE = 'n8n-openai-gateway';
const DEFAULT_CONFIGMAP = 'n8n-openai-cli-gateway-config';
const DEFAULT_KUBECTL_TIMEOUT_MS = 30_000;
const CHANGE_TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage() {
  return `Usage:
  node scripts/reconcile-kimi-k3-configmap.mjs [--dry-run]
  node scripts/reconcile-kimi-k3-configmap.mjs --apply [--backup-dir <directory>]

Options:
  --namespace <name>   Kubernetes namespace (default: ${DEFAULT_NAMESPACE})
  --configmap <name>   Provider ConfigMap (default: ${DEFAULT_CONFIGMAP})
  --backup-dir <path>  Persistent rollback directory
  --dry-run            Server-side JSON Patch dry run (default)
  --apply              Apply only with all production-write gates

--apply requires ALLOW_PROD_WRITE=yes, HUMAN_APPROVED=yes, and a CHANGE_TICKET
that is 2-128 ASCII characters, starts with a letter or digit, and otherwise
contains only letters, digits, periods, underscores, colons, slashes, or
hyphens. Configuration content is never printed; stdout contains only the before
and after SHA-256 values.`;
}

function requireName(value, label) {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) {
    throw new CliError(`${label} must be a Kubernetes DNS-style name.`, 2);
  }
  return value;
}

function readOption(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CliError(`${flag} requires a value.`, 2);
  }
  return value;
}

export function parseArgs(args, env = process.env) {
  const options = {
    mode: 'dry-run',
    namespace: env.ROUTER_NAMESPACE?.trim() || DEFAULT_NAMESPACE,
    configMap: env.ROUTER_CONFIGMAP?.trim() || DEFAULT_CONFIGMAP,
    backupDir: env.ROUTER_CONFIG_ROLLBACK_DIR?.trim()
      || path.resolve('router-config-rollbacks'),
  };
  let selectedMode = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      return { ...options, help: true };
    }
    if (arg === '--dry-run' || arg === '--apply') {
      if (selectedMode) {
        throw new CliError('Choose exactly one of --dry-run or --apply.', 2);
      }
      selectedMode = true;
      options.mode = arg === '--apply' ? 'apply' : 'dry-run';
      continue;
    }
    if (arg === '--namespace') {
      options.namespace = readOption(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--configmap') {
      options.configMap = readOption(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--backup-dir') {
      options.backupDir = path.resolve(readOption(args, index, arg));
      index += 1;
      continue;
    }
    throw new CliError(`Unknown option: ${arg}`, 2);
  }

  options.namespace = requireName(options.namespace, 'namespace');
  options.configMap = requireName(options.configMap, 'configmap');
  options.backupDir = path.resolve(options.backupDir);
  if (options.backupDir === path.parse(options.backupDir).root) {
    throw new CliError('backup directory must not be a filesystem root.', 2);
  }
  return options;
}

function requireApplyGates(env) {
  if (env.ALLOW_PROD_WRITE !== 'yes'
    || env.HUMAN_APPROVED !== 'yes'
    || !CHANGE_TICKET_PATTERN.test(env.CHANGE_TICKET ?? '')) {
    throw new CliError(
      'Production apply requires ALLOW_PROD_WRITE=yes, HUMAN_APPROVED=yes, and a valid 2-128 character CHANGE_TICKET.',
      3,
    );
  }
}

function scalarArrayValue(node) {
  if (!isSeq(node)) {
    return null;
  }
  return node.items.map((item) => item?.toJSON?.() ?? item);
}

function pairByKey(map, key) {
  return map.items.find((pair) => pair.key?.toJSON?.() === key);
}

function lineStart(source, index) {
  const precedingNewline = source.lastIndexOf('\n', Math.max(0, index - 1));
  return precedingNewline < 0 ? 0 : precedingNewline + 1;
}

function lineEndingAt(source, index) {
  const newline = source.indexOf('\n', index);
  return newline > 0 && source[newline - 1] === '\r' ? '\r\n' : '\n';
}

function nodeRange(node, label) {
  if (!Array.isArray(node?.range)
    || !Number.isSafeInteger(node.range[0])
    || !Number.isSafeInteger(node.range[1])) {
    throw new Error(`${label} has no preservable YAML source range.`);
  }
  return node.range;
}

function valueReplacement(pair, replacement, label) {
  if (!isScalar(pair?.value)) {
    throw new Error(`${label} must be a YAML scalar.`);
  }
  const range = nodeRange(pair.value, label);
  return { start: range[0], end: range[1], replacement };
}

function insertionAfterPair(source, map, pair, lines, label) {
  const index = map.items.indexOf(pair);
  if (index < 0) {
    throw new Error(`${label} is not part of the expected YAML map.`);
  }
  const keyRange = nodeRange(pair.key, label);
  const start = lineStart(source, keyRange[0]);
  const keyIndent = ' '.repeat(keyRange[0] - start);
  const eol = lineEndingAt(source, keyRange[0]);
  const nextPair = map.items[index + 1];
  const insertionPoint = nextPair
    ? lineStart(source, nodeRange(nextPair.key, `${label} successor`)[0])
    : (pair.value?.range?.[2] ?? pair.key.range?.[2]);
  if (!Number.isSafeInteger(insertionPoint)) {
    throw new Error(`${label} has no safe insertion point.`);
  }
  return {
    start: insertionPoint,
    end: insertionPoint,
    replacement: lines.map((line) => `${keyIndent}${line}${eol}`).join(''),
  };
}

function pairRemoval(source, map, pair, label) {
  const index = map.items.indexOf(pair);
  if (index < 0) {
    throw new Error(`${label} is not part of the expected YAML map.`);
  }
  const start = lineStart(source, nodeRange(pair.key, label)[0]);
  const end = pair.value?.range?.[2] ?? pair.key.range?.[2];
  if (!Number.isSafeInteger(end) || end < start) {
    throw new Error(`${label} has no safe removable YAML range.`);
  }
  return { start, end, replacement: '' };
}

function modelInsertion(source, provider, models) {
  const modelItems = models.items.filter((model) => isMap(model));
  const beforeModel = modelItems.find((model) => model.get('id') === 'kimi-for-coding')
    || modelItems[0];
  if (beforeModel) {
    const modelRange = nodeRange(beforeModel, `${KIMI_PROVIDER_ID}.models entry`);
    const start = lineStart(source, modelRange[0]);
    const prefix = source.slice(start, modelRange[0]);
    const dash = prefix.lastIndexOf('-');
    if (dash < 0 || prefix.slice(0, dash).trim()) {
      throw new Error(`${KIMI_PROVIDER_ID}.models does not use a preservable block sequence.`);
    }
    const itemIndent = prefix.slice(0, dash);
    const fieldIndent = ' '.repeat(modelRange[0] - start);
    const eol = lineEndingAt(source, modelRange[0]);
    return {
      start,
      end: start,
      replacement: `${itemIndent}- id: ${KIMI_MODEL_ID}${eol}`
        + `${fieldIndent}providerModel: ${KIMI_MODEL_ID}${eol}`,
    };
  }

  const modelsPair = pairByKey(provider, 'models');
  if (!modelsPair || models.items.length !== 0 || !models.flow) {
    throw new Error(`${KIMI_PROVIDER_ID}.models has no safe K3 insertion point.`);
  }
  const keyRange = nodeRange(modelsPair.key, `${KIMI_PROVIDER_ID}.models`);
  const valueRange = nodeRange(modelsPair.value, `${KIMI_PROVIDER_ID}.models`);
  const keyStart = lineStart(source, keyRange[0]);
  const itemIndent = ' '.repeat((keyRange[0] - keyStart) + 2);
  const fieldIndent = `${itemIndent}  `;
  const eol = lineEndingAt(source, keyRange[0]);
  return {
    start: valueRange[0],
    end: valueRange[1],
    replacement: `${eol}${itemIndent}- id: ${KIMI_MODEL_ID}${eol}`
      + `${fieldIndent}providerModel: ${KIMI_MODEL_ID}`,
  };
}

function applyPreservingEdits(source, edits) {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let precedingStart = source.length + 1;
  let output = source;
  for (const edit of ordered) {
    if (!Number.isSafeInteger(edit.start)
      || !Number.isSafeInteger(edit.end)
      || edit.start < 0
      || edit.end < edit.start
      || edit.end > source.length
      || edit.end > precedingStart) {
      throw new Error('Reconciliation produced overlapping or invalid YAML edits.');
    }
    output = `${output.slice(0, edit.start)}${edit.replacement}${output.slice(edit.end)}`;
    precedingStart = edit.start;
  }
  return output;
}

export function reconcileKimiK3ProviderConfig(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('providers.yaml is empty.');
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_PROVIDERS_CONFIG_BYTES) {
    throw new Error(`providers.yaml exceeds ${MAX_PROVIDERS_CONFIG_BYTES} bytes.`);
  }

  const document = parseDocument(source, {
    keepSourceTokens: true,
    maxAliasCount: 100,
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error('providers.yaml is invalid YAML.');
  }

  const providers = document.get('providers', true);
  if (!isSeq(providers)) {
    throw new Error('Top-level providers must be a YAML sequence.');
  }
  const kimiProviders = providers.items.filter(
    (provider) => isMap(provider) && provider.get('id') === KIMI_PROVIDER_ID,
  );
  if (kimiProviders.length !== 1) {
    throw new Error(
      `Expected exactly one ${KIMI_PROVIDER_ID} provider; found ${kimiProviders.length}.`,
    );
  }

  const provider = kimiProviders[0];
  if (provider.get('type') !== 'cli') {
    throw new Error(`${KIMI_PROVIDER_ID} must already be a CLI provider.`);
  }
  const models = provider.get('models', true);
  if (!isSeq(models)) {
    throw new Error(`${KIMI_PROVIDER_ID}.models must already be a YAML sequence.`);
  }
  const sessionCommand = provider.get('sessionCommand', true);
  if (!isMap(sessionCommand)) {
    throw new Error(`${KIMI_PROVIDER_ID} must already define sessionCommand.`);
  }
  const sessionArgs = scalarArrayValue(sessionCommand.get('args', true));
  if (sessionCommand.get('executable') !== KIMI_SESSION_EXECUTABLE
    || JSON.stringify(sessionArgs) !== JSON.stringify(KIMI_SESSION_ARGS)) {
    throw new Error(
      `${KIMI_PROVIDER_ID}.sessionCommand must already invoke the exact bounded Kimi bridge.`,
    );
  }

  const k3Models = models.items.filter(
    (model) => isMap(model) && model.get('id') === KIMI_MODEL_ID,
  );
  if (k3Models.length > 1) {
    throw new Error(`Refusing to reconcile duplicate ${KIMI_MODEL_ID} model entries.`);
  }

  const edits = [];
  if (k3Models.length === 0) {
    edits.push(modelInsertion(source, provider, models));
  } else {
    const k3Model = k3Models[0];
    const providerModelPair = pairByKey(k3Model, 'providerModel');
    const fallbackPair = pairByKey(k3Model, 'fallbackModels');
    if (!providerModelPair) {
      const idPair = pairByKey(k3Model, 'id');
      if (!idPair) {
        throw new Error(`${KIMI_MODEL_ID} model has no id field.`);
      }
      edits.push(insertionAfterPair(
        source,
        k3Model,
        fallbackPair || idPair,
        [`providerModel: ${KIMI_MODEL_ID}`],
        fallbackPair ? `${KIMI_MODEL_ID}.fallbackModels` : `${KIMI_MODEL_ID}.id`,
      ));
    } else if (k3Model.get('providerModel') !== KIMI_MODEL_ID) {
      edits.push(valueReplacement(
        providerModelPair,
        KIMI_MODEL_ID,
        `${KIMI_MODEL_ID}.providerModel`,
      ));
    }
    if (fallbackPair) {
      edits.push(pairRemoval(
        source,
        k3Model,
        fallbackPair,
        `${KIMI_MODEL_ID}.fallbackModels`,
      ));
    }
  }

  const supportsPair = pairByKey(sessionCommand, 'supportsModelSelection');
  const modelFlagPair = pairByKey(sessionCommand, 'modelFlag');
  const missingSessionLines = [];
  if (!supportsPair) {
    missingSessionLines.push('supportsModelSelection: true');
  } else if (sessionCommand.get('supportsModelSelection') !== true) {
    edits.push(valueReplacement(
      supportsPair,
      'true',
      `${KIMI_PROVIDER_ID}.sessionCommand.supportsModelSelection`,
    ));
  }
  if (!modelFlagPair) {
    missingSessionLines.push('modelFlag: --model');
  } else if (sessionCommand.get('modelFlag') !== '--model') {
    edits.push(valueReplacement(
      modelFlagPair,
      '--model',
      `${KIMI_PROVIDER_ID}.sessionCommand.modelFlag`,
    ));
  }
  if (missingSessionLines.length > 0) {
    const argsPair = pairByKey(sessionCommand, 'args');
    if (!argsPair) {
      throw new Error(`${KIMI_PROVIDER_ID}.sessionCommand has no args field.`);
    }
    edits.push(insertionAfterPair(
      source,
      sessionCommand,
      argsPair,
      missingSessionLines,
      `${KIMI_PROVIDER_ID}.sessionCommand.args`,
    ));
  }

  const reconciled = applyPreservingEdits(source, edits);
  checkKimiK3ProviderConfig(reconciled, { sourceName: 'reconciled providers.yaml' });
  return reconciled;
}

export function reconcileRemoteAgentProviderConfig(source) {
  const kimiReconciled = reconcileKimiK3ProviderConfig(source);
  const document = parseDocument(kimiReconciled, {
    keepSourceTokens: true,
    maxAliasCount: 100,
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error('providers.yaml is invalid YAML after Kimi reconciliation.');
  }
  const providers = document.get('providers', true);
  if (!isSeq(providers)) {
    throw new Error('Top-level providers must be a YAML sequence.');
  }
  const matches = providers.items.filter(
    (provider) => isMap(provider) && provider.get('id') === CODEX_PROVIDER_ID,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${CODEX_PROVIDER_ID} provider; found ${matches.length}.`);
  }
  const provider = matches[0];
  if (provider.get('type') !== 'cli') {
    throw new Error(`${CODEX_PROVIDER_ID} must already be a CLI provider.`);
  }
  const existing = provider.get('sessionCommand', true);
  if (existing) {
    checkRemoteAgentProviderConfig(kimiReconciled, { sourceName: 'reconciled providers.yaml' });
    return kimiReconciled;
  }
  const responseCommandPair = pairByKey(provider, 'responseCommand');
  if (!responseCommandPair) {
    throw new Error(`${CODEX_PROVIDER_ID} has no responseCommand insertion anchor.`);
  }
  const edit = insertionAfterPair(
    kimiReconciled,
    provider,
    responseCommandPair,
    [
      'sessionCommand:',
      '  executable: node',
      '  args:',
      '    - dist/scripts/remote-agent-session-bridge.js',
      '    - --provider',
      '    - codex',
      '    - --session',
      '    - "{{session_id}}"',
      '  supportsModelSelection: true',
      '  modelFlag: --model',
      '  supportsWorkingDirectory: true',
      '  closeInputAfterWrite: true',
      '  idleTimeoutMs: 1800000',
      '  maxLifetimeMs: 14400000',
      '  ptyMode: pipe',
    ],
    `${CODEX_PROVIDER_ID}.responseCommand`,
  );
  const reconciled = applyPreservingEdits(kimiReconciled, [edit]);
  checkRemoteAgentProviderConfig(reconciled, { sourceName: 'reconciled providers.yaml' });
  return reconciled;
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parsePrefixArgs(env) {
  const source = env.KUBECTL_PREFIX_ARGS_JSON?.trim();
  if (!source) {
    return [];
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CliError('KUBECTL_PREFIX_ARGS_JSON must be a JSON string array.', 2);
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new CliError('KUBECTL_PREFIX_ARGS_JSON must be a JSON string array.', 2);
  }
  return value;
}

function kubectlTimeout(env) {
  const raw = env.KUBECTL_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_KUBECTL_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) {
    throw new CliError('KUBECTL_TIMEOUT_MS must be an integer from 1000 through 120000.', 2);
  }
  return value;
}

function runKubectl(args, env) {
  const executable = env.KUBECTL_EXECUTABLE?.trim() || 'kubectl';
  const prefixArgs = parsePrefixArgs(env);
  const result = spawnSync(executable, [...prefixArgs, ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: MAX_CONFIGMAP_JSON_BYTES,
    shell: false,
    timeout: kubectlTimeout(env),
    windowsHide: true,
  });
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT' ? 'timed out' : 'could not start';
    throw new Error(`kubectl ${args[0]} ${reason}.`);
  }
  if (result.status !== 0) {
    throw new Error(`kubectl ${args[0]} failed with exit status ${result.status}.`);
  }
  return result.stdout;
}

function parseConfigMap(source, options) {
  if (Buffer.byteLength(source, 'utf8') > MAX_CONFIGMAP_JSON_BYTES) {
    throw new Error('ConfigMap JSON exceeds the bounded response size.');
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('kubectl returned invalid ConfigMap JSON.');
  }
  const resourceVersion = value?.metadata?.resourceVersion;
  const providersSource = value?.data?.['providers.yaml'];
  if (value?.kind !== 'ConfigMap'
    || value?.metadata?.name !== options.configMap
    || value?.metadata?.namespace !== options.namespace) {
    throw new Error('kubectl returned a different ConfigMap identity than requested.');
  }
  if (typeof resourceVersion !== 'string' || !resourceVersion) {
    throw new Error('ConfigMap JSON has no resourceVersion.');
  }
  if (typeof providersSource !== 'string' || !providersSource) {
    throw new Error('ConfigMap JSON has no non-empty data.providers.yaml.');
  }
  return { value, resourceVersion, providersSource };
}

function readConfigMap(options, env) {
  const source = runKubectl([
    'get',
    'configmap',
    options.configMap,
    '-n',
    options.namespace,
    '-o',
    'json',
  ], env);
  return parseConfigMap(source, options);
}

function buildPatch(resourceVersion, before, after) {
  return [
    {
      op: 'test',
      path: '/metadata/resourceVersion',
      value: resourceVersion,
    },
    {
      op: 'test',
      path: '/data/providers.yaml',
      value: before,
    },
    {
      op: 'replace',
      path: '/data/providers.yaml',
      value: after,
    },
  ];
}

async function writeRestrictedFile(file, content, options = {}) {
  await writeFile(file, content, {
    encoding: 'utf8',
    flag: options.flag || 'wx',
    mode: 0o600,
  });
  await chmod(file, 0o600);
}

async function writeRollbackBackup(directory, configMap, beforeHash, content) {
  const createdPath = await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryDetails = await lstat(directory);
  if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink()) {
    throw new Error('Rollback backup directory must be a real directory.');
  }
  if (createdPath) {
    await chmod(directory, 0o700);
  } else if (process.platform !== 'win32' && (directoryDetails.mode & 0o077) !== 0) {
    throw new Error('Existing rollback backup directory permissions are not owner-only.');
  }
  const securedDirectoryDetails = await lstat(directory);
  const file = path.join(directory, `${configMap}.${beforeHash}.rollback.providers.yaml`);
  try {
    await writeRestrictedFile(file, content);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
    const existingDetails = await lstat(file);
    if (!existingDetails.isFile() || existingDetails.isSymbolicLink()) {
      throw new Error('Existing rollback backup must be a regular non-symlink file.');
    }
    const existing = await readFile(file, 'utf8');
    if (existing !== content) {
      throw new Error('Existing rollback backup does not match the current providers.yaml.');
    }
    await chmod(file, 0o600);
  }
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error('Rollback backup is not a regular non-symlink file.');
  }
  if (process.platform !== 'win32'
    && ((securedDirectoryDetails.mode & 0o077) !== 0 || (details.mode & 0o077) !== 0)) {
    throw new Error('Rollback backup permissions are not owner-only.');
  }
  return file;
}

async function withPatchFile(patch, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'router-kimi-k3-reconcile-'));
  try {
    await chmod(directory, 0o700);
    const file = path.join(directory, 'providers-configmap.patch.json');
    await writeRestrictedFile(file, `${JSON.stringify(patch)}\n`);
    return await callback(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function patchArgs(options, patchFile, dryRun) {
  return [
    'patch',
    'configmap',
    options.configMap,
    '-n',
    options.namespace,
    '--type=json',
    '--patch-file',
    patchFile,
    ...(dryRun ? ['--dry-run=server'] : []),
    '-o',
    'json',
  ];
}

export async function reconcileConfigMap(options, env = process.env) {
  if (options.mode === 'apply') {
    requireApplyGates(env);
  }

  const current = readConfigMap(options, env);
  const reconciled = reconcileRemoteAgentProviderConfig(current.providersSource);
  const beforeHash = sha256(current.providersSource);
  const afterHash = sha256(reconciled);
  console.log(`before_sha256=${beforeHash}`);
  console.log(`after_sha256=${afterHash}`);

  const patch = buildPatch(
    current.resourceVersion,
    current.providersSource,
    reconciled,
  );
  await withPatchFile(patch, async (patchFile) => {
    runKubectl(patchArgs(options, patchFile, true), env);
    if (options.mode !== 'apply' || beforeHash === afterHash) {
      return;
    }

    await writeRollbackBackup(
      options.backupDir,
      options.configMap,
      beforeHash,
      current.providersSource,
    );
    runKubectl(patchArgs(options, patchFile, false), env);
  });

  if (options.mode !== 'apply' || beforeHash === afterHash) {
    return { beforeHash, afterHash, changed: beforeHash !== afterHash };
  }

  const verified = readConfigMap(options, env);
  const verifiedHash = sha256(verified.providersSource);
  if (verifiedHash !== afterHash || verified.providersSource !== reconciled) {
    throw new Error('Post-apply providers.yaml does not match the reconciled SHA-256.');
  }
  checkKimiK3ProviderConfig(verified.providersSource, {
    sourceName: 'verified live providers.yaml',
  });
  return { beforeHash, afterHash, changed: true };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  await reconcileConfigMap(options);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  });
}
