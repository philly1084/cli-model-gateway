import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkRemoteTargetConfig } from './check-remote-target-config.mjs';

const manifest = await readFile(new URL('../kubernetes/rancher-install.yaml', import.meta.url), 'utf8');

test('pins primary, secondary, and legacy aliases to stable hosts', () => {
  const result = checkRemoteTargetConfig(manifest);
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
    () => checkRemoteTargetConfig(drifted),
    /k3s-secondary must remain pinned to 203\.0\.113\.20/,
  );
});
