#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { NAMESPACE, DEPLOYMENT, captureBaseline, fingerprint, inspectApplicationState } from './application-promotion-contract.mjs';
import { promoteApplication } from './application-promotion-runner.mjs';

const TOOL_METADATA_SCRIPT = String.raw`
const fs=require('fs'),p=require('path'),root='/var/lib/gateway-home';
const executable=f=>{try{return (fs.statSync(f).mode&73)!==0}catch{return false}};
const site=p.join(root,'.local/share/uv/tools/kimi-cli/lib/python3.13/site-packages');
const versions=fs.readdirSync(site).flatMap(n=>{const m=/^kimi_cli-(\d+\.\d+\.\d+)\.dist-info$/.exec(n);return m?[m[1]]:[]});
if(versions.length!==1)throw Error('ambiguous Kimi metadata');
process.stdout.write(JSON.stringify({geminiExecutable:executable(p.join(root,'.local/bin/gemini')),geminiAuthPresent:fs.existsSync(p.join(root,'.gemini/oauth_creds.json')),kimiExecutable:executable(p.join(root,'.local/bin/kimi')),kimiPythonExecutable:executable(p.join(root,'.local/share/uv/tools/kimi-cli/bin/python')),kimiVersion:versions[0]}));
`;

function invoke(tool, args) {
  let executable = tool === 'gh' ? process.env.GH_EXECUTABLE || 'gh' : process.env.KUBECTL_EXECUTABLE || 'kubectl';
  if (tool === 'inventory') {
    executable = process.env.IMAGE_INVENTORY_EXECUTABLE || process.execPath;
    if (!process.env.IMAGE_INVENTORY_EXECUTABLE) args = [fileURLToPath(new URL('./inspect-application-image-cache.mjs', import.meta.url)), ...args];
  }
  try {
    return execFileSync(executable, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      timeout: 330000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // Never forward arbitrary CLI stderr or captured Kubernetes object values.
    throw new Error(`${tool} operation failed (status ${error.status ?? 'unavailable'}); inspect the operation privately.`);
  }
}
const get = (kind, name) => JSON.parse(invoke('kubectl', ['-n', NAMESPACE, 'get', kind, ...(name ? [name] : []), '-o', 'json']));
function readState() {
  const deployment = get('deployment', DEPLOYMENT);
  const volume = deployment.spec.template.spec.volumes.filter((v) => v.name === 'providers-config');
  if (volume.length !== 1 || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(volume[0].configMap?.name ?? '')) throw new Error('Provider reference unavailable');
  return { deployment, provider: get('configmap', volume[0].configMap.name),
    replicaSets: get('replicasets').items, pods: get('pods').items };
}
function readTools(state) {
  const pod = inspectApplicationState(state).pod.metadata.name;
  return JSON.parse(invoke('kubectl', ['-n', NAMESPACE, 'exec', pod, '-c', 'gateway', '--', 'node', '-e', TOOL_METADATA_SCRIPT]));
}
function reviewedCommand() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const documents = parseAllDocuments(readFileSync(path.join(root, 'kubernetes/rancher-install.yaml'), 'utf8')).map((d) => d.toJSON());
  const d = documents.find((v) => v?.kind === 'Deployment' && v.spec?.template?.spec?.initContainers);
  const kimi = d?.spec.template.spec.initContainers.filter((c) => c.name === 'kimi-bootstrap');
  if (kimi?.length !== 1) throw new Error('Reviewed bootstrap template unavailable');
  return kimi[0].command;
}
function readJson(file) {
  const bytes = readFileSync(file);
  if (bytes.length > 5 * 1024 * 1024) throw new Error('Review artifact too large');
  try { return JSON.parse(bytes); } catch { throw new Error('Invalid review artifact JSON; contents suppressed'); }
}

export async function main(args) {
  const [mode, ...rest] = args;
  if (!['capture', 'dry-run', 'apply', 'rollback'].includes(mode)) throw new Error('Mode must be capture, dry-run, apply or rollback');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--baseline', '--baseline-sha256', '--release', '--release-sha256', '--receipt', '--restore-original-startup'].includes(rest[i])
      || !rest[i + 1] || options[rest[i]]) throw new Error('Invalid or duplicate option');
    options[rest[i]] = rest[i + 1];
  }
  if (!options['--baseline']) throw new Error('--baseline is required');
  if (mode === 'capture') {
    if (Object.keys(options).length !== 1) throw new Error('capture only accepts --baseline');
    const state = readState();
    const baseline = captureBaseline(state, reviewedCommand(), readTools(state));
    writeFileSync(options['--baseline'], `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ decision: 'baseline_captured_for_review', sha256: fingerprint(baseline) }));
    return;
  }
  for (const key of ['--baseline-sha256', '--release', '--release-sha256']) if (!options[key]) throw new Error(`${key} is required`);
  if (mode !== 'dry-run' && !options['--receipt']) throw new Error('--receipt is required for writes');
  if (options['--restore-original-startup'] && options['--restore-original-startup'] !== 'yes') throw new Error('Restoration must be explicit yes');
  const baseline = readJson(options['--baseline']);
  const release = readJson(options['--release']);
  const receipt = mode === 'rollback' ? readJson(options['--receipt']) : undefined;
  let wrote = false;
  const writeReceipt = (record) => {
    const file = options['--receipt'];
    if (!wrote && mode === 'apply') writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    else {
      const temporary = `${file}.tmp-${process.pid}`;
      try {
        writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, file);
      } finally { try { unlinkSync(temporary); } catch {} }
    }
    wrote = true;
  };
  const result = await promoteApplication({ mode, baseline, approvedBaselineHash: options['--baseline-sha256'],
    release, approvedReleaseHash: options['--release-sha256'], receipt, restoreOriginalStartup: options['--restore-original-startup'] === 'yes',
    env: process.env, readState, readTools, run: invoke, writeReceipt,
    readImageInventory: (images) => JSON.parse(invoke('inventory', images)) });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
