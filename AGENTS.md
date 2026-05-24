# n8n OpenAI CLI Gateway - Agent Guide

## Project Overview

This is an OpenAI-compatible API gateway that bridges n8n (workflow automation platform) with CLI-based AI model providers. It exposes standard OpenAI REST endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/images/generations`, `/v1/models`) while delegating actual model execution to configurable CLI commands (Gemini CLI, OpenAI Codex, Antigravity, etc.).

**Key Value Proposition**: n8n uses a single API key to talk to this gateway, while provider authentication (OAuth flows, API keys) is handled separately via admin endpoints and background login jobs. This decouples n8n configuration from provider credential management.

## Technology Stack

- **Runtime**: Node.js 20+ (CommonJS)
- **Language**: TypeScript 5.8+ with strict mode enabled
- **Web Framework**: Fastify 5.2+
- **Schema Validation**: Zod 3.24+
- **YAML Parsing**: yaml 2.7+
- **Development**: tsx for hot-reload during development

## Project Structure

```
src/
├── index.ts              # Application entry point - initializes config, registry, server
├── server.ts             # Fastify server setup, route registration, error handling
├── config.ts             # Environment-based configuration and providers.yaml parsing
├── types.ts              # TypeScript type definitions for all domain objects
├── validation.ts         # Zod schemas for request validation
├── routes/
│   ├── openai.ts         # OpenAI-compatible API endpoints (/v1/*, /openai/v1/*)
│   └── admin.ts          # Admin endpoints for provider management, login jobs, stats, rate limits
├── providers/
│   ├── provider.ts       # Provider interface definition
│   ├── cli-provider.ts   # CLI-based provider implementation with output parsing
│   └── registry.ts       # Provider registry with fallback chain logic and stats tracking
├── jobs/
│   └── job-manager.ts    # Background login job execution and log management
├── stats/
│   └── model-stats.ts    # Model health tracking, failure classification, cooldown logic
├── scripts/
│   ├── codex-appserver-bridge.ts  # JSON-RPC bridge for Codex app-server mode
│   └── gateway-cli.ts    # CLI tool for querying gateway health and rate limits
└── utils/
    ├── command.ts        # Command execution with template variable substitution
    ├── ids.ts            # ID generation utilities
    ├── lru-map.ts        # LRU cache implementation for rate limiting
    ├── prompt.ts         # Message-to-prompt conversion and text extraction
    ├── shell.ts          # Shell escaping utilities for security
    ├── template.ts       # Mustache-style template string replacement
    └── tools.ts          # Tool name normalization utilities

config/
└── providers.example.yaml  # Example provider configuration template

kubernetes/
├── deployment.yaml         # K8s deployment with PVC for credential persistence
├── configmap-example.yaml  # ConfigMap and Secret examples
├── service.yaml            # ClusterIP service definition
└── rancher-install.yaml    # Single-file Rancher import manifest

.github/workflows/
└── build.yml               # Multi-arch Docker build and push to GHCR
```

## Build and Development Commands

```bash
# Install dependencies
npm install

# Development with hot reload (requires tsx)
npm run dev

# Type check without emitting
npm run check

# Build for production (compiles to dist/)
npm run build

# Start production server (requires compiled dist/)
npm start
```

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `N8N_API_KEY` or `N8N_API_KEYS` | API key(s) for n8n access (comma-separated for multiple) | `sk-n8n-xxx` |
| `ADMIN_API_KEY` | API key for admin endpoints | `sk-admin-xxx` |
| `PROVIDERS_CONFIG_PATH` | Path to providers.yaml | `config/providers.yaml` |

### Optional Environment Variables

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

### Provider Configuration (providers.yaml)

Providers are configured via YAML. Each provider defines:

- `id`: Unique provider identifier
- `type`: Currently only `"cli"` is supported
- `models`: Array of exposed model IDs with optional `providerModel` mapping and `fallbackModels`
- `responseCommand`: CLI command template for model execution
- `auth`: Optional `loginCommand` and `statusCommand` for OAuth flows

**Template Variables in Commands:**
- `{{model}}` - Requested model ID from API
- `{{provider_model}}` - Provider-specific model ID
- `{{codex_executable}}` - Resolved Codex CLI executable (`CODEX_EXECUTABLE`, or platform default)
- `{{reasoning_effort}}` - Normalized reasoning effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) when provided
- `{{prompt}}` - Flattened prompt text
- `{{prompt_file}}` - Path to temp prompt file
- `{{request_file}}` - Path to temp request JSON
- `{{request_id}}` - Unique request ID
- `{{provider_id}}` - Provider ID

**Reasoning Flags:**
- `reasoning_effort` and `reasoningEffort` are accepted on chat/responses requests
- `reasoning: { effort: "medium" }` is also accepted on `/v1/responses`
- Supported values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`

**Auth Commands:**
- `auth.loginCommand` - OAuth/login flow command
- `auth.statusCommand` - Check authentication status
- `auth.rateLimitCommand` - Check provider rate limits/quota (optional)

**Codex CLI Override:**
- `CODEX_EXECUTABLE` - Override the Codex CLI executable used by the bridge and direct Codex auth/session commands. Useful on Windows when PATH resolves to an inaccessible WindowsApps binary.

**Output Modes:**
- `text`: Raw stdout with optional JSON contract detection
- `text_plain`: Strict plain text, no JSON parsing
- `text_contract_final_line`: Parse only final non-empty line as JSON contract
- `json_contract`: Require valid JSON contract output

**Input Modes:**
- `prompt_stdin`: Send flattened prompt via stdin
- `request_json_stdin`: Send full request JSON via stdin

## API Endpoints

### OpenAI-Compatible Endpoints (require `Authorization: Bearer <N8N_API_KEY>` or `x-api-key: <N8N_API_KEY>`)

| Endpoint | Description |
|----------|-------------|
| `GET /v1/models` | List available models |
| `POST /v1/chat/completions` | Chat completions (non-streaming) |
| `POST /v1/messages` | Alias for chat/completions |
| `POST /v1/message` | Alias for chat/completions |
| `POST /v1/responses` | OpenAI Responses API format |
| `POST /v1/images/generations` | Image generation |

All endpoints are also available under `/openai/v1/*` for in-cluster compatibility.

### Admin Endpoints (require `x-admin-key: <ADMIN_API_KEY>` or `Authorization: Bearer <ADMIN_API_KEY>`)

| Endpoint | Description |
|----------|-------------|
| `GET /admin/providers?check=true` | List providers with optional auth status check |
| `POST /admin/providers/:id/login` | Start OAuth login job |
| `POST /admin/providers/:id/status` | Check provider auth status |
| `GET /admin/jobs?limit=20` | List recent login jobs |
| `GET /admin/jobs/:id` | Get login job details and logs |
| `GET /admin/stats/models` | Get model health/fallback statistics |
| `GET /admin/stats/models/:id` | Get single model statistics |
| `GET /admin/rate-limits` | Get rate limits for all providers |
| `GET /admin/rate-limits/:providerId` | Get rate limits for specific provider |

#### CLI Execution Endpoints (Software Development Workflows)

| Endpoint | Description |
|----------|-------------|
| `POST /admin/cli/exec` | Execute arbitrary CLI command |
| `POST /admin/cli/git/clone` | Clone a git repository |
| `POST /admin/cli/git/commit` | Commit changes to git |
| `POST /admin/cli/git/push` | Push changes to remote |
| `POST /admin/cli/docker/build` | Build Docker image |
| `POST /admin/cli/kubectl/apply` | Apply Kubernetes manifests |
| `GET /admin/cli/jobs` | List CLI execution jobs |
| `GET /admin/cli/jobs/:id` | Get CLI job status and output |

**Allowed Commands:** git, docker, kubectl, helm, npm, node, python, make, terraform, aws, gcloud, az, and standard Unix utilities.

**Example - Clone and Deploy:**
```bash
# Clone repository
curl -X POST http://localhost:8080/admin/cli/git/clone \
  -H "x-admin-key: <key>" \
  -d '{"repo": "https://github.com/user/app.git", "dir": "./app"}'

# Build Docker image
curl -X POST http://localhost:8080/admin/cli/docker/build \
  -H "x-admin-key: <key>" \
  -d '{"tag": "myapp:v1", "context": "./app", "cwd": "."}'

# Deploy to Kubernetes
curl -X POST http://localhost:8080/admin/cli/kubectl/apply \
  -H "x-admin-key: <key>" \
  -d '{"dir": "./app/k8s", "namespace": "production"}'
```
| `GET /admin/rate-limits` | Get rate limits for all providers |
| `GET /admin/rate-limits/:providerId` | Get rate limits for specific provider |

### Health Check

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness/readiness probe |

## Code Style Guidelines

1. **TypeScript Strict Mode**: Enabled with `noUncheckedIndexedAccess`. All indexed access requires null checks.

2. **Naming Conventions**:
   - PascalCase for types, interfaces, classes
   - camelCase for variables, functions, methods
   - UPPER_SNAKE_CASE for environment variable constants

3. **Import Style**: Use explicit `.js` extensions for relative imports (Node.js ESM/CJS interop):
   ```typescript
   import { something } from "./utils/something.js";
   ```

4. **Error Handling**: 
   - Use Fastify's error handler in routes
   - Always check `reply.sent` before sending error responses
   - Provider errors should include stderr/stdout context

5. **Comments**: Minimal inline comments; prefer self-documenting code. Use comments for non-obvious business logic.

## Testing Strategy

This project does not include automated test suites. Testing is performed via:

1. **Manual Integration Testing**: Run against actual CLI providers
2. **Health Checks**: `curl http://localhost:8080/healthz`
3. **Admin Workflow Testing**:
   ```bash
   # Start login job
   curl -X POST http://localhost:8080/admin/providers/gemini-cli/login -H "x-admin-key: <key>"
   
   # Poll job logs
   curl http://localhost:8080/admin/jobs/<job_id> -H "x-admin-key: <key>"
   ```

## Security Considerations

1. **API Key Separation**: n8n API keys and admin API keys are completely separate. Never expose admin endpoints to n8n.

2. **Command Injection Prevention**: The gateway shell-escapes user-controlled variables (like `{{prompt}}`) when used in shell contexts. However, provider configuration files should still be writable only by administrators.

3. **Credential Persistence**: In Kubernetes, `HOME` is mounted to a PVC at `/var/lib/gateway-home`. Provider CLIs store credentials here.

4. **Non-Root Execution**: Docker image runs as user `gateway` (UID 10001).

5. **Network Security**: The gateway does not implement TLS termination. Use an ingress controller or load balancer for HTTPS.

6. **Secret Management**:
   - Never commit `config/providers.yaml` with real credentials
   - Use Kubernetes Secrets for API keys
   - Use environment variables for sensitive configuration
   - Do not put gateway API keys in deploy/import YAML. Use `scripts/ensure-gateway-secrets.sh` or `scripts/ensure-gateway-secrets.ps1`, which creates the Secret when missing and only patches absent keys.
   - If a private image needs an image pull Secret, create and attach it separately; do not store registry tokens in the Rancher bundle.
   - Never overwrite existing cluster Secret keys during deploy unless the user explicitly asks to rotate that key.

## Deployment

### Docker Build

```bash
# Local build
docker build -t n8n-openai-cli-gateway:latest .

# Multi-arch build with CLI packages
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg EXTRA_NPM_GLOBAL_PACKAGES="@openai/codex @google/gemini-cli opencode-ai" \
  -t ghcr.io/your-org/n8n-openai-cli-gateway:latest \
  --push .
```

### Kubernetes Deployment

1. Update image references in `kubernetes/deployment.yaml`
2. Create or fill missing API keys with `scripts/ensure-gateway-secrets.sh` or `scripts/ensure-gateway-secrets.ps1`
3. Customize `providers.yaml` in ConfigMap
4. Remove or modify `nodeSelector` if not targeting arm64 nodes
5. Apply only the intended manifests; do not use deploy YAML to rotate passwords

### Fallback Chain Behavior

The gateway implements automatic fallback between models:

1. Primary model is attempted first
2. If execution fails and `fallbackModels` are configured, each fallback is tried in order
3. Failures are classified (rate_limited, capacity_exhausted, auth, etc.)
4. Model stats track success rates, consecutive failures, and suggested cooldown periods
5. Fallbacks can cross providers (e.g., Gemini → Codex → Gemini)

## Common Provider Setups

### Gemini via OpenCode
```yaml
responseCommand:
  executable: opencode
  args: [run, --model, "{{provider_model}}", --format, default, "{{prompt}}"]
  input: prompt_stdin
  output: text
auth:
  loginCommand:
    executable: opencode
    args: [auth, login]
```

### Codex via App-Server Bridge
```yaml
responseCommand:
  executable: node
  args: [dist/scripts/codex-appserver-bridge.js, --model, "{{provider_model}}"]
  input: request_json_stdin
  output: json_contract
```

### Antigravity CLI
```yaml
responseCommand:
  executable: antigravity
  args: [chat, --model, "{{provider_model}}", --json]
  input: request_json_stdin
  output: json_contract
```

## Troubleshooting

1. **Provider command not found**: Ensure CLI tools are installed in the runtime image or available in PATH
2. **OAuth login expires**: Use admin login endpoints to re-authenticate; logs contain URLs/codes
3. **Model fallback loops**: Check `fallbackModels` configuration for circular references
4. **High memory usage**: Adjust `MAX_JOB_LOG_LINES` to retain fewer log entries per job
