import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MANAGED_BY = 'router-handoff-promotion';
const IMAGE_PATTERN = /^ghcr\.io\/philly1084\/cli-model-gateway@sha256:([0-9a-f]{64})$/;

function fail(message) {
  throw new Error(`Promotion ConfigMap snapshot contract failed: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function buildPromotionConfigSnapshot({
  providersSource,
  image,
  namespace,
  sourceConfigMap,
}) {
  if (typeof providersSource !== 'string' || providersSource.length === 0) {
    fail('providers.yaml must be non-empty.');
  }
  const imageMatch = typeof image === 'string' ? image.match(IMAGE_PATTERN) : null;
  if (!imageMatch) {
    fail('image must be the expected digest-pinned GHCR reference.');
  }
  if (!namespace || !sourceConfigMap) {
    fail('namespace and source ConfigMap are required.');
  }
  const providersHash = sha256(providersSource);
  const imageDigest = imageMatch[1];
  const name = `router-handoff-${providersHash.slice(0, 16)}-${imageDigest.slice(0, 16)}`;
  return {
    name,
    providersHash,
    imageDigest,
    manifest: {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': MANAGED_BY,
        },
        annotations: {
          'kimibuilt.dev/source-configmap': sourceConfigMap,
          'kimibuilt.dev/providers-sha256': providersHash,
          'kimibuilt.dev/image-digest': `sha256:${imageDigest}`,
        },
      },
      immutable: true,
      data: {
        'providers.yaml': providersSource,
      },
    },
  };
}

export function checkPromotionConfigSnapshot(snapshot, expected) {
  const built = buildPromotionConfigSnapshot(expected);
  if (!isRecord(snapshot)
    || snapshot.apiVersion !== 'v1'
    || snapshot.kind !== 'ConfigMap'
    || snapshot.metadata?.name !== built.name
    || snapshot.metadata?.namespace !== expected.namespace) {
    fail(`snapshot identity must be ${expected.namespace}/${built.name}.`);
  }
  if (snapshot.immutable !== true) {
    fail('snapshot must be immutable.');
  }
  if (snapshot.metadata?.deletionTimestamp) {
    fail('snapshot must not be terminating.');
  }
  if (snapshot.metadata?.ownerReferences !== undefined
    && (!Array.isArray(snapshot.metadata.ownerReferences)
      || snapshot.metadata.ownerReferences.length > 0)) {
    fail('snapshot must not have owner references that can garbage-collect it.');
  }
  if (snapshot.metadata?.labels?.['app.kubernetes.io/managed-by'] !== MANAGED_BY
    || snapshot.metadata?.annotations?.['kimibuilt.dev/source-configmap'] !== expected.sourceConfigMap
    || snapshot.metadata?.annotations?.['kimibuilt.dev/providers-sha256'] !== built.providersHash
    || snapshot.metadata?.annotations?.['kimibuilt.dev/image-digest'] !== `sha256:${built.imageDigest}`) {
    fail('snapshot provenance labels or annotations differ from the expected values.');
  }
  if (!isRecord(snapshot.data)
    || Object.keys(snapshot.data).length !== 1
    || snapshot.data['providers.yaml'] !== expected.providersSource
    || (isRecord(snapshot.binaryData) && Object.keys(snapshot.binaryData).length > 0)) {
    fail('snapshot data is not the exact providers.yaml source.');
  }
  return {
    name: built.name,
    providersHash: built.providersHash,
    imageDigest: built.imageDigest,
  };
}

export function checkCurrentPromotionConfigSnapshot(snapshot, {
  image,
  namespace,
  sourceConfigMap,
}) {
  const providersSource = snapshot?.data?.['providers.yaml'];
  if (typeof providersSource !== 'string' || providersSource.length === 0) {
    fail('current snapshot must contain non-empty providers.yaml data.');
  }
  return checkPromotionConfigSnapshot(snapshot, {
    providersSource,
    image,
    namespace,
    sourceConfigMap,
  });
}

function usage() {
  return [
    'Usage:',
    '  node scripts/remote-agent-promotion-config-snapshot.mjs build <providers.yaml> <image> <namespace> <source-configmap> <manifest.json>',
    '  node scripts/remote-agent-promotion-config-snapshot.mjs verify <snapshot.json> <providers.yaml> <image> <namespace> <source-configmap>',
    '  node scripts/remote-agent-promotion-config-snapshot.mjs verify-current <snapshot.json> <image> <namespace> <source-configmap>',
  ].join('\n');
}

function readExpected(providersFile, image, namespace, sourceConfigMap) {
  return {
    providersSource: readFileSync(path.resolve(providersFile), 'utf8'),
    image,
    namespace,
    sourceConfigMap,
  };
}

function main(args) {
  const [command, firstFile, providersOrImage, imageOrNamespace, namespaceOrSource, sourceOrOutput, outputFile] = args;
  if (command === 'build' && args.length === 6) {
    const expected = readExpected(firstFile, providersOrImage, imageOrNamespace, namespaceOrSource);
    const built = buildPromotionConfigSnapshot(expected);
    writeFileSync(path.resolve(sourceOrOutput), `${JSON.stringify(built.manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    process.stdout.write(`${built.name}\n`);
    return;
  }
  if (command === 'verify' && args.length === 6) {
    const expected = readExpected(providersOrImage, imageOrNamespace, namespaceOrSource, sourceOrOutput);
    const snapshot = JSON.parse(readFileSync(path.resolve(firstFile), 'utf8'));
    process.stdout.write(`${checkPromotionConfigSnapshot(snapshot, expected).name}\n`);
    return;
  }
  if (command === 'verify-current' && args.length === 5) {
    const snapshot = JSON.parse(readFileSync(path.resolve(firstFile), 'utf8'));
    process.stdout.write(`${checkCurrentPromotionConfigSnapshot(snapshot, {
      image: providersOrImage,
      namespace: imageOrNamespace,
      sourceConfigMap: namespaceOrSource,
    }).name}\n`);
    return;
  }
  void outputFile;
  throw new Error(usage());
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
