import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {openAiRoutes} from '../routes/openai';
import {ProviderRegistry} from '../providers/registry';
test('authenticated discovery advertises only the enforced execution contract without dispatch',async()=>{
 const registry=await ProviderRegistry.create([{id:'fixture',type:'cli',models:[{id:'chosen',providerModel:'upstream'}],responseCommand:{executable:process.execPath,args:[],timeoutMs:1000,input:'request_json_stdin',output:'json_contract'}}]);
 let calls=0;registry.getProvider('fixture')!.run=async()=>{calls++;throw Error('Inference forbidden');};
 const app=Fastify({logger:false});await app.register(openAiRoutes,{registry,n8nApiKeys:new Set(['fixture-key'])});
 try{
  assert.equal((await app.inject({method:'GET',url:'/models'})).statusCode,401);
  const response=await app.inject({method:'GET',url:'/models',headers:{authorization:'Bearer fixture-key'}});
  assert.equal(response.statusCode,200);const row=response.json().data.find((item:{id:string})=>item.id==='chosen');
  assert.equal(row.owned_by,'fixture');assert.equal(row.provider_model,'upstream');assert.equal(row.execution_policy_version,1);
  assert.equal(row.routing_policy_version,undefined);assert.equal(calls,0);
 }finally{await app.close();}
});
