import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { retireModels } from './retire-models-snapshot.mjs';
import { checkPromotionConfigSnapshot } from './remote-agent-promotion-config-snapshot.mjs';

const retired = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'z-ai/glm-5.2:free'];
const image = `ghcr.io/philly1084/cli-model-gateway@sha256:${'8'.repeat(64)}`;
// Reduced synthetic fixture with the same provider/model/fallback structure as
// the handoff snapshot. No production file or credential values are included.
const fixture = `# Preserve this header exactly.
providers:
  - id: codex-cli
    type: cli
    responseCommand:
      executable: node # retain inline comment
      args: ['bridge.js', '{{provider_model}}']
      input: request_json_stdin
      output: json_contract
    models:
      - id: gpt-5.5
        providerModel: gpt-5.5
        fallbackModels: [gpt-5.4]
      # Keep this surviving model comment.
      - id: gpt-5.6-sol
        providerModel: 'gpt-5.6-sol'
        fallbackModels:
          - gpt-5.5
          - gpt-5.4-pro # keep sibling
          - gpt-5.4
      - id: gpt-5.4
        description: removed model
      - id: gpt-5.4-mini
      - id: gpt-5.4-pro
        fallbackModels: [gpt-5.5, gpt-5.6-sol, gpt-5.4-mini]
  - id: openrouter-free
    type: openai
    baseUrl: https://example.invalid/v1
    apiKeyEnv: OPENROUTER_API_KEY
    models:
      - id: z-ai/glm-5.2:free
      - id: openrouter-free
        fallbackModels:
          - z-ai/glm-5.2:free
# Preserve the footer too.
`;

for (const ending of ['\n', '\r\n']) test(`minimal edits preserve surviving bytes (${JSON.stringify(ending)})`, () => {
  const source = fixture.replaceAll('\n', ending);
  const result = retireModels(source, retired);
  const expected = fixture
    .replace('      - id: gpt-5.5\n        providerModel: gpt-5.5\n        fallbackModels: [gpt-5.4]\n', '')
    .replace('          - gpt-5.5\n', '').replace('          - gpt-5.4\n', '')
    .replace('      - id: gpt-5.4\n        description: removed model\n', '')
    .replace('      - id: gpt-5.4-mini\n', '')
    .replace('[gpt-5.5, gpt-5.6-sol, gpt-5.4-mini]', '[gpt-5.6-sol]')
    .replace('      - id: z-ai/glm-5.2:free\n', '')
    .replace('          - z-ai/glm-5.2:free\n', '          []\n')
    .replaceAll('\n', ending);
  assert.equal(result.source, expected);
  assert.equal(result.removedModels, 4);
  assert.equal(result.removedReferences, 5);
  assert.equal(result.beforeModels, 7);
  assert.equal(result.afterModels, 3);
});

test('flow fallback runs at the beginning, middle, end and whole list', () => {
  for (const [list, expected] of [
    ['gpt-5.5, gpt-5.4, gpt-5.6-sol', 'gpt-5.6-sol'],
    ['gpt-5.6-sol, gpt-5.5, gpt-5.4, gpt-5.4-pro', 'gpt-5.6-sol, gpt-5.4-pro'],
    ['gpt-5.6-sol, gpt-5.5, gpt-5.4', 'gpt-5.6-sol'],
    ['gpt-5.5, gpt-5.4', ''],
  ]) {
    const result = retireModels(fixture.replace('[gpt-5.5, gpt-5.6-sol, gpt-5.4-mini]', `[${list}]`), retired);
    assert.ok(result.source.includes(`fallbackModels: [${expected}]`));
  }
});

test('reject missing/duplicate retire ids, unknown fallbacks and schema-invalid survivors', () => {
  assert.throws(() => retireModels(fixture, [...retired, 'not-configured']));
  assert.throws(() => retireModels(fixture, [...retired, retired[0]]));
  assert.throws(() => retireModels(fixture.replace('gpt-5.4-pro # keep sibling', 'not-configured'), retired), /Unresolved fallback/);
  assert.throws(() => retireModels(fixture.replace('executable: node', 'executable: 123'), retired));
  assert.throws(() => retireModels('providers: [', retired), /Invalid providers YAML/);
});

test('reject remaining ids in comments, allowlists, aliases or commands instead of silently changing them', () => {
  for (const extra of ['# gpt-5.5\n', 'aliases: [gpt-5.4]\n', 'allowlist: [gpt-5.4-mini]\n', '# alias: openai/gpt-5.4\n']) {
    assert.throws(() => retireModels(fixture + extra, retired), /Retired id remains/);
  }
  assert.throws(() => retireModels(fixture.replace('bridge.js', 'gpt-5.5'), retired), /Retired id remains/);
  assert.throws(() => retireModels(fixture.replace('providerModel: \'gpt-5.6-sol\'', 'providerModel: gpt-5.5'), retired), /Retired id remains/);
});

test('flow model lists retain surviving objects and CLI providers cannot become empty', () => {
  const source = `providers: [{id: codex-cli, type: cli, responseCommand: {executable: node}, models: [{id: gpt-5.5}, {id: gpt-5.6-sol, fallbackModels: [gpt-5.5]}]}]\n`;
  const result = retireModels(source, ['gpt-5.5']);
  assert.equal(result.source, `providers: [{id: codex-cli, type: cli, responseCommand: {executable: node}, models: [{id: gpt-5.6-sol, fallbackModels: []}]}]\n`);
  assert.throws(() => retireModels(source.replace(', {id: gpt-5.6-sol, fallbackModels: [gpt-5.5]}', ''), ['gpt-5.5']));
});

test('CLI builds the existing immutable snapshot contract and does not write on validation failure', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'retirement-test-'));
  try {
    const input = path.join(directory, 'input.yaml');
    const output = path.join(directory, 'output.yaml');
    const manifest = path.join(directory, 'manifest.json');
    writeFileSync(input, fixture);
    const args = ['scripts/retire-models-snapshot.mjs', input, output, image, 'test', 'previous-config', manifest, '--retire', retired.join(',')];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const printed = JSON.parse(result.stdout);
    assert.equal(printed.removedModels, 4);
    const source = readFileSync(output, 'utf8');
    assert.equal(readFileSync(input, 'utf8'), fixture);
    const checked = checkPromotionConfigSnapshot(JSON.parse(readFileSync(manifest, 'utf8')), {
      providersSource: source, image, namespace: 'test', sourceConfigMap: 'previous-config',
    });
    assert.equal(printed.configMap, checked.name);
    assert.equal(printed.afterSha256, checked.providersHash);
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
    assert.equal(readFileSync(output, 'utf8'), source);
    rmSync(output); rmSync(manifest);
    writeFileSync(input, fixture + '# gpt-5.5\n');
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(manifest), false);
    writeFileSync(input, fixture);
    const badImage = [...args]; badImage[3] = 'unpinned-image';
    assert.equal(spawnSync(process.execPath, badImage, { encoding: 'utf8' }).status, 1);
    assert.equal(existsSync(output), false);
    const badManifest = [...args]; badManifest[6] = path.join(directory, 'missing', 'manifest.json');
    assert.equal(spawnSync(process.execPath, badManifest, { encoding: 'utf8' }).status, 1);
    assert.equal(existsSync(output), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('published configuration and routing baseline exclude retired selectors and references', () => {
  const bundle = YAML.parseAllDocuments(readFileSync('kubernetes/rancher-install.yaml', 'utf8'))
    .map(doc => doc.toJS()).find(doc => doc?.kind === 'ConfigMap' && doc.data?.['providers.yaml']);
  for (const catalog of [YAML.parse(readFileSync('config/providers.example.yaml', 'utf8')),
    YAML.parse(bundle.data['providers.yaml']), JSON.parse(readFileSync('src/test/fixtures/catalog-routing-baseline.json', 'utf8'))]) {
    const models = catalog.providers.flatMap(provider => provider.models ?? []);
    for (const model of models) {
      assert.ok(!retired.includes(model.id));
      assert.ok(!retired.includes(model.providerModel));
      for (const fallback of model.fallbackModels ?? []) assert.ok(!retired.includes(fallback));
    }
  }
  const bridge = readFileSync('src/scripts/codex-appserver-bridge.ts', 'utf8');
  assert.ok(!bridge.includes('"gpt-5.5"'));
});
