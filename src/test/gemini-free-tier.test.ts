import test from "node:test";
import assert from "node:assert/strict";
import { profileBackoff, profileRetryAllowed } from "../providers/registry.js";
import { UpstreamError } from "../utils/upstream-error.js";
import { loadProvidersFile } from "../config.js";
import type { ProviderConfig } from "../types.js";

const config: ProviderConfig = { id: "gemini-api", type: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnv: "GEMINI_API_KEY", models: [] };
const error = (status: number, message: string, retryDelay?: string, header?: string) => new UpstreamError(status, [{error:{status:status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE",message,details:retryDelay ? [{"@type":"type.googleapis.com/google.rpc.RetryInfo",retryDelay}] : []}}], true, header);

test("Gemini daily/billing quota exhaustion never retries even with a short RetryInfo", () => {
  for (const message of ["You exceeded your current quota, please check your plan and billing details", "Quota exceeded: GenerateRequestsPerDayPerProject", "daily quota exhausted"]) {
    const upstream = error(429, message, "2s");
    assert.equal(upstream.quotaExhausted, true);
    assert.equal(profileRetryAllowed(config, upstream), false);
    assert.doesNotMatch(upstream.message, /billing|daily|GenerateRequests/);
  }
});

test("Gemini retries only 503 or minute 429 with bounded, valid delay hints", () => {
  assert.equal(profileRetryAllowed(config, error(503, "high demand")), true);
  assert.equal(profileBackoff(config, error(503, "high demand")), 2000);
  for (const delay of ["0s", "2.5s", "10s"]) {
    const upstream = error(429, "per-minute quota", delay);
    assert.equal(profileRetryAllowed(config, upstream), true);
    assert.equal(profileBackoff(config, upstream), Math.max(2000, Number(delay.slice(0,-1))*1000));
  }
  for (const delay of [undefined, "11s", "60s", "invalid", "-1s"]) assert.equal(profileRetryAllowed(config, error(429,"per-minute quota",delay)), false);
  for (const status of [400,401,403,404,500,502,504]) assert.equal(profileRetryAllowed(config,error(status,"other")), false);
  assert.equal(profileRetryAllowed(config,error(503,"high demand","11s")),false);
});

test("Retry-After seconds/date and RetryInfo honor the longest valid delay", () => {
  assert.equal(error(503,"busy",undefined,"3").retryAfterMs,3000);
  assert.equal(error(503,"busy","4s","3").retryAfterMs,4000);
  assert.equal(error(503,"busy","4s","5").retryAfterMs,5000);
  const date = new Date(Date.now()+7000).toUTCString();
  const ms = error(503,"busy",undefined,date).retryAfterMs!;
  assert.ok(ms >= 5000 && ms <= 7000);
  assert.equal(error(503,"busy",undefined,"bad").retryAfterMs,undefined);
});

test("example mirrors every requested free-tier fallback chain", () => {
  const providers = loadProvidersFile("config/providers.example.yaml").providers;
  const chains: Record<string, string[]> = {
    "gemini-3.7-flash": ["gemini-3.5-flash-lite","gemini-3.1-flash-lite","gemini-3-flash-preview","gpt-5.6-luna"],
    "gemini-3.6-flash": ["gemini-3.5-flash-lite","gemini-3.1-flash-lite","gemini-3-flash-preview","gpt-5.6-luna"],
    "gemini-3.5-flash": ["gemini-3.5-flash-lite","gemini-3.1-flash-lite","gemini-3-flash-preview","gpt-5.6-luna"],
    "gemini-3-flash-preview": ["gemini-3.5-flash-lite","gemini-3.1-flash-lite","gpt-5.6-luna"],
    "gemini-3.5-flash-lite": ["gemini-3.1-flash-lite","gemini-3-flash-preview","gpt-5.6-luna"],
    "gemini-3.1-flash-lite": ["gemini-3.5-flash-lite","gemini-3-flash-preview","gpt-5.6-luna"],
    "gemini-3.1-pro-preview": ["gemini-3-flash-preview","gemini-3.5-flash-lite","gpt-5.6-sol"],
  };
  for (const [id, chain] of Object.entries(chains)) {
    const matches = providers.filter(p => p.id.startsWith("gemini")).flatMap(p => p.models ?? []).filter(m => m.id === id);
    assert.ok(matches.length);
    for (const model of matches) assert.deepEqual(model.fallbackModels,chain);
  }
});
