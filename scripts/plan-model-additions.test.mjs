import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { planModelAdditions } from './plan-model-additions.mjs';
const source = '# preserve operator settings\nproviders:\n  - id: existing\n    type: cli\n    responseCommand:\n      executable: custom-cli\n      env:\n        API_KEY: synthetic-private\n    models:\n      - id: working\n        providerModel: actual\n        manualOnly: true\n        fallbackModels: [backup]\nremoteCliTargets: [{id: primary, host: unchanged}]\n';
const addition = { providerId: 'existing', id: 'new-model', providerModel: 'upstream-new', description: 'Catalog-listed candidate, execution unverified' };
const plan = { baselineSha256: createHash('sha256').update(source).digest('hex'), additions: [addition] };
test('only appends opt-in candidates and preserves operator policy, credentials and comments', () => {
  const result = planModelAdditions(source, plan); const original = YAML.parse(source), proposed = YAML.parse(result.yaml);
  assert.deepEqual(proposed.providers[0].models[0], original.providers[0].models[0]);
  assert.equal(proposed.providers[0].models[1].autoEligible, false);
  assert.deepEqual(proposed.providers[0].responseCommand, original.providers[0].responseCommand);
  assert.deepEqual(proposed.remoteCliTargets, original.remoteCliTargets);
  assert.ok(result.yaml.startsWith('# preserve operator settings'));
  assert.equal(JSON.stringify(result.summary).includes('synthetic-private'), false);
});
test('rejects drift, replacement, duplicate additions and unknown providers', () => {
  assert.throws(() => planModelAdditions(source + '\n', plan));
  for (const additions of [[{ ...addition, id: 'working' }], [addition, addition], [{ ...addition, providerId: 'missing' }], [{ ...addition, autoEligible: true }]]) {
    assert.throws(() => planModelAdditions(source, { ...plan, additions }));
  }
});
