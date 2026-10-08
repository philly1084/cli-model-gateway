#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, fingerprint, verifyReleaseProof } from './application-promotion-contract.mjs';

export function buildReleaseProof(image, sourceCommit, readBlob) {
  const match = /^ghcr\.io\/philly1084\/cli-model-gateway@(sha256:[a-f0-9]{64})$/.exec(image);
  if (!match || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Expected canonical digest and exact source commit');
  const read = (digest) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('Invalid content descriptor');
    const bytes = readBlob(digest);
    if (!Buffer.isBuffer(bytes) || bytes.length > 1048576 || `sha256:${sha256(bytes)}` !== digest) throw new Error('Content digest differs');
    return bytes;
  };
  const root = read(match[1]);
  const rootObject = JSON.parse(root);
  let arm = root;
  if (rootObject.manifests) {
    const targets = rootObject.manifests.filter((m) => m.platform?.os === 'linux' && m.platform.architecture === 'arm64');
    if (targets.length !== 1) throw new Error('Expected one Linux ARM64 descriptor');
    arm = read(targets[0].digest);
  }
  const manifest = JSON.parse(arm);
  const config = read(manifest.config?.digest);
  const proof = { image, sourceCommit, rootManifestBase64: root.toString('base64'),
    armManifestBase64: arm.toString('base64'), imageConfigBase64: config.toString('base64') };
  verifyReleaseProof(proof);
  return proof;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  try {
    const [image, sourceCommit, output, ...extra] = process.argv.slice(2);
    if (!output || extra.length) throw new Error('Usage: build-application-release-proof.mjs <canonical-image@digest> <source-commit> <new-output-file>');
    const proof = buildReleaseProof(image, sourceCommit, (digest) => execFileSync(process.env.K3S_EXECUTABLE || 'k3s',
      ['ctr', '--namespace', 'k8s.io', 'content', 'get', digest], { maxBuffer: 1048576, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
    writeFileSync(output, `${JSON.stringify(proof)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ decision: 'proof_built_from_existing_content', sha256: fingerprint(proof) }));
  } catch { console.error('Proof preparation failed; requires exact preloaded content. Nothing was pulled or deployed.'); process.exitCode = 1; }
}
