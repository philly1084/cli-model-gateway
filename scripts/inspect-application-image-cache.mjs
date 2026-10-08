#!/usr/bin/env node
// Read-only helper to run on the deployment node using its existing k3s runtime.
// Never pulls/imports images and never outputs the full CRI inspection object.
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
const references = process.argv.slice(2);
if (!references.length || references.length > 5 || references.some((r) => !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,400}$/.test(r))) {
  console.error('Expected bounded image references'); process.exit(1);
}
try {
  const images = {};
  for (const image of references) {
    const inspected = JSON.parse(execFileSync(process.env.K3S_EXECUTABLE || 'k3s', ['crictl', 'inspecti', image],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
    const id = inspected.status?.id;
    if (!/^sha256:[a-f0-9]{64}$/.test(id ?? '')) throw new Error('Unsupported CRI identity');
    images[image] = id;
  }
  console.log(JSON.stringify({ nodeName: hostname(), images }));
} catch { console.error('Image cache inspection failed; no image was pulled or changed'); process.exitCode = 1; }
