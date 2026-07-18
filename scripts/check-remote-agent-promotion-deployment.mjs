import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROMOTION_DEPLOYMENT_CONTRACT = Object.freeze({
  container: 'gateway',
  initContainers: Object.freeze([
    'gemini-bootstrap',
    'kimi-bootstrap',
    'gemini-auth-bootstrap',
  ]),
  providerVolume: 'providers-config',
  providerMountPath: '/app/config/providers.yaml',
  providerSubPath: 'providers.yaml',
  overlayVolume: 'remote-cli-tail-hotfix',
  overlayMountPath: '/app/dist/jobs/remote-cli-tool-manager.js',
  overlaySubPath: 'remote-cli-tool-manager.js',
  overlayReadOnly: true,
});

const ROUTER_IMAGE_PATTERN = /^ghcr\.io\/philly1084\/(?:cli-model-gateway|n8n-openai-cli-gateway)(?::[^\s@]+|@sha256:[0-9a-f]{64})$/;

function fail(message) {
  throw new Error(`Deployment promotion contract failed: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactNamedEntry(entries, name, label) {
  if (!Array.isArray(entries)) {
    fail(`${label} must be a list.`);
  }
  const matches = entries.filter((entry) => isRecord(entry) && entry.name === name);
  if (matches.length !== 1) {
    fail(`${label} must contain exactly one ${name} entry.`);
  }
  return matches[0];
}

function exactMountAtPath(mounts, mountPath, label) {
  if (!Array.isArray(mounts)) {
    fail('gateway volumeMounts must be a list.');
  }
  const matches = mounts.filter((entry) => isRecord(entry) && entry.mountPath === mountPath);
  if (matches.length !== 1) {
    fail(`${label} must contain exactly one mount at ${mountPath}.`);
  }
  return matches[0];
}

function assertConfigMapVolume(volume, expectedName, label) {
  if (!isRecord(volume.configMap) || volume.configMap.name !== expectedName) {
    fail(`${label} must source ConfigMap ${expectedName}.`);
  }
  const unexpectedSources = Object.keys(volume).filter((key) => key !== 'name' && key !== 'configMap');
  if (unexpectedSources.length > 0) {
    fail(`${label} has unexpected volume source fields: ${unexpectedSources.join(', ')}.`);
  }
  const unexpectedConfigMapFields = Object.keys(volume.configMap)
    .filter((key) => !['name', 'defaultMode', 'optional'].includes(key));
  if (unexpectedConfigMapFields.length > 0) {
    fail(`${label} has unexpected ConfigMap source fields: ${unexpectedConfigMapFields.join(', ')}.`);
  }
  if (volume.configMap.defaultMode !== undefined && volume.configMap.defaultMode !== 420) {
    fail(`${label} ConfigMap defaultMode must retain the Kubernetes 0644 default.`);
  }
  if (volume.configMap.optional !== undefined && volume.configMap.optional !== false) {
    fail(`${label} ConfigMap source must not be optional.`);
  }
}

function assertMountShape(mount, expectedReadOnly, label) {
  const unexpectedFields = Object.keys(mount)
    .filter((key) => !['name', 'mountPath', 'subPath', 'readOnly'].includes(key));
  if (unexpectedFields.length > 0) {
    fail(`${label} has unexpected fields: ${unexpectedFields.join(', ')}.`);
  }
  if (expectedReadOnly) {
    if (mount.readOnly !== true) {
      fail(`${label} must retain readOnly: true.`);
    }
  } else if (mount.readOnly !== undefined && mount.readOnly !== false) {
    fail(`${label} must retain the absent/false readOnly default.`);
  }
}

function assertPromotionInitContainers(podSpec, phase, expectedImage) {
  if (!Array.isArray(podSpec.initContainers)) {
    fail('spec.template.spec.initContainers must be a list.');
  }
  if (podSpec.initContainers.length !== PROMOTION_DEPLOYMENT_CONTRACT.initContainers.length) {
    fail('initContainers must contain exactly the three release bootstrap containers.');
  }

  const initContainers = PROMOTION_DEPLOYMENT_CONTRACT.initContainers.map((name) => (
    exactNamedEntry(podSpec.initContainers, name, 'spec.template.spec.initContainers')
  ));
  for (const initContainer of initContainers) {
    if (typeof initContainer.image !== 'string' || !initContainer.image.trim()) {
      fail(`initContainer ${initContainer.name} image must be non-empty.`);
    }
    if (phase === 'after') {
      if (!expectedImage || initContainer.image !== expectedImage) {
        fail(`initContainer ${initContainer.name} image must equal the promoted digest.`);
      }
    } else if (!ROUTER_IMAGE_PATTERN.test(initContainer.image)) {
      fail(`initContainer ${initContainer.name} image is not an expected router image reference.`);
    }
  }
  if (phase === 'before' && new Set(initContainers.map((entry) => entry.image)).size !== 1) {
    fail('release bootstrap initContainers must use one identical pre-promotion image.');
  }
  return initContainers;
}

export function checkPromotionDeployment(deployment, options) {
  const {
    namespace,
    deploymentName,
    providerConfigMap,
    phase = 'before',
    expectedImage = '',
  } = options ?? {};
  if (!['before', 'after'].includes(phase)) {
    fail(`unsupported phase ${String(phase)}.`);
  }
  if (!isRecord(deployment)
    || deployment.apiVersion !== 'apps/v1'
    || deployment.kind !== 'Deployment') {
    fail('input is not an apps/v1 Deployment.');
  }
  if (deployment.metadata?.name !== deploymentName
    || deployment.metadata?.namespace !== namespace) {
    fail(`identity must be ${namespace}/${deploymentName}.`);
  }
  const resourceVersion = deployment.metadata?.resourceVersion;
  if (typeof resourceVersion !== 'string' || !resourceVersion.trim()) {
    fail('metadata.resourceVersion must be non-empty.');
  }

  const podSpec = deployment.spec?.template?.spec;
  if (!isRecord(podSpec)) {
    fail('spec.template.spec is missing.');
  }
  const gateway = exactNamedEntry(
    podSpec.containers,
    PROMOTION_DEPLOYMENT_CONTRACT.container,
    'spec.template.spec.containers',
  );
  if (typeof gateway.image !== 'string' || !gateway.image.trim()) {
    fail('gateway image must be non-empty.');
  }
  if (expectedImage && gateway.image !== expectedImage) {
    fail(`gateway image does not equal ${expectedImage}.`);
  }

  const initContainers = assertPromotionInitContainers(podSpec, phase, expectedImage);

  const otherContainers = [
    ...podSpec.containers.filter((entry) => entry !== gateway),
    ...initContainers,
  ];
  for (const otherContainer of otherContainers) {
    const otherMounts = Array.isArray(otherContainer?.volumeMounts) ? otherContainer.volumeMounts : [];
    if (otherMounts.some((entry) => [
      PROMOTION_DEPLOYMENT_CONTRACT.providerVolume,
      PROMOTION_DEPLOYMENT_CONTRACT.overlayVolume,
    ].includes(entry?.name))) {
      fail('provider or overlay volume is unexpectedly shared with another container.');
    }
  }

  const mounts = gateway.volumeMounts;
  const providerMount = exactMountAtPath(
    mounts,
    PROMOTION_DEPLOYMENT_CONTRACT.providerMountPath,
    'gateway provider mount',
  );
  if (providerMount.name !== PROMOTION_DEPLOYMENT_CONTRACT.providerVolume
    || providerMount.subPath !== PROMOTION_DEPLOYMENT_CONTRACT.providerSubPath) {
    fail('gateway provider mount name, path, or subPath differs from the release contract.');
  }
  assertMountShape(providerMount, false, 'gateway provider mount');
  if (mounts.filter((entry) => entry?.name === PROMOTION_DEPLOYMENT_CONTRACT.providerVolume).length !== 1) {
    fail('gateway provider volume name must be mounted exactly once.');
  }

  const providerVolume = exactNamedEntry(
    podSpec.volumes,
    PROMOTION_DEPLOYMENT_CONTRACT.providerVolume,
    'spec.template.spec.volumes',
  );
  assertConfigMapVolume(providerVolume, providerConfigMap, 'provider volume');

  const distMounts = mounts.filter((entry) => (
    typeof entry?.mountPath === 'string'
    && (entry.mountPath === '/app/dist' || entry.mountPath.startsWith('/app/dist/'))
  ));
  const overlayNamedMounts = mounts.filter(
    (entry) => entry?.name === PROMOTION_DEPLOYMENT_CONTRACT.overlayVolume,
  );
  const overlayVolumes = podSpec.volumes.filter(
    (entry) => entry?.name === PROMOTION_DEPLOYMENT_CONTRACT.overlayVolume,
  );

  if (phase === 'before') {
    const overlayMount = exactMountAtPath(
      mounts,
      PROMOTION_DEPLOYMENT_CONTRACT.overlayMountPath,
      'gateway overlay mount',
    );
    if (overlayMount.name !== PROMOTION_DEPLOYMENT_CONTRACT.overlayVolume
      || overlayMount.subPath !== PROMOTION_DEPLOYMENT_CONTRACT.overlaySubPath
      || overlayNamedMounts.length !== 1
      || distMounts.length !== 1) {
      fail('gateway overlay mount name, path, subPath, or uniqueness differs from the release contract.');
    }
    assertMountShape(
      overlayMount,
      PROMOTION_DEPLOYMENT_CONTRACT.overlayReadOnly,
      'gateway overlay mount',
    );
    const overlayVolume = exactNamedEntry(
      podSpec.volumes,
      PROMOTION_DEPLOYMENT_CONTRACT.overlayVolume,
      'spec.template.spec.volumes',
    );
    assertConfigMapVolume(
      overlayVolume,
      PROMOTION_DEPLOYMENT_CONTRACT.overlayVolume,
      'overlay volume',
    );
  } else if (overlayNamedMounts.length !== 0 || overlayVolumes.length !== 0 || distMounts.length !== 0) {
    fail('code-shadow overlay or another /app/dist mount remains after promotion.');
  }

  return {
    resourceVersion,
    image: gateway.image,
    providerConfigMap,
    overlayPresent: phase === 'before',
    initContainerImages: Object.fromEntries(
      initContainers.map((entry) => [entry.name, entry.image]),
    ),
  };
}

function usage() {
  return 'Usage: node scripts/check-remote-agent-promotion-deployment.mjs <deployment.json> <namespace> <deployment> <provider-configmap> <before|after> [expected-image]';
}

function main(args) {
  if (args.length < 5 || args.length > 6) {
    throw new Error(usage());
  }
  const [file, namespace, deploymentName, providerConfigMap, phase, expectedImage = ''] = args;
  const parsed = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  const result = checkPromotionDeployment(parsed, {
    namespace,
    deploymentName,
    providerConfigMap,
    phase,
    expectedImage,
  });
  process.stdout.write(`${result.resourceVersion}\t${result.image}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
