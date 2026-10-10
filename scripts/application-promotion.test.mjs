import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';
import {
  NAMESPACE, DEPLOYMENT, sha256, fingerprint, captureBaseline, verifyReleaseProof,
  validateState, buildPatch, checkProjectedDeployment, checkOnlyCommand, attestationArgs,
} from './application-promotion-contract.mjs';
import { promoteApplication } from './application-promotion-runner.mjs';
import { buildReleaseProof } from './build-application-release-proof.mjs';

const digest = (c) => `sha256:${c.repeat(64)}`;
const originalCommand = ['sh', '-lc', 'uv tool upgrade kimi-cli --no-cache\n'];
const tools = { geminiExecutable: true, geminiAuthPresent: true, kimiExecutable: true, kimiPythonExecutable: true, kimiVersion: '1.52.0' };
const approval = { ALLOW_PROD_WRITE: 'yes', HUMAN_APPROVED: 'yes', CHANGE_TICKET: 'review-123' };
const providers = readFileSync(new URL('../config/providers.example.yaml', import.meta.url), 'utf8');
const clone = structuredClone;

function releaseFixture() {
  const config = Buffer.from(JSON.stringify({ architecture: 'arm64', os: 'linux', config: { User: 'gateway' } }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${sha256(config)}` }, layers: [] }));
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${sha256(manifest)}`, platform: { os: 'linux', architecture: 'arm64' } }] }));
  return { image: `ghcr.io/philly1084/cli-model-gateway@sha256:${sha256(index)}`, sourceCommit: 'd'.repeat(40),
    rootManifestBase64: index.toString('base64'), armManifestBase64: manifest.toString('base64'), imageConfigBase64: config.toString('base64') };
}
function fixture() {
  const inits = ['gemini-bootstrap', 'kimi-bootstrap', 'gemini-auth-bootstrap'].map((name) => ({ name,
    image: 'localhost/reviewed-recovery:old', command: name === 'kimi-bootstrap' ? clone(originalCommand) : ['sh', '-c', 'true'] }));
  const spec = { containers: [{ name: 'gateway', image: 'localhost/reviewed-app:old',
    env: [{ name: 'PRIVATE_SYNTHETIC_TEST_VALUE', value: 'must-not-be-in-the-baseline' }],
    volumeMounts: [{ name: 'providers-config', mountPath: '/app/config/providers.yaml', subPath: 'providers.yaml' }] }],
  initContainers: inits, volumes: [{ name: 'providers-config', configMap: { name: 'reviewed-live-snapshot' } }] };
  const state = {
    deployment: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: DEPLOYMENT, namespace: NAMESPACE, uid: 'deployment-uid', resourceVersion: '100' },
      spec: { replicas: 1, template: { metadata: { labels: { app: 'gateway' } }, spec } } },
    provider: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'reviewed-live-snapshot', namespace: NAMESPACE, uid: 'provider-uid', resourceVersion: '10' }, immutable: true, data: { 'providers.yaml': providers } },
    replicaSets: [{ metadata: { uid: 'rs-uid', ownerReferences: [{ uid: 'deployment-uid', kind: 'Deployment', controller: true }] } }],
    pods: [{ metadata: { name: 'gateway-pod', ownerReferences: [{ uid: 'rs-uid', kind: 'ReplicaSet', controller: true }] },
      spec: { ...clone(spec), nodeName: 'reviewed-node' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [{ name: 'gateway', ready: true, imageID: digest('a'), state: { running: {} } }],
        initContainerStatuses: inits.map((i) => ({ name: i.name, imageID: digest('b'), state: { terminated: { exitCode: 0 } } })) } }],
  };
  return { state, baseline: captureBaseline(state, originalCommand, tools), release: releaseFixture() };
}
function projected(deployment, patch) {
  const result = clone(deployment);
  for (const op of patch.filter((p) => p.op === 'replace')) {
    const keys = op.path.split('/').slice(1); let target = result;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = clone(op.value);
  }
  return result;
}
function roll(state, patch, imageId) {
  state.deployment = projected(state.deployment, patch);
  state.deployment.metadata.resourceVersion = String(Number(state.deployment.metadata.resourceVersion) + 1);
  state.pods[0].spec = { ...clone(state.deployment.spec.template.spec), nodeName: 'reviewed-node' };
  state.pods[0].status.containerStatuses[0].imageID = imageId;
}

test('baseline records hashes, identities and reviewed startup without provider/env values', () => {
  const { baseline } = fixture();
  assert.equal(baseline.provider.sha256, sha256(providers));
  assert.doesNotMatch(JSON.stringify(baseline), /must-not-be-in-the-baseline|providers\.yaml/);
});
test('check-only startup cannot install, upgrade, load site code or run the provider CLI', () => {
  const command = checkOnlyCommand('1.52.0')[2];
  assert.match(command, /python -I -S -B/);
  assert.match(command, /1\.52\.0/);
  assert.doesNotMatch(command, /uv tool|--version|\b(?:curl|npm|pip|install|upgrade)\b/);
  assert.throws(() => checkOnlyCommand('1.52.0; evil'), /exact release/);
});
test('release identity is derived from the signed root through ARM64 manifest to config', () => {
  const { release } = fixture();
  assert.match(verifyReleaseProof(release).imageId, /^sha256:[a-f0-9]{64}$/);
  const args = attestationArgs(release);
  for (const flag of ['--signer-workflow', '--source-ref', '--source-digest', '--deny-self-hosted-runners']) assert.ok(args.includes(flag));
  assert.ok(args.includes(release.sourceCommit));
});
test('proof builder uses exact existing blobs and rejects altered content', () => {
  const release = releaseFixture();
  const blobs = Object.fromEntries(['rootManifestBase64', 'armManifestBase64', 'imageConfigBase64'].map((key) => {
    const bytes = Buffer.from(release[key], 'base64'); return [`sha256:${sha256(bytes)}`, bytes];
  }));
  const proof = buildReleaseProof(release.image, release.sourceCommit, (digest) => blobs[digest]);
  assert.deepEqual(proof, release);
  assert.throws(() => buildReleaseProof(release.image, release.sourceCommit, () => Buffer.from('{}')), /digest differs/);
});
for (const field of ['rootManifestBase64', 'armManifestBase64', 'imageConfigBase64']) test(`denies corrupted ${field}`, () => {
  const { release } = fixture(); release[field] = Buffer.from('{}').toString('base64');
  assert.throws(() => verifyReleaseProof(release), /digest differs/);
});
test('rejects mutable, local or foreign target images', () => {
  for (const image of ['localhost/reviewed-app:new', 'ghcr.io/philly1084/cli-model-gateway:main', `ghcr.io/other/repo@${digest('a')}`]) {
    assert.throws(() => verifyReleaseProof({ ...releaseFixture(), image }), /canonical image/);
  }
});
test('only gateway image and Kimi command are replaceable, guarded by resourceVersion', () => {
  const { state, baseline, release } = fixture(); const patch = buildPatch(state, baseline, release);
  assert.deepEqual(patch.map((p) => p.path), ['/metadata/resourceVersion', '/spec/template/spec/containers/0/image', '/spec/template/spec/initContainers/1/command']);
  checkProjectedDeployment(projected(state.deployment, patch), state.deployment, patch);
  roll(state, patch, verifyReleaseProof(release).imageId);
  validateState(state, baseline, release, 'after');
});
const driftCases = {
  'deployment UID': (s) => { s.deployment.metadata.uid = 'other'; },
  'deployment labels': (s) => { s.deployment.metadata.labels = { unrelated: 'change' }; },
  'provider pointer': (s) => { s.deployment.spec.template.spec.volumes[0].configMap.name = 'different'; },
  'provider UID': (s) => { s.provider.metadata.uid = 'recreated'; },
  'provider resource version': (s) => { s.provider.metadata.resourceVersion = '11'; },
  'provider contents': (s) => { s.provider.data['providers.yaml'] += '\n# changed'; },
  'mutable config': (s) => { s.provider.immutable = false; },
  'init reference': (s) => { s.deployment.spec.template.spec.initContainers[0].image = 'localhost/other:tag'; },
  'init runtime identity': (s) => { s.pods[0].status.initContainerStatuses[0].imageID = digest('c'); },
  'app runtime identity': (s) => { s.pods[0].status.containerStatuses[0].imageID = digest('c'); },
  'node identity': (s) => { s.pods[0].spec.nodeName = 'another-node'; },
  'pod ownership': (s) => { s.pods[0].metadata.ownerReferences[0].uid = 'unrelated'; },
  'rollout in progress': (s) => { s.pods.push(clone(s.pods[0])); },
  'unready pod': (s) => { s.pods[0].status.conditions[0].status = 'False'; },
  'startup command': (s) => { s.deployment.spec.template.spec.initContainers[1].command = ['sh', '-c', 'other']; },
  'env value': (s) => { s.deployment.spec.template.spec.containers[0].env[0].value = 'changed'; },
  'security context': (s) => { s.deployment.spec.template.spec.securityContext = { runAsUser: 0 }; },
  'secret reference': (s) => { s.deployment.spec.template.spec.containers[0].envFrom = [{ secretRef: { name: 'new-secret' } }]; },
  'replica count': (s) => { s.deployment.spec.replicas = 2; },
  'mount flags': (s) => { s.deployment.spec.template.spec.containers[0].volumeMounts[0].readOnly = true; },
};
for (const [name, change] of Object.entries(driftCases)) test(`denies ${name} drift`, () => {
  const { state, baseline, release } = fixture(); change(state);
  assert.throws(() => validateState(state, baseline, release), /refused/);
});
test('denies unrelated admission changes after server-side dry-run', () => {
  const { state, baseline, release } = fixture(); const patch = buildPatch(state, baseline, release);
  const observed = projected(state.deployment, patch); observed.spec.template.metadata.labels.injected = 'true';
  assert.throws(() => checkProjectedDeployment(observed, state.deployment, patch), /admission/);
});
test('rollback restores app identity, preserves check-only by default, and can explicitly restore original command', () => {
  const { state, baseline, release } = fixture(); roll(state, buildPatch(state, baseline, release), verifyReleaseProof(release).imageId);
  const originalState = clone(state);
  roll(state, buildPatch(state, baseline, release, { rollback: true }), baseline.app.imageId);
  validateState(state, baseline, release, 'rollback-preserve');
  roll(originalState, buildPatch(originalState, baseline, release, { rollback: true, restoreOriginalStartup: true }), baseline.app.imageId);
  validateState(originalState, baseline, release, 'rollback-original');
});

function harness(options = {}) {
  const f = fixture(); let state = f.state; const calls = []; const receipts = []; let reads = 0;
  const argumentsForRun = { baseline: f.baseline, approvedBaselineHash: fingerprint(f.baseline), release: f.release,
    approvedReleaseHash: fingerprint(f.release), env: approval,
    readState: async () => { reads++; if (reads === 2 && options.drift) options.drift(state); return clone(state); },
    readTools: async () => clone(options.tools ?? tools),
    readImageInventory: async () => ({ nodeName: options.wrongInventoryNode ? 'other-node' : 'reviewed-node', images: {
      [f.baseline.app.image]: options.wrongRollbackImage ? digest('c') : f.baseline.app.imageId,
      'localhost/reviewed-recovery:old': digest('b'),
      [f.release.image]: options.wrongTargetImage ? digest('c') : verifyReleaseProof(f.release).imageId,
    } }),
    writeReceipt: async (r) => receipts.push(clone(r)),
    run: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'gh') { if (options.attestationFails) throw Error('untrusted attestation'); return ''; }
      if (args.includes('patch')) {
        const patch = JSON.parse(args[args.indexOf('--patch') + 1]);
        if (args.includes('--dry-run=server')) {
          const result = projected(state.deployment, patch);
          if (options.admissionDrift) result.spec.paused = true;
          return JSON.stringify(result);
        }
        roll(state, patch, patch[1].value === f.release.image ? verifyReleaseProof(f.release).imageId : f.baseline.app.imageId);
        if (options.canonicalRuntime) {
          const status = state.pods[0].status.containerStatuses[0];
          status.image = status.imageID;
          if (patch[1].value === f.release.image) status.imageID = f.release.image;
        }
        return JSON.stringify(state.deployment);
      }
      return '';
    },
  };
  return { f, calls, receipts, argumentsForRun, state: () => state };
}
test('dry-run performs real verifier command and admission check but no write or receipt', async () => {
  const h = harness(); const result = await promoteApplication({ ...h.argumentsForRun, mode: 'dry-run' });
  assert.equal(result.decision, 'dry_run_pass'); assert.equal(h.calls[0].tool, 'gh'); assert.equal(h.receipts.length, 0);
  assert.equal(h.calls.filter((c) => c.tool === 'kubectl').length, 1);
  assert.ok(h.calls[1].args.includes('--dry-run=server'));
});
test('apply performs exactly the scoped patch and verifies resulting identities', async () => {
  const h = harness(); const result = await promoteApplication({ ...h.argumentsForRun, mode: 'apply' });
  assert.equal(result.decision, 'applied'); assert.equal(result.pvcRestorationClaimed, false);
  assert.deepEqual(h.receipts.map((r) => r.status), ['needs-verification', 'applied']);
  assert.equal(h.state().provider.metadata.name, h.f.baseline.provider.name);
});
test('untrusted attestation stops before any kubectl call', async () => {
  const h = harness({ attestationFails: true }); await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'apply' }), /untrusted/);
  assert.deepEqual(h.calls.map((c) => c.tool), ['gh']);
});
for (const name of ['wrongInventoryNode', 'wrongRollbackImage', 'wrongTargetImage']) test(`denies ${name} before any patch`, async () => {
  const h = harness({ [name]: true });
  await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'apply' }), /inventory|cache identity/);
  assert.deepEqual(h.calls.map((c) => c.tool), ['gh']);
});
test('provider validation errors suppress raw values', async () => {
  const h = harness();
  await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'dry-run', verifyProvider() { throw Error('secret-value'); } }),
    (error) => error.message.includes('values suppressed') && !error.message.includes('secret-value'));
});
for (const missing of ['HUMAN_APPROVED', 'ALLOW_PROD_WRITE', 'CHANGE_TICKET']) test(`apply requires ${missing}`, async () => {
  const h = harness(); const env = { ...approval }; delete env[missing];
  await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'apply', env }), /approval/); assert.equal(h.calls.length, 0);
});
test('reviewed artifact hashes cannot be substituted', async () => {
  const h = harness();
  await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'apply', approvedBaselineHash: 'wrong' }), /baseline hash/);
  await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'apply', approvedReleaseHash: 'wrong' }), /release hash/);
  assert.equal(h.calls.length, 0);
});
test('post-dry-run resourceVersion drift prevents write', async () => {
  const h = harness({ drift: (s) => { s.deployment.metadata.resourceVersion = '101'; } });
  await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'apply' }), /changed after dry-run/); assert.equal(h.receipts.length, 0);
});
test('admission changes prevent write', async () => {
  const h = harness({ admissionDrift: true }); await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'apply' }), /admission/);
  assert.equal(h.receipts.length, 0);
});
test('missing Gemini auth guard prevents installation/seeding on restart', async () => {
  const h = harness({ tools: { ...tools, geminiAuthPresent: false } });
  await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'apply' }), /prerequisites/);
  assert.equal(h.calls.filter((c) => c.tool === 'kubectl').length, 0);
});
test('rollback requires matching receipt and explicit acknowledgement for original upgrade command', async () => {
  const h = harness(); await promoteApplication({ ...h.argumentsForRun, mode: 'apply' });
  const receipt = h.receipts.at(-1);
  await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'rollback', receipt: {} }), /receipt/);
  await assert.rejects(promoteApplication({ ...h.argumentsForRun, mode: 'rollback', receipt, restoreOriginalStartup: true }), /acknowledgement/);
  const result = await promoteApplication({ ...h.argumentsForRun, mode: 'rollback', receipt });
  assert.equal(result.decision, 'rolled-back'); assert.equal(result.startupPolicy, 'check-only'); assert.equal(result.pvcRestorationClaimed, false);
});
test('original startup rollback requires acknowledgement and makes no PVC restoration claim', async () => {
  const h = harness(); await promoteApplication({ ...h.argumentsForRun, mode: 'apply' });
  const result = await promoteApplication({ ...h.argumentsForRun, mode: 'rollback', receipt: h.receipts.at(-1),
    restoreOriginalStartup: true, env: { ...approval, ACKNOWLEDGE_STARTUP_UPGRADE: 'yes' } });
  assert.equal(result.startupPolicy, 'original-auto-upgrade'); assert.equal(result.pvcRestorationClaimed, false);
  assert.deepEqual(h.state().deployment.spec.template.spec.initContainers[1].command, originalCommand);
});

test('check-only Python executes against synthetic package metadata without running Kimi', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'promotion-python-check-'));
  try {
    const bin = path.join(root, '.local/bin');
    const tool = path.join(root, '.local/share/uv/tools/kimi-cli');
    const info = path.join(tool, 'lib/python3.13/site-packages/kimi_cli-1.52.0.dist-info');
    mkdirSync(bin, { recursive: true }); mkdirSync(info, { recursive: true }); mkdirSync(path.join(tool, 'bin'));
    const marker = path.join(root, 'provider-was-executed');
    writeFileSync(path.join(bin, 'kimi'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    symlinkSync('/usr/bin/python3', path.join(tool, 'bin/python'));
    const metadata = path.join(info, 'METADATA');
    writeFileSync(metadata, 'Metadata-Version: 2.1\nName: kimi-cli\nVersion: 1.52.0\n');
    const command = checkOnlyCommand('1.52.0')[2].replaceAll('/var/lib/gateway-home', root);
    const good = spawnSync('sh', ['-lc', command], { encoding: 'utf8', timeout: 5000 });
    assert.equal(good.status, 0, good.stderr); assert.equal(existsSync(marker), false);
    writeFileSync(metadata, 'Metadata-Version: 2.1\nName: kimi-cli\nVersion: 1.53.0\n');
    const changed = spawnSync('sh', ['-lc', command], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(changed.status, 0); assert.match(changed.stderr, /installed Kimi version changed/);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI capture, dry-run, apply and rollback use synthetic executables and bounded receipts', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'promotion-cli-check-'));
  try {
    const f = fixture();
    const documents = parseAllDocuments(readFileSync(new URL('../kubernetes/rancher-install.yaml', import.meta.url), 'utf8')).map((d) => d.toJSON());
    const template = documents.find((d) => d?.kind === 'Deployment' && d.spec?.template?.spec?.initContainers);
    const kimi = template.spec.template.spec.initContainers.find((c) => c.name === 'kimi-bootstrap').command;
    f.state.deployment.spec.template.spec.initContainers[1].command = kimi;
    f.state.pods[0].spec.initContainers[1].command = kimi;
    f.state.pods[0].spec.nodeName = hostname();
    const stateFile = path.join(root, 'state.json'); writeFileSync(stateFile, JSON.stringify(f.state));
    const releaseFile = path.join(root, 'release.json'); writeFileSync(releaseFile, JSON.stringify(f.release));
    const logFile = path.join(root, 'calls.jsonl');
    const fakeKubectl = path.join(root, 'kubectl');
    writeFileSync(fakeKubectl, `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);const s=JSON.parse(fs.readFileSync(process.env.SYN_STATE,'utf8'));
fs.appendFileSync(process.env.SYN_LOG,JSON.stringify(a)+'\\n');
let out={};
if(a.includes('get')){const kind=a[a.indexOf('get')+1];out=kind==='deployment'?s.deployment:kind==='configmap'?s.provider:{items:kind==='pods'?s.pods:s.replicaSets};}
if(a.includes('exec'))out=JSON.parse(process.env.SYN_TOOLS);
if(a.includes('patch')){const p=JSON.parse(a[a.indexOf('--patch')+1]);for(const o of p.filter(x=>x.op==='replace')){const k=o.path.split('/').slice(1);let t=s.deployment;for(const v of k.slice(0,-1))t=t[v];t[k.at(-1)]=o.value;}
 if(!a.includes('--dry-run=server')){s.deployment.metadata.resourceVersion=String(Number(s.deployment.metadata.resourceVersion)+1);s.pods[0].spec={...s.deployment.spec.template.spec,nodeName:require('os').hostname()};s.pods[0].status.containerStatuses[0].imageID=p[1].value===process.env.SYN_TARGET_REF?process.env.SYN_TARGET_ID:process.env.SYN_OLD_ID;fs.writeFileSync(process.env.SYN_STATE,JSON.stringify(s));}out=s.deployment;}
process.stdout.write(JSON.stringify(out));
`, { mode: 0o700 });
    const fakeGh = path.join(root, 'gh');
    writeFileSync(fakeGh, '#!/usr/bin/env node\nif(process.env.SYN_DENY_ATTESTATION)process.exit(1);\n', { mode: 0o700 });
    const fakeK3s = path.join(root, 'k3s');
    writeFileSync(fakeK3s, `#!/usr/bin/env node
const ref=process.argv.at(-1);const id=ref===process.env.SYN_TARGET_REF?process.env.SYN_TARGET_ID:ref.includes('reviewed-recovery')?'${digest('b')}':process.env.SYN_OLD_ID;console.log(JSON.stringify({status:{id},info:{private:'not-for-output'}}));
`, { mode: 0o700 });
    const env = { ...process.env, ...approval, GH_EXECUTABLE: fakeGh, KUBECTL_EXECUTABLE: fakeKubectl, K3S_EXECUTABLE: fakeK3s,
      SYN_STATE: stateFile, SYN_LOG: logFile, SYN_TOOLS: JSON.stringify(tools), SYN_TARGET_REF: f.release.image,
      SYN_TARGET_ID: verifyReleaseProof(f.release).imageId, SYN_OLD_ID: digest('a') };
    delete env.IMAGE_INVENTORY_EXECUTABLE;
    const cli = path.resolve('scripts/promote-application-preserving-state.mjs');
    const call = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
    const baselineFile = path.join(root, 'baseline.json');
    const captured = call(['capture', '--baseline', baselineFile]); assert.equal(captured.status, 0, captured.stderr);
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    assert.doesNotMatch(readFileSync(baselineFile, 'utf8'), /must-not-be-in-the-baseline/);
    const common = ['--baseline', baselineFile, '--baseline-sha256', fingerprint(baseline), '--release', releaseFile, '--release-sha256', fingerprint(f.release)];
    const dry = call(['dry-run', ...common]); assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /dry_run_pass/);
    const receiptFile = path.join(root, 'receipt.json');
    const denied = call(['apply', ...common, '--receipt', receiptFile], { SYN_DENY_ATTESTATION: 'yes' });
    assert.notEqual(denied.status, 0); assert.equal(existsSync(receiptFile), false);
    const applied = call(['apply', ...common, '--receipt', receiptFile]); assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).status, 'applied');
    const rolledBack = call(['rollback', ...common, '--receipt', receiptFile]); assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).status, 'rolled-back');
    assert.doesNotMatch(applied.stdout + rolledBack.stdout, /not-for-output|must-not-be-in-the-baseline/);
    const final = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(final.deployment.spec.template.spec.containers[0].image, f.state.deployment.spec.template.spec.containers[0].image);
    assert.deepEqual(final.deployment.spec.template.spec.initContainers[1].command, checkOnlyCommand('1.52.0'));
    assert.equal(final.provider.metadata.name, baseline.provider.name);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function canonicalRuntimeFixture() {
  const f = fixture();
  const identity = verifyReleaseProof(f.release);
  roll(f.state, buildPatch(f.state, f.baseline, f.release), identity.imageId);
  Object.assign(f.state.pods[0].status.containerStatuses[0], { image: identity.imageId, imageID: identity.image });
  return f;
}

test('canonical runtime pair validates against signed proof without rewriting observations', () => {
  const f = canonicalRuntimeFixture(); const before = clone(f.state);
  validateState(f.state, f.baseline, f.release, 'after');
  assert.deepEqual(f.state, before);
  const patch = buildPatch(f.state, f.baseline, f.release, { rollback: true });
  assert.equal(patch[1].value, f.baseline.app.image);
  assert.deepEqual(patch[2].value, checkOnlyCommand('1.52.0'));
});

const invalidRuntimePairs = {
  'different registry digest': (s) => { s.imageID = `ghcr.io/philly1084/cli-model-gateway@${digest('f')}`; },
  'different config digest': (s) => { s.image = digest('f'); },
  'missing config digest': (s) => { delete s.image; },
  'mutable config reference': (s) => { s.image = 'ghcr.io/philly1084/cli-model-gateway:main'; },
  'foreign repository': (s) => { s.imageID = `ghcr.io/other/app@${digest('f')}`; },
  'mutable registry reference': (s) => { s.imageID = 'ghcr.io/philly1084/cli-model-gateway:main'; },
  'prefixed registry reference': (s) => { s.imageID = 'containerd://' + s.imageID; },
  'prefixed config field': (s) => { s.image = 'containerd://' + s.image; },
  'registry whitespace': (s) => { s.imageID += ' '; },
  'short config digest': (s) => { s.image = 'sha256:abc'; },
  'uppercase config digest': (s) => { s.image = s.image.toUpperCase(); },
  'object config field': (s) => { s.image = { digest: s.image }; },
  'missing registry field': (s) => { delete s.imageID; },
};
for (const [name, alter] of Object.entries(invalidRuntimePairs)) test(`canonical runtime rejects ${name}`, () => {
  const f = canonicalRuntimeFixture(); alter(f.state.pods[0].status.containerStatuses[0]);
  assert.throws(() => validateState(f.state, f.baseline, f.release, 'after'), /refused/);
  assert.throws(() => buildPatch(f.state, f.baseline, f.release, { rollback: true }), /refused/);
});

test('canonical runtime cannot substitute the root or ARM manifest digest for config identity', () => {
  for (const source of ['rootManifestBase64', 'armManifestBase64']) {
    const f = canonicalRuntimeFixture();
    f.state.pods[0].status.containerStatuses[0].image = `sha256:${sha256(Buffer.from(f.release[source], 'base64'))}`;
    assert.throws(() => validateState(f.state, f.baseline, f.release, 'after'), /application image identity/);
  }
});

test('legacy containerd config identity stays supported and bootstrap format stays strict', () => {
  const f = fixture(); f.state.pods[0].status.containerStatuses[0].imageID = 'containerd://' + f.baseline.app.imageId;
  validateState(f.state, f.baseline, f.release);
  const c = canonicalRuntimeFixture();
  Object.assign(c.state.pods[0].status.initContainerStatuses[0], {imageID:c.release.image,image:c.baseline.init['gemini-bootstrap'].imageId});
  assert.throws(() => validateState(c.state,c.baseline,c.release,'after'), /config digest/);
});

test('canonical apply and rollback retain provenance, inventory, scoped patch and receipt gates', async () => {
  const h = harness({ canonicalRuntime:true });
  const applied = await promoteApplication({...h.argumentsForRun,mode:'apply'});
  assert.equal(applied.decision,'applied');
  const receipt = h.receipts.at(-1);
  const rolled = await promoteApplication({...h.argumentsForRun,mode:'rollback',receipt});
  assert.equal(rolled.decision,'rolled-back');
  assert.equal(rolled.startupPolicy,'check-only');
  assert.equal(h.calls.filter(c=>c.tool==='gh').length,2);
  for (const call of h.calls.filter(c=>c.tool==='gh')) assert.deepEqual(call.args,attestationArgs(h.f.release));
  assert.deepEqual(h.receipts.map(r=>r.status),['needs-verification','applied','needs-verification','rolled-back']);
});

test('canonical rollback still rejects failed provenance and missing rollback cache before patch', async () => {
  for (const gate of ['provenance','cache']) {
    const h=harness({canonicalRuntime:true});await promoteApplication({...h.argumentsForRun,mode:'apply'});
    const callCount=h.calls.length;
    const args={...h.argumentsForRun,mode:'rollback',receipt:h.receipts.at(-1)};
    if(gate==='provenance')args.run=async(tool)=>{assert.equal(tool,'gh');throw Error('untrusted attestation');};
    else args.readImageInventory=async()=>({nodeName:'reviewed-node',images:{}});
    await assert.rejects(promoteApplication(args),/untrusted|cache identity/);
    assert.equal(h.calls.slice(callCount).filter(c=>c.tool==='kubectl').length,0);
  }
});
