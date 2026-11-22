# agy-subscription provider

Default-off gateway path for Gemini 4 Neon and Gemini 4 Hydrogen through
Google's Antigravity CLI (`agy`) using a Google AI Pro or Ultra subscription.
This is separate from the existing `gemini-api` provider, which uses
`GEMINI_API_KEY` and per-token API billing.

This change does not deploy or alter the live router. The current live image
and rollback target stay as they are until an explicit yes: revision 666,
`ghcr.io/philly1084/cli-model-gateway@sha256:151e23a8…`, with previous
revision 665 as rollback.

## Why it cannot run inside the gateway pod

`agy` stores the Google OAuth session in the Windows Credential Manager on the
MSI. The gateway process on Lilly cannot see that keyring, and this provider
must not set `modelProvider: gemini` or `GEMINI_API_KEY` (that would switch
the CLI onto paid API billing).

Codex chat completions already run in-cluster through
`codex-appserver-bridge`. Remote CLI SSH targets in
`n8n-openai-cli-gateway-targets` are coding hosts, not the MSI. The MSI
Tailscale mesh address is reachable from Lilly (`msi-mesh` / `lilly-mesh`),
but Windows OpenSSH Server is not running and this work does not enable it
(that may need an admin prompt).

The intended enablement path is a user-scope worker on the MSI that binds
only to the Tailscale address (never `0.0.0.0`) and exposes `/healthz` plus
`POST /v1/complete`. The in-cluster bridge calls that worker.

## Models

| Gateway id | `agy --model` slug | Notes |
| --- | --- | --- |
| `agy-gemini-4-neon` | `gemini-4-neon` | Manual only, not auto-eligible. Needs a paid Google AI Pro or Ultra plan. |
| `agy-gemini-4-hydrogen` | `gemini-4-hydrogen` | Manual only, not auto-eligible. Needs a paid Pro plan (non-trial) or Ultra. |

These ids are distinct from the paid `gemini-api` catalog entries
`gemini-4-neon` and `gemini-4-hydrogen`, so they cannot steal or change
existing API routes.

## Sign in on the MSI

There is no `agy login` command. After installing `agy` (user-scope, already
done at `%LOCALAPPDATA%\agy\bin`), sign in from a local terminal on the MSI
desktop so a browser can open:

```powershell
agy
```

What you should see:

1. On first launch, prompts for color scheme, rendering mode, and workspace
   trust. Pick any preferred color and rendering mode, and trust a dedicated
   folder if asked. A good workspace is
   `C:\Users\phill\AppData\Local\agy\gateway-workspace`.
2. If no saved session exists, `agy` opens the default browser for Google
   OAuth. Sign in with the Google account that has AI Pro or Ultra. Choose
   Google OAuth for a personal account, not "Use a Google Cloud project" and
   not a Gemini API key.
3. After the browser finishes, the CLI header should show that account email,
   not "Gemini API key".

If you run `agy` over SSH or another remote session instead, the CLI prints
an authorization URL. Open that URL in a local browser, sign in, then paste
the alphanumeric code back into the terminal.

After sign-in, this check should list Neon and Hydrogen if the plan includes
them:

```powershell
agy models
agy -p "Reply with the number 391 only" --model gemini-4-neon
```

Headless mode reuses the cached keyring session. It will not open a browser.
If you are not signed in, `agy models` exits with "Please sign in to view
available models."

## Enablement (not done in this PR)

1. Confirm `agy models` shows `gemini-4-neon` and `gemini-4-hydrogen`.
2. Start the worker on the MSI, user-scope only, bound to the mesh address:

   ```powershell
   $env:AGY_SUBSCRIPTION_TOKEN = "<shared secret>"
   $env:AGY_SUBSCRIPTION_BIND = "100.90.0.2"
   $env:AGY_SUBSCRIPTION_PORT = "8787"
   $env:AGY_SUBSCRIPTION_EXECUTABLE = "$env:LOCALAPPDATA\agy\bin\agy.exe"
   $env:AGY_SUBSCRIPTION_WORKDIR = "$env:LOCALAPPDATA\agy\gateway-workspace"
   node dist\scripts\agy-subscription-worker.js
   ```

3. On the gateway, set `AGY_SUBSCRIPTION_ENABLED=true`,
   `AGY_SUBSCRIPTION_MODE=http`, `AGY_SUBSCRIPTION_URL=http://100.90.0.2:8787`,
   and the same `AGY_SUBSCRIPTION_TOKEN`. Do not put the token in git or chat.
4. Add the `agy-subscription` provider from
   `config/providers.example.yaml` to the live ConfigMap, keeping both
   models `manualOnly: true` and `autoEligible: false`.
5. Identify the current image and rollback target before that rollout. Do not
   prune the live or rollback images.

SSH mode (`AGY_SUBSCRIPTION_MODE=ssh`) exists for a future OpenSSH Server or
Tailscale SSH path. It is not enabled, and this PR does not start `sshd`.

## Safety defaults

- Tools are off in the provider profile.
- The worker and local launch pass `--sandbox` and session-only settings that
  deny `command` and `write_file` (`{"permissions":{"deny":[...]}}` only;
  agy rejects `agentMode: "default"`).
- The worker spawns `agy` with stdin closed so headless runs never wait on
  input, and retries once on transient entitlement errors (404 NOT_FOUND or a
  free-tier model list), which were seen for a few minutes after a plan
  upgrade.
- `--dangerously-skip-permissions` is never used.
- The worker refuses wildcard bind addresses.
- Diagnostics redact bearer tokens.

## Official references

- [Get started](https://antigravity.google/docs/getting-started/)
- [Authenticate](https://antigravity.google/docs/install/)
- [Headless mode](https://antigravity.google/docs/cli/headless/)
- [Models](https://antigravity.google/docs/models/)
