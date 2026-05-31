# n8n OpenAI CLI Gateway

[![Build and Push](https://github.com/philly1084/n8n-openai-cli-gateway/actions/workflows/build.yml/badge.svg)](https://github.com/philly1084/n8n-openai-cli-gateway/actions/workflows/build.yml)
[![Docker Image Version (latest semver)](https://img.shields.io/docker/v/ghcr.io/philly1084/n8n-openai-cli-gateway?sort=semver)](https://ghcr.io/philly1084/n8n-openai-cli-gateway)
[![Multi-Architecture](https://img.shields.io/badge/multi--arch-linux%2Famd64%20%7C%20linux%2Farm64-blue)](https://github.com/philly1084/n8n-openai-cli-gateway/pkgs/container/n8n-openai-cli-gateway)

OpenAI-compatible gateway for n8n with multi-architecture support (amd64/arm64).

OpenAI-compatible gateway for n8n that exposes:

- `POST /v1/chat/completions`
- `POST /v1/messages` (alias of chat completions)
- `POST /v1/message` (alias of chat completions)
- `POST /v1/responses`
- `POST /v1/images/generations`
- `POST /v1/documents/generations`
- `POST /v1/files/generations` (alias of document generation)
- `POST /v1/presentations/generations` (alias of document generation)
- `GET /v1/models`

Also exposed under `/openai/v1/*` for in-cluster compatibility URLs.

Model execution is delegated to configurable providers, including CLI runners (Gemini CLI, Kimi ACP, Antigravity CLI, Codex CLI) and OpenAI-compatible remote APIs such as Groq and DeepSeek. When a Codex app-server bridge model is configured, the gateway also prefers it for `POST /v1/images/generations` so frontend image requests run through Codex CLI image generation by default. The gateway keeps n8n on one API key while provider auth is handled on the backend.

## Why this fits your setup

- n8n receives a normal OpenAI-style API base URL + API key.
- Backend handles provider auth flows through admin endpoints and background login jobs.
- Login output logs include URLs/codes so you can copy/paste over SSH from a remote server.
- Built for Kubernetes and GitHub workflows.

## Project layout

- `src/` API server, provider system, auth/login job manager.
  - `routes/` OpenAI-compatible and admin API endpoints.
  - `providers/` Provider interface, CLI implementation, and registry.
  - `jobs/` Background login job execution.
  - `stats/` Model health tracking and failure classification.
  - `scripts/` CLI tools and bridges (codex-appserver-bridge, gateway-cli).
  - `utils/` Command execution, ID generation, prompt building, template replacement.
- `config/providers.example.yaml` provider command templates.
- `kubernetes/` deployment/config examples.
- `Dockerfile` production container build.

## Requirements

- Node.js 20+
- Provider CLIs available in runtime image/host (`gemini`, `kimi`, `antigravity`, `codex`, etc.)
- A real providers config file at `config/providers.yaml`

## 1) Configure providers

Copy and edit the template:

```powershell
Copy-Item config/providers.example.yaml config/providers.yaml
```

Each provider defines:

- `models` exposed to n8n.
- `responseCommand` to run model inference.
- optional `sessionCommand` to expose the provider's interactive CLI to a trusted frontend client.
- optional `auth.loginCommand`, `auth.statusCommand`, and `auth.rateLimitCommand`.
- optional per-model `fallbackModels` list of model ids to try when a provider command fails.
- optional top-level `remoteCliTargets` list for trusted MCP remote coding tools.

The gateway also supports `type: openai` providers for OpenAI-compatible remote APIs such as Groq and DeepSeek. Those providers can auto-discover models from `/models` at startup and register them automatically.

The gateway also exposes a virtual `auto` model. It is not configured in `providers.yaml`; it appears automatically in `GET /v1/models` and picks a compatible configured model for each request. The router scores request kind, image generation, tool use, reasoning effort, token-size estimate, prompt complexity, coding/build signals, configured capabilities, recent model health, and live benchmark quality. The response `model` field is the concrete model that actually handled the request when that is known.

By default, the gateway starts a bounded auto-router capacity baseline in the background after boot and reruns it every 8 hours. It sends quick, medium, low-reasoning, high-reasoning, and tool-call probes to eligible configured models, records completion latency, time to first streamed token when available, rough or measured output token rate, provider usage counts, tool-call behavior, and per-task scores. When a separate stronger configured model is available, the baseline also asks that model to judge benchmark output quality and folds the score into later `auto` choices. The baseline is non-fatal and de-duplicates concurrent runs; failed providers or failed quality checks are marked in the snapshot without blocking startup. Tune it with `AUTO_ROUTER_BENCHMARK_ON_START`, `AUTO_ROUTER_BENCHMARK_TIMEOUT_MS`, `AUTO_ROUTER_BENCHMARK_MAX_MODELS`, `AUTO_ROUTER_BENCHMARK_CONCURRENCY`, `AUTO_ROUTER_BENCHMARK_INTERVAL_MS`, `AUTO_ROUTER_BENCHMARK_EVALUATE_QUALITY`, `AUTO_ROUTER_BENCHMARK_EVALUATOR_MODEL`, and `AUTO_ROUTER_BENCHMARK_QUALITY_TIMEOUT_MS`. Inspect current signals with `GET /admin/stats/auto-router` or trigger a fresh run with `POST /admin/stats/auto-router/baseline`.

### Remote execution contract

Trusted clients can call the Streamable HTTP MCP endpoint `/mcp` with `remote_code_run`, `remote_code_status`, and `remote_code_cancel`. `remote_code_run` accepts only high-level task fields: `targetId`, optional `cwd`, `task`, optional `model`, optional `sessionId`, optional `adminMode`, and optional `waitMs`. Raw shell fields such as `command`, `args`, `executable`, and `shell` are rejected so the gateway remains the single source of truth for the remote execution shape.

`remote_code_run` and `remote_code_status` return both MCP text content and `structuredContent`. Consumers should prefer these structured fields:

- `completionStatus`: `running`, `complete`, `blocked`, `failed`, `cancelled`, `timed_out`, or `unknown`.
- `finalOutput`: normalized completion marker lines for handoff and continuity.
- `whatChanged`, `verifyCommands`, `verifyResults`, `publicUrl`, and `blocker`.
- Git and deployment continuity fields when available: `gitRepo`, `gitBranch`, `gitBaseCommit`, `gitCommit`, `changedFiles`, `deployment`, `publicHost`, `uiCheckReport`, and `uiScreenshots`.

The remote agent is still asked to print marker lines, but downstream chat clients should not scrape raw stdout when `structuredContent` is available.

Supported template variables in commands:

- `{{model}}` requested model id from API
- `{{provider_model}}` provider-specific model id
- `{{codex_executable}}` resolved Codex CLI executable (`CODEX_EXECUTABLE`, or platform default)
- `{{reasoning_effort}}` normalized reasoning effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) when provided
- `{{prompt}}` flattened prompt text
- `{{prompt_file}}` path to temp prompt file
- `{{request_file}}` path to temp request JSON
- `{{request_id}}`
- `{{provider_id}}`

Fallback behavior:

- The gateway first runs the requested model id.
- If the requested model id is `auto`, the gateway first selects the highest-scoring compatible configured model, then uses the rest of the compatible ranked models as an implicit fallback pool.
- If that model's command exits with an error and `fallbackModels` are configured, it tries each fallback id in order.
- Fallbacks can cross providers (for example Gemini -> Codex or Codex -> Gemini).

### Codex OAuth app-server bridge

The repository includes `src/scripts/codex-appserver-bridge.ts`, which runs Codex through `codex app-server` (stdio JSON-RPC) and converts results to the gateway `json_contract`.

Use this in provider config:

```yaml
responseCommand:
  executable: node
  args:
    - dist/scripts/codex-appserver-bridge.js
    - --model
    - "{{provider_model}}"
  input: request_json_stdin
  output: json_contract
  timeoutMs: 240000
```

Optional environment variables:

- `CODEX_EXECUTABLE` override the Codex CLI executable used by the bridge and direct Codex login/session commands. Useful on Windows when PATH resolves to an inaccessible WindowsApps binary.
- `CODEX_APPSERVER_MODEL_PROVIDER` (default `openai`)
- `CODEX_APPSERVER_TIMEOUT_MS` (default `240000`)
- `CODEX_APPSERVER_DEBUG_RPC` (`1`/`true` to log raw Codex app-server JSON-RPC methods to stderr)
- `OPENAI_REASONING_EFFORT` default reasoning effort when requests omit it
- `FRONTEND_API_KEY` / `FRONTEND_API_KEYS` dedicated keys for trusted frontend session clients
- `FRONTEND_ALLOWED_CWDS` comma-separated working-directory roots that frontend session clients may request
- `CODEX_AGENT_ALLOWED_WORKSPACE_ROOTS` comma-separated workspace roots for `/api/codex-agent/*`; falls back to `SYMPHONY_WORKSPACE_ROOTS`, `SYMPHONY_WORKSPACE_ROOT`, then `FRONTEND_ALLOWED_CWDS`
- `REMOTE_CLI_TOOL_AUTH_SCOPES` comma-separated scopes allowed to use `POST /mcp`; defaults to `frontend,admin`, set `n8n,frontend,admin` only for trusted server-side Agents SDK runtimes

### Groq API with model discovery

Use the OpenAI-compatible provider type when you want Groq models to be pulled automatically from the upstream `/models` endpoint:

```yaml
- id: groq-api
  type: openai
  description: Groq API - auto-discovers chat-usable models at startup
  baseUrl: https://api.groq.com/openai/v1
  apiKeyEnv: GROQ_API_KEY
  timeoutMs: 60000
  discovery:
    enabled: true
  models:
    - id: groq/compound
      providerModel: groq/compound
      fallbackModels:
        - openai/gpt-oss-20b
        - llama-3.3-70b-versatile
    - id: groq/compound-mini
      providerModel: groq/compound-mini
    - id: openai/gpt-oss-120b
      providerModel: openai/gpt-oss-120b
    - id: openai/gpt-oss-20b
      providerModel: openai/gpt-oss-20b
    - id: llama-3.3-70b-versatile
      providerModel: llama-3.3-70b-versatile
    - id: llama-3.1-8b-instant
      providerModel: llama-3.1-8b-instant
```

By default, discovery filters out obvious non-chat models such as Whisper, TTS, transcription, and guardrail entries. Restarting the gateway refreshes the discovered list.

## 2) Run locally

```powershell
npm install
$env:N8N_API_KEY="replace-me"
$env:ADMIN_API_KEY="replace-me-admin"
$env:PROVIDERS_CONFIG_PATH="config/providers.yaml"
npm run dev
```

Health check:

```powershell
curl http://localhost:8080/healthz
```

## 3) Login flows over SSH

Start login job:

```bash
curl -X POST http://localhost:8080/admin/providers/gemini-cli/login \
  -H "x-admin-key: replace-me-admin"
```

Poll logs (contains URL/code):

```bash
curl http://localhost:8080/admin/jobs/<job_id> \
  -H "x-admin-key: replace-me-admin"
```

List recent login jobs:

```bash
curl "http://localhost:8080/admin/jobs?limit=20" \
  -H "x-admin-key: replace-me-admin"
```

## 4) Frontend provider sessions

Use provider sessions when you want a trusted frontend CLI to drive the full interactive provider CLI instead of the stateless `/v1/*` adapter surface.

Provider requirements:

- The provider must be `type: cli`.
- The provider must define `sessionCommand`.
- DeepSeek in the default config remains API-backed, so it does not expose an interactive session CLI.

Recommended environment:

```powershell
$env:FRONTEND_API_KEY="replace-me-frontend"
$env:FRONTEND_ALLOWED_CWDS="C:\repos,C:\work"
```

Session lifecycle:

```bash
# List interactive-session capabilities
curl http://localhost:8080/admin/provider-capabilities \
  -H "Authorization: Bearer replace-me-frontend"

# Create a Gemini session
curl -X POST http://localhost:8080/admin/provider-sessions \
  -H "Authorization: Bearer replace-me-frontend" \
  -H "Content-Type: application/json" \
  -d '{"providerId":"gemini-cli","cwd":"C:\\repos\\my-app","cols":120,"rows":40}'

# Send input to the running session
curl -X POST http://localhost:8080/admin/provider-sessions/<session_id>/input \
  -H "Authorization: Bearer replace-me-frontend" \
  -H "Content-Type: application/json" \
  -d '{"data":"hello\n"}'

# Fetch transcript snapshots
curl http://localhost:8080/admin/provider-sessions/<session_id>/transcript \
  -H "Authorization: Bearer replace-me-frontend"
```

Streaming output:

- `GET /admin/provider-sessions/:id/stream` returns an SSE stream.
- The session creation response includes a `streamUrl` with a short-lived attach token so the frontend can open the stream without reusing the main auth key on every reconnect.

## 4b) Remote CLI MCP tools

Use `POST /mcp` when a trusted OpenAI Agents SDK backend should expose remote coding as tools rather than as a raw shell. The endpoint implements Streamable HTTP MCP methods for `initialize`, `tools/list`, and `tools/call`.

Configure targets in `providers.yaml`:

```yaml
remoteCliTargets:
  - targetId: prod
    host: prod.example.com
    user: deploy
    port: 22
    allowedCwds:
      - /srv/apps
    defaultCwd: /srv/apps/my-app
    defaultModel: codex-latest
    opencodeExecutable: opencode
    timeoutMs: 1800000
```

Available MCP tools:

- `remote_code_run({ targetId, cwd?, task, model?, sessionId?, waitMs? })`
- `remote_code_status({ jobId })`
- `remote_code_cancel({ jobId })`

`remote_code_run` starts `ssh <target> "cd <cwd> && opencode run --format json ... <task>"`. The gateway validates `cwd` against `allowedCwds`, quotes dynamic values, and rejects raw `command`, `args`, `executable`, or `shell` fields.

The gateway appends a small completion contract to remote tasks so coding agents finish with source, verification, public URL, and blocker markers. When those markers appear in raw stdout or JSONL agent output, `remote_code_run`/`remote_code_status` include a structured `proof` object with `complete`, `missing`, and parsed `markers` fields.

## 4c) Remote agent sessions

Use `/admin/remote-agent-tasks` when the frontend should choose a local CLI provider session, such as Codex, Gemini, or Kimi, and give it controlled instructions for a configured remote target. This path runs the selected provider CLI on the gateway and sends it a bootstrap prompt with SSH target details, allowed remote roots, and progress marker instructions.

```http
POST /admin/remote-agent-tasks
```

```json
{
  "providerId": "gemini-cli",
  "targetId": "prod",
  "cwd": "/srv/apps/my-app",
  "task": "Update the k3s app and verify the rollout.",
  "model": "gemini-3.1-pro-preview"
}
```

Response:

```json
{
  "task": {
    "id": "ragent_...",
    "providerId": "gemini-cli",
    "targetId": "prod",
    "sessionId": "ps_...",
    "reasoning": {
      "summary": "Remote agent task started with provider gemini-cli on target prod.",
      "data": {
        "sshCommand": "ssh deploy@prod.example.com",
        "progressMarkers": ["REMOTE_AGENT_PLAN", "REMOTE_AGENT_PROGRESS", "REMOTE_AGENT_RESULT"]
      }
    }
  },
  "streamUrl": "/admin/remote-agent-tasks/ragent_.../stream?token=..."
}
```

The task stream is Server-Sent Events. It includes normal provider-session `output` events plus a structured `reasoning` event with non-secret routing context so the chat UI can show what agent, target, cwd, and progress markers are active. It does not expose hidden model chain-of-thought.

## 4d) Codex frontend agent runs

Use `/api/codex-agent/*` when a trusted frontend service, such as Symphony, needs to run a local Codex app-server turn directly in a checked-out workspace. Requests must use a `FRONTEND_API_KEY`/`FRONTEND_API_KEYS` key or the admin key. The gateway validates `workspacePath` against `CODEX_AGENT_ALLOWED_WORKSPACE_ROOTS` and starts `codex app-server` with `cwd` set to that workspace.

```http
POST /api/codex-agent/run
```

```json
{
  "workspacePath": "C:\\tmp\\symphony_workspaces\\KIMI-123",
  "issue": {
    "id": "linear-id",
    "identifier": "KIMI-123",
    "title": "Fix login redirect",
    "description": "...",
    "state": "Todo",
    "labels": ["frontend"]
  },
  "prompt": "Rendered WORKFLOW.md prompt",
  "attempt": null,
  "continuation": false,
  "config": {
    "approvalPolicy": "never",
    "threadSandbox": "workspace-write",
    "turnSandboxPolicy": { "type": "workspace-write" },
    "turnTimeoutMs": 3600000,
    "stallTimeoutMs": 300000
  }
}
```

Response:

```json
{
  "ok": true,
  "runId": "run_...",
  "threadId": "thread_...",
  "turnId": "turn_...",
  "sessionId": "thread_...-turn_...",
  "status": "running"
}
```

Lifecycle endpoints:

- `GET /api/codex-agent/runs/:runId`
- `GET /api/codex-agent/runs/:runId/events`
- `POST /api/codex-agent/runs/:runId/cancel`

The event stream is SSE and emits `session_started`, `output`, and one terminal event: `turn_completed`, `turn_failed`, `turn_cancelled`, or `turn_input_required`. Approval and user-input requests are denied and converted into `turn_input_required` so frontend jobs do not wait forever.

Agents SDK server-side usage:

```ts
import { Agent, MCPServerStreamableHttp } from "@openai/agents";

const remoteCli = new MCPServerStreamableHttp({
  url: "https://gateway.example.com/mcp",
  name: "remote-cli",
  headers: {
    Authorization: `Bearer ${process.env.N8N_API_KEY}`,
  },
  cacheToolsList: true,
});

await remoteCli.connect();

const agent = new Agent({
  name: "Remote coding assistant",
  mcpServers: [remoteCli],
});
```

Only enable n8n-key access deliberately:

```powershell
$env:REMOTE_CLI_TOOL_AUTH_SCOPES="n8n,frontend,admin"
```

Check auth status:

```bash
curl -X POST http://localhost:8080/admin/providers/gemini-cli/status \
  -H "x-admin-key: replace-me-admin"
```

Model-level health/fallback stats:

```bash
curl http://localhost:8080/admin/stats/models \
  -H "x-admin-key: replace-me-admin"
```

Auto-router benchmark stats:

```bash
curl http://localhost:8080/admin/stats/auto-router \
  -H "x-admin-key: replace-me-admin"
```

Run a fresh bounded auto-router baseline:

```bash
curl -X POST http://localhost:8080/admin/stats/auto-router/baseline \
  -H "x-admin-key: replace-me-admin" \
  -H "Content-Type: application/json" \
  -d '{"maxModels":8,"concurrency":2,"timeoutMs":20000,"evaluateQuality":true}'
```

Single model stats:

```bash
curl http://localhost:8080/admin/stats/models/gpt-5-codex \
  -H "x-admin-key: replace-me-admin"
```

Check rate limits for all providers:

```bash
curl http://localhost:8080/admin/rate-limits \
  -H "x-admin-key: replace-me-admin"
```

Check rate limits for specific provider:

```bash
curl http://localhost:8080/admin/rate-limits/gemini-cli \
  -H "x-admin-key: replace-me-admin"
```

## 4) Gateway CLI Tool

A CLI tool is included for querying the gateway from the command line:

```bash
# Check health
npx tsx dist/scripts/gateway-cli.js health

# List providers (shows which support rate limiting)
npx tsx dist/scripts/gateway-cli.js providers -k <admin-key>

# Check all rate limits
npx tsx dist/scripts/gateway-cli.js rate-limits -k <admin-key>

# Check specific provider rate limits
npx tsx dist/scripts/gateway-cli.js rate-limits -k <admin-key> -p gemini-cli

# Output as JSON
npx tsx dist/scripts/gateway-cli.js rate-limits -k <admin-key> -f json
```

Environment variables for CLI:
- `GATEWAY_URL` - Gateway URL (default: http://localhost:8080)
- `ADMIN_API_KEY` - Admin API key

## 5) Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `N8N_API_KEY` or `N8N_API_KEYS` | API key(s) for n8n access (comma-separated for multiple) | `sk-n8n-xxx` |
| `ADMIN_API_KEY` | API key for admin endpoints | `sk-admin-xxx` |
| `PROVIDERS_CONFIG_PATH` | Path to providers.yaml | `config/providers.yaml` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `8080` | Server port |
| `LOG_LEVEL` | `info` | Fastify log level (trace/debug/info/warn/error/fatal) |
| `MAX_JOB_LOG_LINES` | `300` | Max log lines to retain per login job |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful shutdown timeout (milliseconds) |
| `REQUEST_TIMEOUT_MS` | `300000` | HTTP request/socket timeout for long-running provider requests (milliseconds) |
| `RATE_LIMIT_MAX` | `100` | Max requests per rate limit window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (milliseconds) |
| `MAX_REQUEST_BODY_SIZE` | `10485760` | Max request body size in bytes (10MB) |
| `OPENAI_REASONING_EFFORT` | provider default | Default reasoning effort for chat/responses requests |
| `AUTO_ROUTER_BENCHMARK_ON_START` | `true` | Run the bounded auto-router baseline shortly after startup |
| `AUTO_ROUTER_BENCHMARK_TIMEOUT_MS` | `20000` | Per-probe timeout for auto-router benchmark calls |
| `AUTO_ROUTER_BENCHMARK_MAX_MODELS` | `16` | Max configured models to probe per baseline; `0` means no limit |
| `AUTO_ROUTER_BENCHMARK_CONCURRENCY` | `2` | Concurrent benchmark probes during a baseline |
| `AUTO_ROUTER_BENCHMARK_INTERVAL_MS` | `28800000` | Scheduled baseline interval; default is every 8 hours |
| `AUTO_ROUTER_BENCHMARK_EVALUATE_QUALITY` | `true` | Use a separate strong model to judge benchmark output quality when available |
| `AUTO_ROUTER_BENCHMARK_EVALUATOR_MODEL` | auto-selected | Concrete model id to use as the quality judge |
| `AUTO_ROUTER_BENCHMARK_QUALITY_TIMEOUT_MS` | `15000` | Per-candidate timeout for the quality judge call |
| `CODEX_AGENT_ALLOWED_WORKSPACE_ROOTS` | `SYMPHONY_WORKSPACE_ROOTS`, `SYMPHONY_WORKSPACE_ROOT`, then `FRONTEND_ALLOWED_CWDS` | Comma-separated roots allowed for `/api/codex-agent/*` `workspacePath` values |
| `REMOTE_CLI_TOOL_AUTH_SCOPES` | `frontend,admin` | Comma-separated auth scopes allowed to use `POST /mcp` remote CLI tools (`admin`, `frontend`, `n8n`) |
| `OPENAI_API_KEY` | unset | API key for optional OpenAI `type: openai` providers |
| `GROQ_API_KEY` | unset | API key for Groq `type: openai` providers |
| `MOONSHOT_API_KEY` | unset | API key for Kimi/Moonshot `type: openai` providers |

Kimi is available through the Moonshot OpenAI-compatible API when `MOONSHOT_API_KEY` is set, and through the local `kimi` CLI via the `kimi-for-coding` ACP bridge. The CLI adapter does not use `KIMI_API_KEY`; authenticate once in the provider home by running `kimi` in a TTY and then `/login` (some older CLI builds still use `/setup`).

### Reasoning flags

The gateway accepts these request forms:

- `reasoning_effort: "medium"`
- `reasoningEffort: "medium"`
- `reasoning: { "effort": "medium" }`

Supported values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. For `/v1/chat/completions`, use `reasoning_effort` or `reasoningEffort`. For `/v1/responses`, all three forms are accepted.

## Frontend Chat Endpoint

For web and app clients, standardize on:

- `POST /v1/chat/completions`

Recommended request shape:

```json
{
  "model": "your-codex-model",
  "stream": true,
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "reasoning_effort": "medium"
}
```

Streaming contract:

- Content type is `text/event-stream`
- Each SSE frame is a `chat.completion.chunk`
- Read assistant text from `choices[0].delta.content`
- Read reasoning from `choices[0].delta.reasoning`
- Read tool calls from `choices[0].delta.tool_calls`
- Stop on `data: [DONE]`

Non-streaming contract:

- Final assistant text is `choices[0].message.content`
- Final reasoning is `choices[0].message.reasoning`

Notes:

- True incremental streaming is currently implemented for Codex-backed stream-capable models. Other providers may still return a single final SSE chunk.
- The gateway now emits an immediate SSE prelude comment (`: stream-open`) so clients can detect that the stream opened before model output arrives.
- If you need debugging for Codex app-server event flow, start the gateway with `CODEX_APPSERVER_DEBUG_RPC=1`.

## Frontend Image Endpoint

For frontend image generation, standardize on:

- `POST /v1/images/generations`

Behavior:

- Image-generation requests are routed through the model explicitly marked with `image_generation` capability, currently `gpt-image-2` backed by the OpenAI Codex CLI.
- The Codex bridge explicitly invokes the built-in Codex CLI image workflow (equivalent to adding `$imagegen` to the prompt).
- Image fallback chains skip models that are not explicitly image-generation capable, so Gemini chat models are not used for image generation.
- Request fields such as `size`, `quality`, `style`, `background`, `response_format`, and other passthrough image metadata remain available to the downstream provider flow.

Recommended request shape:

```json
{
  "model": "gpt-image-2",
  "prompt": "Create a clean banner illustration for a developer tools landing page.",
  "size": "1536x1024",
  "quality": "high",
  "style": "vivid"
}
```

## 6) Request Tracing

The gateway generates a unique `x-request-id` for every request. This ID is:
- Returned in the response header
- Included in error responses
- Logged with request details (at debug level)

Use this for tracing requests through logs:

```bash
curl -H "x-api-key: <key>" http://localhost:8080/healthz -v
# < x-request-id: req_abc123...
```

## 7) CLI Execution for Software Development

The gateway includes endpoints to execute CLI commands for automated software development workflows. This allows n8n to trigger git operations, Docker builds, and Kubernetes deployments programmatically.

### Available Commands

- **Git**: `clone`, `commit`, `push`
- **Docker**: `build`, `push`
- **Kubernetes**: `kubectl apply`, `helm install`
- **Build tools**: `npm`, `node`, `make`, `terraform`
- **General**: Any command in the allowed whitelist

### Example Workflow

Clone a repository, build a Docker image, and deploy to Kubernetes:

```bash
# 1. Clone repository
curl -X POST http://localhost:8080/admin/cli/git/clone \
  -H "x-admin-key: <admin-key>" \
  -d '{"repo": "https://github.com/user/myapp.git", "dir": "myapp"}'

# 2. Build Docker image
curl -X POST http://localhost:8080/admin/cli/docker/build \
  -H "x-admin-key: <admin-key>" \
  -d '{"tag": "ghcr.io/user/myapp:v1.0.0", "context": "./myapp"}'

# 3. Push to registry
curl -X POST http://localhost:8080/admin/cli/exec \
  -H "x-admin-key: <admin-key>" \
  -d '{"command": "docker", "args": ["push", "ghcr.io/user/myapp:v1.0.0"]}'

# 4. Deploy to Kubernetes
curl -X POST http://localhost:8080/admin/cli/kubectl/apply \
  -H "x-admin-key: <admin-key>" \
  -d '{"dir": "./myapp/k8s", "namespace": "production"}'
```

### Check Job Status

All CLI commands run asynchronously. Get the job ID from the response and poll for results:

```bash
curl http://localhost:8080/admin/cli/jobs/cli_abc123 \
  -H "x-admin-key: <admin-key>"
```

Response includes `stdout`, `stderr`, `exitCode`, and `status` (running/completed/failed/timed_out).

## 8) Point n8n at this gateway

In n8n OpenAI credentials:

- Base URL: `http://<gateway-host>:8080/v1`
- API Key: value of `N8N_API_KEY`

For Agents/Tools use model ids from `GET /v1/models`.

All `/v1/*` and `/openai/v1/*` routes require either:

```http
Authorization: Bearer <N8N_API_KEY>
```

or:

```http
x-api-key: <N8N_API_KEY>
```

## Provider output contract

`responseCommand.output: text`:

- legacy text mode: raw stdout is returned as assistant text, but the gateway may
  promote JSON-like content to a tool-call contract.

`responseCommand.output: text_plain`:

- strict plain text mode: raw stdout becomes assistant text.
- no JSON/tool-call extraction is attempted.

`responseCommand.output: text_contract_final_line`:

- hybrid strict mode for tool experiments.
- the gateway only tries to parse the final non-empty line as a JSON contract.
- if that final line is invalid contract JSON, output is treated as plain text (`finish_reason: "stop"`).

`responseCommand.output: json_contract`:

- command stdout must be JSON (or final line JSON), shape:

```json
{
  "output_text": "assistant answer",
  "tool_calls": [
    {
      "id": "call_1",
      "name": "search_docs",
      "arguments": "{\"query\":\"oauth\"}"
    }
  ],
  "finish_reason": "tool_calls"
}
```

The gateway also accepts `responses` follow-up tool input entries of `type: "function_call_output"` and maps them to tool-role messages for the next model turn.

### Gemini provider guidance

- Use the dedicated Gemini bridge (`dist/scripts/gemini-cli-bridge.js`) for tool turns.
- The bridge normalizes Gemini `stream-json` output into the same JSON tool-call contract used by the Codex and Kimi adapters.

### Kimi, Groq, and DeepSeek routing

- Kimi runs through `dist/scripts/kimi-acp-bridge.js`, which starts `kimi acp` over stdio and converts ACP output to the gateway JSON contract.
- Groq and DeepSeek should use `type: openai` providers instead of shell/curl CLI wrappers. The shared provider forwards normal OpenAI chat messages and tools directly to `/chat/completions`.
- Groq compound models are treated as hosted-tool systems; when n8n sends gateway-managed tools, the registry should route to a fallback model.
- DeepSeek compatibility aliases stay exposed for older clients, but they map to current v4 provider models: `deepseek-chat` and `deepseek-coder` use `deepseek-v4-flash`, while `deepseek-reasoner` uses `deepseek-v4-pro`.
- DeepSeek `reasoning_effort` is translated to the provider `thinking` object: `none`/`minimal` disables thinking, `low`/`medium`/`high` uses `high`, and `xhigh` uses `max`.
- The checked-in provider catalogs are expected to have globally unique model IDs and fallback targets that resolve to configured models; use provider-prefixed aliases when two providers expose the same upstream model.

### Image generation provider output

`POST /v1/images/generations` maps provider output to OpenAI image response format. The configured image model is `gpt-image-2`, an OpenAI Codex CLI-backed alias that explicitly routes the turn through Codex CLI image generation. Image requests and image fallback chains are constrained to models with the `image_generation` capability.

Accepted provider output patterns:

- plain URL text: `https://...`
- plain data URL text: `data:image/png;base64,...`
- JSON object/array in text:
  - `{"data":[{"url":"https://..."}]}`
  - `{"data":[{"b64_json":"..."}]}`
  - `[{"url":"https://..."}]`
  - `{"images":[{"b64_json":"...","revised_prompt":"..."}]}`

Returned shape:

```json
{
  "created": 0,
  "data": [
    {
      "url": "https://...",
      "b64_json": "...",
      "revised_prompt": "optional"
    }
  ]
}
```

### Document generation provider output

`POST /v1/documents/generations`, `POST /v1/files/generations`, and `POST /v1/presentations/generations` run the selected model and expect document payloads in JSON or base64 form. Use the presentations alias when the provider is producing decks such as `.pptx`.

Accepted provider output patterns:

- raw base64 text
- data URL text such as `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,...`
- JSON object/array in text:
  - `{"data":[{"filename":"deck.pptx","mime_type":"application/vnd.openxmlformats-officedocument.presentationml.presentation","b64_data":"..."}]}`
  - `{"documents":[{"filename":"deck.pptx","base64":"..."}]}`
  - `[{"name":"deck.pptx","b64_json":"..."}]`

Optional design/document fields that are also passed through when present:

- `title`
- `summary`
- `text`
- `markdown`
- `html`
- `page_count`
- `slide_count`
- `theme`
- `template`
- `design_style`
- `preview_url`
- `preview_b64_json`
- `slides` as an array of `{title, subtitle, text, notes, bullets, image_url}`

Request body:

```json
{
  "model": "gemini-2.5-flash",
  "prompt": "Create a 5-slide product overview deck.",
  "file_type": "pptx",
  "filename": "product-overview.pptx"
}
```

Returned shape:

```json
{
  "created": 0,
  "data": [
    {
      "filename": "product-overview.pptx",
      "mime_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "b64_data": "...",
      "title": "Product Overview",
      "slide_count": 5,
      "theme": "modern",
      "design_style": "editorial",
      "slides": [
        {
          "title": "Problem",
          "bullets": ["Fragmented workflow", "High reporting overhead"]
        }
      ]
    }
  ]
}
```

## Kubernetes

Use:

- `kubernetes/deployment.yaml`
- `kubernetes/configmap-example.yaml`
- `kubernetes/rancher-install.yaml` (single-file Rancher import)

Password safety:

- Deploy manifests intentionally do not define `n8n-openai-cli-gateway-secrets`.
- Create the Secret before first deploy, or add missing provider keys later, with `scripts/ensure-gateway-secrets.sh` or `scripts/ensure-gateway-secrets.ps1`.
- The helper never overwrites existing keys. It only creates the Secret when missing or patches absent keys.
- Do not put real API keys back into Rancher/import YAML unless you are intentionally rotating them by hand.
- If your GHCR image is private, create the image pull Secret separately and attach it outside the import YAML; do not store the registry token in this bundle.

Linux/macOS:

```bash
chmod +x scripts/ensure-gateway-secrets.sh
N8N_API_KEY="replace-with-long-random-n8n-key" \
ADMIN_API_KEY="replace-with-long-random-admin-key" \
./scripts/ensure-gateway-secrets.sh

# Optional provider keys are added only when absent.
GROQ_API_KEY="replace-with-groq-api-key" ./scripts/ensure-gateway-secrets.sh
MOONSHOT_API_KEY="replace-with-moonshot-api-key" ./scripts/ensure-gateway-secrets.sh
```

Windows PowerShell:

```powershell
$env:N8N_API_KEY = "replace-with-long-random-n8n-key"
$env:ADMIN_API_KEY = "replace-with-long-random-admin-key"
.\scripts\ensure-gateway-secrets.ps1

# Optional provider keys are added only when absent.
$env:GROQ_API_KEY = "replace-with-groq-api-key"
.\scripts\ensure-gateway-secrets.ps1
$env:MOONSHOT_API_KEY = "replace-with-moonshot-api-key"
.\scripts\ensure-gateway-secrets.ps1
```

Important for OAuth/token persistence:

- `HOME` is mounted to PVC: `/var/lib/gateway-home`
- Provider CLIs should store credentials under this persistent path.
- Deployment is pinned to `arm64` nodes via `nodeSelector`.
  Remove the selector if you publish a multi-arch image and want mixed scheduling.

### Gemini auth bootstrap secret

The Kubernetes manifests now support an optional Secret named `n8n-openai-cli-gateway-gemini-auth`.
If the PVC does not already contain `/var/lib/gateway-home/.gemini/oauth_creds.json`, an init container
will seed `/var/lib/gateway-home/.gemini/` from that Secret on startup. Existing PVC auth is left untouched.

This is the repeatable way to bring Gemini auth forward to a fresh cluster or a fresh PVC.

Create the Secret from a running gateway pod if it does not already exist:

```bash
chmod +x scripts/bootstrap-gemini-auth-secret.sh
./scripts/bootstrap-gemini-auth-secret.sh
```

Create the Secret from a local Gemini CLI directory if it does not already exist:

```bash
./scripts/bootstrap-gemini-auth-secret.sh --source-dir "$HOME/.gemini"
```

Windows PowerShell:

```powershell
.\scripts\bootstrap-gemini-auth-secret.ps1
.\scripts\bootstrap-gemini-auth-secret.ps1 -SourceDir "$HOME\.gemini"
```

To intentionally refresh stored Gemini auth, pass `--overwrite` for Bash or `-Overwrite` for PowerShell.

After creating or intentionally refreshing the Secret, restart the deployment if you want a fresh PVC to be seeded on next start:

```bash
kubectl rollout restart deployment/n8n-openai-cli-gateway -n n8n-openai-gateway
```

### Codex on Kubernetes

The runtime image already installs `@openai/codex`, and the Kubernetes manifests set `CODEX_EXECUTABLE=codex`
so the gateway, admin auth commands, and Codex app-server bridge all resolve the Linux CLI path consistently.

For a new cluster or a new PVC, authenticate Codex once after deploy:

```bash
curl -X POST http://<gateway-host>:8080/admin/providers/codex-cli/login \
  -H "x-admin-key: <admin-key>"
```

This now runs `codex login --device-auth`. The resulting auth state is stored under
`/var/lib/gateway-home` on the PVC, so pod restarts reuse it.

Verify status with:

```bash
curl -X POST http://<gateway-host>:8080/admin/providers/codex-cli/status \
  -H "x-admin-key: <admin-key>"
```

If you prefer to log in directly inside the pod, use:

```bash
kubectl -n n8n-openai-gateway exec -it deploy/n8n-openai-cli-gateway -- codex login --device-auth
```

## Build image

```bash
docker build -t n8n-openai-cli-gateway:latest .
```

If provider CLIs are not in PATH, extend `Dockerfile` to install them in the runtime image.

For Linux arm64 builds and pushes:

```bash
docker buildx build \
  --platform linux/arm64 \
  -t ghcr.io/your-org/n8n-openai-cli-gateway:latest \
  --push .
```

To bake CLI packages into the image:

```bash
docker buildx build \
  --platform linux/arm64 \
  --build-arg EXTRA_NPM_GLOBAL_PACKAGES="@openai/codex @google/gemini-cli opencode-ai" \
  -t ghcr.io/your-org/n8n-openai-cli-gateway:latest \
  --push .
```

Use only CLI packages that publish Linux arm64 binaries.

### OpenCode OAuth for Gemini

If you use the `opencode-gemini-auth` plugin, mount this config at `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-auth@latest"]
}
```

Then run login interactively in the pod:

```bash
kubectl -n n8n-openai-gateway exec -it deploy/n8n-openai-cli-gateway -- opencode auth login
```

## Rancher Install

Use `kubernetes/rancher-install.yaml` as a single import in Rancher:

1. In Rancher, go to your target cluster and choose `Import YAML`.
2. Paste `kubernetes/rancher-install.yaml`.
3. Change:
   - `ghcr.io/your-org/n8n-openai-cli-gateway:latest`
   - ingress host `gateway.example.com`
   - `providers.yaml` contents for your real CLI commands/models
4. Deploy.

Before first deploy, create `n8n-openai-cli-gateway-secrets` through the Rancher Secrets UI or the `ensure-gateway-secrets` helper above. Existing clusters should keep the existing Secret; the Rancher import YAML does not overwrite it.

Optional for Gemini CLI:

- Create the `n8n-openai-cli-gateway-gemini-auth` Secret before first start if you want Rancher to seed Gemini OAuth state into a new PVC automatically.
- Use `scripts/bootstrap-gemini-auth-secret.sh` or `scripts/bootstrap-gemini-auth-secret.ps1` to export that Secret from an existing working environment.

After deploy:

- In-cluster base URL for n8n: `http://n8n-openai-cli-gateway.n8n-openai-gateway.svc.cluster.local/v1`
- External ingress URL (if enabled): `https://gateway.example.com/v1`
- Auth header:
  - `Authorization: Bearer <n8nApiKey>`
  - or `x-api-key: <n8nApiKey>`

### Add Groq to the Rancher bundle

If you already use the bundled Rancher manifest, generate a merged copy with Groq added.

Ubuntu/Linux:

```bash
chmod +x scripts/merge-rancher-groq.sh
./scripts/merge-rancher-groq.sh \
  --input kubernetes/rancher-install.yaml \
  --output kubernetes/rancher-install-groq.yaml \
  --groq-api-key "replace-with-your-groq-api-key"
```

PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/merge-rancher-groq.ps1 `
  -InputPath kubernetes/rancher-install.yaml `
  -OutputPath kubernetes/rancher-install-groq.yaml `
  -GroqApiKey "replace-with-your-groq-api-key"
```

That writes `kubernetes/rancher-install-groq.yaml` with:

- `GROQ_API_KEY` added to the gateway deployment
- a Groq provider block added to the embedded `providers.yaml`

The Groq API key is not written into the YAML. Add it safely with `scripts/ensure-gateway-secrets.sh --groq-api-key ...` or `scripts/ensure-gateway-secrets.ps1 -GroqApiKey ...`; existing `groqApiKey` values are kept.

The generated Groq models match the current Groq docs production/system IDs:

- `groq/compound`
- `groq/compound-mini`
- `openai/gpt-oss-120b`
- `openai/gpt-oss-20b`
- `llama-3.3-70b-versatile`
- `llama-3.1-8b-instant`

Do not import `kubernetes/groq-rancher-overlay.yaml` directly into Rancher as a standalone manifest. Rancher applies imported YAML as full Kubernetes resources, and that file is only suitable as a patch-style overlay, not a complete deployment object.
