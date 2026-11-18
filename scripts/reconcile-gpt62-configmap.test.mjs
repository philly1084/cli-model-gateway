import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reconcileGpt62ProviderConfig} from './reconcile-gpt62-configmap.mjs';
const source='providers:\n  - id: codex-cli\n    type: cli\n    models:\n      - id: existing\n        providerModel: existing\n        manualOnly: false\n# retained comment\n  - id: other\n    type: cli\n    models: []\n';
test('adds only two manual entries, preserves every prior byte and is idempotent',()=>{
 const result=reconcileGpt62ProviderConfig(source);assert.equal(reconcileGpt62ProviderConfig(result),result);
 const a=result.indexOf('      - id: gpt-6.2-astra'),z=result.indexOf('      - id: existing');
 assert.equal(result.slice(0,a)+result.slice(z),source);
 assert.equal((result.match(/manualOnly: true/g)??[]).length,2);
});
test('existing conflicts and duplicates fail closed; shipped examples are already reconciled',()=>{
 const result=reconcileGpt62ProviderConfig(source);
 assert.throws(()=>reconcileGpt62ProviderConfig(result.replace('manualOnly: true','manualOnly: false')));
 assert.throws(()=>reconcileGpt62ProviderConfig(result.replace('id: existing','id: gpt-6.2-sol')));
 const example=readFileSync(new URL('../config/providers.example.yaml',import.meta.url),'utf8');assert.equal(reconcileGpt62ProviderConfig(example),example);
});
