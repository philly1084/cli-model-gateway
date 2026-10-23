const readline = require('node:readline');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const mode = process.argv[2];
if (mode === 'exit') process.exit(7);
if (mode === 'eol-out' || mode === 'eol-err') {
  const stream = mode === 'eol-out' ? process.stdout : process.stderr;
  stream.write('kimi-cli is no longer main');
  setTimeout(() => {
    stream.write('tained. Please use the new Kimi Code CLI\n');
    process.exit(0);
  }, 20);
} else {
  const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\n');
  readline.createInterface({input:process.stdin}).on('line', line => {
    const {id, method, params} = JSON.parse(line);
    if (method === 'initialize') {
      assert.equal(params.protocolVersion, 1);
      if (mode !== 'legacy') {
        assert.equal(process.env.KIMI_MODEL_NAME, mode);
        assert.equal(process.env.KIMI_MODEL_API_KEY, process.env.KIMI_CODE_API_KEY);
        assert.equal(process.env.KIMI_MODEL_BASE_URL, 'https://api.kimi.com/coding/v1');
        assert.ok(fs.statSync(process.env.KIMI_CODE_HOME).isDirectory());
        for (const name of ['KIMI_DISABLE_TELEMETRY','KIMI_CODE_NO_AUTO_UPDATE','KIMI_CODE_TRUST_WORKSPACE']) assert.equal(process.env[name], '1');
      }
      send({id, result:{protocolVersion:1}});
    } else if (method === 'session/new') {
      send({id, result:{sessionId:'fixture-session',configOptions:[{id:'model',category:'model',currentValue:mode==='legacy'?'k3':'__kimi_env_model__',options:[{value:'k3',name:'k3'}]}]}});
    } else if (method === 'session/prompt') {
      send({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'available_commands_update',availableCommands:[]}}});
      const chunks = mode === 'eol-content' ? ['kimi-cli is no longer maintained'] : ['ACP ', 'OK'];
      for (const text of chunks) send({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
      send({id,result:{stopReason:'end_turn'}});
    } else {
      send({id,error:{code:-32601,message:'Unexpected model/config mutation'}});
    }
  });
}
