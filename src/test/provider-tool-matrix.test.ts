import test from "node:test";
import assert from "node:assert/strict";
import {OpenAiCompatibleProvider} from "../providers/openai-compatible-provider.js";
import type {UnifiedRequest,ProviderStreamEvent} from "../types";
const offered={type:"function" as const,function:{name:"calculate",parameters:{type:"object",properties:{a:{type:"number"}},required:["a"],additionalProperties:false}}};
const call={id:"original",name:"calculate",arguments:'{"a":7}'};
const request:UnifiedRequest={requestId:"fixture",model:"fixture",providerModel:"fixture",messages:[{role:"user",content:"fixture"}],tools:[offered]};
for(const profile of ['openai','anthropic'] as const)test(`${profile} buffered tool identity/arguments/continuation matrix`,async()=>{
 const oldFetch=globalThis.fetch,oldKey=process.env.PROTOCOL_FIXTURE_KEY;process.env.PROTOCOL_FIXTURE_KEY='synthetic';let variant='valid';const bodies:Record<string,unknown>[]=[];
 globalThis.fetch=(async(_url,init)=>{
  bodies.push(JSON.parse(String(init?.body)));const c={...call,...(variant==='missing-id'?{id:undefined}:{}),...(variant==='unoffered'?{name:'unrelated'}:{}),...(variant==='malformed'?{arguments:'{"a":7,}'}:{})};
  if(variant==='text-example'){const text=JSON.stringify({tool_calls:[call],finish_reason:'tool_calls'});return Response.json(profile==='openai'?{choices:[{message:{content:text},finish_reason:'stop'}]}:{content:[{type:'text',text}],stop_reason:'end_turn'});}
  return Response.json(profile==='openai'?{choices:[{message:{content:'',tool_calls:[{id:c.id,type:'function',function:{name:c.name,arguments:c.arguments}}]},finish_reason:variant==='truncated'?'length':'tool_calls'}]}:{content:[{type:'tool_use',id:c.id,name:c.name,input:variant==='malformed'?[]:{a:7}}],stop_reason:variant==='truncated'?'max_tokens':'tool_use'});
 })as typeof fetch;
 try{
  const provider=await OpenAiCompatibleProvider.create({id:'fixture',type:'openai',baseUrl:profile==='anthropic'?'https://api.kimi.com/coding/v1':'https://example.invalid/v1',apiKeyEnv:'PROTOCOL_FIXTURE_KEY',models:[{id:'fixture'}]});
  const result=await provider.run(request);assert.deepEqual(result.toolCalls,[call]);
  variant='text-example';const example=await provider.run(request);assert.deepEqual(example.toolCalls,[]);assert.match(example.outputText,/tool_calls/);assert.equal(example.finishReason,'stop');
  for(variant of ['missing-id','unoffered','malformed','truncated'])await assert.rejects(provider.run(request));
  variant='valid';const continuation={...request,messages:[...request.messages,{role:'assistant' as const,content:'TOOL_CALLS:\n'+JSON.stringify([call,{...call,id:'parallel'}])},{role:'tool' as const,tool_call_id:'parallel',content:'two'},{role:'tool' as const,tool_call_id:call.id,content:'one'}]};await provider.run(continuation);
  const messages=bodies.at(-1)!.messages as Array<Record<string,unknown>>;
  if(profile==='anthropic'){assert.equal(messages.length,3);assert.deepEqual(messages[2]!.content,[{type:'tool_result',tool_use_id:'parallel',content:'two'},{type:'tool_result',tool_use_id:'original',content:'one'}]);}
  else assert.deepEqual(messages.slice(-2).map(m=>m.tool_call_id),['parallel','original']);
  const before=bodies.length;await assert.rejects(provider.run({...request,messages:[{role:'tool',content:'orphan',tool_call_id:'missing'}]}));assert.equal(bodies.length,before);
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.PROTOCOL_FIXTURE_KEY;else process.env.PROTOCOL_FIXTURE_KEY=oldKey;}
});
test('a later unoffered streamed call prevents release of the whole tool batch',async()=>{
 const oldFetch=globalThis.fetch,oldKey=process.env.PROTOCOL_FIXTURE_KEY;process.env.PROTOCOL_FIXTURE_KEY='synthetic';
 const chunk={choices:[{index:0,delta:{tool_calls:[{index:0,id:'one',type:'function',function:{name:'calculate',arguments:'{"a":7}'}},{index:1,id:'two',type:'function',function:{name:'unoffered',arguments:'{}'}}]},finish_reason:'tool_calls'}]};
 globalThis.fetch=(async()=>new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}))as typeof fetch;
 try{const provider=await OpenAiCompatibleProvider.create({id:'fixture',type:'openai',baseUrl:'https://example.invalid/v1',apiKeyEnv:'PROTOCOL_FIXTURE_KEY',models:[{id:'fixture'}]});const events:ProviderStreamEvent[]=[];await assert.rejects(async()=>{for await(const event of provider.runStream(request))events.push(event);},/tool_not_offered/);assert.deepEqual(events,[]);}
 finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.PROTOCOL_FIXTURE_KEY;else process.env.PROTOCOL_FIXTURE_KEY=oldKey;}
});
