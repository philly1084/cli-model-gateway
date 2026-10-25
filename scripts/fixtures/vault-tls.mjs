import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

// Minimal self-signed X.509, generated entirely in memory; no openssl/temp keys.
const der = (tag, ...parts) => {
  const b = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  const n = b.length < 128 ? [b.length] : b.length < 256 ? [0x81, b.length] : [0x82, b.length >> 8, b.length & 255];
  return Buffer.concat([Buffer.from([tag, ...n]), b]);
};
const seq = (...v) => der(0x30, ...v), oid = hex => der(6, Buffer.from(hex, 'hex'));
const algorithm = seq(oid('2a8648ce3d040302'));
const pem = b => `-----BEGIN CERTIFICATE-----\n${b.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
function certificate(name) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const subject = seq(der(0x31, seq(oid('550403'), der(0x0c, name))));
  const date = offset => der(0x18, new Date(Date.now() + offset).toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z$/, 'Z'));
  const extensions = der(0xa3, seq(
    seq(oid('551d13'), der(1, [255]), der(4, seq(der(1, [255])))),
    seq(oid('551d11'), der(4, seq(der(0x82, name))))
  ));
  const serial = randomBytes(16); serial[0] |= 0x80;
  const body = seq(der(0xa0, der(2, [2])), der(2, Buffer.concat([Buffer.from([0]), serial])), algorithm, subject,
    seq(date(-60000), date(365 * 86400000)), subject, publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const cert = pem(seq(body, algorithm, der(3, Buffer.concat([Buffer.from([0]), sign('sha256', body, privateKey)]))));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert, fingerprint: new X509Certificate(cert).fingerprint256 };
}
export function ephemeralTLS() {
  const server = certificate('localhost'), management = certificate('brain-vault-management'), injector = certificate('brain-vault-injector');
  return { tls: { key: server.key, cert: server.cert, ca: [management.cert, injector.cert] },
    clientFingerprint: management.fingerprint, injectorFingerprint: injector.fingerprint,
    broker: { tls: { key: injector.key, cert: injector.cert, ca: server.cert }, serverFingerprint: server.fingerprint } };
}
