import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

export function planModelAdditions(source, plan) {
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (!plan || plan.baselineSha256 !== sha256) throw Error('Provider baseline changed; inspect the mounted configuration again.');
  if (!Array.isArray(plan.additions) || !plan.additions.length || plan.additions.length > 20) throw Error('Expected 1-20 reviewed additions.');
  const doc = YAML.parseDocument(source);
  if (doc.errors.length) throw Error('Invalid provider YAML.');
  const before = doc.toJS();
  if (!Array.isArray(before?.providers)) throw Error('Missing providers.');
  const ids = new Set(before.providers.flatMap(p => (p.models ?? []).map(m => m.id)));
  const changes = [];
  for (const addition of plan.additions) {
    const { providerId, id, providerModel, description } = addition;
    if (Object.keys(addition).some(k => !['providerId', 'id', 'providerModel', 'description'].includes(k)) ||
        ![providerId, id, providerModel].every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(v)) ||
        typeof description !== 'string' || description.length > 300) throw Error('Invalid model addition.');
    const matches = before.providers.map((p, i) => p.id === providerId ? i : -1).filter(i => i >= 0);
    if (matches.length !== 1 || ids.has(id)) throw Error('Unknown/ambiguous provider or existing model ID; no replacement is allowed.');
    const index = matches[0];
    if (!Array.isArray(before.providers[index].models)) throw Error('Existing explicit models required.');
    const model = { id, providerModel, description, autoEligible: false };
    doc.addIn(['providers', index, 'models'], model);
    ids.add(id); changes.push({ providerId, ...model });
  }
  // The proposal may only append models. Preserve credentials, commands and all unknown policy fields.
  const after = doc.toJS();
  for (let i = 0; i < before.providers.length; i++) after.providers[i].models = before.providers[i].models;
  if (JSON.stringify(after) !== JSON.stringify(before)) throw Error('Proposal changed existing provider configuration.');
  return { yaml: doc.toString(), summary: { baselineSha256: sha256, additions: changes, applied: false } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [sourcePath, planPath, outputPath, ...extra] = process.argv.slice(2);
    if (!sourcePath || !planPath || !outputPath || extra.length || resolve(sourcePath) === resolve(outputPath) || resolve(planPath) === resolve(outputPath)) throw Error('Usage: node scripts/plan-model-additions.mjs BASELINE.yaml PLAN.json NEW-PROPOSAL.yaml');
    const result = planModelAdditions(await readFile(sourcePath, 'utf8'), JSON.parse(await readFile(planPath, 'utf8')));
    await writeFile(outputPath, result.yaml, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result.summary, null, 2));
  } catch { console.error('Model proposal refused. Check the baseline hash, reviewed additions and unused output path.'); process.exitCode = 1; }
}
