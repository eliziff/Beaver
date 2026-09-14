# Model catalogue refresh

Checked 13 September 2026.

## Problem

The picker's cloud models were a hand-maintained list in `models.ts`, and the
picker was organized by transport lane. Every provider release forced a source
edit, and a model served by several providers appeared as unrelated rows.

## Decision

Read maintained public catalogue endpoints at runtime, with no catalogue client
dependency, and present the picker by model creator:

- **Composite selection.** A chosen model is `provider:nativeId`
  (`backend/src/lib/llm/models.ts`). The provider is explicit, so one model can
  be served by several inference providers; the wire adapters strip the provider
  and send the native id. Legacy shape-only ids remain readable.
- **Creator-first.** `backend/src/lib/llm/catalog.ts` correlates each
  provider entry to a canonical model id and emits one row per model, ordered by
  company commonness. `modelKey` carries the canonical identity, `group` is the
  company, and `family` is the tier.
- **Sources.** `modelsDev.ts` probes `https://models.dev/api.json` for the
  first-party providers and `https://models.dev/models.json` for canonical
  model identity; `openRouter.ts` probes OpenRouter's public
  `GET /api/v1/models`; `openCodeGo.ts` probes the subscription listing. Both use
  `createCatalogCache` with a six-hour TTL, degrading to the last known value.
- **Tiers.** Subtabs come from the catalogue's own `family` (Opus/Sonnet/Haiku/
  Fable, GPT/GPT Pro/GPT Mini/GPT Nano/GPT Codex, Gemini Pro/Flash/Flash Lite,
  DeepSeek Flash/Pro; new families fall back to an id-inferred tier). Within a
  company, rows keep newest-first order.
- **Duplicates.** Dated snapshots collapse under their `(latest)` alias and the
  pinned seed wins ties, so `claude-opus-4-5-20251101` and `claude-opus-4-5` are
  one row.
- **Reasoning.** Effort levels come from the catalogue's `reasoning_options`;
  aggregator lanes are filled from the `opencode`, `opencode-go` and
  `openrouter` providers via `reasoningForModel`. No effort level is invented.
- **Curation.** Only companies in `MIKE_MODEL_COMPANIES` (default: the common
  set) appear, capped per company, so OpenRouter's long tail does not flood the
  picker. `MIKE_MODEL_COMPANIES=all` restores everything. Asynchronous `:batch`
  endpoints, dated snapshot slugs, and models older than
  `MIKE_MODEL_MAX_AGE_DAYS` (default 400) are dropped.
- **Ordering.** Rows are sorted newest major/minor version first; the tier
  subtab rail is always rendered (a single tab when a company has one tier) so
  switching companies never shifts the list.
- **Subscription first.** When a model is reachable through a flat-rate
  subscription (`codex`, `claude-p`, `opencode-go`), that serving is the default
  over per-token API keys; the per-row provider control overrides it.
- **Picker surface.** The chat-window trigger shows the provider mark (baked
  from models.dev into `frontend/src/app/lib/providerLogos.ts`) beside the model
  name. The modal keeps one row per model with an inline provider control, and
  its search spans the whole catalogue rather than the active company. A reader
  can hide providers from the picker in Settings; the choice is stored in
  `assistantPreferences.disabledProviders` and applied in every picker.
- **Load cost.** Catalogues are warmed at server boot, the models.dev provider
  and model documents are fetched together, and `/models` sends an ETag with
  `Cache-Control: private, max-age=30, stale-while-revalidate=300`. The client
  caches in `localStorage` and refreshes every five minutes (fifteen seconds
  while a provider is unavailable); model rows use `content-visibility` so long
  lanes do not lay out off-screen rows.
- **OpenCode Go** exposes every slug from its live listing; a slug absent from
  `OPENCODE_GO_MODELS` inherits its sibling vendor's wire, defaulting to the
  OpenAI-compatible chat wire.

## Why not an off-the-shelf catalogue client

`@opencode-ai/models`, `@openrouter/sdk` and model-catalog exist and are
maintained, but all are ESM-only while this backend compiles to CommonJS, and
the two official ones are 4-6 MB unpacked. The published JSON endpoints are the
maintained interface and this code reads a handful of fields, so a dependency
plus an ESM bridge would be more to maintain, not less.

## Limits

- OpenCode Go's wire protocol is still classified by `OPENCODE_GO_MODELS`; the
  vendor fallback is a heuristic, and a model whose wire differs from its
  siblings fails at call time rather than being hidden.
- Canonical identity depends on `models.json`; when two creators share a model
  name the row is not merged and each keeps its own row.
- Auto-discovery can add a low-cost variant the seed would have marked
  `settingsOnly`; such ids need an explicit seed entry.
- The provider toggle shows one row per model with a provider list; rendering
  each provider as a control on the row is still a list of provider choices.

## Validation

`backend/src/lib/__tests__/catalog.test.ts` covers cross-provider merge, company
order and curation; `modelsDev.test.ts` covers tiers, snapshot deduplication,
merge and metadata; `openRouter.test.ts` and `openCodeGo.test.ts` cover the live
lanes. `frontend/src/app/components/assistant/ModelPicker.test.tsx` covers the
company tab, tier subtabs and provider choice. The change crosses the assistant
dock, so `scripts/mike.ps1 smoke -WithAssistantDock` and its screenshots are
required.
