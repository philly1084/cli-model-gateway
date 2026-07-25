#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseAllDocuments, parseDocument } from 'yaml';

const TARGET_CONFIG_MAP = 'n8n-openai-cli-gateway-targets';
const REQUIRED_TARGETS = Object.freeze({
  'k3s-primary': '168.119.176.121',
  'k3s-secondary': '162.55.163.199',
  'k3s-prod': '168.119.176.121',
  prod: '168.119.176.121',
});

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function fail(sourceName, message) {
  throw new Error(`${sourceName}: ${message}`);
}

export function checkRemoteTargetConfig(source, options = {}) {
  const sourceName = options.sourceName || 'kubernetes/rancher-install.yaml';
  const documents = parseAllDocuments(source, {
    maxAliasCount: 100,
    prettyErrors: true,
    uniqueKeys: true,
  });
  const parseErrors = documents.flatMap((document) => document.errors);
  if (parseErrors.length > 0) {
    fail(sourceName, `invalid YAML: ${parseErrors.map((error) => error.message).join('; ')}`);
  }

  const configMaps = documents
    .map((document) => asRecord(document.toJS({ maxAliasCount: 100 })))
    .filter((document) => (
      document?.kind === 'ConfigMap'
      && asRecord(document.metadata)?.name === TARGET_CONFIG_MAP
    ));
  if (configMaps.length !== 1) {
    fail(sourceName, `expected exactly one ${TARGET_CONFIG_MAP} ConfigMap; found ${configMaps.length}.`);
  }

  const targetSource = asRecord(configMaps[0].data)?.['targets.yaml'];
  if (typeof targetSource !== 'string' || !targetSource.trim()) {
    fail(sourceName, `${TARGET_CONFIG_MAP} must contain data.targets.yaml.`);
  }
  const targetDocument = parseDocument(targetSource, {
    maxAliasCount: 100,
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (targetDocument.errors.length > 0) {
    fail(sourceName, `targets.yaml is invalid: ${targetDocument.errors.map((error) => error.message).join('; ')}`);
  }
  const targetRoot = asRecord(targetDocument.toJS({ maxAliasCount: 100 }));
  if (!targetRoot || !Array.isArray(targetRoot.remoteCliTargets)) {
    fail(sourceName, 'targets.yaml must define remoteCliTargets as an array.');
  }

  const targets = new Map();
  for (const value of targetRoot.remoteCliTargets) {
    const target = asRecord(value);
    const targetId = typeof target?.targetId === 'string' ? target.targetId.trim() : '';
    const host = typeof target?.host === 'string' ? target.host.trim() : '';
    if (!targetId || !host) {
      fail(sourceName, 'every remote CLI target must define targetId and host.');
    }
    if (targets.has(targetId)) {
      fail(sourceName, `duplicate remote CLI targetId ${targetId}.`);
    }
    targets.set(targetId, host);
  }

  for (const [targetId, expectedHost] of Object.entries(REQUIRED_TARGETS)) {
    const actualHost = targets.get(targetId);
    if (actualHost !== expectedHost) {
      fail(sourceName, `${targetId} must remain pinned to ${expectedHost}; found ${actualHost || 'missing'}.`);
    }
  }
  if (targets.get('k3s-primary') === targets.get('k3s-secondary')) {
    fail(sourceName, 'k3s-primary and k3s-secondary must resolve to different hosts.');
  }

  return {
    targetCount: targets.size,
    targets: Object.fromEntries(targets),
  };
}

async function main() {
  const input = path.resolve(process.argv[2] || 'kubernetes/rancher-install.yaml');
  const source = await readFile(input, 'utf8');
  const result = checkRemoteTargetConfig(source, { sourceName: input });
  console.log(`Remote target preflight passed (${result.targetCount} targets).`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
