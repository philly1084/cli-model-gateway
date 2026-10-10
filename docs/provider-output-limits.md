# Output limits and a smaller canary proposal

Reviewed 2026-10-10. This follow-up is separate from router safety PR20 at `00876fcc4361811b5a39ef66fd152d023135d2e3`. It does not authorize deployment or inference. It supersedes the proposed USD1 total / USD0.25 per-provider assurance in the earlier Brain release proposal: that monetary ceiling is not enforceable with the evidence available.

## Code changes and what they prove

The API adapter previously dropped Responses `max_output_tokens` on generic chat-completion routes and dropped `max_completion_tokens` outside the Kimi special case. All three aliases now receive shared positive-safe-integer validation. Conflicting aliases fail at the public schema and internal execution boundary before dispatch/fallback. API requests preserve an explicit `max_completion_tokens`; otherwise their output limit maps to `max_tokens`. The Kimi Code Anthropic adapter maps all three aliases to its required `max_tokens` and no longer silently replaces invalid limits with 8192.

The Kimi ACP bridge now passes a request-scoped `KIMI_MODEL_MAX_COMPLETION_TOKENS` to its child, keeping any stricter inherited positive cap. Parent environment, deployment configuration and credentials are untouched. The [pinned Kimi 1.52 source](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/1.52.0/src/kimi_cli/llm.py) reads this setting for its Kimi provider. This bounds each generation, not total internal agent generations or retries. It does not apply to arbitrary alternate provider types selected inside that CLI.

Offline fetch fixtures cover generic, Gemini, Moonshot and Kimi Code serialization; buffered and supported native-streaming paths; all aliases; and rejection before fetch. Environment fixtures cover request isolation and stricter inherited limits. A Linux fake-executable test runs the actual Kimi bridge and observes the child's cap without authentication or inference. These tests prove forwarding and rejection, not remote provider compliance or billing.

## Provider evidence and remaining limits

| Configured route | Output ceiling evidence | Billing limitation |
| --- | --- | --- |
| `codex-cli` / `gpt-6-astra` | Current bridge does not forward a token ceiling. No applicable turn-level ceiling identified in the [App Server reference](https://learn.chatgpt.com/docs/app-server). | Included allowance can spill into purchased credits; concurrent usage can produce a negative balance. Auto-reload is separate. [OpenAI credit rules](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans). Excluded from the bounded live proposal. |
| `kimi-code-cli` / `k3` | Pinned source supports the per-generation environment ceiling now wired above. Internal step/retry count remains distinct from gateway attempt count. | Same subscription/Extra Usage concern as API; excluded from two-call proposal. |
| `kimi-code-api` / `kimi-k3` → `k3` | Adapter sends `/coding/v1/messages` with `max_tokens`. Kimi [documents Anthropic compatibility](https://www.kimi.com/code/docs/en/); Anthropic defines an [absolute generation maximum including thinking](https://platform.claude.com/docs/en/api/messages/create). Applying that protocol guarantee to Kimi is an inference from compatibility, not a live measurement. | [Kimi membership rules](https://www.kimi.com/code/docs/en/kimi-code/membership.html) share subscription quota across keys/clients. Extra Usage can continue after quota exhaustion, and the last model call can exceed its limit. Its spending cap is therefore not a strict per-canary dollar guarantee. |
| `gemini-api` / `gemini-3.7-flash` | Native [GenerateContent](https://ai.google.dev/api/generate-content) documents `maxOutputTokens`; [Interactions thinking docs](https://ai.google.dev/gemini-api/docs/thinking) explicitly include thought tokens. The deployed route is OpenAI compatibility, not those native endpoints. Forwarding is tested; equivalence on that exact route is not established by the reviewed official reference. | [Gemini billing](https://ai.google.dev/gemini-api/docs/billing) warns prepaid balance/project caps can overrun during processing delays. Existing project's tier is unverified. Excluded for now. |

Timeout, cancellation, client truncation and response byte limits are local operational bounds; they are never a provider billing ceiling. A model's maximum context/output capacity is also not a total task-dollar cap. No account settings were inspected or changed for this review.

## Concrete alternative, not yet authorized

The only currently unconditional zero-inference-cost test set is the offline suite, with **zero live model calls**.

For a later live test using existing entitlements, propose **at most two sequential generation requests total**, solely to existing `kimi-code-api`, public model `kimi-k3`, provider model `k3`. Use authenticated gateway `POST /v1/chat/completions` for an inert `calculate` tool proposal, then `POST /v1/responses` for its explicit synthetic tool-result continuation. Both resolve to the existing configured Kimi Code `/coding/v1/messages` route and existing server-side key. Do not substitute Moonshot `kimi-api`, another model, or an auto/fallback route.

Each request: one gateway attempt, `allowFallback:false`, a unique operation ID, 45-second deadline, `max_tokens:512` (Responses uses `max_output_tokens:512`), at most 8KiB total serialized request, at most 8KiB accepted response. No retries, auto-repair, continuation loop, external tool execution, server tools, paid search, or automatic task-planner calls. Stop after the first error, truncation, unexpected model/provider, invalid call or ambiguous outcome; do not increase the limit. Two successful calls request at most 1024 generated tokens under the provider's protocol contract; input tokens remain additional usage. A 512-token budget may be insufficient for K3 reasoning, which is an acceptable inconclusive result.

Prerequisites: confirm the exact existing Kimi Code account has an eligible active subscription and **Extra Usage disabled**, with no fallback to a separate paid account; confirm the chosen deployed adapter and route match the reviewed source; separately authorize the two calls. Quota exhaustion should then stop the test rather than consume Extra Usage. Account state has not been verified, so no unconditional no-overage claim is made. Do not turn features off, alter billing, buy credits or create keys as part of this proposal. If these facts cannot be confirmed without changing the account, retain offline-only validation.

Gemini could be reconsidered only after verifying its existing project is Free Tier, the exact model is eligible, and the OpenAI-route output semantics are established. That is not an additional approved test row. Codex/Astra task planning remains offline-only until its separate usage risk is resolved.

## Proposed broker-only internet scope

This is a separate proposal, not an enabled permission. Allow only explicit user-requested public HTTPS GET on port443 through the existing broker: at most four reads per task run, 15 seconds per read, 512KiB decompressed per read and 2MiB aggregate, at most two redirects per read, public-address resolution/pinning and redirect revalidation. No private/link-local/metadata destinations, arbitrary headers, credentials/cookies, uploads, forms, writes, WebSocket, CONNECT or paid search. Runner containers remain network-disabled; no firewall or host-egress changes. Existing fixed weather access does not imply broader broker permission.

No live requests, promotions, billing changes or egress changes were performed. Preserve the certificate coordinator's first natural renewal observation at 18:51:10UTC on 2026-10-10 and avoid overlapping promotion.
