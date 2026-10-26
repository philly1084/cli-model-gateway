# Provider tool protocol review

## Codex streamed JSON answer contracts

The Codex bridge buffers assistant text beginning with `{` until turn completion,
including `item/agentMessage/delta` fragments split inside JSON strings and escapes.
It uses the same top-level contract parser as buffered requests, then emits only
`output_text`, with the existing reasoning, tool-call validation and finish handling.
Empty contract answers stay empty. Invalid/partial JSON and non-contract JSON fall
back to the buffered text without content loss. Plain text still emits incrementally.
Chat and Responses share this bridge path. Offline ZZTEST node-runner fixtures cover
both client SSE formats, tool-result continuations, completed agent messages,
fragmented/invalid envelopes, gated incremental plain text, unchanged non-stream
answers and native/contract tool calls. No live inference was used.

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

When parsed dynamic tools are present, the bridge now starts Codex with these exact
arguments (including executable fallback attempts):

```text
app-server --listen stdio:// -c features.code_mode_host=false -c features.unified_exec=false -c features.shell_tool=false -c features.code_mode=false -c features.code_mode_only=false
```

These are process-start configuration overrides, applied before initialization and
thread creation. Codex 0.144.1 `app-server --help` documents `-c key=value` and its
repeatable equivalent `--disable <feature>`. All five flags are recognized by
`features list`; removed flags such as `apply_patch_freeform`, `js_repl`, and
`js_repl_tools_only` are not used. Both thread/start paths omit the former redundant
`config` object and retain the dynamic tool declarations. Requests with omitted or
empty tools retain the exact original spawn arguments
`["app-server","--listen","stdio://"]` and serialized RPC params. The request was
already parsed before spawning; no input-order restructuring was needed. There is
no thread-resume path in this bridge.

Offline verification on 2026-10-26 used `npx --yes --package=@openai/codex@0.144.1
codex` in an OS temporary directory outside the repository (PATH was 0.159.3).
The install/cache, generated experimental JSON Schema, recorder scripts and separate
CODEX_HOME directories were deleted afterwards. No user credentials were copied.
Schema inspection established the `config/read` and `experimentalFeature/list`
request shapes. Each fresh stdio app-server received `initialize` with
`capabilities.experimentalApi=true`, `initialized`, then
`config/read {"includeLayers":true}` and
`experimentalFeature/list {"limit":200}`:

| Feature | Empty-home enabled state (Windows) | Spawn overrides | Home explicitly enables all five, then spawn overrides |
| --- | --- | --- | --- |
| `code_mode_host` | true | false | false |
| `unified_exec` | false | false | false |
| `shell_tool` | true | false | false |
| `code_mode` | false | false | false |
| `code_mode_only` | false | false | false |

The all-enabled home without overrides reported all five true. With overrides,
`config/read` reported all five false in effective `config.features` and a
highest-priority `sessionFlags` layer containing exactly those five false entries
(SHA-256 `7fd2b4b654c381c32a29ead5b61ed8aaebd7835ee98c5201a16977d41c91ac2f`).
Thus the check establishes effective app-server startup state, rather than merely
acceptance of fields in a thread/start request.

A second offline check inspected the actual serialized Responses API `tools` array.
A temporary Node HTTP recorder listened only on `127.0.0.1`; a custom provider used
that loopback base URL, `wire_api="responses"`, `requires_openai_auth=false`, and
zero request/stream retries. The model id `gpt-5.4` selected embedded model metadata;
there was no model behind the recorder. An ephemeral read-only thread declared
`ZZTEST` as a dynamic function, then a synthetic turn triggered request serialization.
The recorder captured tool names and returned HTTP 400 without model output:

- With all five features enabled in the temporary home, the wire list contained
  `{"type":"custom","name":"exec"}` (plus `wait`, `request_user_input`, web search).
- With code mode disabled but unified exec enabled, it contained `exec_command`
  and `write_stdin`; the empty-home shell baseline contained `shell_command`.
- With the five spawn overrides, the list contained `ZZTEST` and none of `exec`,
  `wait`, `exec_command`, `write_stdin`, `shell`, or `shell_command`.
  Other built-ins, including `update_plan`, `request_user_input`, `apply_patch`,
  `view_image`, tool search and web search, remain outside this change's scope.

Thread/start-only overrides also removed these tools in this isolated Windows
recorder, so the deployed PR #41 failure was not reproduced here. The earlier
feature-query-only evidence did not establish deployed wire tool exposure; it must
not be treated as proof of that runtime. Startup overrides are independently
verified above and no longer depend on thread-level feature application. No live
model inference, provider credentials, deployment, or tool execution was used.

Cross-platform ZZTEST process fixtures assert exact serialized spawn arguments and
thread-start params for dynamic, empty and omitted tools, including model fallback.
Existing tool-contract validation remains strict. This offline wire check does not
constitute a live model tool-round-trip proof.

## Catalog tool mode override (Codex 0.144.1, offline proof)

The feature flags above do **not** override a model catalog entry's
`tool_mode: "code_mode_only"`. The supported solution is a process-start
`-c model_catalog_json="<absolute JSON path>"` pointing at a catalog whose model
entries use `tool_mode: "direct"`. The binary's adjacent enum strings are
`direct`, `code_mode`, `code_mode_only`; `debug models` round-trips each of those
values. An invalid value is silently omitted from the normalized model metadata,
so mere acceptance of a made-up value is not evidence of a valid enum. The
generated experimental app-server schema does not describe this catalog enum.
A top-level `-c tool_mode="direct"` (also tested with `"standard"` and `"invalid"`) left the
code-mode-only wire declarations unchanged; it is not the mechanism used here.

For requests with parsed dynamic tools, the bridge reads
`CODEX_HOME/models_cache.json` (default `~/.codex/models_cache.json`). The cache
and `model_catalog_json` both accept the `{"models":[ModelInfo,...]}` envelope;
cache metadata such as `fetched_at`, `etag`, and `client_version` can remain in
that envelope. It copies all JSON fields, changing only every model's `tool_mode`
to `direct`, including fallback candidates. It creates a private OS temporary
directory and exclusively writes a 0600 JSON file, adds the catalog config after
the five existing feature flags, and removes the file/directory in `finally`,
at process exit, or on handled SIGINT/SIGTERM. Missing, unreadable, malformed, or
structurally invalid caches skip the override. The original cache is never changed.
Empty/omitted tools retain byte-identical spawn arguments and thread parameters,
without reading or writing a catalog. No environment configuration is changed.

Verification on 2026-10-26 installed `@openai/codex@0.144.1` using npx into an
isolated temporary npm cache outside the repository, confirmed `codex-cli 0.144.1`,
and used that package's executable for stdio probes. All CODEX_HOME directories,
recorder scripts, schemas, catalogs, and npm cache were isolated outside the repo
and deleted afterwards. No user credentials, live inference, tool execution,
production process, commit, or deployment was used.

The fixture copied the binary's complete bundled frontier ModelInfo, renamed it
`gpt-6-astra`, set `prefer_websockets=false`, and retained the model's other fields.
A custom provider used only `http://127.0.0.1:<ephemeral>/v1`, `wire_api="responses"`,
`requires_openai_auth=false`, and zero retries. Both variants used all five feature
flags. The declared dynamic tool was `blender_build`, with this schema:

```json
{"type":"object","properties":{"script":{"type":"string","maxLength":65536},"timeoutSeconds":{"type":"number"}},"required":["script"]}
```

Captured serialized declarations (namespace children abbreviated):

| Catalog tool_mode | Tools on the wire |
| --- | --- |
| `code_mode_only` | custom `exec`; function `wait`, `request_user_input`; namespace `collaboration` |
| `code_mode` | custom `exec`, `apply_patch`; function `wait`, `update_plan`, `request_user_input`, `view_image`, **`blender_build`**; namespace `collaboration` |
| `direct` | function `update_plan`, `request_user_input`, `view_image`, **`blender_build`**; custom `apply_patch`; namespace `collaboration`; **no `exec`** |

With the model's `use_responses_lite=true`, these declarations occur in
`input[]` entries of type `additional_tools`, rather than the top-level `tools`
array. Repeating with only `use_responses_lite=false` places the same declarations
in top-level `tools`, additionally containing the unnamed `web_search` built-in.
Both forms reproduce the code-mode-only issue and prove the direct override.

The recorder returned SSE `response.created`, `response.output_item.added`,
`response.function_call_arguments.delta`, `response.output_item.done`, and
`response.completed`, including this synthetic item:

```json
{"type":"function_call","id":"fc_ZZTEST","call_id":"call_ZZTEST","name":"blender_build","arguments":"{\"script\":\"ZZTEST\",\"timeoutSeconds\":1}"}
```

App-server emitted both `rawResponseItem/completed` with that function_call and
`item/tool/call` with `callId="call_ZZTEST"`, `tool="blender_build"`, and parsed
arguments. A separate full compiled-bridge run seeded the isolated cache with
`code_mode_only` and used the bridge-created direct catalog. The recorder observed
the function declaration without `exec`; the bridge exited 0 with:

```json
{"output_text":"","tool_calls":[{"id":"call_ZZTEST","name":"blender_build","arguments":"{\"script\":\"ZZTEST\",\"timeoutSeconds\":1}"}],"finish_reason":"tool_calls"}
```

The bridge's delegated-tool acknowledgement reached app-server, and a second
synthetic completed response let its turn complete successfully. This proves
serialization and bridge parsing against the pinned binary, not model intelligence
or a real Blender execution.

ZZTEST regression fixtures cover valid/missing/malformed catalogs for dynamic,
empty, and omitted tools, with and without model fallback; exact spawn and thread
params; preservation of nested fields and cache metadata; cleanup after bridge
exit; malformed shapes; idempotent cleanup; POSIX 0600 file mode; and exact parsing
of the recorder's function-call ID and argument bytes. Windows shell wrappers strip
TOML quotes in captured argv; direct executable probes retain the JSON/TOML quoting.

Validation after implementation: `npm run check` and `npm run build` passed;
`npm test` passed (compiled tests: 591 passed, 1 skipped; protocol/snapshot/vault
scripts: 12 passed, 17 skipped); `npm run test:remote-agent-handoff-release` passed
(141 passed, 3 skipped). Skips are the existing platform-dependent fixtures.
The focused catalog/argument suite passed all 21 tests. `git diff --check` passed.
