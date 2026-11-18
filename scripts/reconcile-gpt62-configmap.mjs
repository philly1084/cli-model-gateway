import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseDocument,isMap,isSeq} from 'yaml';
import {parseArgs,reconcileConfigMap,runKubectl} from './reconcile-kimi-k3-configmap.mjs';
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
export async function main(){
 const options=parseArgs(process.argv.slice(2));
 // Read-only deployed-module proof must precede even the server dry-run.
 const script="const fs=require('fs'),crypto=require('crypto'),r=require('./dist/utils/route-table.js');const rows=['gpt-6.2-astra','gpt-6.2-sol'].map(m=>r.modelRoute(m));if(rows.some(r=>r.providerId!=='codex-cli'))throw Error('binding');console.log(crypto.createHash('sha256').update(fs.readFileSync('./dist/route-table-v1.json')).digest('hex'));";
 const remote=runKubectl(['-n',options.namespace,'exec','deployment/n8n-openai-cli-gateway','-c','gateway','--','node','-e',script],process.env).trim();
 const expected=readFileSync(new URL('../src/route-table-v1.sha256',import.meta.url),'utf8').trim();
 if(remote!==expected)throw Error('GPT62_RUNTIME_MUST_PRECEDE_CONFIG');
 return reconcileConfigMap(options,process.env,{transform:reconcileGpt62ProviderConfig,verify:verifyGpt62Config});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('GPT62_CONFIG_RECONCILE_FAILED');process.exitCode=1;});
