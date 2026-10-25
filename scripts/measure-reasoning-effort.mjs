#!/usr/bin/env node
// Deliberately sequential and bounded; no retries or credential persistence.
const args = process.argv.slice(2);
const model = args[0] ?? "gpt-6.1-sol";
const runs = Number(args[1] ?? 3);
if (args.length > 2 || !Number.isInteger(runs) || runs < 1 || runs * 2 > 10) {
  console.error("Usage: node scripts/measure-reasoning-effort.mjs [model] [runs-per-effort:1..5]");
  process.exit(1);
}
const base = process.env.ROUTER_BASE_URL;
const key = process.env.ROUTER_API_KEY;
if (!base || !key) {
  console.error("ROUTER_BASE_URL and ROUTER_API_KEY must be set.");
  process.exit(1);
}
let url;
try {
  const root = new URL(base);
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw Error();
  url = root.href.replace(/\/$/, "");
  url += /\/v1$/.test(url) ? "/chat/completions" : "/v1/chat/completions";
} catch {
  console.error("ROUTER_BASE_URL must be an HTTP(S) base URL without credentials, query, or fragment.");
  process.exit(1);
}
const rows = [];
for (const effort of ["low", "medium"]) {
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, reasoning_effort: effort, max_tokens: 512,
          messages: [{ role: "user", content: "ZZTEST: Return only the sum of 17 and 25." }] }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        rows.push({ effort, "latency ms": Math.round(performance.now() - start), status: response.status });
        process.exitCode = 1;
        continue;
      }
      const body = await response.json();
      const usage = body.usage ?? {};
      const receipt = body.reasoning_effort_receipt ?? response.headers.get("x-reasoning-effort-receipt");
      // Redact even unexpected credential echoes from an upstream service.
      const safe = value => String(value ?? "unavailable").split(key).join("[redacted]");
      rows.push({ effort, "latency ms": Math.round(performance.now() - start),
        "prompt tokens": safe(usage.prompt_tokens), "completion tokens": safe(usage.completion_tokens),
        "reasoning tokens": safe(usage.completion_tokens_details?.reasoning_tokens),
        receipt: safe(typeof receipt === "object" ? JSON.stringify(receipt) : receipt) });
    } catch {
      rows.push({ effort, "latency ms": Math.round(performance.now() - start), status: "request failed or timed out" });
      process.exitCode = 1;
    }
  }
}
console.table(rows);
