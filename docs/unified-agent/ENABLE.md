# Enable the experimental agent

This is an operator-run procedure. Keep the agent disabled until an image containing
this feature has been reviewed and deployed through your normal release process.
The phase 1 runtime supports model text only; it does not provide sandboxed code
execution or write tools. Enabling it can make calls to configured model providers.

## Prepare keys on the operator machine

On Windows, install the `sops` and `age` binaries (including `age-keygen`) on PATH,
for example via winget or the pinned release binaries, plus Git for
output-location validation. The Windows script supports Windows PowerShell 5.1
and later. Git Bash can use the `.sh` script, which also requires Python 3.
Generate outside **every** Git work tree:

```powershell
powershell -NoProfile -File scripts/agent-keys/generate-agent-keys.ps1
```

```sh
bash scripts/agent-keys/generate-agent-keys.sh
```

Defaults are `%USERPROFILE%\.cli-model-gateway\agent-keys` and
`~/.cli-model-gateway/agent-keys`. Override with `-OutputDir` or `--output-dir`.
`-ValidateOnly` / `--validate-only` checks location and overwrite rules without
requiring crypto tools or generating anything. Existing files require `-Force` /
`--force`; replacing an identity/key set can make old state unreadable. Back up
the old identity and keys securely before replacement. Preserve historical data
key ids when rotating an existing store.

The scripts create a private directory, age identity `age-key.txt`, and two
SOPS-encrypted JSON files. Their decrypted shapes match `SopsKeyProvider`:
`{"keys":{"data":"<base64 of 32 random bytes>"}}` and
`{"macKey":"<base64 of a separate 32 random bytes>"}`. Plaintext JSON exists only
in restricted temporary files, deleted in cleanup/finally blocks. Only paths and
the public age recipient are printed. Never add identities, encrypted key files,
or generated keys to this public repository. Keep shell tracing/transcripts off
when generating keys.

## Create the separate Secret

Select the intended context and namespace yourself. The examples below use the
namespace from the bundled manifests; adapt `-n` consistently if yours differs.
The scripts print a command using your paths. Add the intended namespace:

```powershell
$keyDir = Join-Path $env:USERPROFILE '.cli-model-gateway/agent-keys'
kubectl -n n8n-openai-gateway create secret generic cli-model-gateway-agent-keys --from-file="keys.sops.json=$keyDir/keys.sops.json" --from-file="checker.sops.json=$keyDir/checker.sops.json" --from-file="age-key.txt=$keyDir/age-key.txt"
```

```sh
key_dir="$HOME/.cli-model-gateway/agent-keys"
kubectl -n n8n-openai-gateway create secret generic cli-model-gateway-agent-keys \
  --from-file="keys.sops.json=$key_dir/keys.sops.json" \
  --from-file="checker.sops.json=$key_dir/checker.sops.json" \
  --from-file="age-key.txt=$key_dir/age-key.txt"
```

This creates a new Secret and leaves existing gateway API keys untouched. The
Secret contains the decryption identity too: SOPS does not protect against a
principal that can read this Secret. Restrict Secret access with cluster RBAC.

## Enable with a strategic-merge patch

Record the pre-patch Deployment revision before proceeding. Verify the Deployment
already has one replica and ensure no HPA or other controller will scale it above
one replica. The patch leaves the live replica count unchanged and uses
`maxSurge: 0`, `maxUnavailable: 1` to avoid overlapping writers on the PVC when
running one replica. Rollouts have an availability gap.

```sh
kubectl -n n8n-openai-gateway rollout history deployment/n8n-openai-cli-gateway
kubectl -n n8n-openai-gateway patch deployment n8n-openai-cli-gateway --type strategic --patch-file kubernetes/agent-enable-patch.yaml
kubectl -n n8n-openai-gateway rollout status deployment/n8n-openai-cli-gateway
```

**Never apply the patch as a full Deployment.** Strategic merge preserves existing
containers, env, routes, image, PVC and other live settings by name. The patch adds
a read-only Secret at `/etc/gateway-agent-keys`, mode `0440`; pod `fsGroup: 10001`
allows the non-root gateway user (UID 10001) to read the group-owned files.
`fsGroup` applies to the Secret volume and to supported PVCs, so check that this
group fits your existing volume policy. `fsGroupChangePolicy: OnRootMismatch`
avoids recursive ownership changes on supported volumes when the root already
matches; it does not change Secret volume handling. `AGENT_DATA_DIR` is created
recursively with mode `0700` when missing. SOPS inherits `SOPS_AGE_KEY_FILE` from
the process environment. Stale writer locks fail closed: reconcile interrupted
work before any manual removal. Do not delete encrypted state to clear a lock.

## Verify through the service

The public ingress exposes only selected paths. Access the test page through a
local port-forward, or explicitly decide to expose an `/admin/agent` Prefix path
on your HTTPS ingress. No ingress change is included in this feature.

```sh
kubectl -n n8n-openai-gateway port-forward svc/n8n-openai-cli-gateway 8080:80
```

In another terminal:

```sh
curl -i http://localhost:8080/healthz
curl -i http://localhost:8080/admin/agent/inbox
```

Expect healthy JSON and **401** on the unauthenticated inbox. Open
`http://localhost:8080/admin/agent/ui`, sign in with the existing admin key, and
submit a tiny text goal. Refresh the task list, inspect child status and explicit
untrusted logs, and check the inbox. A health response alone does not demonstrate
provider or checker success. Check final receipts/state; `needs_review` is not
successful completion. Tasks without children have no delegate log or controls.

Sessions are process-local, capped at 128, expire after 30 minutes idle or 8 hours
absolute, and disappear on restart. Cookies are HttpOnly, SameSite=Strict and
scoped to `/admin/agent`; HTTPS uses Secure. Plain HTTP is allowed only with a
loopback peer and localhost/loopback host. Configure the ingress to overwrite
`X-Forwarded-Proto` and prevent untrusted direct access to the gateway when using
that header to identify HTTPS. Five failed logins per peer IP per minute are
allowed; behind a proxy this can be a shared limit.

UI state-changing APIs require a session and its `X-CSRF-Token`, including when an
admin header is supplied. Header clients first GET `/admin/agent/ui/api/session`
with their admin header, retain the returned cookie, then send its CSRF token on
mutations. Goals are sealed server-side with AAD `agent:submit`; the browser never
receives keys or envelopes. Optional submit `budget` uses the real router fields
`maxCalls` (1–8) and `deadlineMs` (1–600000); it applies per planning/delegate
operation, not as a total job spending cap. Recent jobs are limited to 50 parent
ids submitted by this process. Status uses parent ids; log/stop/summarize use
delegate child ids shown by status.

## Roll back

`set env AGENT_ENABLED-` only turns the agent off (disabling new startup and
removing its routes); it leaves the other patch settings in place:

```sh
kubectl -n n8n-openai-gateway set env deployment/n8n-openai-cli-gateway -c gateway AGENT_ENABLED-
kubectl -n n8n-openai-gateway rollout status deployment/n8n-openai-cli-gateway
```

To revert env, strategy, securityContext and the mount together, use
`rollout undo --to-revision=<pre-patch revision>` to restore the recorded revision.
This restores the whole pod template, including any intervening changes; review
first:

```sh
kubectl -n n8n-openai-gateway rollout undo deployment/n8n-openai-cli-gateway --to-revision=<pre-patch-revision>
kubectl -n n8n-openai-gateway rollout status deployment/n8n-openai-cli-gateway
```

Verify `/admin/agent/inbox` and `/admin/agent/ui` return 404. Removing the enable
variable leaves the Secret mount and remaining env entries in place. After
disabling, remove the `agent-keys` volume and the gateway volumeMount using a
reviewed strategic patch with `$patch: delete` on those named list entries, and
remove the remaining `AGENT_*` / `SOPS_AGE_KEY_FILE` entries if no longer needed.
Retain the Secret/identity and encrypted PVC state for recovery; deleting them is
a separate decision. If disabling without rollout undo, restore the prior rollout
strategy and securityContext through a reviewed patch after the agent is disabled.
