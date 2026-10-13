# Manual catalog implementation — draft, not deployed

This working-tree implementation supersedes the earlier reference-only proposal for repository examples. Production still has its existing configuration. This draft runtime commit follows the audited reference-only version. No runtime deployment or inference has occurred.

`manualOnly: true` lists a model for explicit requests but excludes it from automatic routing, benchmark probes, automatic or configured benchmark judges, and incoming fallback chains. It overrides `autoEligible:true`; omission/false preserves legacy semantics. Its own existing outgoing fallback list is honored on an explicit request, but newly added entries have no fallback lists. The schema accepts only booleans. Existing model indices count all legacy entries, including pre-existing autoEligible:false entries, and skip new manual entries. Thus insertion inside a provider leaves legacy positions/scores unchanged. Existing autoEligible behavior is deliberately preserved.

Both repository examples now contain14 manual entries: four GPT6; DeepSeekFlash; Code k3-256k and rolling standard alias; five curated OpenRouter free selectors; direct GoogleAPI Argon/3.8Flash. All set autoEligible:false too. The new Google provider uses Google's OpenAI-compatible endpoint and existing GEMINI_API_KEY environment contract; no credential is created. Google CLI remains separate. Code upstream k3 is unchanged; Moonshot and Groq additions remain held after401 discovery.

`docs/model-mapping-repairs-2026-10-13.json` is a separate exact old/new repair set, intentionally not applied to this routing-baseline patch. Existing execution mappings can affect name-based scores and output, so repairs need a separate before/after validation. No fallback/default replacement is hidden in this patch.

## Verification and deployment decisions

- Offline tests compare all49 legacy Rancher entries and16 routing scenarios, including near ties. New tests verify schema defaults/type rejection, insertion before/mid-list including legacy excluded entries, benchmark and judge exclusions, explicit execution via a stub, and prevention of implicit fallback. No real provider called.
- Do not apply rancher-install.yaml over production: its mounted38-model catalog differs. To migrate, deploy reviewed runtime support first with existing config unchanged, then selectively merge only absent manual entries into the mounted provider file. Existing Astra/Sol, Code k3-256k and Poolside entries must not be duplicated or silently reclassified.
- Binary/config order matters: an old binary ignores an unknown manualOnly property and autoEligible:false alone does not prevent judges/fallbacks. Runtime support must precede new entries. Maintain old config as rollback artifact; rollback config before binary.
- First validate effective /v1/models plus baseline route explanations read-only. Successful inference/tool compatibility remains untested and needs separately bounded authorization. Review Google thinking/output restrictions, Code alias behavior and OpenRouter Oct31 expiry before use.
- The general repository example already has duplicate Gemini IDs across CLI/free providers. Choose the desired provider blocks; it is not a wholesale production config. The unique Rancher example is the regression baseline.

Published audit commit843ec4a remains draftPR23; synchronization run38478984647 was skipped. This runtime implementation passed independent review and is approved for draft-PR publication only. No extra CI was run.

Scope: manualOnly governs registry/OpenAI route dispatch, benchmarks, judges and implicit fallback/image selection. Existing admin provider sessions and remote CLI tasks can omit a model and use native CLI/target defaults outside the registry. Their behavior is unchanged; this flag is not a global restriction on native CLI defaults. All14 new records explicitly declare only chat/responses/tools; generation and tool round-trip compatibility remain untested.
