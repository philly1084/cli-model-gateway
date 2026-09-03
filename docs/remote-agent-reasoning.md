# Remote-agent reasoning effort contract

`POST /admin/remote-agent-tasks` and `POST /admin/provider-sessions` accept
`reasoningEffort`: `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
The compatibility alias `max` normalizes to `xhigh`. Unknown values return 400.

This is separate from normal OpenAI chat/Responses reasoning.
`OPENAI_REASONING_EFFORT` is not a default for remote coding sessions.

## Request to CLI

Effort is supported for a configured Node session command running
`remote-agent-session-bridge.js --provider codex`. Existing provider YAML works
unchanged. `/admin/provider-capabilities` advertises `supportsReasoningEffort`.
Explicit effort on other providers or login sessions returns 400. Omitted
effort preserves provider defaults and cannot inherit a gateway-process override.

The session manager supplies `GATEWAY_REMOTE_REASONING_EFFORT` per child. The
bridge forwards `--reasoning-effort VALUE` to the configured host wrapper for
fresh and resumed sessions. Explicit bridge CLI arguments take precedence.
Session templates also expose `reasoning_effort` and `reasoningEffort` variables.

The host wrapper must validate the flag, add the matching
`-c model_reasoning_effort="VALUE"` Codex override, preserve actual exit codes,
and emit this exact newline-terminated stdout marker after validating argv:

```text
GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=high
```

Deploy compatible host wrappers before enabling explicit effort requests.
The source-controlled wrapper is maintained in Lilly at
`scripts/remote-cli/codex-remote-run.sh`.

## Receipt semantics

Authenticated task and provider-session summaries expose:

```json
{"reasoningEffortReceipt":{"requested":"high","status":"forwarded"}}
```

A matching unframed wrapper acknowledgement changes it to:

```json
{"reasoningEffortReceipt":{"requested":"high","applied":"high","status":"applied","appliedTo":"cli-invocation"}}
```

This proves application to the CLI invocation, not model-internal thinking.
Missing/mismatched receipts remain `forwarded`. JSON-contained, prefixed, and
unterminated marker text never qualifies. Exact marker lines are stripped from
user transcript output. Consume authenticated summaries, not model prose.
Remote task summaries also expose actual `exitCode` when known; nonzero exits
are failed regardless of claims in generated text.

## Tests

```sh
npm run build
node --test dist/test/remote-reasoning.test.js dist/test/remote-agent-routes.test.js dist/test/remote-agent-session-bridge.test.js dist/test/provider-sessions.test.js dist/test/agent-handoff-managers.test.js
```

Verify a bounded live task's requested model, applied CLI receipt, real exit and
terminal status, plus independent output read-back. A receipt alone is not
proof that a user task finished.
