import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProviderTaskModel,
  createPlan,
  loadConfig,
  parseArgs,
} from './canary-remote-agent-handoff.mjs';

const ENV_KEYS = [
  'CANARY_KIMI_MODEL',
  'CANARY_KIMI_PROVIDER_ID',
  'GATEWAY_API_KEY',
  'GATEWAY_BEARER_TOKEN',
  'GATEWAY_BASE_URL',
];

function withCleanEnv(callback) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('Kimi dry-run defaults to an explicit k3 task model', () => withCleanEnv(() => {
  const options = parseArgs(['--dry-run', '--mode', 'kimi']);
  const config = loadConfig({ dryRun: true, modes: options.modes });
  const plan = createPlan('kimi', config);
  assert.equal(config.kimiModel, 'k3');
  assert.equal(plan.providerId, 'kimi-code-cli');
  assert.equal(plan.body.model, 'k3');
}));

test('Kimi canary refuses every requested model except exact k3', () => withCleanEnv(() => {
  process.env.CANARY_KIMI_MODEL = 'kimi-for-coding';
  assert.throws(
    () => loadConfig({ dryRun: true, modes: ['kimi'] }),
    /CANARY_KIMI_MODEL must be exactly k3/,
  );
}));

test('Kimi canary refuses every provider except the release-gated kimi-code-cli provider', () => withCleanEnv(() => {
  process.env.CANARY_KIMI_PROVIDER_ID = 'not-the-release-gated-provider';
  assert.throws(
    () => loadConfig({ dryRun: true, modes: ['kimi'] }),
    /CANARY_KIMI_PROVIDER_ID must be exactly kimi-code-cli/,
  );
}));

test('Kimi canary accepts a returned provider task only when task.model is k3', () => withCleanEnv(() => {
  const config = loadConfig({ dryRun: true, modes: ['kimi'] });
  const plan = createPlan('kimi', config);
  assert.doesNotThrow(() => assertProviderTaskModel({ model: 'k3' }, plan));
  assert.throws(
    () => assertProviderTaskModel({ model: 'kimi-for-coding' }, plan),
    /did not attest task.model as k3/,
  );
  assert.throws(
    () => assertProviderTaskModel({}, plan),
    /did not attest task.model as k3/,
  );
}));

test('non-Kimi lanes do not claim a Kimi model attestation', () => {
  assert.doesNotThrow(() => assertProviderTaskModel({}, { mode: 'grok', body: {} }));
});
