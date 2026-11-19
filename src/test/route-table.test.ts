import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {routeTable,modelRoute,normalizeRouteEffort,routeAdmits,requireGpt62Binding,isProfileManagedModel,validateRouteTable} from '../utils/route-table.js';
import {normalizeModelReasoningEffort,buildReasoningEffortReceipt,validateGpt62RequestEffort} from '../utils/reasoning.js';
import {imageRequest} from '../utils/image-input.js';
import type {UnifiedRequest} from '../types.js';
test('shared schema and exact content digest agree with Brain publication',()=>{
 assert.equal(routeTable.schemaVersion,1);
 assert.equal(createHash('sha256').update(readFileSync('src/route-table-v1.json')).digest('hex'),readFileSync('src/route-table-v1.sha256','utf8').trim());
 assert.throws(()=>modelRoute('unknown'));
 assert.throws(()=>requireGpt62Binding('openai-api','gpt-6.2-sol','gpt-6.2-sol'));
 assert.equal(isProfileManagedModel('gpt-6-luna'),true);
 assert.equal(isProfileManagedModel('gpt-6-astra'),false);
 assert.throws(()=>validateRouteTable({...routeTable,workClasses:{...routeTable.workClasses,broken:{model:'gpt-6.2-sol',effort:'medium'}} as unknown as typeof routeTable.workClasses}));
 for(const m of ['gpt-6.2-sol','gpt-6.2-astra']){const r=modelRoute(m);assert.equal(r.manualOnly,true);assert.equal(r.autoEligible,false);}
});
test('profile managed models accept the four efforts, map aliases and reject unsupported values',()=>{
 for(const model of ['gpt-6.2-sol','gpt-6.2-astra','gpt-6-luna']){
  for(const effort of ['low','medium','high','xhigh'] as const)assert.equal(normalizeModelReasoningEffort(model,effort),effort);
  for(const effort of ['none','minimal'] as const)assert.equal(normalizeModelReasoningEffort(model,effort),'low');
  assert.equal(normalizeRouteEffort(model,'max'),'xhigh');assert.equal(normalizeModelReasoningEffort(model),'medium');
  assert.throws(()=>normalizeRouteEffort(model,'ultra'));assert.throws(()=>normalizeRouteEffort(model,'bogus'));
  for(const fields of [{reasoning_effort:'bogus'},{reasoningEffort:'ultra'},{reasoning:{effort:42}}])assert.throws(()=>validateGpt62RequestEffort(model,fields,'medium'),/MODEL_EFFORT_UNSUPPORTED/);
  assert.equal(validateGpt62RequestEffort(model,{reasoning:{effort:'max'}},'medium'),'xhigh');
  assert.equal(validateGpt62RequestEffort(model,{},'high'),'high');
  assert.deepEqual(buildReasoningEffortReceipt('max','xhigh',model,'codex-cli',true),{requested:'max',normalized:'xhigh',forwarded:'xhigh',applied:true,appliedEffort:'xhigh',normalizedFrom:'max',model,providerId:'codex-cli'});
 }
});
const request=():Omit<UnifiedRequest,'model'|'providerModel'>=>({requestId:'fixture',requestKind:'chat_completions',stream:false,messages:[{role:'user',content:'Synthetic fixture'}],tools:[],metadata:{brain_scene_knowledge:{version:1,role:'actor',source:'scene_knowledge'}}});
test('knowledge is codex-only, ephemeral-scoped and single-attempt',()=>{
 for(const model of ['gpt-6.2-sol','gpt-6.2-astra']){
  const result=imageRequest(request(),'codex-cli',model);assert.equal((result.metadata?.gateway_policy as {maxAttempts:number}).maxAttempts,1);
  for(const provider of ['kimi-code-api','deepseek-api','openai-api'])assert.throws(()=>imageRequest(request(),provider,model));
  assert.throws(()=>imageRequest({...request(),stream:true},'codex-cli',model));
  assert.throws(()=>imageRequest({...request(),requestKind:'responses'},'codex-cli',model));
 }
 assert.throws(()=>imageRequest(request(),'codex-cli','unknown'));
});
test('image route admission is explicit and independent from provider image capability',()=>{
 assert.equal(routeAdmits('codex-cli','gpt-6.2-astra','actorPreview'),false);
 assert.equal(routeAdmits('codex-cli','gpt-6.2-sol','actorPreview'),false);
 assert.equal(routeAdmits('deepseek-api','gpt-6.2-astra','actorPreview'),false);
 assert.equal(routeAdmits('codex-cli','gpt-6.2-astra','reviewerImages'),false);
 assert.equal(routeAdmits('codex-cli','gpt-6.2-sol','reviewerImages'),false);
 assert.equal(routeAdmits('codex-cli','gpt-6-luna','actorPreview'),false);
 assert.equal(routeAdmits('codex-cli','gpt-6-luna','reviewerImages'),true);
 assert.equal(routeAdmits('codex-cli','unknown','reviewerImages'),false);
});
test('unavailable legacy routes stay closed while Luna reviewer images are admitted',t=>{
 const actorFlag=process.env.GATEWAY_BRAIN_SCENE_ACTOR_IMAGES;process.env.GATEWAY_BRAIN_SCENE_ACTOR_IMAGES='1';
 t.after(()=>{if(actorFlag===undefined)delete process.env.GATEWAY_BRAIN_SCENE_ACTOR_IMAGES;else process.env.GATEWAY_BRAIN_SCENE_ACTOR_IMAGES=actorFlag;});
 const old=process.env.GATEWAY_REVIEWER_IMAGE_ROUTES;
 process.env.GATEWAY_REVIEWER_IMAGE_ROUTES=JSON.stringify([{provider:'codex-cli',model:'gpt-6-luna'}]);
 t.after(()=>{if(old===undefined)delete process.env.GATEWAY_REVIEWER_IMAGE_ROUTES;else process.env.GATEWAY_REVIEWER_IMAGE_ROUTES=old;});
 const bytes=Buffer.from([255,216,255,217]),data=bytes.toString('base64');
 const req={...request(),messages:[{role:'user' as const,content:'Synthetic image',inputImages:[{mediaType:'image/jpeg' as const,data}]}],metadata:{brain_scene_preview:{version:1,role:'actor',source:'scene_preview',images:[{sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mime:'image/jpeg'}]}}};
 assert.throws(()=>imageRequest(req,'codex-cli','gpt-6-luna'),/ACTOR_PREVIEW_ROUTE_UNSUPPORTED/);
 for(const model of ['gpt-6.2-sol','deepseek-v4-pro','unknown'])assert.throws(()=>imageRequest(req,'codex-cli',model));
 const review={...req,metadata:{brain_scene_review:{version:1,role:'verifier',source:'scene_review'}}};
 assert.equal((imageRequest(review,'codex-cli','gpt-6-luna').metadata?.gateway_policy as {maxAttempts:number}).maxAttempts,1);
 assert.throws(()=>imageRequest(review,'openai-api','gpt-6-luna'));
});
