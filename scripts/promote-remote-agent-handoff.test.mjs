import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stringify } from 'yaml';

const repositoryRoot = path.resolve('.');
const promotionScript = path.join(repositoryRoot, 'scripts', 'promote-remote-agent-handoff.sh');
const immutableImage = `ghcr.io/philly1084/cli-model-gateway:sha-${'a'.repeat(40)}`;
const bashExecutable = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';

function portablePath(value) {
  return value.replaceAll('\\', '/');
}

function validProvidersSource() {
  return stringify({
    providers: [{
      id: 'kimi-code-cli',
      type: 'cli',
      models: [{ id: 'k3', providerModel: 'k3' }],
      responseCommand: { executable: 'node', args: [] },
      sessionCommand: {
        executable: 'node',
        args: ['dist/scripts/remote-agent-session-bridge.js', '--provider', 'kimi'],
        supportsModelSelection: true,
        modelFlag: '--model',
      },
    }],
  });
}

async function createHarness(providersSource, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'router-promotion-gate-'));
  const providersFile = path.join(directory, 'providers.yaml');
  const invocationLog = path.join(directory, 'kubectl.log');
  const applyState = path.join(directory, 'applied.state');
  const kubectl = path.join(directory, 'fake-kubectl.sh');
  await writeFile(providersFile, providersSource, 'utf8');
  await writeFile(invocationLog, '', 'utf8');
  await writeFile(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"\${FAKE_KUBECTL_LOG}"
printf '\\n' >>"\${FAKE_KUBECTL_LOG}"
if [[ "$1" == "get" && "$2" == "configmap" ]]; then
  if [[ "\${FAKE_CONFIGMAP_FAILURE:-}" == "yes" ]]; then
    exit 44
  fi
  cat "\${FAKE_PROVIDERS_FILE}"
  exit 0
fi
if [[ "$1" == "get" && "$2" == "deployment" ]]; then
  if [[ -f "\${FAKE_APPLY_STATE}" ]]; then
    printf '%s' "\${FAKE_REQUESTED_IMAGE}"
  else
    printf '%s' 'ghcr.io/philly1084/cli-model-gateway:sha-${'b'.repeat(40)}'
  fi
  exit 0
fi
if [[ "$1" == "patch" && "$2" == "deployment" ]]; then
  printf '%s\\n' 'deployment.apps/n8n-openai-cli-gateway'
  if [[ " $* " != *" --dry-run=server "* ]]; then
    : >"\${FAKE_APPLY_STATE}"
  fi
  exit 0
fi
if [[ "$1" == "rollout" && "$2" == "status" ]]; then
  exit 0
fi
exit 45
`, 'utf8');
  await chmod(kubectl, 0o755);

  const result = spawnSync(bashExecutable, [
    portablePath(promotionScript),
    immutableImage,
    options.mode || '--dry-run',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_EXECUTABLE: portablePath(process.execPath),
      KUBECTL_EXECUTABLE: portablePath(kubectl),
      FAKE_PROVIDERS_FILE: portablePath(providersFile),
      FAKE_KUBECTL_LOG: portablePath(invocationLog),
      FAKE_APPLY_STATE: portablePath(applyState),
      FAKE_REQUESTED_IMAGE: immutableImage,
      ...(options.configMapFailure ? { FAKE_CONFIGMAP_FAILURE: 'yes' } : {}),
      ...(options.env || {}),
    },
  });
  return {
    ...result,
    log: await readFile(invocationLog, 'utf8'),
    mutated: existsSync(applyState),
  };
}

test('promotion refuses an invalid live K3 config before reading or patching the Deployment', {
  skip: !existsSync(bashExecutable),
}, async () => {
  const invalid = stringify({
    providers: [{
      id: 'kimi-code-cli',
      type: 'cli',
      models: [{ id: 'kimi-for-coding', providerModel: 'kimi-for-coding' }],
    }],
  });
  const result = await createHarness(invalid);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not satisfy the Kimi K3 CLI gate/);
  assert.match(result.log, /^get configmap /);
  assert.doesNotMatch(result.log, /get deployment|patch deployment/);
});

test('promotion refuses an unreadable live ConfigMap before any Deployment operation', {
  skip: !existsSync(bashExecutable),
}, async () => {
  const result = await createHarness(validProvidersSource(), { configMapFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unable to read providers.yaml from live ConfigMap/);
  assert.match(result.log, /^get configmap /);
  assert.doesNotMatch(result.log, /get deployment|patch deployment/);
});

test('promotion reads but never replaces the live ConfigMap before a server-side Deployment dry run', {
  skip: !existsSync(bashExecutable),
}, async () => {
  const result = await createHarness(validProvidersSource());
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /verified_kimi_model=k3/);
  assert.match(result.stdout, /decision=dry_run_pass/);
  assert.match(result.log, /^get configmap /m);
  assert.match(result.log, /^get deployment /m);
  assert.match(result.log, /^patch deployment /m);
  assert.doesNotMatch(result.log, /apply|patch configmap|replace configmap/);
});

test('apply with a whitespace change ticket exits after one server-side dry run and before mutation', {
  skip: !existsSync(bashExecutable),
}, async () => {
  const result = await createHarness(validProvidersSource(), {
    mode: '--apply',
    env: {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: ' \t ',
    },
  });
  const invocations = result.log.trim().split('\n');
  const patchInvocations = invocations.filter((line) => line.startsWith('patch deployment '));

  assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /non-whitespace CHANGE_TICKET id/);
  assert.equal(patchInvocations.length, 1);
  assert.match(patchInvocations[0], /--dry-run=server/);
  assert.equal(result.mutated, false);
  assert.equal(invocations.some((line) => line.startsWith('rollout ')), false);
  assert.doesNotMatch(result.stdout, /change_ticket=|decision=rollout_pass/);
});

test('fully gated apply dry-runs before one real patch, rolls out, and verifies the image', {
  skip: !existsSync(bashExecutable),
}, async () => {
  const result = await createHarness(validProvidersSource(), {
    mode: '--apply',
    env: {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: 'CHG-1234',
    },
  });
  const invocations = result.log.trim().split('\n');
  const patchIndexes = invocations
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith('patch deployment '));
  const rolloutIndex = invocations.findIndex((line) => line.startsWith('rollout status '));
  const imageVerificationIndex = invocations.findIndex((line, index) => (
    index > rolloutIndex && line.startsWith('get deployment ')
  ));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(patchIndexes.length, 2);
  assert.match(patchIndexes[0].line, /--dry-run=server/);
  assert.doesNotMatch(patchIndexes[1].line, /--dry-run=server/);
  assert.ok(patchIndexes[0].index < patchIndexes[1].index);
  assert.ok(patchIndexes[1].index < rolloutIndex);
  assert.ok(rolloutIndex < imageVerificationIndex);
  assert.equal(result.mutated, true);
  assert.match(result.stdout, /change_ticket=CHG-1234/);
  assert.match(result.stdout, new RegExp(`verified_image=${immutableImage}`));
  assert.match(result.stdout, /decision=rollout_pass_pending_agent_canaries/);
});
