# Provider tool protocol review

## Codex custom tool input compatibility

For raw `custom_tool_call` only, a string containing a JSON object is preserved
byte-for-byte. Otherwise the offered function's object schema must identify one
string field: use its sole required property if that property is a string; failing
that, use its sole property if it is a string. Free text becomes
`JSON.stringify({ [field]: input })`. Thus `blender_build` with required `script`
and optional numeric `timeoutSeconds` receives the original text in `script`.
Non-string input, absent schemas, and ambiguous schemas fail with
`custom_tool_input_unmappable`. A declared field `maxLength` counts Unicode code
points and fails with `custom_tool_input_too_long`; text is never truncated. The
256 KB UTF-8 argument limit applies both before and after wrapping. This conversion
does not rename tools, guess fields, or change raw `function_call` validation.

The existing app-server `dynamicTools` declaration already supplies `inputSchema`.
No additional JSON function-call selector is established by this repository's
protocol, so the declaration remains unchanged; the adapter conversion is required
even when the schema was supplied.

Tool contract failures terminate the bridge successfully (exit 0) with a JSONL
error event rather than a broken process stream:
`{"type":"error","error":{"message":"Provider tool contract rejected: custom_tool_input_unmappable.","type":"provider_tool_contract_invalid","code":"custom_tool_input_unmappable","param":null,"retryable":true}}`.
There is no success `done` after this terminal error. The CLI provider decodes it
as `ToolContractError`, discards buffered tool proposals, and preserves the issue
code. Chat SSE sends `data: {"error":{...}}`; Responses SSE sends an `error` event
whose data adds `type:"error",object:"error"` to that envelope. Both terminate with
`data: [DONE]` and close normally. Buffered requests return HTTP 502 with the same
error envelope. Retryable describes a new planning attempt, never automatic tool
execution or replay. Error messages contain only the issue code; rejected input
and child stderr are not forwarded on this path.

This draft addresses a reproduced adapter failure: when only one function was offered,
the CLI adapter changed an unrelated function name to that function, repaired malformed
JSON, and renamed argument keys. That could turn an invalid proposal into an executable
one. Reproduction uses a local Node fixture, not inference or credentials.

The adapter now requires exact offered names, nonempty original call IDs, JSON object
arguments, complete tool results, and consistent completion. JSON strings and keys are
preserved. CLI streams hold tool calls until a successful process exit and terminal
event; duplicate IDs, malformed events, truncation and post-terminal data fail closed.
Contract errors expose a stable code, issue and SHA-256 evidence fingerprint, not raw
arguments. No automatic repair request or tool replay is introduced.

Compatibility change: callers must resend their active tool definitions on each turn
where tools may be requested. Missing IDs and guessed aliases no longer receive
fabricated replacements. Native Anthropic parallel results are grouped in the next user
message with exact `tool_use_id` values; truncated native tool turns cannot be promoted
to success. The buffered OpenAI/Anthropic matrix exercises both valid continuations and
missing IDs, malformed arguments, unoffered functions, truncation and orphan results.
Native API assistant text is never scanned into executable tool calls: a JSON example
in `content` remains text. Text-contract bridges remain a separate compatibility path.

## Deployed configuration inspected, not changed

Mounted provider YAML SHA-256 on 2026-10-10:
`4769d83accbb7783c2ac6af40b6240af4faac873b3449c3bc6401aad7936edf7`.
The schema uses flat `baseUrl` / `apiKeyEnv` fields for API providers and
`request_json_stdin` / `json_contract` for the three CLI bridges. Credential values
were not read or included. Existing provider versions, including Kimi 1.52, remain pinned.

| Deployed adapter | Request / continuation | Fixture coverage / limitation |
| --- | --- | --- |
| Codex CLI | app-server bridge; explicit JSON tool contract; exact call IDs | Shared contract tests; real bridge fake-process tests require Linux CI |
| Kimi CLI / Grok CLI | ACP bridges; Grok shares Kimi parser | Malformed arguments and missing IDs reject; valid object arguments serialize without key repair |
| Gemini API | OpenAI chat messages; tool results use `tool_call_id`; opaque thought signatures retained server-side | Fragmented SSE, unindexed complete calls, signature binding/expiry fixtures |
| DeepSeek API | OpenAI chat; thinking continuation retains `reasoning_content` | Existing request-policy fixtures retained; no live canary |
| Kimi Code API | Anthropic messages; assistant `tool_use`, following user `tool_result` with `tool_use_id` | Strict tool IDs and object inputs; existing message conversion fixtures retained |
| Moonshot / Groq / OpenRouter | OpenAI chat | Shared buffered/stream contract validation; Groq compound tool restriction retained |

Official protocol references: [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai),
[Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).
Provider-specific exceptions must be explicit tested representation conversions, not
fuzzy tool-name or argument repair.

## Remaining review gates

This is not proof that all providers execute a real tool round trip. No live inference
was authorized for this work. A separately budgeted canary must check each enabled model.
Routes now retain explicit tool-call fields and do not reparse provider response text.
Legacy marker history is imported only beside explicit tool-result continuations and
validated for matching identities. Conversion is in memory: original transcripts remain
unchanged for rollback. CLI prompt rendering is an adapter-boundary representation,
not the canonical API/history representation. Malformed or unmatched continuations fail.
The existing schema validators at execution remain necessary: valid JSON is not proof
that arguments satisfy a tool's schema or that an operation is authorized.

Malformed proposals must produce a new bounded planning attempt, preserving prior call
IDs and durable execution receipts. Unknown execution outcomes must require reconciliation,
not replay. This patch does not implement that planner policy or expand sandbox internet.

Raw private model output is not newly persisted. Synthetic fixtures preserve exact raw
evidence; production failures expose hashes only. A protected evidence store would require
an explicit retention and access design rather than adding raw output to logs.

## Ordinary response text is not execution authority

Native API results use explicit tool-call fields only. Deployed CLI json_contract
results likewise use only top-level tool_calls. Codex and Kimi/Grok bridge text
contracts must be complete top-level JSON: fenced examples, prose, nested output_text
and arbitrary nested objects are not promoted into executable calls. This deliberately
removes permissive wrapper recovery. Synthetic fixtures retain valid explicit call IDs
and argument bytes while proving nested examples stay text. Live compatibility canaries
remain required before promotion; no inference or deployment was performed.

The Windows local suite skips the symlink-result-file test only when Windows cannot
create the fixture symlink; Linux CI runs it. Real Codex bridge process fixtures use
a POSIX fake executable and run on Linux CI, without provider calls or credentials.

## Codex built-in tools with dynamic tools

When dynamic tools are present, both Codex `thread/start` paths now pass a `config`
object with `features.code_mode_host`, `features.unified_exec`, `features.shell_tool`,
`features.code_mode`, and `features.code_mode_only` set to `false`. This prevents
built-in exec/shell/code tools from competing with the caller's dynamic tools.
Requests without dynamic tools omit this object; existing RPC params and app-server
spawn arguments remain unchanged. There is no thread-resume path in this bridge.

Verified against an isolated temporary install of the release-pinned Codex CLI
0.144.1 (the local PATH version was 0.159.3): generated experimental JSON Schema and
TypeScript expose `ThreadStartParams.config`; `features list` accepts all five flags.
An offline app-server `thread/start` followed by `experimentalFeature/list` for that
thread confirmed all five disabled, without starting a model turn. The removed flags
`apply_patch_freeform`, `js_repl`, and `js_repl_tools_only` are deliberately omitted.
Cross-platform ZZTEST process fixtures assert exact serialized thread-start params
and unchanged spawn args for tool/no-tool requests, including model fallback. Existing
tool-contract validation remains strict. This is not a live model tool-round-trip proof.
