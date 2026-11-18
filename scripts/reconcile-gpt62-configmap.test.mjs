import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reconcileGpt62ProviderConfig,immutableGpt62Plan} from './reconcile-gpt62-configmap.mjs';
const source='providers:\n  - id: codex-cli\n    type: cli\n    models:\n      - id: existing\n        providerModel: existing\n        manualOnly: false\n# retained comment\n  - id: other\n    type: cli\n    models: []\n';
test('immutable mounted config uses the existing snapshot contract and exact guarded mount replacement',()=>{
 const options={namespace:'synthetic',configMap:'old'},current={metadata:{name:'old',namespace:'synthetic'},immutable:true,data:{'providers.yaml':source}};
 const deployment={metadata:{name:'n8n-openai-cli-gateway',namespace:'synthetic',uid:'fixture',resourceVersion:'1'},spec:{template:{spec:{containers:[{name:'gateway',image:'ghcr.io/philly1084/cli-model-gateway@sha256:'+'a'.repeat(64),volumeMounts:[{name:'providers-config',mountPath:'/app/config/providers.yaml',subPath:'providers.yaml'}]}],volumes:[{name:'providers-config',configMap:{name:'old'}}]}}}};
 const original=JSON.stringify({current,deployment}),plan=immutableGpt62Plan(current,deployment,options);
 assert.equal(JSON.stringify({current,deployment}),original);assert.equal(plan.snapshot.manifest.immutable,true);
 assert.equal(plan.patch.length,4);assert.deepEqual(plan.patch.slice(0,3).map(p=>p.op),['test','test','test']);
 assert.equal(plan.patch[3].path,'/spec/template/spec/volumes/0/configMap/name');
 const restored=structuredClone(plan.next);restored.template.spec.volumes[0].configMap.name='old';assert.deepEqual(restored,deployment.spec);
 assert.throws(()=>immutableGpt62Plan({...current,immutable:false},deployment,options));
 assert.throws(()=>immutableGpt62Plan(current,{...deployment,spec:{template:{spec:{...deployment.spec.template.spec,volumes:[]}}}},options));
});
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
