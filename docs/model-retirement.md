# Retiring router models

The owner-approved retirement removes `gpt-5.5`, `gpt-5.4`,
`gpt-5.4-mini`, and `z-ai/glm-5.2:free`. Retained sibling IDs such as
`gpt-5.4-pro` are separate models. Historical inventories and unsupported-model
diagnostic fixtures remain historical evidence, not active catalogs. The Codex
bridge's implicit ChatGPT fallback now uses the already-configured `gpt-5.6-sol`.

## Local dry run

Use Node 20+ with the repository's existing dependencies installed (the script
uses `yaml` and `tsx` to call `src/config.ts` directly). Put the exact mounted
provider source in git-excluded `.live-providers.yaml`; never commit it. Create
the git-ignored/excluded `.scratch/` directory first. With fresh output paths:

```sh
node scripts/retire-models-snapshot.mjs .live-providers.yaml .scratch/retired-providers.yaml ghcr.io/philly1084/cli-model-gateway@sha256:83a086ed16bceb780e8dcabc9002f3d31bc546d22730b96b988a370b78c2586f n8n-openai-gateway router-sol-4769d83accbb7783 .scratch/retired-manifest.json --retire gpt-5.5,gpt-5.4,gpt-5.4-mini,z-ai/glm-5.2:free
```

This is local generation only. Source-range deletions preserve surviving bytes,
comments and line endings. Validation uses the router's own config loader and
compares complete parsed structures, allowing only the requested model deletions
and removal of their fallback references. Every remaining fallback must resolve.
Unexpected references in commands, comments, aliases or allowlists cause failure
and require explicit review; the script does not rewrite them speculatively.
Output paths must be distinct and new. Successful stdout contains only hashes,
the content-addressed ConfigMap name and counts. No provider executes.

## Separately authorized promotion and rollback

Before any cluster action, verify the intended context, namespace, running image,
and current `providers-config` snapshot. Record the previous ConfigMap name and
Deployment revision. Confirm the copied source hash matches the mounted source;
for this retirement its expected SHA-256 begins `19cfc44f66bd87c9`.

Review the diff and manifest, then run a server dry run:
`kubectl create --dry-run=server -f .scratch/retired-manifest.json`.
Guard creation by checking whether the generated name already exists in the
intended namespace. Only a confirmed NotFound permits
`kubectl create -f .scratch/retired-manifest.json`; stop on other read errors.
If it exists, save its JSON locally and use
`scripts/remote-agent-promotion-config-snapshot.mjs verify` with the new provider
file, pinned image, namespace and source ConfigMap to prove exact identity,
provenance, immutability and bytes. Do not apply over or mutate an existing snapshot.
The manifest is built by `buildPromotionConfigSnapshot`, retaining its
`router-handoff-promotion` label and source/hash/image annotations.

Repoint only the Deployment's `providers-config` volume's `configMap.name` to
the verified new snapshot (a strategic merge patch keyed by volume name avoids
replacing other volumes). Observe the rollout and independently verify the
mounted hash, authenticated catalog and fallback behavior. Keep the previous
immutable snapshot. Rollback uses `kubectl rollout undo` to the recorded revision,
or repoints that same volume to the previous snapshot, followed by rollout and
runtime verification. No Secret keys or unrelated configuration need changing.

No cluster commands in this section are part of the local dry run.
