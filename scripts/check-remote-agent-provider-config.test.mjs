import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { checkRemoteAgentProviderConfig } from './check-remote-agent-provider-config.mjs';

function fixture() {
  return {
    providers: [
      {
        id: 'codex-cli',
        type: 'cli',
        models: [{ id: 'gpt-5.6-sol', providerModel: 'gpt-5.6-sol' }],
        responseCommand: { executable: 'node', args: [] },
        sessionCommand: {
          executable: 'node',
          args: [
            'dist/scripts/remote-agent-session-bridge.js',
            '--provider',
            'codex',
            '--session',
            '{{session_id}}',
          ],
          supportsModelSelection: true,
          modelFlag: '--model',
          supportsWorkingDirectory: true,
          closeInputAfterWrite: true,
          idleTimeoutMs: 1_800_000,
          maxLifetimeMs: 14_400_000,
          ptyMode: 'pipe',
        },
      },
      {
        id: 'kimi-code-cli',
        type: 'cli',
        models: [{ id: 'k3', providerModel: 'k3' }],
        responseCommand: { executable: 'node', args: [] },
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

test('accepts the exact Codex host-side and Kimi K3 provider contract', () => {
  const result = checkRemoteAgentProviderConfig(stringify(fixture()));
  assert.equal(result.codex.providerId, 'codex-cli');
  assert.equal(result.kimi.modelId, 'k3');
});

test('rejects a Codex session that bypasses the bounded host-side bridge', () => {
  const value = fixture();
  value.providers[0].sessionCommand.executable = 'codex';
  assert.throws(
    () => checkRemoteAgentProviderConfig(stringify(value)),
    /sessionCommand.executable does not match the release contract/,
  );
});
