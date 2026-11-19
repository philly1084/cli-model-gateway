import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkRouteAvailability } from './check-route-availability.mjs';

const table = resolve('src/route-table-v1.json');
test('availability check accepts list and hide-but-present targets and warns on absent metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-availability-'));
  try {
    const cache = join(dir, 'models_cache.json');
    const models = [{ slug: 'gpt-6-luna', visibility: 'list' }];
    writeFileSync(cache, JSON.stringify({ models }));
    const result = checkRouteAvailability(cache, { routeTablePath: table, now: 0 });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some(w => w.code === 'CLIENT_VERSION_MISSING'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('availability check fails with a structured list for missing or hidden work targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-availability-'));
  try {
    const cache = join(dir, 'models_cache.json');
    writeFileSync(cache, JSON.stringify({ fetched_at: new Date().toISOString(), client_version: 'ZZTEST', models: [{ slug: 'gpt-6-luna', visibility: 'hide' }] }));
    const result = checkRouteAvailability(cache, { routeTablePath: table });
    assert.deepEqual(result.errors, [
      { code: 'WORK_CLASS_TARGET_NOT_VISIBLE', model: 'gpt-6-luna', visibility: 'hide' },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('availability check warns when the cache exceeds the configured age', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-availability-'));
  try {
    const cache = join(dir, 'models_cache.json');
    writeFileSync(cache, JSON.stringify({ fetched_at: '2020-01-01T00:00:00Z', client_version: 'ZZTEST', models: [] }));
    const result = checkRouteAvailability(cache, { routeTablePath: table, now: Date.parse('2020-01-03T00:00:00Z'), maxAgeHours: 36 });
    assert.ok(result.warnings.some(w => w.code === 'CACHE_STALE'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
