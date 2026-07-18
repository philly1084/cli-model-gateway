import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseAllDocuments, stringify } from 'yaml';
import { checkKimiK3ProviderConfig } from './check-kimi-k3-provider-config.mjs';

function validConfig() {
  return {
    providers: [
      {
        id: 'kimi-code-cli',
        type: 'cli',
        models: [
          { id: 'k3', providerModel: 'k3' },
          { id: 'kimi-for-coding', providerModel: 'kimi-for-coding' },
        ],
        responseCommand: {
          executable: 'node',
          args: ['dist/scripts/kimi-acp-bridge.js', '--model', '{{provider_model}}'],
        },
        sessionCommand: {
          executable: 'node',
          args: ['dist/scripts/remote-agent-session-bridge.js', '--provider', 'kimi'],
          supportsModelSelection: true,
          modelFlag: '--model',
        },
      },
    ],
  };
}

function expectRejected(mutator, pattern) {
  const config = validConfig();
  mutator(config);
  assert.throws(
    () => checkKimiK3ProviderConfig(stringify(config), { sourceName: 'test providers.yaml' }),
    pattern,
  );
}

test('accepts only the exact Kimi K3 CLI session bridge contract', () => {
  assert.deepEqual(checkKimiK3ProviderConfig(stringify(validConfig())), {
    providerId: 'kimi-code-cli',
    modelId: 'k3',
    providerModel: 'k3',
    sessionExecutable: 'node',
    sessionArgs: ['dist/scripts/remote-agent-session-bridge.js', '--provider', 'kimi'],
    modelFlag: '--model',
  });
});

test('rejects malformed or missing provider inventory', () => {
  assert.throws(() => checkKimiK3ProviderConfig('providers: ['), /invalid YAML/);
  assert.throws(() => checkKimiK3ProviderConfig('remoteCliTargets: []\n'), /providers must be an array/);
  expectRejected((config) => { config.providers = []; }, /exactly one kimi-code-cli provider; found 0/);
  expectRejected((config) => { config.providers.push(structuredClone(config.providers[0])); }, /found 2/);
  expectRejected((config) => { config.providers[0].type = 'openai'; }, /must be a CLI provider/);
});

test('rejects missing, duplicate, aliased, or fallback-enabled K3 models', () => {
  expectRejected(
    (config) => { config.providers[0].models = config.providers[0].models.slice(1); },
    /model with id k3; found 0/,
  );
  expectRejected(
    (config) => { config.providers[0].models.push({ id: 'k3', providerModel: 'k3' }); },
    /model with id k3; found 2/,
  );
  expectRejected(
    (config) => { config.providers[0].models[0].providerModel = 'kimi-for-coding'; },
    /must set providerModel: k3/,
  );
  expectRejected(
    (config) => { config.providers[0].models[0].fallbackModels = []; },
    /must not declare fallbackModels/,
  );
  expectRejected(
    (config) => { config.providers[0].models[0].fallbackModels = ['kimi-for-coding']; },
    /must not declare fallbackModels/,
  );
});

test('rejects any session command that does not bind the Kimi bridge and --model', () => {
  expectRejected(
    (config) => { delete config.providers[0].sessionCommand; },
    /must define sessionCommand/,
  );
  expectRejected(
    (config) => { config.providers[0].sessionCommand.executable = 'kimi'; },
    /bounded Kimi remote-agent session bridge/,
  );
  expectRejected(
    (config) => { config.providers[0].sessionCommand.args[2] = 'grok'; },
    /bounded Kimi remote-agent session bridge/,
  );
  expectRejected(
    (config) => { config.providers[0].sessionCommand.args.push('--unexpected'); },
    /bounded Kimi remote-agent session bridge/,
  );
  expectRejected(
    (config) => { config.providers[0].sessionCommand.supportsModelSelection = false; },
    /supportsModelSelection must be true/,
  );
  expectRejected(
    (config) => { delete config.providers[0].sessionCommand.supportsModelSelection; },
    /supportsModelSelection must be true/,
  );
  expectRejected(
    (config) => { config.providers[0].sessionCommand.modelFlag = '-m'; },
    /modelFlag must be --model/,
  );
  expectRejected(
    (config) => { delete config.providers[0].sessionCommand.modelFlag; },
    /modelFlag must be --model/,
  );
});

test('checked-in provider examples satisfy the exact release gate', async () => {
  const example = await readFile(path.resolve('config/providers.example.yaml'), 'utf8');
  assert.equal(checkKimiK3ProviderConfig(example).providerModel, 'k3');

  const rancherSource = await readFile(path.resolve('kubernetes/rancher-install.yaml'), 'utf8');
  const configMap = parseAllDocuments(rancherSource)
    .map((document) => document.toJS())
    .find((document) => document?.kind === 'ConfigMap'
      && document?.metadata?.name === 'n8n-openai-cli-gateway-config');
  assert.equal(typeof configMap?.data?.['providers.yaml'], 'string');
  assert.equal(checkKimiK3ProviderConfig(configMap.data['providers.yaml']).providerModel, 'k3');
});
