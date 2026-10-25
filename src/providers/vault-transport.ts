import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { OpenAiCompatibleProviderConfig } from '../types.js';

type BrokerConfig = NonNullable<OpenAiCompatibleProviderConfig['credentialBroker']>;
export type VaultRequestIdentity = { requestId: string; taskId: string; session: string };
const refused = () => Object.assign(Error('Vault provider request unavailable; do not automatically replay.'), { uncertain: true });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function requestVaultProvider(config: BrokerConfig, pathname: string, init: { method: string; body?: string }, timeoutMs: number, signal?: AbortSignal, identity?: VaultRequestIdentity): Promise<unknown> {
  let cert: Buffer | undefined, key: Buffer | undefined, ca: Buffer | undefined;
  try {
    const base = new URL(config.url);
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.providerId) || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(config.serverFingerprint) || ![config.certFile, config.keyFile, config.caFile].every(isAbsolute)) throw refused();
    if (!((pathname === '/models' && init.method === 'GET' && !init.body) || (pathname === '/chat/completions' && init.method === 'POST'))) throw refused();
    if (init.body && Buffer.byteLength(init.body) > 1024 * 1024) throw refused();
    signal?.throwIfAborted();
    [cert, key, ca] = await Promise.all([readFile(config.certFile), readFile(config.keyFile), readFile(config.caFile)]);
    signal?.throwIfAborted();
    const binding = identity ?? { session: 'gateway-admin', taskId: randomUUID(), requestId: randomUUID() };
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      const req = https.request(new URL('/v1/providers/' + config.providerId + pathname, base), {
        method: init.method, cert, key, ca, agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.3', signal,
        checkServerIdentity: (host, certificate) => checkServerIdentity(host, certificate) || (certificate.fingerprint256 !== config.serverFingerprint ? refused() : undefined),
        headers: { 'content-type': 'application/json', 'x-brain-session': digest(binding.session), 'x-brain-task-id': digest(binding.taskId), 'x-brain-request-id': digest(binding.requestId) },
      }, res => {
        if (res.statusCode !== 200 || !res.headers['content-type']?.includes('application/json')) { res.destroy(); req.destroy(refused()); reject(refused()); return; }
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) { chunk.fill(0); res.destroy(); req.destroy(refused()); reject(refused()); } else chunks.push(chunk); });
        res.on('error', () => reject(refused()));
        res.on('end', () => {
          let bytes: Buffer | undefined;
          try { bytes = Buffer.concat(chunks); resolve(JSON.parse(bytes.toString('utf8'))); }
          catch { reject(refused()); }
          finally { bytes?.fill(0); chunks.forEach(chunk => chunk.fill(0)); }
        });
      });
      const timer = setTimeout(() => req.destroy(refused()), Math.min(120000, Math.max(1, timeoutMs)));
      req.on('error', () => { chunks.forEach(chunk => chunk.fill(0)); reject(refused()); });
      req.on('close', () => clearTimeout(timer));
      req.end(init.body);
    });
  } catch { throw refused(); }
  finally { cert?.fill(0); key?.fill(0); ca?.fill(0); }
}
