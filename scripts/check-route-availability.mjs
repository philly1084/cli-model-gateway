import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkRouteAvailability(cachePath, { routeTablePath, maxAgeHours = 36, now = Date.now() } = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const tablePath = routeTablePath ?? resolve(here, '../src/route-table-v1.json');
  const errors = [], warnings = [];
  let cache, table;
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); }
  catch (error) { return { errors: [{ code: 'CACHE_READ_FAILED', path: cachePath, message: String(error.message) }], warnings }; }
  try { table = JSON.parse(readFileSync(tablePath, 'utf8')); }
  catch (error) { return { errors: [{ code: 'ROUTE_TABLE_READ_FAILED', path: tablePath, message: String(error.message) }], warnings }; }
  if (!Array.isArray(cache?.models)) return { errors: [{ code: 'CACHE_MODELS_INVALID' }], warnings };
  if (!cache.client_version) warnings.push({ code: 'CLIENT_VERSION_MISSING' });
  const fetched = Date.parse(cache.fetched_at);
  if (!Number.isFinite(fetched)) warnings.push({ code: 'CACHE_TIMESTAMP_MISSING_OR_INVALID' });
  else if (now - fetched > maxAgeHours * 3600000) warnings.push({ code: 'CACHE_STALE', ageHours: Math.round((now - fetched) / 3600000 * 10) / 10, maxAgeHours });
  const targets = new Set(Object.values(table.workClasses ?? {}).filter(w => table.routes?.some(r => r.model === w.model && r.providerId === 'codex-cli')).map(w => w.model));
  for (const model of [...targets].sort()) {
    const entry = cache.models.find(item => item?.slug === model);
    if (!entry) errors.push({ code: 'WORK_CLASS_TARGET_MISSING', model });
    else if (!['list', 'hide-but-present'].includes(entry.visibility)) errors.push({ code: 'WORK_CLASS_TARGET_NOT_VISIBLE', model, visibility: entry.visibility ?? null });
  }
  return { errors, warnings };
}

function main(args) {
  let cachePath, routeTablePath, maxAgeHours = 36;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--route-table') routeTablePath = resolve(args[++i] ?? '');
    else if (args[i] === '--max-age-hours') maxAgeHours = Number(args[++i]);
    else if (!cachePath && !args[i].startsWith('--')) cachePath = resolve(args[i]);
    else throw new Error('Usage: node scripts/check-route-availability.mjs <models_cache.json> [--route-table path] [--max-age-hours N]');
  }
  if (!cachePath || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('Usage: node scripts/check-route-availability.mjs <models_cache.json> [--route-table path] [--max-age-hours N]');
  const result = checkRouteAvailability(cachePath, { routeTablePath, maxAgeHours });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.errors.length) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(JSON.stringify({ errors: [{ code: 'ARGUMENTS_INVALID', message: error.message }], warnings: [] }, null, 2) + '\n'); process.exitCode = 2; }
}
