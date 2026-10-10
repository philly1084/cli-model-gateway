# Provider tool protocol review

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
The route layer still has legacy tool-history flattening and textual wrapper extraction;
that deserves a separate typed-message migration before broad autonomous execution.
The existing schema validators at execution remain necessary: valid JSON is not proof
that arguments satisfy a tool's schema or that an operation is authorized.

Malformed proposals must produce a new bounded planning attempt, preserving prior call
IDs and durable execution receipts. Unknown execution outcomes must require reconciliation,
not replay. This patch does not implement that planner policy or expand sandbox internet.

Raw private model output is not newly persisted. Synthetic fixtures preserve exact raw
evidence; production failures expose hashes only. A protected evidence store would require
an explicit retention and access design rather than adding raw output to logs.
