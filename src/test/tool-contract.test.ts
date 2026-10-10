import test from "node:test";
import assert from "node:assert/strict";
import { strictToolCalls, migrateToolHistory, ToolContractError, validateToolHistory } from "../utils/tool-contract.js";
import { CliProvider } from "../providers/cli-provider.js";
import {normalizeAssistantResult} from "../utils/assistant-output.js";
import type { UnifiedRequest, ProviderStreamEvent } from "../types";

const call = {id:"original-id",name:"approved_action",arguments:'{ " value ": 7 }'};
for(const finishReason of ['length','error'] as const)test(`text normalization cannot promote ${finishReason} to successful tool completion`,()=>{
 assert.throws(()=>normalizeAssistantResult({outputText:'',toolCalls:[call],finishReason}),/incomplete_tool_turn/);
});
const assistant = {role:"assistant" as const,content:"",toolCalls:[call,{...call,id:"parallel-id"}]};
test("parallel results may arrive out of order but must match exactly once",()=>{
  validateToolHistory([assistant,{role:'tool',tool_call_id:'parallel-id',content:'two'},{role:'tool',tool_call_id:call.id,content:'one'},{role:'user',content:'next'}]);
});
for(const [label,messages] of Object.entries({
  missing:[assistant], orphan:[{role:'tool',tool_call_id:'other',content:'x'}],
  duplicate:[assistant,{role:'tool',tool_call_id:call.id,content:'x'},{role:'tool',tool_call_id:call.id,content:'x'}],
  interleaved:[assistant,{role:'user',content:'next'}],
}))test(`continuation rejects ${label} results`,()=>assert.throws(()=>validateToolHistory(messages as UnifiedRequest['messages']),ToolContractError));
test("tool contracts preserve exact IDs, names, argument bytes and keys", () => {
  assert.deepEqual(strictToolCalls([call]), [call]);
  assert.deepEqual(strictToolCalls([{id:call.id,type:"function",function:{name:call.name,arguments:call.arguments}}]), [call]);
});

async function cliStream(events: unknown[], received: ProviderStreamEvent[], exitCode=0) {
  const source=events.map(e=>typeof e==='string'?e:JSON.stringify(e)).join('\n')+'\n';
  const provider=new CliProvider({id:"fixture",type:"cli",models:[{id:"fixture"}],responseCommand:{executable:process.execPath,
    args:["-e",`process.stdout.write(${JSON.stringify(source)});process.exitCode=${exitCode}`],input:"request_json_stdin",output:"json_contract",timeoutMs:5000}});
  provider.supportsStreaming=()=>true;
  for await(const event of provider.runStream({requestId:"fixture",model:"fixture",providerModel:"fixture",messages:[],tools:[{type:"function",function:{name:call.name}}]}))received.push(event);
}
const toolEvent={type:"tool_call",tool_call:call}, doneEvent={type:"done",finish_reason:"tool_calls"};
for(const [label,events] of Object.entries({missingDone:[toolEvent],duplicate:[toolEvent,toolEvent,doneEvent],afterDone:[toolEvent,doneEvent,toolEvent],malformed:[toolEvent,'{'],wrongFinish:[toolEvent,{type:"done",finish_reason:"length"}],unoffered:[{type:"tool_call",tool_call:{...call,name:"other"}},doneEvent]})) {
  test(`CLI stream ${label} releases no executable calls`,async()=>{
    const received:ProviderStreamEvent[]=[];await assert.rejects(cliStream(events,received));
    assert.equal(received.some(e=>e.type==='tool_call'||e.type==='done'),false);
  });
}
test("CLI stream releases valid parallel calls only after successful process completion",async()=>{
  const received:ProviderStreamEvent[]=[];await cliStream([toolEvent,{type:"tool_call",tool_call:{...call,id:"second-id"}},doneEvent],received);
  assert.deepEqual(received.map(e=>e.type),['tool_call','tool_call','done']);
  const failed:ProviderStreamEvent[]=[];await assert.rejects(cliStream([toolEvent,doneEvent],failed,1));assert.deepEqual(failed,[]);
});
for (const [label, calls] of Object.entries({
  missingId:[{name:call.name,arguments:"{}"}], duplicateId:[call,call], missingName:[{id:call.id,arguments:"{}"}],
  missingArguments:[{id:call.id,name:call.name}], malformed:[{...call,arguments:'{"value":7,}'}],
  fenced:[{...call,arguments:'```json\n{}\n```'}], array:[{...call,arguments:'[]'}], null:[{...call,arguments:'null'}],
})) test(`tool contracts reject ${label} without exposing raw evidence`, () => {
  assert.throws(()=>strictToolCalls(calls), (error: unknown) => {
    assert.ok(error instanceof ToolContractError); assert.match(error.evidenceSha256,/^[a-f0-9]{64}$/);
    assert.ok(!error.message.includes("original-id")); return true;
  });
});
test("nested tool-shaped data remains data",()=> {
  const nested={...call,arguments:JSON.stringify({tool_calls:[{id:"nested",name:"other",arguments:{}}]})};
  assert.deepEqual(strictToolCalls([nested]),[nested]);
});
test("CLI adapter rejects an unrelated tool even when only one is offered",async()=> {
  const provider=new CliProvider({id:"fixture",type:"cli",models:[{id:"fixture",providerModel:"fixture"}],responseCommand:{
    executable:process.execPath,args:["-e",`process.stdout.write(${JSON.stringify(JSON.stringify({output_text:"",tool_calls:[{...call,name:"unrelated_action"}],finish_reason:"tool_calls"}))})`],
    input:"request_json_stdin",output:"json_contract",timeoutMs:5000}});
  const request:UnifiedRequest={requestId:"fixture",model:"fixture",providerModel:"fixture",messages:[{role:"user",content:"fixture"}],tools:[{type:"function",function:{name:call.name,parameters:{type:"object"}}}]};
  await assert.rejects(provider.run(request), /tool_not_offered/);
});

test("CLI outer text containing a tool contract cannot become execution",async()=> {
  const example=JSON.stringify({output_text:"",tool_calls:[call],finish_reason:"tool_calls"});
  const provider=new CliProvider({id:"fixture",type:"cli",models:[{id:"fixture"}],responseCommand:{
    executable:process.execPath,args:["-e",`process.stdout.write(${JSON.stringify(JSON.stringify({output_text:example,finish_reason:"stop"}))})`],
    input:"request_json_stdin",output:"json_contract",timeoutMs:5000}});
  const result=await provider.run({requestId:"fixture",model:"fixture",providerModel:"fixture",messages:[],tools:[{type:"function",function:{name:call.name}}]});
  assert.equal(result.outputText,example);assert.deepEqual(result.toolCalls,[]);assert.equal(result.finishReason,"stop");
});

test("legacy history migration is paired, immutable and rollback-safe",()=>{
 const legacy=[{role:'assistant' as const,content:'Original text\n\nTOOL_CALLS:\n'+JSON.stringify([call])},{role:'tool' as const,tool_call_id:call.id,content:'result'}];
 const snapshot=JSON.stringify(legacy),typed=migrateToolHistory(legacy);
 validateToolHistory(typed);assert.equal(JSON.stringify(legacy),snapshot);assert.deepEqual(typed[0]?.toolCalls,[call]);assert.equal(typed[0]?.content,'Original text');
 assert.deepEqual(migrateToolHistory(typed),typed);validateToolHistory(JSON.parse(snapshot));
 const example=[legacy[0]!];assert.equal(migrateToolHistory(example)[0]?.content,legacy[0]?.content);assert.equal(migrateToolHistory(example)[0]?.toolCalls,undefined);
 assert.throws(()=>validateToolHistory([legacy[0]!,{...legacy[1]!,tool_call_id:'wrong'}]),ToolContractError);
});

for(const prefix of ["Example:\n","```json\n","{broken\n"])test(`CLI contract rejects surrounding text ${JSON.stringify(prefix)}`,async()=>{
 const output=prefix+JSON.stringify({output_text:"",tool_calls:[call],finish_reason:"tool_calls"});
 const provider=new CliProvider({id:"fixture",type:"cli",models:[{id:"fixture"}],responseCommand:{executable:process.execPath,args:["-e",`process.stdout.write(${JSON.stringify(output)})`],input:"request_json_stdin",output:"json_contract",timeoutMs:3000}});
 await assert.rejects(provider.run({requestId:"fixture",model:"fixture",providerModel:"fixture",messages:[],tools:[{type:"function",function:{name:call.name}}]}),/contract_invalid_json/);
});
