import { createHash } from 'node:crypto';

export const NAMESPACE = 'n8n-openai-gateway';
export const DEPLOYMENT = 'n8n-openai-cli-gateway';
export const REPOSITORY = 'philly1084/cli-model-gateway';
const INIT_NAMES = ['gemini-bootstrap', 'kimi-bootstrap', 'gemini-auth-bootstrap'];
const IMAGE = /^ghcr\.io\/philly1084\/cli-model-gateway@sha256:([a-f0-9]{64})$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const clone = (value) => structuredClone(value);
const fail = (message) => { throw new Error(`Application promotion refused: ${message}`); };
function requireThat(condition, message) { if (!condition) fail(message); }

export function canonical(value) {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))) : item);
}
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function fingerprint(value) { return sha256(canonical(value)); }
function metadataFingerprint(metadata) {
  const m = clone(metadata);
  for (const key of ['resourceVersion', 'generation', 'managedFields']) delete m[key];
  if (m.annotations) {
    delete m.annotations['deployment.kubernetes.io/revision'];
    if (!Object.keys(m.annotations).length) delete m.annotations;
  }
  return fingerprint(m);
}
function one(entries, name) {
  const matches = (entries ?? []).filter((entry) => entry.name === name);
  requireThat(matches.length === 1, `expected exactly one ${name}`);
  return matches[0];
}
function configId(value) {
  const normalized = String(value ?? '').replace(/^containerd:\/\//, '');
  requireThat(DIGEST.test(normalized), 'runtime must report an exact image config digest');
  return normalized;
}

export function checkOnlyCommand(version) {
  requireThat(/^\d+\.\d+\.\d+$/.test(version), 'Kimi version must be an exact release version');
  const python = [
    'import importlib.metadata as m',
    'p="/var/lib/gateway-home/.local/share/uv/tools/kimi-cli/lib/python3.13/site-packages"',
    'v=[d.version for d in m.distributions(path=[p]) if d.metadata["Name"].replace("_","-").lower()=="kimi-cli"]',
    `assert v==["${version}"], "installed Kimi version changed"`,
  ].join('; ');
  // Isolated Python, no site initialization, bytecode writes, CLI startup or downloads.
  return ['sh', '-lc', [
    'set -eu',
    'test -x /var/lib/gateway-home/.local/bin/kimi',
    `/var/lib/gateway-home/.local/share/uv/tools/kimi-cli/bin/python -I -S -B -c '${python}'`,
    '',
  ].join('\n')];
}

function inspect(state) {
  const d = state.deployment;
  requireThat(d?.apiVersion === 'apps/v1' && d.kind === 'Deployment', 'wrong deployment type');
  requireThat(d.metadata?.name === DEPLOYMENT && d.metadata.namespace === NAMESPACE, 'wrong deployment identity');
  requireThat(d.metadata.uid && d.metadata.resourceVersion && !d.metadata.deletionTimestamp, 'deployment identity unavailable');
  requireThat(d.spec?.replicas === 1 && !d.spec.paused, 'expected one unpaused replica');
  const podSpec = d.spec.template.spec;
  requireThat(podSpec.containers?.length === 1 && podSpec.initContainers?.length === 3, 'unexpected containers');
  const gateway = one(podSpec.containers, 'gateway');
  const inits = INIT_NAMES.map((name) => one(podSpec.initContainers, name));
  const kimi = one(inits, 'kimi-bootstrap');
  requireThat(!kimi.args?.length, 'unexpected Kimi startup arguments');
  const providerVolume = one(podSpec.volumes, 'providers-config');
  const providerMount = (gateway.volumeMounts ?? []).filter((m) => m.mountPath === '/app/config/providers.yaml');
  requireThat(providerMount.length === 1 && providerMount[0].name === 'providers-config'
    && providerMount[0].subPath === 'providers.yaml', 'provider mount differs');
  requireThat(!(gateway.volumeMounts ?? []).some((m) => m.mountPath === '/app/dist' || m.mountPath.startsWith('/app/dist/')),
    'code overlays are not supported');
  const cm = state.provider;
  requireThat(cm?.apiVersion === 'v1' && cm.kind === 'ConfigMap' && cm.immutable === true, 'provider must be immutable');
  requireThat(cm.metadata?.namespace === NAMESPACE && cm.metadata.name === providerVolume.configMap?.name
    && cm.metadata.uid && !cm.metadata.deletionTimestamp, 'provider identity differs');
  requireThat(Object.keys(cm.data ?? {}).length === 1 && typeof cm.data['providers.yaml'] === 'string'
    && cm.data['providers.yaml'].length > 0 && !Object.keys(cm.binaryData ?? {}).length, 'provider data shape differs');
  const rsIds = new Set((state.replicaSets ?? []).filter((r) => (r.metadata.ownerReferences ?? []).some((o) =>
    o.controller === true && o.kind === 'Deployment' && o.uid === d.metadata.uid)).map((r) => r.metadata.uid));
  const ownedPods = (state.pods ?? []).filter((p) => (p.metadata.ownerReferences ?? []).some((o) =>
    o.controller === true && o.kind === 'ReplicaSet' && rsIds.has(o.uid)));
  requireThat(ownedPods.length === 1, 'expected exactly one owned pod, without a rollout in progress');
  const pod = ownedPods[0];
  requireThat(!pod.metadata.deletionTimestamp && pod.status?.phase === 'Running'
    && pod.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'), 'pod is not stable and ready');
  requireThat(canonical(pod.spec.containers.map((c) => ({ name: c.name, image: c.image })))
    === canonical(podSpec.containers.map((c) => ({ name: c.name, image: c.image }))), 'pod application reference differs');
  const startup = (c) => ({ name: c.name, image: c.image, command: c.command ?? [], args: c.args ?? [] });
  requireThat(canonical(pod.spec.initContainers.map(startup)) === canonical(podSpec.initContainers.map(startup)),
    'pod bootstrap command differs from the deployment');
  const appStatus = one(pod.status.containerStatuses, 'gateway');
  requireThat(appStatus.ready === true && appStatus.state?.running, 'gateway is not running');
  const initIds = {};
  for (const init of inits) {
    requireThat(one(pod.spec.initContainers, init.name).image === init.image, 'pod bootstrap reference differs');
    const status = one(pod.status.initContainerStatuses, init.name);
    requireThat(status.state?.terminated?.exitCode === 0, 'bootstrap has not succeeded');
    initIds[init.name] = configId(status.imageID);
  }
  return { d, podSpec, gateway, kimi, cm, pod, appId: configId(appStatus.imageID), initIds };
}

export { inspect as inspectApplicationState };

export function captureBaseline(state, reviewedOriginalKimiCommand, toolState) {
  const x = inspect(state);
  requireThat(canonical(x.kimi.command) === canonical(reviewedOriginalKimiCommand), 'startup is not the reviewed public template');
  requireThat(toolState?.geminiExecutable === true && toolState.geminiAuthPresent === true
    && toolState.kimiExecutable === true && toolState.kimiPythonExecutable === true, 'bootstrap prerequisites missing');
  checkOnlyCommand(toolState.kimiVersion);
  return {
    version: 1, deploymentUid: x.d.metadata.uid, deploymentMetadataSha256: metadataFingerprint(x.d.metadata),
    deploymentSpecSha256: fingerprint(x.d.spec), nodeName: x.pod.spec.nodeName,
    provider: { name: x.cm.metadata.name, uid: x.cm.metadata.uid, resourceVersion: x.cm.metadata.resourceVersion, sha256: sha256(x.cm.data['providers.yaml']),
      objectSha256: fingerprint({ immutable: x.cm.immutable, data: x.cm.data, binaryData: x.cm.binaryData ?? {} }) },
    app: { image: x.gateway.image, imageId: x.appId },
    init: Object.fromEntries(INIT_NAMES.map((name) => [name, { image: one(x.podSpec.initContainers, name).image, imageId: x.initIds[name] }])),
    originalKimiCommand: clone(reviewedOriginalKimiCommand), kimiVersion: toolState.kimiVersion,
  };
}

export function verifyReleaseProof(release) {
  const match = IMAGE.exec(release?.image ?? '');
  requireThat(match && /^[a-f0-9]{40}$/.test(release.sourceCommit ?? ''), 'release must pin canonical image and source commit');
  const decode = (encoded) => Buffer.from(encoded ?? '', 'base64');
  const rootBytes = decode(release.rootManifestBase64);
  requireThat(rootBytes.length > 0 && rootBytes.length <= 1048576 && sha256(rootBytes) === match[1], 'root manifest digest differs');
  let root;
  try { root = JSON.parse(rootBytes); } catch { fail('invalid root manifest'); }
  requireThat(root.schemaVersion === 2, 'unsupported manifest schema');
  let manifest = root;
  if (root.manifests) {
    const arm = root.manifests.filter((m) => m.platform?.os === 'linux' && m.platform.architecture === 'arm64');
    requireThat(arm.length === 1 && DIGEST.test(arm[0].digest), 'expected one Linux ARM64 manifest');
    const child = decode(release.armManifestBase64);
    requireThat(child.length > 0 && child.length <= 1048576 && `sha256:${sha256(child)}` === arm[0].digest, 'ARM64 manifest digest differs');
    try { manifest = JSON.parse(child); } catch { fail('invalid ARM64 manifest'); }
  }
  requireThat(manifest.schemaVersion === 2 && DIGEST.test(manifest.config?.digest ?? ''), 'config descriptor missing');
  const config = decode(release.imageConfigBase64);
  requireThat(config.length > 0 && config.length <= 1048576 && `sha256:${sha256(config)}` === manifest.config.digest, 'image config digest differs');
  let parsed;
  try { parsed = JSON.parse(config); } catch { fail('invalid image config'); }
  requireThat(parsed.os === 'linux' && parsed.architecture === 'arm64', 'wrong target platform');
  return { image: release.image, imageId: manifest.config.digest, sourceCommit: release.sourceCommit };
}

export function attestationArgs(release) {
  const r = verifyReleaseProof(release);
  return ['attestation', 'verify', `oci://${r.image}`, '--repo', REPOSITORY,
    '--signer-workflow', `${REPOSITORY}/.github/workflows/build.yml`, '--source-ref', 'refs/heads/main',
    '--source-digest', r.sourceCommit, '--deny-self-hosted-runners'];
}

export function validateState(state, baseline, release, phase = 'before') {
  requireThat(baseline?.version === 1 && /^[a-f0-9]{64}$/.test(baseline.deploymentSpecSha256 ?? ''), 'invalid reviewed baseline');
  requireThat(['before', 'after', 'rollback-preserve', 'rollback-original'].includes(phase), 'invalid phase');
  const x = inspect(state);
  requireThat(x.d.metadata.uid === baseline.deploymentUid, 'deployment was replaced');
  requireThat(metadataFingerprint(x.d.metadata) === baseline.deploymentMetadataSha256, 'unrelated deployment metadata drift');
  requireThat(baseline.nodeName && x.pod.spec.nodeName === baseline.nodeName, 'deployment moved to another node');
  requireThat(x.cm.metadata.name === baseline.provider.name && x.cm.metadata.uid === baseline.provider.uid
    && x.cm.metadata.resourceVersion === baseline.provider.resourceVersion
    && sha256(x.cm.data['providers.yaml']) === baseline.provider.sha256
    && fingerprint({ immutable: x.cm.immutable, data: x.cm.data, binaryData: x.cm.binaryData ?? {} }) === baseline.provider.objectSha256,
  'provider snapshot drift');
  for (const name of INIT_NAMES) {
    requireThat(one(x.podSpec.initContainers, name).image === baseline.init[name]?.image
      && x.initIds[name] === baseline.init[name].imageId, 'bootstrap image identity drift');
  }
  const after = phase === 'after';
  const r = verifyReleaseProof(release);
  requireThat(x.gateway.image === (after ? r.image : baseline.app.image)
    && x.appId === (after ? r.imageId : baseline.app.imageId), 'application image identity differs');
  const expectedCommand = (phase === 'after' || phase === 'rollback-preserve')
    ? checkOnlyCommand(baseline.kimiVersion) : baseline.originalKimiCommand;
  requireThat(canonical(x.kimi.command) === canonical(expectedCommand), 'startup command differs');
  const normalized = clone(x.d.spec);
  one(normalized.template.spec.containers, 'gateway').image = baseline.app.image;
  one(normalized.template.spec.initContainers, 'kimi-bootstrap').command = clone(baseline.originalKimiCommand);
  requireThat(fingerprint(normalized) === baseline.deploymentSpecSha256, 'unrelated deployment field drift');
  return x;
}

export function buildPatch(state, baseline, release, { rollback = false, restoreOriginalStartup = false } = {}) {
  validateState(state, baseline, release, rollback ? 'after' : 'before');
  const p = state.deployment.spec.template.spec;
  const appIndex = p.containers.findIndex((c) => c.name === 'gateway');
  const kimiIndex = p.initContainers.findIndex((c) => c.name === 'kimi-bootstrap');
  return [
    { op: 'test', path: '/metadata/resourceVersion', value: state.deployment.metadata.resourceVersion },
    { op: 'replace', path: `/spec/template/spec/containers/${appIndex}/image`, value: rollback ? baseline.app.image : release.image },
    { op: 'replace', path: `/spec/template/spec/initContainers/${kimiIndex}/command`,
      value: rollback && restoreOriginalStartup ? baseline.originalKimiCommand : checkOnlyCommand(baseline.kimiVersion) },
  ];
}

export function checkProjectedDeployment(observed, before, patch) {
  const expected = clone(before.spec);
  for (const operation of patch.filter((op) => op.op === 'replace')) {
    const parts = operation.path.split('/').slice(2);
    let parent = expected;
    for (const key of parts.slice(0, -1)) parent = parent[key];
    parent[parts.at(-1)] = clone(operation.value);
  }
  requireThat(metadataFingerprint(observed.metadata) === metadataFingerprint(before.metadata) && fingerprint(observed.spec) === fingerprint(expected),
    'admission changed an unrelated deployment field');
}

export function validateImageInventory(inventory, baseline, release) {
  requireThat(inventory?.nodeName === baseline.nodeName, 'image inventory is from another node');
  const r = verifyReleaseProof(release);
  const expected = [baseline.app, ...Object.values(baseline.init), { image: r.image, imageId: r.imageId }];
  for (const e of expected) {
    requireThat(inventory.images?.[e.image] === e.imageId, 'node image cache identity differs or image is not preloaded');
  }
}
