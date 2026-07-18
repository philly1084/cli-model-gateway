import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { checkKimiK3ProviderConfig } from './check-kimi-k3-provider-config.mjs';
import {
  parseArgs,
  reconcileKimiK3ProviderConfig,
  sha256,
} from './reconcile-kimi-k3-configmap.mjs';

const repositoryRoot = path.resolve('.');
const cli = path.join(repositoryRoot, 'scripts', 'reconcile-kimi-k3-configmap.mjs');
const configMapName = 'n8n-openai-cli-gateway-config';

function liveLikeProvidersSource() {
  return `# top-level comment must survive byte-for-byte
remoteCliTargets:
  - id: k3s-prod
    host: "deploy@example.invalid"
customRoot:
  exact: 'keep this style'
providers:
  - id: another-provider
    type: openai
    description: Never rewrite me
    models:
      - id: other-model
        providerModel: other-model
    customProviderKey: "preserve"

  # Kimi bridge comment must survive
  - id: kimi-code-cli
    type: cli
    description: Existing authenticated bridge
    models:
      - id: kimi-for-coding
        providerModel: kimi-for-coding
        fallbackModels:
          - other-model
        unrelatedModelKey: 'keep'
    responseCommand:
      executable: node
      args:
        - dist/scripts/kimi-acp-bridge.js
        - --model
        - "{{provider_model}}"
    sessionCommand:
      executable: node
      args:
        - dist/scripts/remote-agent-session-bridge.js
        - --provider
        - kimi
      env:
        TERM: "xterm-256color"
      supportsWorkingDirectory: true
      customSessionKey: preserve
    customKimiKey:
      nested: true
unrelatedTail: "unchanged"
`;
}

function expectedReconciledSource(source, eol = '\n') {
  return source
    .replace(
      `      - id: kimi-for-coding${eol}`,
      `      - id: k3${eol}        providerModel: k3${eol}      - id: kimi-for-coding${eol}`,
    )
    .replace(
      `      env:${eol}`,
      `      supportsModelSelection: true${eol}      modelFlag: --model${eol}      env:${eol}`,
    );
}

function existingWrongK3Source() {
  return liveLikeProvidersSource()
    .replace(
      '      - id: kimi-for-coding\n',
      `      - id: k3
        providerModel: kimi-for-coding
        description: Preserve K3 description
        fallbackModels:
          - kimi-for-coding
      - id: kimi-for-coding
`,
    )
    .replace(
      '      env:\n',
      `      supportsModelSelection: false
      modelFlag: -m
      env:
`,
    );
}

async function writeFakeKubectl(file) {
  await writeFile(file, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_KUBECTL_LOG, JSON.stringify(args) + '\\n');

function loadState() {
  return JSON.parse(readFileSync(process.env.FAKE_KUBECTL_STATE, 'utf8'));
}

function saveState(state) {
  writeFileSync(process.env.FAKE_KUBECTL_STATE, JSON.stringify(state), 'utf8');
}

if (args[0] === 'get' && args[1] === 'configmap') {
  process.stdout.write(JSON.stringify(loadState()));
  process.exit(0);
}

if (args[0] !== 'patch' || args[1] !== 'configmap') {
  process.exit(90);
}

const patchIndex = args.indexOf('--patch-file');
if (patchIndex < 0 || !args[patchIndex + 1] || !args.includes('--type=json')) {
  process.exit(91);
}
const patch = JSON.parse(readFileSync(args[patchIndex + 1], 'utf8'));
const dryRun = args.includes('--dry-run=server');
appendFileSync(
  process.env.FAKE_KUBECTL_PATCHES,
  JSON.stringify({ dryRun, patch }) + '\\n',
);
let state = loadState();

function testsPass() {
  return patch[0]?.op === 'test'
    && patch[0]?.path === '/metadata/resourceVersion'
    && patch[0]?.value === state.metadata.resourceVersion
    && patch[1]?.op === 'test'
    && patch[1]?.path === '/data/providers.yaml'
    && patch[1]?.value === state.data['providers.yaml'];
}

if (!testsPass()) {
  process.exit(42);
}
if (dryRun) {
  if (process.env.FAKE_DRY_RUN_FAILURE === 'yes') {
    process.exit(43);
  }
  if (process.env.FAKE_TOCTOU_MODE === 'resourceVersion') {
    state.metadata.resourceVersion = 'external-change';
    saveState(state);
  } else if (process.env.FAKE_TOCTOU_MODE === 'providers') {
    state.data['providers.yaml'] += '# external change\\n';
    state.metadata.resourceVersion = 'external-content-change';
    saveState(state);
  }
  process.stdout.write(JSON.stringify(state));
  process.exit(0);
}
if (process.env.FAKE_APPLY_FAILURE === 'yes') {
  process.exit(44);
}

state.data['providers.yaml'] = patch[2].value;
state.metadata.resourceVersion = '18';
if (process.env.FAKE_VERIFY_TAMPER === 'yes') {
  state.data['providers.yaml'] += '# post-apply tamper\\n';
}
saveState(state);
process.stdout.write(JSON.stringify(state));
`, 'utf8');
  await chmod(file, 0o700);
}

async function createHarness(providersSource = liveLikeProvidersSource()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'router-k3-reconcile-'));
  const stateFile = path.join(directory, 'configmap.json');
  const logFile = path.join(directory, 'kubectl.log');
  const patchesFile = path.join(directory, 'patches.jsonl');
  const fakeKubectl = path.join(directory, 'fake-kubectl.mjs');
  const backupDir = path.join(directory, 'rollback backups');
  const state = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configMapName,
      namespace: 'n8n-openai-gateway',
      resourceVersion: '17',
      labels: { unrelated: 'preserve' },
      annotations: { custom: 'preserve' },
    },
    data: {
      'providers.yaml': providersSource,
      'unrelated.txt': 'do not replace',
    },
    binaryData: {
      'unrelated.bin': 'AAE=',
    },
  };
  await writeFile(stateFile, JSON.stringify(state), 'utf8');
  await writeFile(logFile, '', 'utf8');
  await writeFile(patchesFile, '', 'utf8');
  await writeFakeKubectl(fakeKubectl);
  return {
    backupDir,
    directory,
    fakeKubectl,
    logFile,
    patchesFile,
    providersSource,
    state,
    stateFile,
  };
}

function runHarness(harness, args = [], env = {}) {
  return spawnSync(process.execPath, [cli, ...args, '--backup-dir', harness.backupDir], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      KUBECTL_EXECUTABLE: process.execPath,
      KUBECTL_PREFIX_ARGS_JSON: JSON.stringify([harness.fakeKubectl]),
      FAKE_KUBECTL_LOG: harness.logFile,
      FAKE_KUBECTL_PATCHES: harness.patchesFile,
      FAKE_KUBECTL_STATE: harness.stateFile,
      ...env,
    },
  });
}

async function readJsonLines(file) {
  const source = await readFile(file, 'utf8');
  return source.trim() ? source.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : [];
}

function assertHashOnlyOutput(result, before, after) {
  assert.equal(result.stdout, `before_sha256=${sha256(before)}\nafter_sha256=${sha256(after)}\n`);
  assert.doesNotMatch(result.stdout, /providers|kimi|sessionCommand/u);
}

test('AST reconciliation inserts only K3 and model-selection fields while preserving all other bytes', () => {
  const source = liveLikeProvidersSource();
  const expected = expectedReconciledSource(source);
  const reconciled = reconcileKimiK3ProviderConfig(source);
  assert.equal(reconciled, expected);
  assert.equal(checkKimiK3ProviderConfig(reconciled).providerModel, 'k3');

  const before = parse(source);
  const after = parse(reconciled);
  assert.deepEqual(after.remoteCliTargets, before.remoteCliTargets);
  assert.deepEqual(after.customRoot, before.customRoot);
  assert.deepEqual(after.unrelatedTail, before.unrelatedTail);
  assert.deepEqual(after.providers[0], before.providers[0]);
  assert.deepEqual(after.providers[1].models[1], before.providers[1].models[0]);
  assert.deepEqual(after.providers[1].responseCommand, before.providers[1].responseCommand);
  assert.deepEqual(after.providers[1].customKimiKey, before.providers[1].customKimiKey);
  assert.deepEqual(after.providers[1].sessionCommand.env, before.providers[1].sessionCommand.env);
  assert.equal(reconcileKimiK3ProviderConfig(reconciled), reconciled, 'must be byte-idempotent');
});

test('AST reconciliation repairs an existing K3 entry without retaining fallbacks', () => {
  const source = existingWrongK3Source();
  const reconciled = reconcileKimiK3ProviderConfig(source);
  const expected = source
    .replace('        providerModel: kimi-for-coding\n', '        providerModel: k3\n')
    .replace('        fallbackModels:\n          - kimi-for-coding\n', '')
    .replace('      supportsModelSelection: false\n', '      supportsModelSelection: true\n')
    .replace('      modelFlag: -m\n', '      modelFlag: --model\n');
  assert.equal(reconciled, expected);
  assert.doesNotMatch(
    reconciled.slice(reconciled.indexOf('      - id: k3'), reconciled.indexOf('      - id: kimi-for-coding')),
    /fallbackModels/u,
  );
  assert.equal(checkKimiK3ProviderConfig(reconciled).providerModel, 'k3');

  const missingProviderModel = source.replace('        providerModel: kimi-for-coding\n', '');
  const repairedMissingProviderModel = reconcileKimiK3ProviderConfig(missingProviderModel);
  assert.match(
    repairedMissingProviderModel,
    /      - id: k3\n        description: Preserve K3 description\n        providerModel: k3\n      - id: kimi-for-coding/u,
  );
  assert.doesNotMatch(
    repairedMissingProviderModel.slice(
      repairedMissingProviderModel.indexOf('      - id: k3'),
      repairedMissingProviderModel.indexOf('      - id: kimi-for-coding'),
    ),
    /fallbackModels/u,
  );
  assert.equal(checkKimiK3ProviderConfig(repairedMissingProviderModel).providerModel, 'k3');
});

test('AST reconciliation preserves CRLF input and refuses an unexpected Kimi bridge', () => {
  const crlf = liveLikeProvidersSource().replaceAll('\n', '\r\n');
  assert.equal(
    reconcileKimiK3ProviderConfig(crlf),
    expectedReconciledSource(crlf, '\r\n'),
  );
  assert.throws(
    () => reconcileKimiK3ProviderConfig(
      liveLikeProvidersSource().replace(
        '    sessionCommand:\n      executable: node\n',
        '    sessionCommand:\n      executable: kimi\n',
      ),
    ),
    /must already invoke the exact bounded Kimi bridge/u,
  );
  assert.throws(
    () => reconcileKimiK3ProviderConfig(
      liveLikeProvidersSource().replace('        - kimi\n      env:', '        - grok\n      env:'),
    ),
    /must already invoke the exact bounded Kimi bridge/u,
  );
});

test('CLI rejects a filesystem root as the rollback directory', () => {
  const root = path.parse(path.resolve('.')).root;
  assert.throws(
    () => parseArgs(['--backup-dir', root], {}),
    /backup directory must not be a filesystem root/u,
  );
});

test('default mode server-dry-runs guarded JSON Patch and never mutates the ConfigMap', async () => {
  const harness = await createHarness();
  const result = runHarness(harness);
  const expected = expectedReconciledSource(harness.providersSource);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assertHashOnlyOutput(result, harness.providersSource, expected);
  assert.deepEqual(JSON.parse(await readFile(harness.stateFile, 'utf8')), harness.state);

  const invocations = await readJsonLines(harness.logFile);
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].slice(0, 3), ['get', 'configmap', configMapName]);
  assert.equal(invocations[1][0], 'patch');
  assert.ok(invocations[1].includes('--type=json'));
  assert.ok(invocations[1].includes('--dry-run=server'));

  const patches = await readJsonLines(harness.patchesFile);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].dryRun, true);
  assert.deepEqual(patches[0].patch, [
    { op: 'test', path: '/metadata/resourceVersion', value: '17' },
    { op: 'test', path: '/data/providers.yaml', value: harness.providersSource },
    { op: 'replace', path: '/data/providers.yaml', value: expected },
  ]);
  await assert.rejects(() => readdir(harness.backupDir), /ENOENT/u);
});

test('--apply fails closed before kubectl unless every production gate is present', async (t) => {
  const cases = [
    { name: 'no gates', env: {} },
    { name: 'no human approval', env: { ALLOW_PROD_WRITE: 'yes', CHANGE_TICKET: 'CHG-1' } },
    { name: 'no write gate', env: { HUMAN_APPROVED: 'yes', CHANGE_TICKET: 'CHG-1' } },
    { name: 'no ticket', env: { ALLOW_PROD_WRITE: 'yes', HUMAN_APPROVED: 'yes' } },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const harness = await createHarness();
      const result = runHarness(harness, ['--apply'], entry.env);
      assert.equal(result.status, 3);
      assert.match(result.stderr, /Production apply requires/u);
      assert.equal(await readFile(harness.logFile, 'utf8'), '');
      assert.deepEqual(JSON.parse(await readFile(harness.stateFile, 'utf8')), harness.state);
      await assert.rejects(() => readdir(harness.backupDir), /ENOENT/u);
    });
  }
});

test('--apply writes an exact restrictive backup, applies guarded patch, and verifies live bytes', async () => {
  const harness = await createHarness();
  const expected = expectedReconciledSource(harness.providersSource);
  const result = runHarness(harness, ['--apply'], {
    ALLOW_PROD_WRITE: 'yes',
    HUMAN_APPROVED: 'yes',
    CHANGE_TICKET: 'CHG-1234',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assertHashOnlyOutput(result, harness.providersSource, expected);

  const backupFiles = await readdir(harness.backupDir);
  assert.deepEqual(backupFiles, [
    `${configMapName}.${sha256(harness.providersSource)}.rollback.providers.yaml`,
  ]);
  const backupFile = path.join(harness.backupDir, backupFiles[0]);
  assert.equal(await readFile(backupFile, 'utf8'), harness.providersSource);
  if (process.platform !== 'win32') {
    assert.equal((await stat(backupFile)).mode & 0o077, 0);
    assert.equal((await stat(harness.backupDir)).mode & 0o077, 0);
  }

  const finalState = JSON.parse(await readFile(harness.stateFile, 'utf8'));
  assert.equal(finalState.data['providers.yaml'], expected);
  assert.equal(finalState.data['unrelated.txt'], harness.state.data['unrelated.txt']);
  assert.deepEqual(finalState.binaryData, harness.state.binaryData);
  assert.deepEqual(finalState.metadata.labels, harness.state.metadata.labels);
  assert.deepEqual(finalState.metadata.annotations, harness.state.metadata.annotations);
  assert.equal(checkKimiK3ProviderConfig(finalState.data['providers.yaml']).providerModel, 'k3');

  const invocations = await readJsonLines(harness.logFile);
  assert.equal(invocations.length, 4);
  assert.ok(invocations[1].includes('--dry-run=server'));
  assert.equal(invocations[2][0], 'patch');
  assert.ok(!invocations[2].includes('--dry-run=server'));
  assert.equal(invocations[3][0], 'get');
  const patches = await readJsonLines(harness.patchesFile);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0].patch, patches[1].patch);
});

test('--apply refuses a symlinked rollback directory before ConfigMap mutation', async (t) => {
  const harness = await createHarness();
  const target = path.join(harness.directory, 'external-backup-target');
  await mkdir(target);
  try {
    await symlink(target, harness.backupDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const result = runHarness(harness, ['--apply'], {
    ALLOW_PROD_WRITE: 'yes',
    HUMAN_APPROVED: 'yes',
    CHANGE_TICKET: 'CHG-SYMLINK',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Rollback backup directory must be a real directory/u);
  assert.deepEqual(JSON.parse(await readFile(harness.stateFile, 'utf8')), harness.state);
  assert.deepEqual(await readdir(target), []);
  const invocations = await readJsonLines(harness.logFile);
  assert.equal(invocations.length, 2);
  assert.ok(invocations[1].includes('--dry-run=server'));
});

test('--apply refuses an existing group-readable rollback directory', {
  skip: process.platform === 'win32',
}, async () => {
  const harness = await createHarness();
  await mkdir(harness.backupDir, { mode: 0o755 });
  await chmod(harness.backupDir, 0o755);
  const result = runHarness(harness, ['--apply'], {
    ALLOW_PROD_WRITE: 'yes',
    HUMAN_APPROVED: 'yes',
    CHANGE_TICKET: 'CHG-PERMS',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Existing rollback backup directory permissions are not owner-only/u);
  assert.deepEqual(JSON.parse(await readFile(harness.stateFile, 'utf8')), harness.state);
  const invocations = await readJsonLines(harness.logFile);
  assert.equal(invocations.length, 2);
  assert.ok(invocations[1].includes('--dry-run=server'));
});

test('resourceVersion and content TOCTOU changes fail atomically after preserving rollback bytes', async (t) => {
  for (const mode of ['resourceVersion', 'providers']) {
    await t.test(mode, async () => {
      const harness = await createHarness();
      const result = runHarness(harness, ['--apply'], {
        ALLOW_PROD_WRITE: 'yes',
        HUMAN_APPROVED: 'yes',
        CHANGE_TICKET: 'CHG-TOCTOU',
        FAKE_TOCTOU_MODE: mode,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /kubectl patch failed with exit status 42/u);
      const state = JSON.parse(await readFile(harness.stateFile, 'utf8'));
      assert.notEqual(state.metadata.resourceVersion, '18');
      assert.notEqual(state.data['providers.yaml'], expectedReconciledSource(harness.providersSource));
      const files = await readdir(harness.backupDir);
      assert.equal(files.length, 1);
      assert.equal(
        await readFile(path.join(harness.backupDir, files[0]), 'utf8'),
        harness.providersSource,
      );
    });
  }
});

test('dry-run and post-apply verification failures are fail-closed and never expose config content', async (t) => {
  await t.test('server dry-run rejection', async () => {
    const harness = await createHarness();
    const result = runHarness(harness, [], { FAKE_DRY_RUN_FAILURE: 'yes' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /kubectl patch failed with exit status 43/u);
    assert.doesNotMatch(result.stderr, /customRoot|sessionCommand|providers:/u);
    assert.deepEqual(JSON.parse(await readFile(harness.stateFile, 'utf8')), harness.state);
    await assert.rejects(() => readdir(harness.backupDir), /ENOENT/u);
  });

  await t.test('post-apply byte mismatch', async () => {
    const harness = await createHarness();
    const result = runHarness(harness, ['--apply'], {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: 'CHG-VERIFY',
      FAKE_VERIFY_TAMPER: 'yes',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the reconciled SHA-256/u);
    assert.doesNotMatch(result.stderr, /customRoot|sessionCommand|providers:/u);
    const files = await readdir(harness.backupDir);
    assert.equal(files.length, 1);
    assert.equal(
      await readFile(path.join(harness.backupDir, files[0]), 'utf8'),
      harness.providersSource,
    );
  });
});

test('an unexpected live Kimi bridge is rejected before any patch or backup', async () => {
  const invalid = liveLikeProvidersSource().replace(
    '        - kimi\n      env:',
    '        - grok\n      env:',
  );
  const harness = await createHarness(invalid);
  const result = runHarness(harness);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must already invoke the exact bounded Kimi bridge/u);
  const invocations = await readJsonLines(harness.logFile);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0][0], 'get');
  assert.equal((await readJsonLines(harness.patchesFile)).length, 0);
  await assert.rejects(() => readdir(harness.backupDir), /ENOENT/u);
});
