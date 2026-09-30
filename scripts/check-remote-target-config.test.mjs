import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkRemoteTargetConfig } from './check-remote-target-config.mjs';

const manifest = await readFile(new URL('../kubernetes/rancher-install.yaml', import.meta.url), 'utf8');

test('pins primary, secondary, and legacy aliases to stable hosts', () => {
  const result = checkRemoteTargetConfig(manifest, { env: {} });
  assert.equal(result.targets['k3s-primary'], '203.0.113.10');
  assert.equal(result.targets['k3s-secondary'], '203.0.113.20');
  assert.equal(result.targets['k3s-prod'], '203.0.113.10');
  assert.equal(result.targets.prod, '203.0.113.10');
});

test('rejects moving the secondary target onto the primary host', () => {
  const drifted = manifest.replace(
    /(- targetId: k3s-secondary[\s\S]*?\n\s+host: )203\.0\.113\.20/,
    '$1203.0.113.10',
  );
  assert.throws(
    () => checkRemoteTargetConfig(drifted, { env: {} }),
    /k3s-secondary must remain pinned to 203\.0\.113\.20/,
  );
});

test('uses explicit environment pins for all target ids including legacy aliases', () => {
  const env = {
    REMOTE_TARGET_HOST_K3S_PRIMARY: '192.0.2.10',
    REMOTE_TARGET_HOST_K3S_SECONDARY: '192.0.2.20',
    REMOTE_TARGET_HOST_K3S_PROD: '192.0.2.10',
    REMOTE_TARGET_HOST_PROD: '192.0.2.10',
  };
  assert.deepEqual(checkRemoteTargetConfig(manifest, { env }).targets, {
    'k3s-primary': '192.0.2.10', 'k3s-secondary': '192.0.2.20',
    'k3s-prod': '192.0.2.10', prod: '192.0.2.10',
  });
  assert.throws(() => checkRemoteTargetConfig(manifest, {
    env: { ...env, REMOTE_TARGET_HOST_K3S_SECONDARY: '192.0.2.10' },
  }), /different hosts/);
});

test('rejects invalid overrides and does not allow env to create missing inventory entries', () => {
  for (const value of ['', ' ', '-oBad', 'user@host', 'host:22', 'host name']) {
    assert.throws(() => checkRemoteTargetConfig(manifest, {
      env: { REMOTE_TARGET_HOST_PROD: value },
    }), /Invalid REMOTE_TARGET_HOST_PROD/);
  }
  assert.throws(() => checkRemoteTargetConfig(manifest.replace('targetId: prod', 'targetId: other'), {
    env: { REMOTE_TARGET_HOST_PROD: '192.0.2.10' },
  }), /found missing/);
});

test('every gateway deployment loads the optional target secret', async () => {
  const { parseAllDocuments } = await import('yaml');
  for (const file of ['deployment.yaml', 'rancher-install.yaml', 'groq-rancher-overlay.yaml']) {
    const source = await readFile(new URL(`../kubernetes/${file}`, import.meta.url), 'utf8');
    const deployment = parseAllDocuments(source).map(doc => doc.toJS()).find(doc => doc.kind === 'Deployment');
    const gateway = deployment.spec.template.spec.containers.find(container => container.name === 'gateway');
    assert.ok(gateway.envFrom.some(entry => entry.secretRef?.name === 'cli-model-gateway-targets' && entry.secretRef.optional === true));
  }
});
