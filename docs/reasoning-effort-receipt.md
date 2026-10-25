# Reasoning effort receipts

Normal chat completions (including message aliases) and Responses requests accept
`reasoning_effort`, `reasoningEffort`, and `reasoning: { effort: "low" }`.
Precedence follows that order. A configured default alone does not produce a receipt.

When effort is explicitly requested, `x-reasoning-effort-receipt` contains compact JSON:

```json
{"requested":"none","forwarded":"low","applied":"unconfirmed","model":"gpt-6.1-sol","providerId":"codex-cli","normalizedFrom":"none"}
```

Non-streaming JSON also includes the same object at `reasoning_effort_receipt`.
Streaming exposes the receipt in the header only, with no extra SSE fields.
`model` and `providerId` identify the selected gateway model/provider, including fallbacks.
`forwarded` is the provider value (including adapter spellings such as `max`);
it is null when the adapter does not forward an effort option.
`normalizedFrom` appears when the forwarded value differs from the requested effort.
The existing `max` request alias is parsed as `xhigh`.

Known model restrictions are normalized before dispatch: GPT-6.1 Sol maps none/minimal
to low; o1/o3/o4 and GPT-OSS map to the nearest low/medium/high value. Unknown models
retain their requested value; the gateway cannot infer undocumented provider restrictions.
Existing Groq and DeepSeek translations are reflected in the receipt.

`applied: true` means structured provider metadata confirmed the forwarded effort;
`false` means it explicitly returned a different effort. Neither proves model-internal
reasoning behavior. Missing confirmation is `"unconfirmed"`, even on HTTP success.
The Codex bridge surfaces effort returned by thread/turn startup and turn completion.
Streaming headers reflect confirmation available before the first event; later
confirmation cannot update already-sent headers. Assistant-generated text is never
used as confirmation.

## Bounded measurement

Set `ROUTER_BASE_URL` (origin or a `/v1` base) and `ROUTER_API_KEY` in the environment:

```sh
node scripts/measure-reasoning-effort.mjs [model] [runs-per-effort]
```

Defaults: gpt-6.1-sol, three low and three medium calls, max_tokens 512, fixed ZZTEST
prompt, sequential calls, no retries, 120-second timeout per call. Runs must be 1–5
(at most ten calls total). The table shows latency, provider token counts and receipt;
unavailable usage is not guessed. Credentials are never printed or persisted.

Tests compile under `npm run build` and are discovered by the existing `npm test`
compiled test runner. They use ZZTEST fixtures and mocked provider transport.
