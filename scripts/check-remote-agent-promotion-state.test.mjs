import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkPromotionDeployment,
  PROMOTION_DEPLOYMENT_CONTRACT,
} from './check-remote-agent-promotion-deployment.mjs';
import {
  buildPromotionConfigSnapshot,
  checkPromotionConfigSnapshot,
} from './remote-agent-promotion-config-snapshot.mjs';

const namespace = 'n8n-openai-gateway';
const deploymentName = 'n8n-openai-cli-gateway';
const sourceConfigMap = 'n8n-openai-cli-gateway-config';
const image = `ghcr.io/philly1084/cli-model-gateway@sha256:${'a'.repeat(64)}`;
const providersSource = 'providers:\n  - id: kimi-code-cli\n';

function deploymentFixture({ phase = 'before', providerConfigMap = sourceConfigMap } = {}) {
  const overlayMount = {
    name: PROMOTION_DEPLOYMENT_CONTRACT.overlayVolume,
    mountPath: PROMOTION_DEPLOYMENT_CONTRACT.overlayMountPath,
    subPath: PROMOTION_DEPLOYMENT_CONTRACT.overlaySubPath,
    readOnly: true,
  };
  const overlayVolume = {
    name: PROMOTION_DEPLOYMENT_CONTRACT.overlayVolume,
    configMap: { name: PROMOTION_DEPLOYMENT_CONTRACT.overlayVolume },
  };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: deploymentName, namespace, resourceVersion: '100' },
    spec: {
      template: {
        spec: {
          initContainers: PROMOTION_DEPLOYMENT_CONTRACT.initContainers.map((name) => ({
            name,
            image,
          })),
          containers: [{
            name: PROMOTION_DEPLOYMENT_CONTRACT.container,
            image,
            volumeMounts: [
              {
                name: PROMOTION_DEPLOYMENT_CONTRACT.providerVolume,
                mountPath: PROMOTION_DEPLOYMENT_CONTRACT.providerMountPath,
                subPath: PROMOTION_DEPLOYMENT_CONTRACT.providerSubPath,
              },
              ...(phase === 'before' ? [overlayMount] : []),
            ],
          }],
          volumes: [
            {
              name: PROMOTION_DEPLOYMENT_CONTRACT.providerVolume,
              configMap: { name: providerConfigMap },
            },
            ...(phase === 'before' ? [overlayVolume] : []),
          ],
        },
      },
    },
  };
}

test('pre-promotion Deployment checker requires the exact provider and overlay ConfigMap mounts', () => {
  const value = deploymentFixture();
  value.spec.template.spec.volumes[0].configMap.defaultMode = 420;
  value.spec.template.spec.volumes[1].configMap.optional = false;
  const result = checkPromotionDeployment(value, {
    namespace,
    deploymentName,
    providerConfigMap: sourceConfigMap,
    phase: 'before',
  });
  assert.deepEqual(result, {
    resourceVersion: '100',
    image,
    providerConfigMap: sourceConfigMap,
    overlayPresent: true,
    initContainerImages: Object.fromEntries(
      PROMOTION_DEPLOYMENT_CONTRACT.initContainers.map((name) => [name, image]),
    ),
  });
});

test('promotion Deployment checker requires the exact bootstrap init-container set and image convergence', () => {
  for (const mutate of [
    (value) => { value.spec.template.spec.initContainers.pop(); },
    (value) => {
      value.spec.template.spec.initContainers.push({
        name: 'unexpected-bootstrap',
        image,
      });
    },
    (value) => { value.spec.template.spec.initContainers[0].name = 'unexpected-bootstrap'; },
    (value) => { value.spec.template.spec.initContainers[0].image = 'example.invalid/router:latest'; },
    (value) => {
      value.spec.template.spec.initContainers[0].image =
        'ghcr.io/philly1084/n8n-openai-cli-gateway:other';
    },
  ]) {
    const value = deploymentFixture();
    mutate(value);
    assert.throws(
      () => checkPromotionDeployment(value, {
        namespace,
        deploymentName,
        providerConfigMap: sourceConfigMap,
        phase: 'before',
      }),
      /Deployment promotion contract failed/,
    );
  }

  const divergentAfter = deploymentFixture({
    phase: 'after',
    providerConfigMap: buildPromotionConfigSnapshot({
      providersSource,
      image,
      namespace,
      sourceConfigMap,
    }).name,
  });
  divergentAfter.spec.template.spec.initContainers[0].image =
    `ghcr.io/philly1084/cli-model-gateway@sha256:${'b'.repeat(64)}`;
  assert.throws(
    () => checkPromotionDeployment(divergentAfter, {
      namespace,
      deploymentName,
      providerConfigMap: divergentAfter.spec.template.spec.volumes[0].configMap.name,
      phase: 'after',
      expectedImage: image,
    }),
    /image must equal the promoted digest/,
  );
});

test('pre-promotion Deployment checker rejects semantically different ConfigMap source options', () => {
  for (const mutate of [
    (value) => { value.spec.template.spec.volumes[0].configMap.defaultMode = 384; },
    (value) => { value.spec.template.spec.volumes[0].configMap.optional = true; },
    (value) => { value.spec.template.spec.volumes[0].configMap.items = []; },
  ]) {
    const value = deploymentFixture();
    mutate(value);
    assert.throws(
      () => checkPromotionDeployment(value, {
        namespace,
        deploymentName,
        providerConfigMap: sourceConfigMap,
        phase: 'before',
      }),
      /Deployment promotion contract failed/,
    );
  }
});

test('pre-promotion Deployment checker rejects overlay source, path, name, and subPath drift', () => {
  for (const mutate of [
    (value) => { value.spec.template.spec.volumes[1].configMap.name = 'other-overlay'; },
    (value) => { value.spec.template.spec.containers[0].volumeMounts[1].mountPath = '/app/dist/other.js'; },
    (value) => { value.spec.template.spec.containers[0].volumeMounts[1].name = 'other-overlay'; },
    (value) => { value.spec.template.spec.containers[0].volumeMounts[1].subPath = 'other.js'; },
    (value) => { value.spec.template.spec.containers[0].volumeMounts[1].readOnly = false; },
  ]) {
    const value = deploymentFixture();
    mutate(value);
    assert.throws(
      () => checkPromotionDeployment(value, {
        namespace,
        deploymentName,
        providerConfigMap: sourceConfigMap,
        phase: 'before',
      }),
      /Deployment promotion contract failed/,
    );
  }
});

test('pre-promotion Deployment checker rejects an additional code-shadow mount', () => {
  const value = deploymentFixture();
  value.spec.template.spec.containers[0].volumeMounts.push({
    name: 'unexpected-code-shadow',
    mountPath: '/app/dist/another.js',
    subPath: 'another.js',
  });
  assert.throws(
    () => checkPromotionDeployment(value, {
      namespace,
      deploymentName,
      providerConfigMap: sourceConfigMap,
      phase: 'before',
    }),
    /overlay mount name, path, subPath, or uniqueness/,
  );
});

test('pre-promotion Deployment checker rejects provider or overlay volumes shared with another container', () => {
  for (const volumeName of [
    PROMOTION_DEPLOYMENT_CONTRACT.providerVolume,
    PROMOTION_DEPLOYMENT_CONTRACT.overlayVolume,
  ]) {
    const value = deploymentFixture();
    value.spec.template.spec.containers.push({
      name: 'unexpected-consumer',
      image: 'example.invalid/consumer@sha256:deadbeef',
      volumeMounts: [{ name: volumeName, mountPath: '/unexpected' }],
    });
    assert.throws(
      () => checkPromotionDeployment(value, {
        namespace,
        deploymentName,
        providerConfigMap: sourceConfigMap,
        phase: 'before',
      }),
      /unexpectedly shared with another container/,
    );
  }
});

test('post-promotion Deployment checker requires the digest image, immutable provider snapshot, and no overlay', () => {
  const snapshot = buildPromotionConfigSnapshot({ providersSource, image, namespace, sourceConfigMap });
  const result = checkPromotionDeployment(deploymentFixture({
    phase: 'after',
    providerConfigMap: snapshot.name,
  }), {
    namespace,
    deploymentName,
    providerConfigMap: snapshot.name,
    phase: 'after',
    expectedImage: image,
  });
  assert.equal(result.overlayPresent, false);
  assert.equal(result.providerConfigMap, snapshot.name);
});

test('content-addressed provider snapshot is immutable and verifies exact bytes and provenance', () => {
  const expected = { providersSource, image, namespace, sourceConfigMap };
  const built = buildPromotionConfigSnapshot(expected);
  assert.match(built.name, /^router-handoff-[0-9a-f]{16}-[0-9a-f]{16}$/);
  assert.equal(built.manifest.immutable, true);
  assert.equal(built.manifest.data['providers.yaml'], providersSource);
  assert.equal(checkPromotionConfigSnapshot(built.manifest, expected).name, built.name);

  const tampered = structuredClone(built.manifest);
  tampered.data['providers.yaml'] += '# drift\n';
  assert.throws(
    () => checkPromotionConfigSnapshot(tampered, expected),
    /snapshot data is not the exact providers.yaml source/,
  );

  for (const mutate of [
    (value) => { value.metadata.deletionTimestamp = '2026-07-18T12:00:00Z'; },
    (value) => {
      value.metadata.ownerReferences = [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        name: 'ephemeral-owner',
        uid: '00000000-0000-0000-0000-000000000000',
      }];
    },
  ]) {
    const unsafe = structuredClone(built.manifest);
    mutate(unsafe);
    assert.throws(
      () => checkPromotionConfigSnapshot(unsafe, expected),
      /snapshot must not/,
    );
  }
});
