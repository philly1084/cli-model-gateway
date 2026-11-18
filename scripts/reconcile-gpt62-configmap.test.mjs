import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reconcileGpt62ProviderConfig,immutableGpt62Plan,canonicalJsonSha256} from './reconcile-gpt62-configmap.mjs';
import {canonicalDataSha256,selectImmutableSnapshot,snapshotMatches,reconcileImmutableGpt62,formatGpt62Error} from './reconcile-gpt62-configmap.mjs';
import {runKubectl} from './reconcile-kimi-k3-configmap.mjs';
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

test('runtime route-table check hashes canonical JSON so the tsc-emitted dist copy matches src',()=>{
 const src=readFileSync(new URL('../src/route-table-v1.json',import.meta.url),'utf8');
 const emitted=JSON.stringify(JSON.parse(src),null,4)+'\n';
 assert.notEqual(emitted,src);
 assert.equal(canonicalJsonSha256(emitted),canonicalJsonSha256(src));
 assert.match(canonicalJsonSha256(src),/^[0-9a-f]{64}$/);
});

function fixture(){
 const options={namespace:'synthetic',configMap:'old',mode:'dry-run'};
 const current={metadata:{name:'old',namespace:'synthetic'},immutable:true,data:{'providers.yaml':source}};
 const deployment={metadata:{name:'n8n-openai-cli-gateway',namespace:'synthetic',uid:'fixture',resourceVersion:'1'},spec:{template:{spec:{containers:[{name:'gateway',image:'ghcr.io/philly1084/cli-model-gateway@sha256:'+'a'.repeat(64),volumeMounts:[{name:'providers-config',mountPath:'/app/config/providers.yaml',subPath:'providers.yaml'}]}],volumes:[{name:'providers-config',configMap:{name:'old'}}]}}}};
 return {options,current,deployment,plan:immutableGpt62Plan(current,deployment,options)};
}
for(const state of ['absent','identical','differs'])test(`immutable dry-run: ${state}`,async()=>{
 const {options,current,deployment,plan}=fixture();const calls=[];
 const existing=structuredClone(plan.snapshot.manifest);if(state==='differs')existing.data['providers.yaml']+='\n# drift';
 const result=await reconcileImmutableGpt62(current,deployment,options,{},args=>{
  calls.push(args);
  if(args.includes('get'))return args.includes(plan.snapshot.name)&&state!=='absent'?JSON.stringify(existing):'';
  if(args.includes('create')){assert.ok(args.includes('--dry-run=server'));assert.equal(args.at(-1),'yaml');return 'validated';}
  if(args.includes('patch')){assert.ok(args.includes('--dry-run=server'));return JSON.stringify(deployment);}
  throw Error('unexpected command');
 });
 assert.equal(result.snapshotAction,state==='identical'?'reused':'created');
 assert.equal(calls.filter(a=>a.includes('create')).length,state==='identical'?0:1);
 assert.equal(result.renamed,state==='differs');
 if(state==='differs')assert.ok(result.targetConfigMap.endsWith(canonicalDataSha256(plan.snapshot.manifest.data).slice(0,16)));
 assert.ok(calls.every(a=>!a.includes('delete')&&!a.includes('apply')));
});
test('canonical comparison includes all keys, provenance and immutable flag',()=>{
 assert.equal(canonicalDataSha256({b:'2',a:'1'}),canonicalDataSha256({a:'1',b:'2'}));
 const {plan}=fixture(),m=plan.snapshot.manifest;
 for(const edit of [x=>x.immutable=false,x=>x.data.extra='value',x=>x.metadata.labels['app.kubernetes.io/managed-by']='other',x=>x.metadata.annotations['kimibuilt.dev/image-digest']='other',x=>x.metadata.ownerReferences=[{}]]){
  const changed=structuredClone(m);edit(changed);assert.equal(snapshotMatches(changed,m),false);
 }
 assert.throws(()=>selectImmutableSnapshot(plan,name=>({...structuredClone(m),metadata:{...m.metadata,name},immutable:false})),/IMMUTABLE_CONTENT_HASH_COLLISION/);
});
test('kubectl failure keeps actual exit and bounded redacted stderr',()=>{
 let caught;
 try{runKubectl([], {...process.env,KUBECTL_EXECUTABLE:process.execPath,KUBECTL_PREFIX_ARGS_JSON:JSON.stringify(['-e','process.stderr.write("Error from server (Forbidden): configmaps forbidden token=synthetic-secret");process.exit(23)'])});}catch(error){caught=error;}
 assert.ok(caught);const output=JSON.parse(formatGpt62Error(caught));
 assert.equal(output.code,'GPT62_CONFIG_RECONCILE_FAILED');assert.equal(output.exitCode,23);
 assert.match(output.stderr,/Forbidden/);assert.doesNotMatch(output.stderr,/synthetic-secret/);
 assert.ok(JSON.parse(formatGpt62Error({stderr:'x'.repeat(10000)})).stderr.length<=2048);
});
