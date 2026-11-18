import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseDocument,isMap,isSeq} from 'yaml';
import {parseArgs,reconcileConfigMap,runKubectl,requireApplyGates,writeRollbackBackup,withPatchFile} from './reconcile-kimi-k3-configmap.mjs';
import {buildPromotionConfigSnapshot,checkPromotionConfigSnapshot} from './remote-agent-promotion-config-snapshot.mjs';
const table=JSON.parse(readFileSync(new URL('../src/route-table-v1.json',import.meta.url),'utf8'));
const selected=table.routes.filter(r=>r.model.startsWith('gpt-6.2-'));
export function reconcileGpt62ProviderConfig(source){
 if(typeof source!=='string'||Buffer.byteLength(source)>2097152)throw Error('PROVIDERS_CONFIG_INVALID');
 const doc=parseDocument(source,{keepSourceTokens:true,uniqueKeys:true,prettyErrors:false});
 if(doc.errors.length)throw Error('PROVIDERS_CONFIG_INVALID');
 const providers=doc.get('providers',true);if(!isSeq(providers))throw Error('PROVIDERS_CONFIG_INVALID');
 const rows=providers.items.filter(p=>isMap(p)&&p.get('id')==='codex-cli');
 if(rows.length!==1||rows[0].get('type')!=='cli')throw Error('CODEX_PROVIDER_REQUIRED');
 const models=rows[0].get('models',true);if(!isSeq(models)||!models.items.length||models.flow)throw Error('PRESERVABLE_MODELS_REQUIRED');
 const all=doc.toJS().providers.flatMap(p=>(p.models??[]).map(m=>({provider:p.id,...m})));
 const missing=[];
 for(const route of selected){
  const found=all.filter(m=>m.id===route.model);
  if(found.length>1)throw Error('DUPLICATE_MODEL');
  if(found.length){const m=found[0];if(m.provider!=='codex-cli'||m.providerModel!==route.providerModel||m.manualOnly!==true||m.autoEligible!==false||(m.fallbackModels?.length??0)>0||JSON.stringify(m.capabilities)!==JSON.stringify(['chat','responses','tools']))throw Error('EXISTING_MODEL_CONFLICT');}
  else missing.push(route);
 }
 if(!missing.length)return source;
 const first=models.items[0];if(!isMap(first)||!first.range)throw Error('PRESERVABLE_MODELS_REQUIRED');
 const start=source.lastIndexOf('\n',first.range[0]-1)+1,prefix=source.slice(start,first.range[0]),dash=prefix.lastIndexOf('-');
 if(dash<0||prefix.slice(0,dash).trim())throw Error('PRESERVABLE_MODELS_REQUIRED');
 const indent=prefix.slice(0,dash),fields=' '.repeat(first.range[0]-start),eol=source.includes('\r\n')?'\r\n':'\n';
 const added=missing.map(m=>`${indent}- id: ${m.model}${eol}${fields}providerModel: ${m.providerModel}${eol}${fields}capabilities: [chat, responses, tools]${eol}${fields}manualOnly: true${eol}${fields}autoEligible: false${eol}`).join('');
 const result=source.slice(0,start)+added+source.slice(start);
 if(reconcileGpt62ProviderConfig(result)!==result)throw Error('RECONCILE_NOT_IDEMPOTENT');
 return result;
}
export function verifyGpt62Config(source){if(reconcileGpt62ProviderConfig(source)!==source)throw Error('GPT62_ENTRIES_MISSING');}
export function immutableGpt62Plan(current,deployment,options){
 if(current.immutable!==true||current.metadata?.name!==options.configMap||current.metadata?.namespace!==options.namespace||Object.keys(current.data??{}).join()!=='providers.yaml'||Object.keys(current.binaryData??{}).length)throw Error('IMMUTABLE_CONFIG_SHAPE');
 if(deployment.metadata?.name!=='n8n-openai-cli-gateway'||deployment.metadata?.namespace!==options.namespace||!deployment.metadata.uid||!deployment.metadata.resourceVersion)throw Error('DEPLOYMENT_IDENTITY');
 const pod=deployment.spec.template.spec,containers=pod.containers.filter(c=>c.name==='gateway'),volumes=pod.volumes.filter(v=>v.name==='providers-config');
 if(containers.length!==1||volumes.length!==1||volumes[0].configMap?.name!==options.configMap)throw Error('CONFIG_MOUNT_DRIFT');
 const mounts=containers[0].volumeMounts.filter(m=>m.mountPath==='/app/config/providers.yaml');
 if(mounts.length!==1||mounts[0].name!=='providers-config'||mounts[0].subPath!=='providers.yaml')throw Error('CONFIG_MOUNT_DRIFT');
 const providersSource=reconcileGpt62ProviderConfig(current.data['providers.yaml']),expected={providersSource,image:containers[0].image,namespace:options.namespace,sourceConfigMap:options.configMap};
 const snapshot=buildPromotionConfigSnapshot(expected),index=pod.volumes.indexOf(volumes[0]),pointer=`/spec/template/spec/volumes/${index}/configMap/name`;
 const next=structuredClone(deployment.spec);next.template.spec.volumes[index].configMap.name=snapshot.name;
 const tests=[{op:'test',path:'/metadata/uid',value:deployment.metadata.uid},{op:'test',path:'/metadata/resourceVersion',value:deployment.metadata.resourceVersion},{op:'test',path:'/spec',value:deployment.spec}];
 return {snapshot,expected,next,pointer,patch:[...tests,{op:'replace',path:pointer,value:snapshot.name}],beforeHash:createHash('sha256').update(current.data['providers.yaml']).digest('hex')};
}
export async function reconcileImmutableGpt62(current,deployment,options,env=process.env){
 if(options.mode==='apply')requireApplyGates(env);
 const plan=immutableGpt62Plan(current,deployment,options),ns=['-n',options.namespace],dep=['deployment','n8n-openai-cli-gateway'];
 const patch=async(ops,dry)=>withPatchFile(ops,file=>JSON.parse(runKubectl([...ns,'patch',...dep,'--type=json','--patch-file',file,...(dry?['--dry-run=server']:[]),'-o','json'],env)));
 if(plan.expected.providersSource===current.data['providers.yaml'])return {changed:false,beforeHash:plan.beforeHash,afterHash:plan.beforeHash};
 await withPatchFile(plan.snapshot.manifest,file=>runKubectl([...ns,'create','-f',file,'--dry-run=server','-o','name'],env));
 await patch(plan.patch,true);
 if(options.mode!=='apply')return {changed:true,beforeHash:plan.beforeHash,afterHash:plan.snapshot.providersHash,dryRun:true};
 await writeRollbackBackup(options.backupDir,options.configMap,plan.beforeHash,current.data['providers.yaml']);
 const receipt={sourceConfigMap:options.configMap,targetConfigMap:plan.snapshot.name,beforeHash:plan.beforeHash,afterHash:plan.snapshot.providersHash,deploymentUid:deployment.metadata.uid,image:plan.expected.image,pointer:plan.pointer,configBeforeBinaryRollback:true};
 writeFileSync(path.join(options.backupDir,'gpt62-rollback.json'),JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});
 await withPatchFile(plan.snapshot.manifest,file=>runKubectl([...ns,'create','-f',file,'-o','name'],env));
 checkPromotionConfigSnapshot(JSON.parse(runKubectl([...ns,'get','configmap',plan.snapshot.name,'-o','json'],env)),plan.expected);
 let applied=false;
 try{
  applied=true;const result=await patch(plan.patch,false);
  if(JSON.stringify(result.spec)!==JSON.stringify(plan.next))throw Error('CONFIG_APPLY_DRIFT');
  runKubectl([...ns,'rollout','status',...dep,'--timeout=25s'],env);
  const fresh=JSON.parse(runKubectl([...ns,'get',...dep,'-o','json'],env));if(JSON.stringify(fresh.spec)!==JSON.stringify(plan.next))throw Error('CONFIG_READBACK_DRIFT');
 }catch(error){
  if(applied){const fresh=JSON.parse(runKubectl([...ns,'get',...dep,'-o','json'],env));if(JSON.stringify(fresh.spec)!==JSON.stringify(deployment.spec)){await patch([{op:'test',path:'/metadata/uid',value:deployment.metadata.uid},{op:'test',path:'/metadata/resourceVersion',value:fresh.metadata.resourceVersion},{op:'test',path:'/spec',value:plan.next},{op:'replace',path:plan.pointer,value:options.configMap}],false);runKubectl([...ns,'rollout','status',...dep,'--timeout=25s'],env);}}
  throw error;
 }
 return {...receipt,changed:true};
}
export async function main(){
 const options=parseArgs(process.argv.slice(2));
 // Read-only deployed-module proof must precede even the server dry-run.
 const script="const fs=require('fs'),crypto=require('crypto'),r=require('./dist/utils/route-table.js');const rows=['gpt-6.2-astra','gpt-6.2-sol'].map(m=>r.modelRoute(m));if(rows.some(r=>r.providerId!=='codex-cli'))throw Error('binding');console.log(crypto.createHash('sha256').update(fs.readFileSync('./dist/route-table-v1.json')).digest('hex'));";
 const remote=runKubectl(['-n',options.namespace,'exec','deployment/n8n-openai-cli-gateway','-c','gateway','--','node','-e',script],process.env).trim();
 const expected=readFileSync(new URL('../src/route-table-v1.sha256',import.meta.url),'utf8').trim();
 if(remote!==expected)throw Error('GPT62_RUNTIME_MUST_PRECEDE_CONFIG');
 const current=JSON.parse(runKubectl(['-n',options.namespace,'get','configmap',options.configMap,'-o','json'],process.env));
 if(current.immutable===true){const deployment=JSON.parse(runKubectl(['-n',options.namespace,'get','deployment','n8n-openai-cli-gateway','-o','json'],process.env));const result=await reconcileImmutableGpt62(current,deployment,options);console.log(JSON.stringify(result));return result;}
 return reconcileConfigMap(options,process.env,{transform:reconcileGpt62ProviderConfig,verify:verifyGpt62Config});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('GPT62_CONFIG_RECONCILE_FAILED');process.exitCode=1;});
