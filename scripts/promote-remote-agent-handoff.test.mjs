import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stringify } from 'yaml';
import { buildPromotionConfigSnapshot } from './remote-agent-promotion-config-snapshot.mjs';

const repositoryRoot = path.resolve('.');
const promotionScript = path.join(repositoryRoot, 'scripts', 'promote-remote-agent-handoff.sh');
const workflowFile = path.join(repositoryRoot, '.github', 'workflows', 'build.yml');
const immutableImage = `ghcr.io/philly1084/cli-model-gateway@sha256:${'a'.repeat(64)}`;
const currentImage = `ghcr.io/philly1084/cli-model-gateway@sha256:${'b'.repeat(64)}`;
const racedImage = `ghcr.io/philly1084/cli-model-gateway@sha256:${'c'.repeat(64)}`;
const namespace = 'n8n-openai-gateway';
const deploymentName = 'n8n-openai-cli-gateway';
const sourceConfigMap = 'n8n-openai-cli-gateway-config';
const bashExecutable = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';

function portablePath(value) {
  return value.replaceAll('\\', '/');
}

function validProvidersSource() {
  return stringify({
    providers: [
      {
        id: 'codex-cli',
        type: 'cli',
        models: [{ id: 'gpt-5.6-sol', providerModel: 'gpt-5.6-sol' }],
        responseCommand: { executable: 'node', args: [] },
        sessionCommand: {
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
        },
      },
      {
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
      },
    ],
  });
}

function deploymentFixture({
  resourceVersion = '100',
  image = currentImage,
  providerConfigMap = sourceConfigMap,
  overlay = true,
} = {}) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: deploymentName, namespace, resourceVersion },
    spec: {
      template: {
        spec: {
          initContainers: [
            'gemini-bootstrap',
            'kimi-bootstrap',
            'gemini-auth-bootstrap',
          ].map((name) => ({
            name,
            image: phaseImage(image),
            imagePullPolicy: 'Always',
          })),
          containers: [{
            name: 'gateway',
            image,
            volumeMounts: [
              { name: 'providers-config', mountPath: '/app/config/providers.yaml', subPath: 'providers.yaml' },
              ...(overlay ? [{
                name: 'remote-cli-tail-hotfix',
                mountPath: '/app/dist/jobs/remote-cli-tool-manager.js',
                subPath: 'remote-cli-tool-manager.js',
                readOnly: true,
              }] : []),
            ],
          }],
          volumes: [
            { name: 'providers-config', configMap: { name: providerConfigMap, defaultMode: 420 } },
            ...(overlay ? [{
              name: 'remote-cli-tail-hotfix',
              configMap: { name: 'remote-cli-tail-hotfix', defaultMode: 420 },
            }] : []),
          ],
        },
      },
    },
  };
}

function phaseImage(gatewayImage) {
  return gatewayImage === currentImage
    ? 'ghcr.io/philly1084/n8n-openai-cli-gateway:latest'
    : gatewayImage;
}

async function createHarness(providersSource, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'router-promotion-gate-'));
  const selectedImage = options.image || immutableImage;
  const fixtureImage = /^ghcr\.io\/philly1084\/cli-model-gateway@sha256:[0-9a-f]{64}$/.test(selectedImage)
    ? selectedImage
    : immutableImage;
  const snapshot = buildPromotionConfigSnapshot({
    providersSource,
    image: fixtureImage,
    namespace,
    sourceConfigMap,
  });
  const previousSnapshot = buildPromotionConfigSnapshot({
    providersSource,
    image: currentImage,
    namespace,
    sourceConfigMap,
  });
  const providersFile = path.join(directory, 'providers.yaml');
  const driftProvidersFile = path.join(directory, 'providers-drifted.yaml');
  const deploymentBeforeFile = path.join(directory, 'deployment-before.json');
  const deploymentRacedFile = path.join(directory, 'deployment-raced.json');
  const deploymentAfterFile = path.join(directory, 'deployment-after.json');
  const deploymentResidualFile = path.join(directory, 'deployment-residual.json');
  const invocationLog = path.join(directory, 'kubectl.log');
  const ghLog = path.join(directory, 'gh.log');
  const patchLog = path.join(directory, 'patches.log');
  const applyState = path.join(directory, 'applied.state');
  const dryRunState = path.join(directory, 'dry-run.state');
  const snapshotState = path.join(directory, 'snapshot.json');
  const previousSnapshotState = path.join(directory, 'snapshot-previous.json');
  const kubectl = path.join(directory, 'fake-kubectl.sh');
  const gh = path.join(directory, 'fake-gh.sh');

  const deploymentBefore = options.repeatPromotion
    ? deploymentFixture({
      providerConfigMap: previousSnapshot.name,
      overlay: false,
    })
    : deploymentFixture();
  options.deploymentMutator?.(deploymentBefore);
  const deploymentAfter = deploymentFixture({
    resourceVersion: '101',
    image: fixtureImage,
    providerConfigMap: snapshot.name,
    overlay: false,
  });
  options.deploymentAfterMutator?.(deploymentAfter);
  const deploymentResidual = deploymentFixture({
    resourceVersion: '101',
    image: fixtureImage,
    providerConfigMap: snapshot.name,
    overlay: true,
  });
  await Promise.all([
    writeFile(providersFile, providersSource, 'utf8'),
    writeFile(driftProvidersFile, `${providersSource}# concurrent ConfigMap update\n`, 'utf8'),
    writeFile(deploymentBeforeFile, JSON.stringify(deploymentBefore), 'utf8'),
    writeFile(deploymentRacedFile, JSON.stringify(deploymentFixture({
      resourceVersion: 'race-101',
      image: racedImage,
    })), 'utf8'),
    writeFile(deploymentAfterFile, JSON.stringify(deploymentAfter), 'utf8'),
    writeFile(deploymentResidualFile, JSON.stringify(deploymentResidual), 'utf8'),
    writeFile(invocationLog, '', 'utf8'),
    writeFile(ghLog, '', 'utf8'),
    writeFile(patchLog, '', 'utf8'),
  ]);
  if (options.repeatPromotion) {
    const previous = structuredClone(previousSnapshot.manifest);
    options.previousSnapshotMutator?.(previous);
    await writeFile(previousSnapshotState, JSON.stringify(previous), 'utf8');
  }
  if (options.existingSnapshotMutator) {
    const existing = structuredClone(snapshot.manifest);
    options.existingSnapshotMutator(existing);
    await writeFile(snapshotState, JSON.stringify(existing), 'utf8');
  }

  await writeFile(gh, `#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"\${FAKE_GH_LOG}"
printf '\\n' >>"\${FAKE_GH_LOG}"
if [[ "\${FAKE_PROVENANCE_FAILURE:-}" == "yes" ]]; then
  exit 71
fi
if [[ " $* " == *" --source-ref \${FAKE_PROVENANCE_REF:-refs/heads/main} "* ]]; then
  exit 0
fi
exit 72
`, 'utf8');

  await writeFile(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"\${FAKE_KUBECTL_LOG}"
printf '\\n' >>"\${FAKE_KUBECTL_LOG}"

if [[ "$1" == "get" && "$2" == "configmap" ]]; then
  name="$3"
  if [[ "$name" == "\${FAKE_SOURCE_CONFIGMAP}" ]]; then
    if [[ "\${FAKE_CONFIGMAP_FAILURE:-}" == "yes" ]]; then
      exit 44
    fi
    drift=no
    if [[ -f "\${FAKE_APPLY_STATE}" && "\${FAKE_CONFIG_DRIFT_AFTER_APPLY:-}" == "yes" ]]; then
      drift=yes
    elif [[ -f "\${FAKE_SNAPSHOT_STATE}" && "\${FAKE_CONFIG_DRIFT_AFTER_SNAPSHOT:-}" == "yes" ]]; then
      drift=yes
    elif [[ -f "\${FAKE_DRY_RUN_STATE}" && "\${FAKE_CONFIG_DRIFT_AFTER_DRY_RUN:-}" == "yes" ]]; then
      drift=yes
    fi
    if [[ " $* " == *"metadata.resourceVersion"* ]]; then
      [[ "$drift" == "yes" ]] && printf '%s' '18' || printf '%s' '17'
      exit 0
    fi
    if [[ " $* " == *"data.providers"* ]]; then
      [[ "$drift" == "yes" ]] && cat "\${FAKE_DRIFT_PROVIDERS_FILE}" || cat "\${FAKE_PROVIDERS_FILE}"
      exit 0
    fi
    exit 45
  fi
  if [[ "$name" == "\${FAKE_PREVIOUS_SNAPSHOT_NAME}" && -f "\${FAKE_PREVIOUS_SNAPSHOT_STATE}" ]]; then
    cat "\${FAKE_PREVIOUS_SNAPSHOT_STATE}"
    exit 0
  fi
  if [[ "$name" != "\${FAKE_SNAPSHOT_NAME}" ]]; then
    exit 46
  fi
  if [[ -f "\${FAKE_SNAPSHOT_STATE}" ]]; then
    cat "\${FAKE_SNAPSHOT_STATE}"
  fi
  exit 0
fi

if [[ "$1" == "create" ]]; then
  arguments=("$@")
  manifest=''
  for ((index = 0; index < \${#arguments[@]}; index += 1)); do
    if [[ "\${arguments[$index]}" == "-f" ]]; then
      manifest="\${arguments[$((index + 1))]:-}"
      break
    fi
  done
  [[ -n "$manifest" ]] || exit 47
  printf '%s\\n' "configmap/\${FAKE_SNAPSHOT_NAME}"
  if [[ " $* " != *" --dry-run=server "* ]]; then
    cp -- "$manifest" "\${FAKE_SNAPSHOT_STATE}"
  fi
  exit 0
fi

if [[ "$1" == "get" && "$2" == "deployment" ]]; then
  if [[ -f "\${FAKE_APPLY_STATE}" ]]; then
    if [[ "\${FAKE_RESIDUAL_OVERLAY:-}" == "yes" ]]; then
      cat "\${FAKE_DEPLOYMENT_RESIDUAL_FILE}"
    else
      cat "\${FAKE_DEPLOYMENT_AFTER_FILE}"
    fi
  elif [[ -f "\${FAKE_DRY_RUN_STATE}" && "\${FAKE_DEPLOYMENT_RACE_AFTER_DRY_RUN:-}" == "yes" ]]; then
    cat "\${FAKE_DEPLOYMENT_RACED_FILE}"
  else
    cat "\${FAKE_DEPLOYMENT_BEFORE_FILE}"
  fi
  exit 0
fi

if [[ "$1" == "patch" && "$2" == "deployment" ]]; then
  arguments=("$@")
  patch_value=''
  for ((index = 0; index < \${#arguments[@]}; index += 1)); do
    if [[ "\${arguments[$index]}" == "--patch" ]]; then
      patch_value="\${arguments[$((index + 1))]:-}"
      break
    fi
  done
  [[ -n "$patch_value" ]] || exit 48
  printf '%s\\n---PATCH---\\n' "$patch_value" >>"\${FAKE_PATCH_LOG}"
  if [[ "$patch_value" != *'resourceVersion: "100"'* \
    || "$patch_value" != *"\${FAKE_REQUESTED_IMAGE}"* \
    || "$patch_value" != *"\${FAKE_SNAPSHOT_NAME}"* \
    || "$patch_value" != *'name: gemini-bootstrap'* \
    || "$patch_value" != *'name: kimi-bootstrap'* \
    || "$patch_value" != *'name: gemini-auth-bootstrap'* \
    || "$patch_value" != *'mountPath: /app/dist/jobs/remote-cli-tool-manager.js'* \
    || "$(grep -cF '$patch: delete' <<<"$patch_value")" -ne 2 ]]; then
    exit 49
  fi
  printf '%s\\n' 'deployment.apps/n8n-openai-cli-gateway'
  if [[ " $* " == *" --dry-run=server "* ]]; then
    : >"\${FAKE_DRY_RUN_STATE}"
  else
    if [[ "\${FAKE_ATOMIC_DEPLOYMENT_CONFLICT:-}" == "yes" ]]; then
      exit 50
    fi
    : >"\${FAKE_APPLY_STATE}"
  fi
  exit 0
fi

if [[ "$1" == "rollout" && "$2" == "status" ]]; then
  exit 0
fi
exit 51
`, 'utf8');
  await Promise.all([chmod(kubectl, 0o755), chmod(gh, 0o755)]);

  const result = spawnSync(bashExecutable, [
    portablePath(promotionScript),
    selectedImage,
    options.mode || '--dry-run',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_EXECUTABLE: portablePath(process.execPath),
      KUBECTL_EXECUTABLE: portablePath(kubectl),
      GH_EXECUTABLE: portablePath(gh),
      FAKE_PROVIDERS_FILE: portablePath(providersFile),
      FAKE_DRIFT_PROVIDERS_FILE: portablePath(driftProvidersFile),
      FAKE_DEPLOYMENT_BEFORE_FILE: portablePath(deploymentBeforeFile),
      FAKE_DEPLOYMENT_RACED_FILE: portablePath(deploymentRacedFile),
      FAKE_DEPLOYMENT_AFTER_FILE: portablePath(deploymentAfterFile),
      FAKE_DEPLOYMENT_RESIDUAL_FILE: portablePath(deploymentResidualFile),
      FAKE_KUBECTL_LOG: portablePath(invocationLog),
      FAKE_GH_LOG: portablePath(ghLog),
      FAKE_PATCH_LOG: portablePath(patchLog),
      FAKE_APPLY_STATE: portablePath(applyState),
      FAKE_DRY_RUN_STATE: portablePath(dryRunState),
      FAKE_SNAPSHOT_STATE: portablePath(snapshotState),
      FAKE_PREVIOUS_SNAPSHOT_STATE: portablePath(previousSnapshotState),
      FAKE_PREVIOUS_SNAPSHOT_NAME: previousSnapshot.name,
      FAKE_SNAPSHOT_NAME: snapshot.name,
      FAKE_SOURCE_CONFIGMAP: sourceConfigMap,
      FAKE_REQUESTED_IMAGE: fixtureImage,
      ...(options.configMapFailure ? { FAKE_CONFIGMAP_FAILURE: 'yes' } : {}),
      ...(options.env || {}),
    },
  });
  return {
    ...result,
    log: await readFile(invocationLog, 'utf8'),
    ghLog: await readFile(ghLog, 'utf8'),
    patches: await readFile(patchLog, 'utf8'),
    mutated: existsSync(applyState),
    snapshotCreated: existsSync(snapshotState),
    snapshotName: snapshot.name,
    previousSnapshotName: previousSnapshot.name,
  };
}

test('promotion refuses an invalid live K3 config before reading or patching the Deployment', async () => {
  const invalid = stringify({
    providers: [{
      id: 'kimi-code-cli',
      type: 'cli',
      models: [{ id: 'kimi-for-coding', providerModel: 'kimi-for-coding' }],
    }],
  });
  const result = await createHarness(invalid);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not satisfy the Codex\/Kimi remote-agent gate/);
  assert.match(result.log, /^get configmap /);
  assert.doesNotMatch(result.log, /get deployment|patch deployment/);
});

test('promotion refuses an unreadable live ConfigMap before any Deployment operation', async () => {
  const result = await createHarness(validProvidersSource(), { configMapFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unable to read initial ConfigMap resourceVersion/);
  assert.doesNotMatch(result.log, /get deployment|patch deployment/);
});

test('promotion rejects a mutable tag before invoking provenance or Kubernetes tooling', async () => {
  const mutableImage = `ghcr.io/philly1084/cli-model-gateway:sha-${'a'.repeat(40)}`;
  const result = await createHarness(validProvidersSource(), { image: mutableImage });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /mutable, non-digest/);
  assert.equal(result.ghLog, '');
  assert.equal(result.log, '');
});

test('promotion requires signed canonical main provenance before invoking kubectl', async () => {
  const result = await createHarness(validProvidersSource(), {
    env: { FAKE_PROVENANCE_FAILURE: 'yes' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no trusted signed build provenance from the canonical main branch/);
  assert.equal(result.ghLog.trim().split('\n').length, 1);
  assert.match(result.ghLog, /--source-ref refs\/heads\/main/);
  assert.doesNotMatch(result.ghLog, /refs\/heads\/master/);
  assert.equal(result.log, '');
});

test('promotion does not fall back to a legacy master provenance attestation', async () => {
  const result = await createHarness(validProvidersSource(), {
    env: { FAKE_PROVENANCE_REF: 'refs/heads/master' },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.ghLog.trim().split('\n').length, 1);
  assert.match(result.ghLog, /--source-ref refs\/heads\/main/);
  assert.doesNotMatch(result.ghLog, /refs\/heads\/master/);
  assert.equal(result.log, '');
});

test('workflow builds and emits promotion provenance only from canonical main', async () => {
  const workflow = await readFile(workflowFile, 'utf8');
  const trustedCondition = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
  assert.equal(workflow.split(trustedCondition).length - 1, 2);
  assert.match(workflow, /push:\s*\r?\n\s*branches: \[ main \]/);
  assert.match(workflow, /pull_request:\s*\r?\n\s*branches: \[ main \]/);
  assert.doesNotMatch(workflow, /refs\/heads\/master|branches:\s*\[[^\]]*\bmaster\b/);
  assert.match(workflow, /uses: actions\/attest@v4/);
  assert.match(workflow, /push-to-registry: true/);
  assert.doesNotMatch(workflow, /Record digest-pinned promotion reference\s*\r?\n\s*if: github\.event_name != 'pull_request'/);
});

test('promotion exact-guards overlay mount, volume, and ConfigMap source before any patch', async () => {
  const mutations = [
    (value) => { value.spec.template.spec.containers[0].volumeMounts[1].name = 'unexpected'; },
    (value) => { value.spec.template.spec.containers[0].volumeMounts[1].mountPath = '/app/dist/unexpected.js'; },
    (value) => { value.spec.template.spec.containers[0].volumeMounts[1].subPath = 'unexpected.js'; },
    (value) => { value.spec.template.spec.containers[0].volumeMounts[1].readOnly = false; },
    (value) => { value.spec.template.spec.volumes[1].configMap.name = 'unexpected'; },
    (value) => { value.spec.template.spec.volumes[0].configMap.name = 'unexpected'; },
  ];
  for (const deploymentMutator of mutations) {
    const result = await createHarness(validProvidersSource(), { deploymentMutator });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Deployment promotion contract failed|Unable to read currently mounted provider snapshot/);
    assert.doesNotMatch(result.log, /^patch deployment /m);
    assert.equal(result.mutated, false);
  }
});

test('promotion exact-guards the bootstrap init-container set before any patch', async () => {
  const mutations = [
    (value) => { value.spec.template.spec.initContainers.pop(); },
    (value) => {
      value.spec.template.spec.initContainers.push({
        name: 'unexpected-bootstrap',
        image: 'ghcr.io/philly1084/n8n-openai-cli-gateway:latest',
      });
    },
    (value) => { value.spec.template.spec.initContainers[0].image = 'example.invalid/router:latest'; },
    (value) => {
      value.spec.template.spec.initContainers[0].image =
        'ghcr.io/philly1084/n8n-openai-cli-gateway:other';
    },
  ];
  for (const deploymentMutator of mutations) {
    const result = await createHarness(validProvidersSource(), { deploymentMutator });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Deployment promotion contract failed/);
    assert.doesNotMatch(result.log, /^patch deployment /m);
    assert.equal(result.mutated, false);
  }
});

test('promotion dry-run validates an immutable content-addressed snapshot and uses merge-key-correct deletes', async () => {
  const result = await createHarness(validProvidersSource());
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /verified_kimi_model=k3/);
  assert.match(result.stdout, /verified_source_ref=refs\/heads\/main/);
  assert.match(result.stdout, /decision=dry_run_pass/);
  assert.match(result.ghLog, /--source-ref refs\/heads\/main/);
  assert.match(result.ghLog, /--deny-self-hosted-runners/);
  assert.match(result.ghLog, /--repo philly1084\/cli-model-gateway/);
  assert.match(result.ghLog, /--signer-workflow philly1084\/cli-model-gateway\/\.github\/workflows\/build\.yml/);
  assert.doesNotMatch(result.ghLog, /philly1084\/n8n-openai-cli-gateway/);
  assert.match(result.log, /^create --dry-run=server /m);
  assert.match(result.log, /^get deployment /m);
  assert.match(result.log, /^patch deployment /m);
  assert.equal(result.snapshotCreated, false);
  assert.match(result.patches, /resourceVersion: "100"/);
  assert.match(result.patches, new RegExp(`image: "${immutableImage}"`));
  for (const name of ['gemini-bootstrap', 'kimi-bootstrap', 'gemini-auth-bootstrap']) {
    assert.match(result.patches, new RegExp(`name: ${name}\\n\\s+image: "${immutableImage}"`));
  }
  assert.match(result.patches, new RegExp(`name: "${result.snapshotName}"`));
  assert.match(result.patches, /volumeMounts:\n\s+- mountPath: \/app\/dist\/jobs\/remote-cli-tool-manager\.js\n\s+\$patch: delete/);
  assert.doesNotMatch(result.patches, /volumeMounts:\n\s+- name: remote-cli-tail-hotfix/);
  assert.equal((result.patches.match(/\$patch: delete/g) ?? []).length, 2);
});

test('promotion dry-run advances from a verified prior immutable snapshot with no overlay', async () => {
  const result = await createHarness(validProvidersSource(), { repeatPromotion: true });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`current_provider_configmap=${result.previousSnapshotName}`));
  assert.match(result.stdout, /current_overlay=absent/);
  assert.match(result.log, new RegExp(`get configmap ${result.previousSnapshotName}`));
  assert.match(result.log, /patch deployment .*--dry-run=server/);
  assert.equal(result.mutated, false);
});

test('promotion rejects a tampered prior immutable snapshot before any patch', async () => {
  const result = await createHarness(validProvidersSource(), {
    repeatPromotion: true,
    previousSnapshotMutator(snapshot) {
      snapshot.metadata.annotations['kimibuilt.dev/providers-sha256'] = '0'.repeat(64);
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /neither the source ConfigMap nor a verified immutable promotion snapshot/);
  assert.doesNotMatch(result.log, /patch deployment/);
});

test('promotion refuses a pre-existing immutable snapshot whose bytes differ', async () => {
  const result = await createHarness(validProvidersSource(), {
    existingSnapshotMutator: (snapshot) => { snapshot.data['providers.yaml'] += '# tampered\n'; },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /snapshot data is not the exact providers.yaml source/);
  assert.doesNotMatch(result.log, /get deployment|patch deployment/);
});

test('apply refuses source ConfigMap drift after dry-run before creating a snapshot or patching', async () => {
  const result = await createHarness(validProvidersSource(), {
    mode: '--apply',
    env: {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: 'CHG-CONFIG-RACE',
      FAKE_CONFIG_DRIFT_AFTER_DRY_RUN: 'yes',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed after the server-side dry run/);
  assert.equal(result.log.match(/^patch deployment /gm)?.length, 1);
  assert.equal(result.snapshotCreated, false);
  assert.equal(result.mutated, false);
});

test('apply refuses Deployment drift after dry-run before creating a snapshot or real patch', async () => {
  const result = await createHarness(validProvidersSource(), {
    mode: '--apply',
    env: {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: 'CHG-DEPLOYMENT-RACE',
      FAKE_DEPLOYMENT_RACE_AFTER_DRY_RUN: 'yes',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Deployment .* changed after the server-side dry run/);
  assert.equal(result.log.match(/^patch deployment /gm)?.length, 1);
  assert.equal(result.snapshotCreated, false);
  assert.equal(result.mutated, false);
});

test('source drift after immutable snapshot creation fails before the Deployment mutation', async () => {
  const result = await createHarness(validProvidersSource(), {
    mode: '--apply',
    env: {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: 'CHG-PREPATCH-RACE',
      FAKE_CONFIG_DRIFT_AFTER_SNAPSHOT: 'yes',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed before the Deployment patch/);
  assert.equal(result.snapshotCreated, true);
  assert.equal(result.mutated, false);
});

test('resourceVersion precondition fails closed on a race between final guard and patch', async () => {
  const result = await createHarness(validProvidersSource(), {
    mode: '--apply',
    env: {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: 'CHG-ATOMIC-RACE',
      FAKE_ATOMIC_DEPLOYMENT_CONFLICT: 'yes',
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.log.match(/^patch deployment /gm)?.length, 2);
  assert.equal(result.snapshotCreated, true);
  assert.equal(result.mutated, false);
  assert.doesNotMatch(result.log, /^rollout /m);
});

test('apply with a whitespace ticket stops after server dry-run and before snapshot creation', async () => {
  const result = await createHarness(validProvidersSource(), {
    mode: '--apply',
    env: {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: ' \t ',
    },
  });
  assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /non-whitespace CHANGE_TICKET id/);
  assert.equal(result.log.match(/^patch deployment /gm)?.length, 1);
  assert.equal(result.snapshotCreated, false);
  assert.equal(result.mutated, false);
  assert.doesNotMatch(result.stdout, /change_ticket=|decision=rollout_pass/);
});

test('fully gated apply creates the immutable snapshot before one guarded patch and verifies final state', async () => {
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
  const createIndex = invocations.findIndex((line) => line.startsWith('create -f '));
  const rolloutIndex = invocations.findIndex((line) => line.startsWith('rollout status '));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(patchIndexes.length, 2);
  assert.match(patchIndexes[0].line, /--dry-run=server/);
  assert.doesNotMatch(patchIndexes[1].line, /--dry-run=server/);
  assert.ok(createIndex > patchIndexes[0].index);
  assert.ok(createIndex < patchIndexes[1].index);
  assert.ok(patchIndexes[1].index < rolloutIndex);
  assert.equal(result.snapshotCreated, true);
  assert.equal(result.mutated, true);
  assert.match(result.stdout, /change_ticket=CHG-1234/);
  assert.match(result.stdout, new RegExp(`verified_image=${immutableImage}`));
  assert.match(result.stdout, new RegExp(`verified_bootstrap_images=${immutableImage}`));
  assert.match(result.stdout, new RegExp(`verified_provider_snapshot=${result.snapshotName}`));
  assert.match(result.stdout, /verified_overlay=absent/);
  assert.match(result.stdout, /decision=rollout_pass_pending_agent_canaries/);
});

test('apply fails after rollout when the code-shadow mount or volume remains', async () => {
  const result = await createHarness(validProvidersSource(), {
    mode: '--apply',
    env: {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: 'CHG-OVERLAY-RESIDUAL',
      FAKE_RESIDUAL_OVERLAY: 'yes',
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.mutated, true);
  assert.match(result.stderr, /code-shadow overlay or another \/app\/dist mount remains/);
  assert.doesNotMatch(result.stdout, /verified_overlay=absent|decision=rollout_pass/);
});

test('apply fails after rollout when a bootstrap init container is not digest-pinned', async () => {
  const result = await createHarness(validProvidersSource(), {
    mode: '--apply',
    deploymentAfterMutator: (value) => {
      value.spec.template.spec.initContainers[0].image =
        'ghcr.io/philly1084/n8n-openai-cli-gateway:latest';
    },
    env: {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: 'CHG-INIT-DIGEST-DRIFT',
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.mutated, true);
  assert.match(result.stderr, /image must equal the promoted digest/);
  assert.doesNotMatch(result.stdout, /decision=rollout_pass/);
});

test('apply fails if the mutable source ConfigMap changes during rollout', async () => {
  const result = await createHarness(validProvidersSource(), {
    mode: '--apply',
    env: {
      ALLOW_PROD_WRITE: 'yes',
      HUMAN_APPROVED: 'yes',
      CHANGE_TICKET: 'CHG-POST-CONFIG-RACE',
      FAKE_CONFIG_DRIFT_AFTER_APPLY: 'yes',
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.mutated, true);
  assert.match(result.stderr, /changed during router promotion/);
  assert.doesNotMatch(result.stdout, /decision=rollout_pass/);
});
