# Research: OpenRouter as Eden's model layer (2026-07-02)

Question: can OpenRouter replace the Vercel AI Gateway as the way deployed eve agents reach
models — and does it buy us anything for the managed offering?

## Verified by execution (spike agent, eve 0.18.1)

Wired `@openrouter/ai-sdk-provider@2.10.0` into the spike agent's `agent.ts`:

```ts
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? "" });

export default defineAgent({
  model: openrouter("anthropic/claude-sonnet-4.5"),
  // eve resolves context metadata from the AI Gateway catalog for string ids only;
  // non-gateway models must pin it (or eve errors at boot).
  modelContextWindowTokens: 200_000,
  build: { externalDependencies: ["@workflow/world-postgres"] },
  experimental: { workflow: { world: "@workflow/world-postgres" } },
});
```

- **Typecheck + `eve build` pass**; the provider is traced into the bundle.
- **Runtime routing proven:** a session turn fails inside `openrouter__ai-sdk-provider.mjs`
  with OpenRouter's "Missing Authentication header" (empty key) — the Vercel gateway is
  completely out of the path. With a real `OPENROUTER_API_KEY` env the same wiring should
  serve turns (not yet run — no key on this machine).
- Peer-dep note: 2.10.0 declares `ai ^6` while eve pins `ai ^7`; it installs and works
  (interface-compatible at runtime). A `6.0.0-alpha` line with no `ai` peer dep exists if
  this ever breaks. Treat provider-version ↔ eve-version as another pinned pair.

## From OpenRouter docs (web, 2026-07)

- **Key management / provisioning API** (`/api/v1/keys`, Management-key auth): create / list /
  update / delete API keys programmatically. Per key: spend `limit` (USD), `limitReset`
  (daily/weekly/monthly, midnight UTC), `disabled` flag, `includeByokInLimit`. Per-key usage
  counters (`usage`, `usage_daily/weekly/monthly`, BYOK variants, `limitRemaining`).
  Management keys cannot call completion endpoints (good separation).
- **Guardrails**: org-level budgets layered over per-key limits; key spend counts toward both.
- **Fees**: model pricing is pass-through (no per-token markup); OpenRouter takes ~5.5% on
  credit purchases ($0.80 min; 5% crypto). **BYOK**: first 1M requests/month free, then 5% of
  the OpenRouter-equivalent cost.
- One key reaches 300+ models across providers; provider failover built in.

## What this means for Eden

**OSS/BYO:** "set `OPENROUTER_API_KEY` as a project secret" is a clean single-credential story
with no Vercel account — and model choice stays a string-ish slug (`openrouter("vendor/model")`).

**Managed mode — this is the significant part.** The provisioning API is most of ARCH §3.2's
model gateway as a service:

| ARCH §3.2 requirement | Own proxy (planned) | OpenRouter provisioning |
|---|---|---|
| Eden owns provider keys | build it | Eden owns one funded org; issues per-instance keys |
| Meter tokens per instance | build it (chokepoint) | per-key usage counters, queryable |
| Per-tenant spend caps | build it | per-key `limit` + reset interval |
| Kill switch | build it | `disabled: true` on the key |
| Multi-provider | build per provider | included |

Deploy pipeline shape: provision instance → create an OpenRouter key (limit = tenant's cap) →
inject as env secret → poll usage for metering/billing reconciliation → disable key on
kill-switch/teardown. That is `ModelGateway` seam-sized work, not a new service. Trade-offs:
third-party dependency in the serving path, ~5.5% effective fee on managed credits, usage
polling (not push) for metering, and per-run token detail still comes from observability
(the event log / OTel), with OpenRouter as the billing-grade source of spend.

**Recommendation:** adopt OpenRouter as the default model path for BYO *and* managed v1
(`openRouterModelGateway` implementing the seam via the provisioning API). Keep the Vercel
gateway as the zero-config option for repos that already use model-string config, and revisit
an in-house proxy only if fees or the dependency bite. The "make deployable" PR gains one more
edit: swap the model string for the OpenRouter provider form (+ `modelContextWindowTokens`).

## Follow-ups

1. Real turn end-to-end with a funded `OPENROUTER_API_KEY` (user).
2. `openRouterModelGateway` behind the `ModelGateway` seam (create/limit/usage/disable).
3. Model-picker editor: understand the provider-instance form, not just strings.
4. Reconciliation: per-key usage ↔ per-run tokens from the event log (billing vs detail).
