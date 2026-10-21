#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { require as tsxRequire } from 'tsx/cjs/api';
import { buildPromotionConfigSnapshot } from './remote-agent-promotion-config-snapshot.mjs';

const { loadProvidersFile } = tsxRequire('../src/config.ts', import.meta.url);
const hash = source => createHash('sha256').update(source).digest('hex');

function parse(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid providers YAML.');
  return document;
}

// Splice source ranges rather than serializing YAML: commands, quoting, comments,
// key order and line endings outside removed list items stay byte-for-byte intact.
export function retireModels(source, retiredIds) {
  const retired = new Set(retiredIds);
  assert.ok(retired.size && retired.size === retiredIds.length && retiredIds.every(id => typeof id === 'string' && id.trim() === id && id), 'Expected distinct non-empty retired ids.');
  const document = parse(source);
  const before = document.toJS();
  const expected = structuredClone(before);
  const edits = [];
  let removedModels = 0;
  let removedReferences = 0;
  const found = new Set();

  function removeItems(sequence, indexes) {
    if (!indexes.length) return;
    assert.ok(isSeq(sequence), 'Expected a YAML sequence.');
    if (sequence.flow) {
      // Remove consecutive runs, including exactly one neighboring comma.
      for (let offset = 0; offset < indexes.length;) {
        const first = indexes[offset];
        let last = first;
        while (indexes[offset + 1] === last + 1) { last++; offset++; }
        const next = sequence.items[last + 1];
        const previous = sequence.items[first - 1];
        edits.push(next
          ? [sequence.items[first].range[0], next.range[0], '']
          : previous
            ? [previous.range[1], sequence.items[last].range[2], '']
            : [sequence.range[0] + 1, sequence.range[1] - 1, '']);
        offset++;
      }
    } else if (indexes.length === sequence.items.length) {
      const ending = source.slice(sequence.range[0], sequence.range[2]).endsWith('\r\n') ? '\r\n' : '\n';
      edits.push([sequence.range[0], sequence.range[2], `[]${ending}`]);
    } else {
      for (const index of indexes) {
        const item = sequence.items[index];
        const start = source.lastIndexOf('\n', item.range[0] - 1) + 1;
        assert.match(source.slice(start, item.range[0]), /^\s*-?\s*$/, 'Cannot safely remove a non-block list item.');
        edits.push([start, item.range[2], '']);
      }
    }
  }

  const providers = document.get('providers', true);
  assert.ok(isSeq(providers), 'Expected providers sequence.');
  for (const [providerIndex, provider] of providers.items.entries()) {
    assert.ok(isMap(provider), 'Expected provider map.');
    const models = provider.get('models', true);
    if (!models) continue;
    assert.ok(isSeq(models), 'Expected models sequence.');
    const remove = [];
    for (const [index, model] of models.items.entries()) {
      assert.ok(isMap(model), 'Expected model map.');
      const id = model.get('id');
      if (retired.has(id)) {
        remove.push(index); found.add(id); removedModels++;
        continue;
      }
      const fallbacks = model.get('fallbackModels', true);
      if (fallbacks) {
        assert.ok(isSeq(fallbacks), 'Expected fallbackModels sequence.');
        const indexes = fallbacks.items.flatMap((item, i) => isScalar(item) && retired.has(item.value) ? [i] : []);
        removedReferences += indexes.length;
        removeItems(fallbacks, indexes);
      }
    }
    removeItems(models, remove);
    expected.providers[providerIndex].models = expected.providers[providerIndex].models
      .filter(model => !retired.has(model.id))
      .map(model => model.fallbackModels === undefined ? model : {
        ...model, fallbackModels: model.fallbackModels.filter(id => !retired.has(id)),
      });
  }
  assert.deepEqual([...found].sort(), [...retired].sort(), 'Every retired id must identify a configured model.');
  let result = source;
  let boundary = source.length;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
    assert.ok(end <= boundary, 'Overlapping YAML edits.');
    result = result.slice(0, start) + replacement + result.slice(end);
    boundary = start;
  }
  const after = parse(result).toJS();
  assert.deepEqual(after, expected, 'Unexpected change outside retired models and fallback references.');
  // Match complete ids, so retained siblings such as gpt-5.4-pro are allowed.
  for (const id of retired) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.ok(!new RegExp(`(?<![A-Za-z0-9_.:-])${escaped}(?![A-Za-z0-9_.:-])`).test(result), 'Retired id remains in YAML (including comments, aliases or allowlists).');
  }
  const models = after.providers.flatMap(provider => provider.models ?? []);
  const ids = new Set(models.map(model => model.id));
  for (const model of models) for (const fallback of model.fallbackModels ?? []) {
    assert.ok(ids.has(fallback), 'Unresolved fallbackModels entry.');
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'retire-models-'));
  try {
    const file = path.join(directory, 'providers.yaml');
    writeFileSync(file, result, { mode: 0o600 });
    loadProvidersFile(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return { source: result, beforeSha256: hash(source), afterSha256: hash(result),
    beforeModels: before.providers.reduce((count, provider) => count + (provider.models?.length ?? 0), 0),
    afterModels: models.length, removedModels, removedReferences };
}

export function main(args) {
  assert.equal(args.length, 8, 'Usage: node scripts/retire-models-snapshot.mjs <in-providers.yaml> <out-providers.yaml> <image@sha256> <namespace> <source-configmap> <manifest.json> --retire <id,id,...>');
  const [input, output, image, namespace, sourceConfigMap, manifestFile, flag, list] = args;
  assert.equal(flag, '--retire');
  const paths = [input, output, manifestFile].map(file => path.resolve(file));
  assert.equal(new Set(paths).size, 3, 'Input, output and manifest paths must differ.');
  assert.ok(!existsSync(output) && !existsSync(manifestFile), 'Output paths must be new.');
  const result = retireModels(readFileSync(input, 'utf8'), list.split(','));
  const snapshot = buildPromotionConfigSnapshot({ providersSource: result.source, image, namespace, sourceConfigMap });
  writeFileSync(output, result.source, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    writeFileSync(manifestFile, `${JSON.stringify(snapshot.manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    rmSync(output);
    throw error;
  }
  const { source: _source, ...counts } = result;
  process.stdout.write(`${JSON.stringify({ ...counts, configMap: snapshot.name })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch { process.stderr.write('Model retirement failed validation or output creation; no snapshot was promoted.\n'); process.exitCode = 1; }
}
