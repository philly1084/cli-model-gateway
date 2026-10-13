# Catalog publication review — 2026-10-13

This supplements [catalog evidence](model-catalog-2026-10-13.md). All work is
local. Publication, model calls, CI runs, and production upgrades remain outside
this change.

## Evidence boundaries

| Claim | Evidence | What remains unverified |
| --- | --- | --- |
| Four new Codex IDs are documented selectors | [Official Codex models](https://learn.chatgpt.com/docs/models) | Successful inference; production-client discovery is verified below |
| GPT-6.1 Sol, Astra, Sol, Luna and retained GPT-5.6 descriptions | Exact display descriptions from local client 0.162.0 discovery at 2026-10-13T21:40:54.392721700Z; sanitized adjacent JSON | These are discovery labels, not benchmark results or API guarantees |
| deepseek-flash is current Flash selector, V4.1 Flash | [Official current model table](https://api-docs.deepseek.com/quick_start/pricing/) | Production account access, balance, successful request |
| deepseek-v4-flash still accepted, served by V4.1 Flash; deepseek-v4-pro is V4-Pro-0813 | Same official model table | Account-specific access and end-to-end behavior |
| deepseek-chat and deepseek-reasoner retired | [Official release notice](https://api-docs.deepseek.com/news/news260424/) | No attempt made to call retired endpoints |

The cache is corroborating evidence for Codex selection only. Its
`supported_in_api` flag was intentionally not copied into catalog evidence or
used to claim current public API availability. The new GPT IDs map only to
`codex-cli`; no OpenAI API provider is created. Other retained models were not
exhaustively revalidated. Existing provider-local aliases (for example
`codex-latest`, `antigravity-default`, and `grok-build`) are not newly certified by
this update. Nothing here proves a production account's entitlement.

The same official Codex page states that `gpt-5.4` and `gpt-5.4-mini` retired
for ChatGPT sign-in on **2026-08-31**, and `gpt-5.5` retires on **2026-10-14**.
Those existing selectors/fallback references remain in this catalog under the
preserve-routing requirement; they need a separately approved migration for
ChatGPT-authenticated deployments. The notice explicitly distinguishes API-key
access, so it must not be generalized to public API retirement. The gateway's
`codex-latest` special fallback also still names `gpt-5.5`. No availability claim
is made for other old Codex selectors merely because they appear in the YAML.

## Pinned Codex compatibility inspection

Follow-up production evidence supersedes the assumption that the image pin is
the effective client: the image PATH binary is 0.144.1, but CODEX_EXECUTABLE
selects 0.161.0. At 2026-10-13T22:09:15.628Z that executable successfully returned
all four GPT-6 IDs from read-only model/list, marking gpt-6.1-sol default. The
[sanitized response](production-model-discovery-2026-10-13.json) contains no
credentials. No thread or turn was started. Source inspection below still
describes the image pin, not the effective production client's catalog.

Both Dockerfile and build workflow pin `@openai/codex@0.144.1`. The official tag
`rust-v0.144.1` resolves to commit
`44918ea10c0f99151c6710411b4322c2f5c96bea`. Only five small source/catalog files
were downloaded for inspection; no binary was installed or executed.

- [thread/start schema, lines 56–60](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L56): model is `Option<String>`, not a fixed enum.
- [turn/start model, line 121](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L121): likewise accepts a string.
- [Model manager](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/models-manager/src/manager.rs): the OpenAI manager preserves an explicitly supplied model ID; remote discovery passes the client version, so a newer client's catalog cannot stand in for production discovery.
- [Bundled catalog](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/models-manager/models.json) contains GPT-5.6 and earlier entries; none of the four new GPT IDs is bundled.
- [Fallback model metadata](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/models-manager/src/model_info.rs#L74) keeps an unknown slug but supplies generic settings if no matching discovery metadata exists. That is not evidence of upstream model support.

The gateway passes the selected ID to both thread/start and turn/start. Its
special model substitution concerns `codex-latest`, not the new IDs. Conclusion:
the inspected schema can carry these selectors. Effective production-client
discovery is now verified; inference compatibility is NOT proven. Do not upgrade
production or issue a paid canary based on source or discovery evidence alone.

## Repository example DeepSeek route impact

| Gateway route | Unchanged upstream mapping | Existing fallback order |
| --- | --- | --- |
| deepseek-chat | deepseek-chat (retired) | deepseek-v4-flash, deepseek-v4-pro |
| deepseek-coder | deepseek-chat (retired) | deepseek-v4-flash, deepseek-v4-pro |
| deepseek-reasoner | deepseek-reasoner (retired) | deepseek-v4-pro, deepseek-v4-flash |

The official retirement time is **2026-07-24 15:59 UTC**. Those three routes
already risk a failed first attempt and fallback latency; request policy,
health, quota, or attempt limits can prevent fallback. They also retain their
existing automatic eligibility. No other model in either edited catalog has
these retired gateway IDs in its fallback list. Existing references to
`deepseek-v4-flash` remain accepted according to the current documentation, but
upstream now serves V4.1 Flash under that name. That provider-side change predates
this patch. The separate reference lists `deepseek-flash` with no automatic eligibility or fallback; it is not a loaded route.
Retirement descriptions clarify risk without remapping or disabling old routes.
Migrating/disabling the retired routes requires a separate routing decision.

## Zero-drift catalog choice

The simplest append was checked first. ProviderRegistry.create iterates each
provider's nested models array before moving to the next provider. Codex and
DeepSeek are not the last providers. Appending within either array shifts later
entries' global positions; placing duplicate provider blocks at the file end
fails the registry's duplicate-provider-ID check. Moving whole providers would
also change existing positions. No serialization-only append preserves all
positions while keeping provider identity and grouping.

The five new IDs are therefore listed only in docs/models-opt-in-2026-10-13.json,
which has no runtime import. Every existing entry keeps its global position.
A regression compares current scores and selections with the pinned baseline,
including near-tie benchmark scores. No ranking or Pareto logic changes.

The earlier automatic-judge eligibility fix and its test extension have been
removed: with no new runtime models they are unnecessary for this update.
Current autoEligible:false does not stop automatic quality-judge selection;
that limitation must be addressed before any future activation. Reference-only
entries cannot be selected, benchmarked, or used as judges by the gateway.

## Configured default and fallback exposure

The inventory below is checked-in configuration evidence. Follow-up SSH access
verified the production host/image and selectively read the gateway's mounted
provider file: 38 entries, including opt-in gpt-6-astra and gpt-6.1-sol. The live
file has 14 incoming references to gpt-5.4, nine to gpt-5.4-mini, and 15 to
gpt-5.5; the corresponding auto-eligible source counts are six, seven, and seven.
Unlike the repository examples, live DeepSeek has no chat/reasoner/coder legacy
routes; only V4 Flash/Pro are configured, both auto-ineligible. No production
Secret, credential value, or private endpoint was printed. The mounted file
has not been independently compared to the authenticated in-memory /v1/models
response; that GET remains useful before any migration.

The compiled live Codex agent default is gpt-5.6-sol, which is not identified as retired by the
cited documentation. Its fallback chain includes gpt-5.5 and gpt-5.4 after the
other GPT-5.6 models. The bridge's special codex-latest fallback defaults to
gpt-5.5. Checked-in remote targets omit defaultModel, leaving their default to
the target executable/configuration. Live startup benchmarking is disabled and
its recurring interval is zero. Chat request model selection remains as
implemented; no universal default was invented.

The [sanitized exposure inventory](retired-route-exposure-2026-10-13.json) lists
every incoming fallback reference and the affected routes. The Rancher catalog
has 28 incoming references to gpt-5.4, three to gpt-5.4-mini, and 26 to gpt-5.5.
Those routes remain automatically eligible. DeepSeek's three legacy gateway
routes remain automatically eligible too, with no other model referencing them
as fallbacks. The user's choices are to approve migration/disablement after
live discovery, or retain the known failure/fallback risk; this patch does not
make that decision.

## Local CI patch — not published or run

build.yml now has a read-only validate job with timeout-minutes: 5, no matrix,
fixed concurrency group gateway-catalog-validation, and cancel-in-progress:true.
It runs for non-draft pull requests targeting main, or manual dispatch on a
non-main branch. Draft PR jobs are gated off; ready_for_review is explicitly
included so validation runs when promoted. Ordinary feature-branch pushes do
not trigger this workflow. A branch with an open non-draft PR does trigger the
PR synchronize event. Draft/manual gating is explicit, not a waived check.

The job retains ALL existing source, test, Kubernetes, provider, reconciliation,
and dry-run canary validation commands. It has no Docker/login/publish steps.
The original build job remains intact for main and manual tag releases, including
its existing validation, image publication, and main provenance checks. Manual
main also retains the original build. Manual feature branches now validate only.
No release tag push trigger was added. The original main/release timeout behavior
is unchanged; those builds are NOT authorized within this publication scope.

GitHub read-only checks returned Branch not protected for legacy main protection
and an empty effective main rules list on 2026-10-13. No protection was changed.
Recheck protection/rules and both workflows immediately before publication;
repository state can change. build-ollama-upstream.yml is unchanged and only
triggers for its own path changes or manual dispatch, not this catalog change.

Proposed first publication: branch plus DRAFT PR, then at most one explicitly
authorized manual branch validation. Maximum job execution is five minutes per
attempt, not a completion guarantee or account-wide spending cap. One initial
run plus one separately approved retry reserves ten execution minutes plus
three minutes overhead within the 33-minute budget. No automatic retry is added.
Concurrency limits overlap, not cumulative usage; recheck the actual remaining
budget before every run. A cold install or full test suite can exceed the cap
and fail; do not silently increase it. Full multi-arch duration remains unmeasured.
No merge/main dispatch/tag dispatch/image publication/deployment is proposed.

GitHub references: [job timeout syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes),
[workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
