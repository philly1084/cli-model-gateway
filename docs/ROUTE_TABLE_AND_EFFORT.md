# Versioned routes and effort

`BRAIN_ROUTE_PROFILE=gpt62` opts into the version 1 table at
the Brain `packages/model/route-table-v1.json`. Unset preserves legacy routing. Unknown
profiles, models, provider bindings and unsupported efforts fail before dispatch.
The gateway carries the identical file as `src/route-table-v1.json`; both test
suites pin its SHA-256. Before release run
`node scripts/check-route-table-agreement.mjs <gateway>/src/route-table-v1.json`.
Change the table and digest in both repositories together.

| Work class | Model | Effort |
| --- | --- | --- |
| Planner, intent, plan, research, critique, choreography, audio | gpt-6.2-sol | low |
| Animation, layout, builder, builder-code | gpt-6.2-astra | high |
| Hardest coding (explicit selection) | gpt-6.2-astra | xhigh |
| Scene actor, materials | deepseek-v4-pro | disabled thinking |
| Final reviewer, critic | kimi-k3 | provider default |
| Optional Astra / Sol reviewer | gpt-6.2-astra / gpt-6.2-sol | medium |
| MSI ordinary work | gpt-6.2-sol | medium |
| Quick chat | gpt-6.2-sol | low |

The voice call route is unchanged. The scene actor and single reviewer do not
switch when the profile is enabled. To opt into Astra as actor, explicitly set
`BRAIN_SCENE_ACTOR_MODEL=gpt-6.2-astra` and `BRAIN_SCENE_ACTOR_EFFORT=high`.
Reviewer consensus still requires the existing explicit reviewer list and mode.

Effort precedence is request, run, role, environment/config, then route default.
Scene machine input accepts `effort` and `runEffort`. Operator environment settings
are `BRAIN_SCENE_RUN_EFFORT`, `BRAIN_SCENE_<ROLE>_EFFORT` (including ANIMATION,
LAYOUT, MATERIALS, PLANNER, ACTOR and VERIFIER), then `BRAIN_REASONING_EFFORT`.
Long-form roles use `BRAIN_PLAN_EFFORT`, `BRAIN_RESEARCH_EFFORT`,
`BRAIN_CRITIQUE_EFFORT`, `BRAIN_BUILDER_EFFORT`, `BRAIN_BUILDER_CODE_EFFORT`.
Chat uses `BRAIN_CHAT_QUICK_EFFORT`; intent uses `BRAIN_INTENT_EFFORT`; the MSI
launcher uses `BRAIN_MSI_EFFORT`. Mixed-provider runs should use role settings:
an effort unsupported by a selected provider is an error.

6.2 accepts low, medium, high and xhigh. The compatibility aliases none/minimal
normalize to low and max to xhigh. Ultra is rejected. Non-reasoning routes use
explicit `disabled` or `provider-default` metadata, without forwarding a Codex
effort. No hidden reasoning is stored. Per-call `model_attempt` events and the
run projection retain requested, normalized, forwarded and applied metadata.
`applied: unconfirmed` is not proof of provider application; only structured
provider metadata can confirm it. A model's answer text cannot confirm effort.

6.2 routes use only the existing codex-cli ChatGPT-plan bridge, including its
tool JSON contract. No OpenAI API-key route is added. Direct OpenAI API tool
calling would require Responses; it is outside this integration. Knowledge turns
require codex-cli, non-streaming chat-completions and ephemeral sessions. Actor
preview admits only the listed Astra routes; Sol can be an explicitly enabled
reviewer. Image and knowledge flags remain independently gated.

Release runtime support before mounted gateway configuration. The reconciliation
script verifies the deployed table, backs up old config, uses resourceVersion
and exact-content tests, preserves existing entries and prints hashes only.
Restore config before binary rollback. Keep live and rollback images pinned.
New entries are manual-only and excluded from automatic routing, benchmarks,
quality judges and implicit fallback. Profile-on default role chains contain
one explicit model. Legacy gpt-5.6-sol was still present in the authenticated
catalog on 2026-11-18; catalog presence is not a successful inference receipt.

Official compatibility references:
- https://developers.openai.com/api/docs/guides/latest-model
- https://developers.openai.com/codex/models
- https://developers.openai.com/codex/changelog
