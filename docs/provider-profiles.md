# Provider profiles and Brain's chat contract

Profiles live in `config/provider-profiles/*.yaml`. Every file is loaded and
validated at startup, including unused profiles. Unknown keys at every profile
level, duplicate IDs, invalid regexes, invalid environment names and mismatched
provider types fail startup. No new dependencies are needed.

An explicit `profile` supplies omitted transport defaults:

```yaml
providers:
  - id: gemini-api
    type: openai
    profile: gemini-api
    models:
      - id: gemini-3.7-flash
        providerModel: gemini-3.7-flash
```

Existing `baseUrl`, `apiKeyEnv`, `timeoutMs`, and complete `responseCommand`
settings override those defaults. Authentication values belong in the process
environment or existing CLI login storage, never in profiles. CLI `auth.env`
documents the provider's optional API-key environment name; the bridge retains
its existing OAuth/session authentication. `CODEX_EXECUTABLE` still works.

Without `profile`, inference recognizes exact provider hosts (Kimi, Moonshot,
OpenRouter, DeepSeek and Gemini) or the Codex/Kimi bridge arguments. Inference
identifies the normalization policy but does not replace legacy URLs, commands,
capabilities, system handling, retries or timeouts. Unrecognized providers use
the common normalization defaults. Existing model/fallback catalogs are retained.

The supplied local live-config snapshot confirms `kimi-api` uses
`https://api.kimi.com/coding/v1` with `MOONSHOT_API_KEY`. Both its profile and
the example now reflect that endpoint; `kimi-code-api` uses the same base URL
with `KIMI_CODE_API_KEY`. The existing Kimi Code adapter uses buffered Anthropic
`/messages` transport; client SSE is synthesized from its completed result.
No cluster inspection or upstream calls were made to obtain this setting.

## Schema

`src/provider-profiles.ts` exports the strict Zod schema and inferred TypeScript
`ProviderProfile` type. Every profile declares:

| Field | Meaning |
| --- | --- |
| `id`, `type` | Unique lowercase ID; `openai` or `cli` |
| `baseUrl`, `endpoint` | API URL default and request path; required for APIs |
| `auth.env` | Environment variable name only |
| `command` | CLI executable, argument templates, input and output modes; required for CLIs |
| `stream_format` | `openai-sse`, `anthropic-json`, `buffered-json`, or `cli-jsonl` |
| `quirks.duplicate_finish_trailer` | Permit an identical empty terminal choice, as OpenRouter sends on its usage trailer |
| `quirks.json_array_errors` | Decode Gemini's array error envelope; other error arrays are rejected without decoding vendor codes |
| `quirks.unsupported_model_patterns` | Case-insensitive CLI diagnostic regexes, inspected incrementally |
| `quirks.refusal_patterns` | CLI model-availability refusal text regexes; distinct from ordinary safety refusals |
| `quirks.retry_on`, `backoff_ms` | HTTP statuses eligible for one retry and delay in milliseconds |
| `quirks.auth_fail_fast` | Skip sibling models sharing a failed credential for the remainder of the request |
| `quirks.timeouts.first_token`, `total` | Milliseconds; native streams bound first-token wait; buffered transports use total timeout |
| `capabilities.tools`, `json_mode` | Explicit-profile capability checks before dispatch |
| `capabilities.system_prompt` | `native`, `prepend_to_user`, or `cli_flag` (requires `system_flag`) |
| `normalization.strip_think` | Remove `<think>...</think>` content blocks; default `true` |
| `normalization.strip_fence` | Remove one outer triple-backtick fence; default `false` |

Retries keep the established safety boundaries: ordinary replay-safe chat only,
before output, within request attempt/deadline budgets. Tools, sessions, uncertain
delivery, auth failures and partial output are never blindly replayed. Explicit
profile tools/JSON capability restrictions supplement model capabilities.
`native` keeps the existing API message or bridge request handling.
`prepend_to_user` moves system text to the first user message.
`cli_flag` appends the system instruction as one escaped command argument.
For explicit OpenAI SSE profiles, JSON `response_format` is forwarded; legacy
request construction is unchanged. CLI bridges receive the request metadata as
before. Profiles do not introduce a new JSON validator or change generated text
into JSON. Kimi's Anthropic adapter retains its existing prompt-based handling.

## Normalization contract

Brain can rely on the following for `/v1/chat/completions`, its message aliases,
and `/openai/v1/*` chat aliases, regardless of whether upstream is buffered or SSE:

- Buffered messages and each stream's first choice delta have `role: assistant`.
- Finish reasons are `stop`, `length`, `tool_calls`, `content_filter`, or `error`.
  Successful streams emit exactly one finish per supported choice (the gateway
  supports one choice), followed by one `[DONE]`. Duplicate upstream terminal
  trailers cannot become duplicate client finishes.
- Choices omit `reasoning`, `reasoning_content`, `reasoning_details`, `provider`,
  `native_finish_reason`, `service_tier`, and `extra_content` by default, including
  null values. Set top-level `include_reasoning: true` to expose supported reasoning
  summaries. Opaque vendor fields already discarded by the adapter are not restored.
  Internal Gemini tool signatures remain server-side.
- Content strips think blocks by default and preserves fences. Delimiters split
  across upstream chunks are handled. Fence stripping is explicit and buffers
  the content until completion so the entire wrapper can be checked correctly.
  Tool argument strings are never modified by content normalization.
- Buffered responses always have integer `prompt_tokens`, `completion_tokens`,
  and `total_tokens` inside `usage`. Missing counts are estimated using the
  existing word/character heuristic, with `usage.estimated: true`. These are
  approximations, not billing counts; available upstream counts/details remain.
- Streams always include `usage` on the single finish chunk for Brain backward
  compatibility, including synthesized CLI streams. Missing upstream counts are
  estimated with `usage.estimated: true`, using the same heuristic as buffered
  responses. With `stream_options: { include_usage: true }`, an additional
  OpenAI-style chunk with `choices: []` and the same usage follows the finish,
  before `[DONE]`. Omitting the option or setting it to false suppresses only
  that additional chunk. Non-terminal chunks do not carry usage.
- Errors have `{error:{message,type,code,param:null}}`. Known upstream errors map
  to HTTP 401 (auth), 404 (model unavailable), 429 (rate limit), 503 (capacity),
  or 502 (other upstream protocol errors); local capability failures are 400.
  An established stream ends with exactly one sanitized error event and `[DONE]`,
  without a success finish. `[DONE]` is transport termination, not proof of success:
  clients must check for an error event. Errors before a stream starts can be HTTP
  JSON errors. Existing native-stream runtime failures retain HTTP 200 SSE errors.
- Successful responses have `x-gateway-served-model` and
  `x-gateway-fallback: true|false`. The buffered body and first SSE chunk also
  include `gateway_fallback`. A serving model different from the requested ID
  is explicitly marked, including model aliases and cross-provider fallback.
  Streaming headers wait for selection of the first upstream event; they cannot
  promise the originally requested model while a fallback is still being selected.

The Responses API keeps its existing event vocabulary; the chat contract above
does not rename Responses events or change the unified agent/coordinator.

## Add a provider

1. Copy a profile for the same transport, choose a unique `id`, and set endpoint
   or command templates plus the authentication environment name.
2. Declare actual capabilities and observed quirks; keep model IDs and fallback
   chains in `providers.yaml`. Reference the new profile explicitly.
3. Add mocked upstream/CLI shapes in `src/test/provider-profiles.test.ts` covering
   buffered and client-stream output, errors and any new quirks. Existing fixtures
   reproduce the supplied ZZTEST baseline without copying credentials or calling
   a real service.
4. Run `npm run check`, `npm run build`, and `npm test`. Copy the profile directory
   with the runtime when packaging (`Dockerfile` already includes it).

## Temporary local comparison

Run from the repository root with Node.js 20+ and already installed dependencies.
Inherit `N8N_API_KEY`/`N8N_API_KEYS`, `ADMIN_API_KEY`, and upstream environment
variables from your existing local session. These commands do not set secret values.

PowerShell, using the supplied git-excluded live YAML snapshot:

```powershell
npm run build
$env:PROVIDERS_CONFIG_PATH = (Resolve-Path .scratch/live-providers-current.yaml).Path
$env:AGENT_ENABLED = 'false'
$env:HOST = '127.0.0.1'
$env:PORT = '18081'
$env:AUTO_ROUTER_BENCHMARK_ON_START = 'false'
$env:AUTO_ROUTER_BENCHMARK_INTERVAL_MS = '0'
node dist/index.js
```

Equivalent shell invocation:

```sh
npm run build
PROVIDERS_CONFIG_PATH=.scratch/live-providers-current.yaml AGENT_ENABLED=false HOST=127.0.0.1 PORT=18081 AUTO_ROUTER_BENCHMARK_ON_START=false AUTO_ROUTER_BENCHMARK_INTERVAL_MS=0 node dist/index.js
```

In a second PowerShell session, inherit the harness's
`ZZ_KEY` or `BRAIN_MODEL_API_KEY`, set `ZZ_BASE` and `ZZ_MODELS`, and run:

```powershell
$env:ZZ_BASE = 'http://127.0.0.1:18081/v1/'
$env:ZZ_MODELS = 'kimi-for-coding,kimi-k3,kimi-k2.6,z-ai/glm-5.3-flash,openrouter-free,deepseek-v4-flash,gemini-3.7-flash,gpt-5.6-luna'
node .scratch/harness.mjs > .scratch/after-profiles.jsonl
```

Compare against `.scratch/baseline.jsonl`. The harness's stream case omits
`stream_options.include_usage` and still expects usage on the finish chunk for
Brain compatibility. It records served `model`, `fallback_flag` (whether
`x-gateway-fallback` equals `true`), and `served_hdr` (`x-gateway-served-model`).
To inspect the additional empty-choices usage trailer, send the option in a
separate probe.
To test profile transport opt-ins, use a separate local YAML file with `profile`
references. Do not edit the captured baseline/live-config files.
These are operator-run comparison commands; implementation tests use mocked
upstreams and local CLI processes. No live-key comparison was run here.

### Local mock upstreams on Windows

The git-excluded `.scratch/local-providers.yaml` copies the captured snapshot,
changing only the `openrouter-free`, `deepseek-api`, and `gemini-api` base URLs
to the mock server on `127.0.0.1:18090`. Their `apiKeyEnv` names remain unchanged.
The plain Node `.scratch/mock-upstreams.mjs` serves buffered and SSE chat requests,
vendor reasoning/tool extensions, OpenRouter's duplicate finish usage trailer,
and Gemini's missing usage and every-fourth-request HTTP 503 array error.
Its request counter covers Gemini chat requests only and resets on restart.

After building, run `.scratch/run-local.ps1` with Node on PATH. The caller must
already have `KIMI_CODE_API_KEY` and `MOONSHOT_API_KEY` set in the process
environment; the launcher never loads credentials from disk. It supplies dummy
keys for the three mocks, disables agents and startup/scheduled benchmarks,
and starts the gateway on `127.0.0.1:18081`. Ctrl+C stops the gateway and cleans
up the mock process. Other providers and fallback chains remain as captured;
calling those models or reaching their fallbacks can contact real providers.
The captured Groq provider also has discovery enabled, so an inherited Groq key
can trigger discovery at startup. Run only when those contacts are authorized.

The launcher writes only a random throwaway gateway client key to
`$env:TEMP\zzlocalkey.txt`. In a second PowerShell session:

```powershell
$env:ZZ_BASE = 'http://127.0.0.1:18081/v1/'
$env:ZZ_KEY = [IO.File]::ReadAllText((Join-Path $env:TEMP 'zzlocalkey.txt'))
$env:ZZ_MODELS = 'openrouter-free,deepseek-v4-flash,gemini-3.7-flash'
node .scratch/harness.mjs > .scratch/local-results.jsonl
```

`ZZ_BASE` and `ZZ_KEY` work directly in Windows Node without a shell wrapper.
The harness retains `BRAIN_ROUTER_URL`/`BRAIN_MODEL_API_KEY` as environment aliases.
