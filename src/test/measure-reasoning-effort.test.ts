import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("ZZTEST measurement caps calls and redacts unexpected credential echoes", () => {
  const script = pathToFileURL(resolve("scripts/measure-reasoning-effort.mjs")).href;
  const code = `
    const assert = require('node:assert/strict');
    let calls = 0;
    process.argv = ['node', 'ZZTEST', 'gpt-6.1-sol', '5'];
    globalThis.fetch = async (url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.max_tokens, 512);
      assert.equal(body.messages.length, 1);
      assert.match(body.messages[0].content, /^ZZTEST:/);
      assert.equal(body.reasoning_effort, calls <= 5 ? 'low' : 'medium');
      return new Response(JSON.stringify({usage:{prompt_tokens:1,completion_tokens:2,completion_tokens_details:{reasoning_tokens:1}},reasoning_effort_receipt:process.env.ROUTER_API_KEY}));
    };
    import(${JSON.stringify(script)}).then(() => { assert.equal(calls, 10); console.log('ZZTEST calls: 10'); });
  `;
  const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", windowsHide: true,
    env: { ...process.env, ROUTER_BASE_URL: "https://zztest.invalid/v1", ROUTER_API_KEY: "ZZTEST-secret-sentinel" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ZZTEST calls: 10/);
  assert.match(result.stdout, /\[redacted\]/);
  assert.doesNotMatch(result.stdout + result.stderr, /ZZTEST-secret-sentinel/);
});

test("ZZTEST measurement rejects more than ten calls before dispatch", () => {
  const result = spawnSync(process.execPath, ["scripts/measure-reasoning-effort.mjs", "gpt-6.1-sol", "6"], {
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, ROUTER_BASE_URL: "https://zztest.invalid", ROUTER_API_KEY: "ZZTEST" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runs-per-effort:1\.\.5/);
});
