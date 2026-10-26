import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexAppServerArgs, prepareToolCatalog, parseToolCallFromRawItem } from "../scripts/codex-appserver-bridge.js";

const originalArgs = ["app-server", "--listen", "stdio://"];
const toolArgs = [
  ...originalArgs,
  "-c", "features.code_mode_host=false",
  "-c", "features.unified_exec=false",
  "-c", "features.shell_tool=false",
  "-c", "features.code_mode=false",
  "-c", "features.code_mode_only=false",
];

test("app-server feature args are conditional and return independent arrays", () => {
  assert.deepEqual(codexAppServerArgs(false, "ZZTEST"), originalArgs);
  assert.deepEqual(codexAppServerArgs(true, "ZZTEST"), [...toolArgs, "-c", 'model_catalog_json="ZZTEST"']);
  assert.deepEqual(codexAppServerArgs(false), originalArgs);
  assert.deepEqual(codexAppServerArgs(true), toolArgs);
  assert.notEqual(codexAppServerArgs(true), codexAppServerArgs(true));
  assert.notEqual(codexAppServerArgs(false), codexAppServerArgs(false));
});

const fake = `const {appendFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
writeFileSync(join(__dirname,'ZZTEST-args.json'),JSON.stringify(process.argv.slice(2)));
const catalogArg=process.argv.find(a=>a.startsWith('model_catalog_json='));
if(catalogArg) {
 const value=catalogArg.slice('model_catalog_json='.length);
 const path=value.startsWith('"')?JSON.parse(value):value;
 writeFileSync(join(__dirname,'ZZTEST-catalog.json'),require('node:fs').readFileSync(path));
 writeFileSync(join(__dirname,'ZZTEST-catalog-path.txt'),path);
}
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') {
  appendFileSync(join(__dirname,'ZZTEST-starts.jsonl'),JSON.stringify(m.params)+'\\n');
  if(m.params.model==='codex-latest') send({id:m.id,error:{message:'ZZTEST codex-latest not supported for ChatGPT account'}});
  else send({id:m.id,result:{thread:{id:'ZZTEST-thread'}}});
 }
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'ZZTEST-turn'}}});
  send({method:'item/completed',params:{item:{type:'agentMessage',text:'ZZTEST'}}});
  send({method:'turn/completed',params:{turn:{id:'ZZTEST-turn',status:'completed'}}});
 }
});`;

const fixtureCatalog = { fetched_at: "ZZTEST", etag: "ZZTEST", client_version: "0.144.1", models: [
  { slug: "ZZTEST", tool_mode: "code_mode_only", base_instructions: "ZZTEST", use_responses_lite: true, nested: { ZZTEST: [1, 2] } },
  { slug: "ZZTEST-fallback", tool_mode: "code_mode", description: "ZZTEST" },
] };
for (const catalog of ["missing", "valid", "invalid"] as const) {
for (const tools of ["omitted", "empty", "dynamic"] as const) {
  const hasTools = tools === "dynamic";
  for (const fallback of [false, true]) {
    test(`ZZTEST app-server spawn and cleanup tools=${tools}, fallback=${fallback}, catalog=${catalog}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "ZZTEST-builtin-tools-"));
      let child: ReturnType<typeof spawn> | undefined;
      try {
        if (catalog !== "missing") await writeFile(join(dir, "models_cache.json"), catalog === "valid" ? JSON.stringify(fixtureCatalog) : "{ZZTEST");
        const cli = join(dir, process.platform === "win32" ? "ZZTEST-codex.cmd" : "ZZTEST-codex");
        const script = join(dir, "ZZTEST-fake.cjs");
        await writeFile(script, fake);
        await writeFile(cli, process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "%~dp0ZZTEST-fake.cjs" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o700 });
        child = spawn(process.execPath, [resolve("dist/scripts/codex-appserver-bridge.js"), fallback ? "codex-latest" : "ZZTEST"], {
          env: { ...process.env, CODEX_HOME: dir, CODEX_EXECUTABLE: cli, CODEX_APPSERVER_MODEL_PROVIDER: "ZZTEST", CODEX_APPSERVER_CHATGPT_FALLBACK_MODEL: "ZZTEST", OPENAI_REASONING_EFFORT: "low", CODEX_APPSERVER_TIMEOUT_MS: "5000" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", value => { stderr += value; });
        child.stdout?.resume();
        child.stdin?.end(JSON.stringify({ messages: [{ role: "user", content: "ZZTEST" }], reasoningEffort: "low", tools: hasTools ? [{ type: "function", function: { name: "ZZTEST", description: "ZZTEST", parameters: { type: "object", properties: {} } } }] : tools === "empty" ? [] : undefined }));
        const code = await new Promise<number | null>((done, reject) => {
          child!.on("error", reject);
          child!.on("close", done);
        });
        assert.equal(code, 0, stderr);
        const args: string[] = JSON.parse(await readFile(join(dir, "ZZTEST-args.json"), "utf8"));
        if (hasTools && catalog === "valid") {
          const path = await readFile(join(dir, "ZZTEST-catalog-path.txt"), "utf8");
          assert.deepEqual(args, [...toolArgs, "-c", `model_catalog_json=${process.platform === "win32" ? path : JSON.stringify(path)}`]);
          assert.deepEqual(JSON.parse(await readFile(join(dir, "ZZTEST-catalog.json"), "utf8")), {
            ...fixtureCatalog, models: fixtureCatalog.models.map(model => ({ ...model, tool_mode: "direct" })),
          });
          await assert.rejects(access(path));
        } else assert.deepEqual(args, hasTools ? toolArgs : originalArgs);
        const starts = (await readFile(join(dir, "ZZTEST-starts.jsonl"), "utf8")).trim().split("\n");
        const models = fallback ? ["codex-latest", "ZZTEST"] : ["ZZTEST"];
        assert.equal(starts.length, models.length);
        for (const [index, model] of models.entries()) {
          const oldParams = { model, modelProvider: "ZZTEST", reasoningEffort: "low", approvalPolicy: "never", sandbox: "read-only", experimentalRawEvents: true, persistExtendedHistory: false };
          const expected = hasTools ? { ...oldParams, dynamicTools: [{ name: "ZZTEST", description: "ZZTEST", inputSchema: { type: "object", properties: {} } }] } : oldParams;
          assert.equal(starts[index], JSON.stringify(expected));
        }
      } finally {
        child?.kill();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

}

test("ZZTEST tool catalog permissions, malformed shapes, and idempotent cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZZTEST-catalog-"));
  let catalog: ReturnType<typeof prepareToolCatalog>;
  try {
    assert.equal(prepareToolCatalog(true, dir), undefined);
    for (const value of [null, [], {}, { models: [] }, { models: [null] }, { models: [{}] }]) {
      await writeFile(join(dir, "models_cache.json"), JSON.stringify(value));
      assert.equal(prepareToolCatalog(true, dir), undefined);
    }
    await writeFile(join(dir, "models_cache.json"), JSON.stringify(fixtureCatalog));
    assert.equal(prepareToolCatalog(false, dir), undefined);
    catalog = prepareToolCatalog(true, dir);
    assert.ok(catalog);
    if (process.platform !== "win32") assert.equal((await stat(catalog.path)).mode & 0o777, 0o600);
    catalog.cleanup();
    catalog.cleanup();
    await assert.rejects(access(catalog.path));
  } finally { catalog?.cleanup(); await rm(dir, { recursive: true, force: true }); }
});

test("ZZTEST recorder function_call retains call ID and argument bytes", () => {
  const item = { type: "function_call", id: "fc_ZZTEST", call_id: "call_ZZTEST", name: "blender_build", arguments: '{"script":"ZZTEST","timeoutSeconds":1}' };
  assert.deepEqual(parseToolCallFromRawItem(item), { id: item.call_id, name: item.name, arguments: item.arguments });
});
