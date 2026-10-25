import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ephemeralTLS } from './fixtures/vault-tls.mjs';
import { requestVaultProvider } from '../dist/providers/vault-transport.js';
import { OpenAiCompatibleProvider } from '../dist/providers/openai-compatible-provider.js';
import { loadProvidersFile } from '../dist/config.js';

async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'vault-gateway-')), material = ephemeralTLS();
  const server = https.createServer({ ...material.tls, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, handler);
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const config = { url: 'https://localhost:' + server.address().port, providerId: 'fixture', certFile: join(dir, 'client.pem'), keyFile: join(dir, 'client-key.pem'), caFile: join(dir, 'ca.pem'), serverFingerprint: material.broker.serverFingerprint };
  await Promise.all([writeFile(config.certFile, material.broker.tls.cert), writeFile(config.keyFile, material.broker.tls.key), writeFile(config.caFile, material.broker.tls.ca)]);
  return { dir, config };
}
const payload = { model: 'synthetic-model', messages: [{ role: 'user', content: 'Synthetic hello' }] };
const identity = { requestId: 'fixed-request', taskId: 'fixed-task', session: 'fixed-session' };
const init = { method: 'POST', body: JSON.stringify(payload) };

test('mTLS transport sends no provider key and binds stable opaque request IDs', async t => {
  const seen = [];
  const f = await fixture(t, (req, res) => {
    seen.push(req.headers); assert.equal(req.socket.authorized, true); assert.equal(req.url, '/v1/providers/fixture/chat/completions');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'Verified synthetic answer' } }] }));
  });
  const provider = await OpenAiCompatibleProvider.create({ id: 'vault-fixture', type: 'openai', baseUrl: 'https://provider.example/v1', credentialBroker: f.config, models: [{ id: 'synthetic-model' }], discovery: { enabled: false } });
  assert.equal(provider.supportsStreaming(), false);
  const request = { requestId: identity.requestId, model: 'synthetic-model', providerModel: 'synthetic-model', messages: payload.messages, tools: [] };
  assert.equal((await provider.run(request)).outputText, 'Verified synthetic answer');
  await provider.run(request);
  assert.equal(seen[0].authorization, undefined); assert.equal(seen[0]['x-api-key'], undefined);
  assert.equal(seen[0]['x-brain-request-id'], seen[1]['x-brain-request-id']);
  assert.notEqual(seen[0]['x-brain-request-id'], identity.requestId);
});

test('pin mismatch, redirect and duplicate responses fail closed without replay', async t => {
  let calls = 0, status = 302;
  const f = await fixture(t, (_req, res) => { calls++; res.writeHead(status, { 'content-type': 'application/json', location: 'https://evil.invalid/' }); res.end('{"error":"synthetic-sensitive-error"}'); });
  const rejects = promise => assert.rejects(promise, error => error.uncertain === true && !error.message.includes('sensitive'));
  await rejects(requestVaultProvider({ ...f.config, serverFingerprint: '00:'.repeat(31) + '00' }, '/chat/completions', init, 1000, undefined, identity));
  assert.equal(calls, 0);
  await rejects(requestVaultProvider(f.config, '/chat/completions', init, 1000, undefined, identity)); assert.equal(calls, 1);
  status = 409; await rejects(requestVaultProvider(f.config, '/chat/completions', init, 1000, undefined, identity)); assert.equal(calls, 2);
});

test('abort interrupts an accepted request; pre-abort never reaches the broker', async t => {
  let calls = 0, entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, () => { calls++; entered(); });
  const controller = new AbortController();
  const result = requestVaultProvider(f.config, '/chat/completions', init, 10000, controller.signal, identity);
  await started; controller.abort(); await assert.rejects(result, error => error.uncertain === true); assert.equal(calls, 1);
  await assert.rejects(requestVaultProvider(f.config, '/chat/completions', init, 10000, controller.signal, identity)); assert.equal(calls, 1);
});

test('provider schema requires exactly one credential source and absolute TLS paths', async t => {
  const f = await fixture(t, () => {}), path = join(f.dir, 'providers.json');
  const provider = { id: 'vault', type: 'openai', baseUrl: 'https://provider.example/v1', credentialBroker: f.config, models: [{ id: 'synthetic-model' }] };
  await writeFile(path, JSON.stringify({ providers: [provider] })); assert.ok(loadProvidersFile(path).providers[0].credentialBroker);
  for (const invalid of [{ ...provider, apiKeyEnv: 'SHOULD_NOT_BE_USED' }, { ...provider, credentialBroker: undefined }, { ...provider, credentialBroker: { ...f.config, keyFile: 'relative' } }]) {
    await writeFile(path, JSON.stringify({ providers: [invalid] })); assert.throws(() => loadProvidersFile(path));
  }
});
