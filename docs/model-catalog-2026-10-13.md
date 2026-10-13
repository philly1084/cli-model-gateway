# Model catalog verification — 2026-10-13

Prepared against `philly1084/cli-model-gateway` main commit
`813dcaba83994285fa0bbfcfac9d38e36c60d55e`. The old
`philly1084/n8n-openai-cli-gateway` remote resolves to the same HEAD.

The five new selectors are in [a separate opt-in reference](models-opt-in-2026-10-13.json).
This reference is NOT loaded by the gateway, NOT a providers configuration, and
NOT a production enablement. Existing model IDs, provider mappings, global order,
defaults, fallback lists, eligibility, credentials, and limits remain unchanged.
No registry/ranking/benchmark implementation is changed.

| Provider | Reference-only selector | Evidence |
| --- | --- | --- |
| codex-cli | gpt-6.1-sol | Official Codex docs plus production-client discovery |
| codex-cli | gpt-6-astra | Official Codex docs plus production-client discovery |
| codex-cli | gpt-6-sol | Official Codex docs plus production-client discovery |
| codex-cli | gpt-6-luna | Official Codex docs plus production-client discovery |
| deepseek-api | deepseek-flash | Official DeepSeek current model table |

Runtime catalog edits only refresh descriptions for the older GPT-5.6 family,
DeepSeek V4 Flash/Pro versions, and retired DeepSeek aliases. No entries are
added or removed from the loaded provider examples. No pricing or capability
metadata is invented. The descriptive Flash replacement requires an operator
migration; it is not an enabled gateway selector in this patch.

Sources checked on 2026-10-13:

- [Official Codex models](https://learn.chatgpt.com/docs/models), reached from
  https://developers.openai.com/codex/models. Availability depends on account,
  workspace policy, rollout, and client.
- Local `~/.codex/models_cache.json`, fetched at
  `2026-10-13T21:40:54.392721700Z` by client `0.162.0`. The adjacent
  [sanitized discovery snapshot](model-catalog-2026-10-13.json) contains public
  IDs, display descriptions, and timestamp only. This is not production
  entitlement or public API availability evidence.
- [DeepSeek model table](https://api-docs.deepseek.com/quick_start/pricing/)
  lists `deepseek-flash` (V4.1 Flash), `deepseek-v4-pro` (V4-Pro-0813), and
  continued acceptance of `deepseek-v4-flash` backed by V4.1 Flash.
- [DeepSeek retirement notice](https://api-docs.deepseek.com/news/news260424/)
  sets `deepseek-chat` and `deepseek-reasoner` retirement to 2026-07-24 15:59 UTC.
  `deepseek-coder` remains mapped to `deepseek-chat`, so it shares that risk.

The runtime reads `PROVIDERS_CONFIG_PATH`, defaulting to `config/providers.yaml`.
This patch changes descriptions in `config/providers.example.yaml` and the
provider data in `kubernetes/rancher-install.yaml`; the separate reference is
not imported anywhere. The Gemini-only `kubernetes/configmap-example.yaml`
remains unchanged. Other providers have not received an exhaustive availability
or entitlement audit. Retained entries are not certified as currently available.

The image pins Codex 0.144.1, but follow-up production inspection verified the
configured gateway executable is 0.161.0. Its successful read-only model/list
response advertises all four GPT-6 selectors; see the [sanitized production
discovery record](production-model-discovery-2026-10-13.json). No inference or
configuration change was performed. The mounted provider file already contains
opt-in Astra and GPT-6.1 Sol; gateway execution still requires verification. See the
[publication review](model-catalog-publication-review.md) for exact source links,
zero-drift rationale, existing route exposure, and CI gating.

## Offline validation

- TypeScript build/check passed using existing dependencies via a workspace
  junction; no dependency installation or production upgrade.
- 42 targeted catalog/configuration/registry/bridge tests passed.
- Regression compares all 49 Rancher model entries against a pinned baseline,
  including global positions, per-model scores, and selected routes over 16
  prompt/reasoning/benchmark scenarios. Provider execution and discovery are
  replaced by inert adapters; no inference occurs.
- Kubernetes dist-overlay and Codex/Kimi provider preflights passed.
- Parsed baseline checks preserve all YAML fields except documented descriptions.
- CI gate truth table checked for draft/ready PR, manual branch, main push,
  manual main, and manual tag. Existing main/release job contents and all
  validation commands are preserved.
- `git diff --check` passed.

The general example already contains five duplicate Gemini IDs under different
providers; this pre-existing sample issue is not repaired here. The routing
regression uses the complete, unique-ID Rancher catalog. No full example startup
or live-production availability claim is made.
