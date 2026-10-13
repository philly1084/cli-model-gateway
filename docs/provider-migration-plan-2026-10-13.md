> Historical audit/proposal at published commit843ec4a or earlier. The local runtime follow-up is described in [manual catalog implementation](manual-catalog-implementation.md); it now adds manual entries to the examples but is not published or deployed.

# Concrete catalog migration plan — 2026-10-13

This is a proposed executable scope, not an applied migration. Current branch runtime remains unchanged.

## Phase A: repair existing mappings without changing public IDs or list positions

1. In both repository samples, Code provider gateway `kimi-k2.7-code` upstream changes from `kimi-k2.7-code` to `kimi-for-coding`; highspeed upstream changes from `kimi-k2.7-code-highspeed` to `kimi-for-coding-highspeed`. Preserve eligibility, position and fallback arrays. Describe standard alias as rolling Code (currently K2.8 Preview), not pinned K2.7. Production already uses these correct upstream aliases, so production needs a description/caller naming migration, not the same mapping repair.
2. Repository groq-whisper gateway `groq-whisper-v3-turbo` upstream changes `whisper-v3-turbo` to documented `whisper-large-v3-turbo`, preserving public ID/position. This is a separate speech adapter correction, not a newly enabled lane.
3. Keep production `kimi-k3 -> k3`: valid Code mapping, returned by HTTP200 discovery. Current account advertises262144 context. Do not replace with Moonshot `kimi-k3`, claim1M entitlement, or alter thinking: disabled thinking may select K2.8 upstream.
4. Refresh alias/retirement/context descriptions in place. Do not delete retired selectors or rewrite fallback arrays in this phase; those are separate behavioral migrations.

## Phase B: explicit-only additions with an explicit ranking decision

Decision: do not append nested provider models under current scorer. It uses the global model index (`100-index*0.01`), so insertion shifts unrelated scores. `autoEligible:false` also does not exclude automatic judges.

Proposed minimal prerequisite: introduce one opt-in `manualOnly` model property (defaultfalse). Enforce `autoEligible:false` for it; exclude these entries from automatic routing, benchmark candidates and automatic judge selection, while permitting explicit selection. During registry construction, assign the legacy ranking index by counting only entries without manualOnly. Preserve existing entries' counting and judge behavior exactly, including pre-existing autoEligible:false entries; do not broadly change eligibility semantics. New manualOnly entries get no automatic rank. Test existing baseline scores/selections, benchmark candidates, judge selection and explicit access before catalog insertion. This is an explicit implementation decision requiring separate reviewed code, not an existing supported config flag.

After that prerequisite is approved/tested, add only:

- Direct production Google API: gemini-4-argon, gemini-3.8-flash; upstream IDs identical. Keep current3.6/3.5Lite already present. Repo parity needs a reviewed direct Google provider configuration; never put these into Gemini CLI or assume free entitlement.
- Code API: kimi-k3-256k -> k3-256k only where absent. Proposed new gateway kimi-code-standard -> kimi-for-coding supports honest rolling-model naming; retain old public2.7 selector as a documented compatibility alias pending callers' migration. Do not duplicate existing live k3-256k.
- OpenRouter curated explicit-only: nvidia/nemotron-3.5-lightning:free, thinkingmachines/inkling-small:free, cohere/north-mini-code:free, google/gemma-4-31b-it:free. Keep already-live poolside/laguna-s-2.1:free with Oct31 expiry notice; do not add it twice. Exact upstream IDs equal gateway IDs. Recheck pricing/tools/availability immediately before activation.

Hold Moonshot moonshot-kimi-k3 -> kimi-k3 and Groq qwen/qwen3.8-27b until their401 is resolved through separately authorized access work. No credentials changed. Paid OpenRouter Google/Kimi routes remain excluded. No client upgrades are implied.

## Phase C: intentionally changed fallback behavior, separate approval

Plan a before/after route diff for retired Codex, Compound, MoonshotK2.5 and absent OpenRouter aliases. There is no honest way to remove/replace a retired route while promising identical model selection. Keep current automatic eligibility until that behavioral migration is explicitly approved; do not call an unchanged broken route healthy.

## What401 means

One GET /models against each configured Moonshot and Groq endpoint returned401 using its existing in-pod configuration. It does not prove every key/account invalid, identify a root cause, or establish inference failure for every route. No credential values, response bodies or private endpoint data were exported. Kimi Code is a separate provider and returned200; its k3 mapping is unaffected by Moonshot401.

## Draft PR publication evidence

Read-only recheck2026-10-13: PR23 OPEN anddrafttrue, headb63a03c0ee17aa50cdf89558be50e2d87e185d9a, main813dcaba83994285fa0bbfcfac9d38e36c60d55e. Only two active workflow files. Current branch build.yml handles synchronize but both jobs evaluatefalse for a draft PR. Feature branch push does not match main-only push; Ollama has main/path-only push and manual triggers. A follow-up push under this unchanged state creates a skipped PR check run, with zero runner jobs, no image build and no manual dispatch. This is not a guarantee against a concurrent draft/workflow change; recheck immediately before authorized push. No workflow changes or extra CI run are proposed.
