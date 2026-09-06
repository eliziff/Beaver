# Beaver master plan

This is the sole backlog, priority and release authority. Spokes refine execution,
not status. Shipped behavior belongs in [current documentation](../README.md);
update that contract and delete completed planning prose. Git retains history.

## Constraints

- One modular monolith: local SQLite/filesystem and cloud Postgres/private object
  storage compose at the edge. Preserve account-free use and cloud identity,
  sharing/MFA without parallel feature implementations.
- Reuse document, source/evidence, job/agent/tabular and preference primitives.
  Exact versions, hashes, locators and receipts are authority; summaries and
  untrusted retrieved text/OCR/metadata cannot authorize tools.
- Rust `legal-structure` owns semantics/grammars; `legal-pdf-parser` owns
  PDF extraction/OCR/geometry; `documentProjectionService.ts` owns cross-format
  reads. Preserve provider facts, native DOCX sessions and spreadsheet grids.
- One UI/core per standalone/embedded product; Word is another frontend route
  using ordinary sessions/tools/jobs. Optional features are static preferences.
- Git links, lock/Cargo pins, native identities and guardrail receipts must agree.
  PDF Inspector remains one automatically synchronized, gated parser branch.
- No migrations/compatibility paths, second product stores/runtimes, plugin
  marketplace, generated SDK, graph database or speculative abstraction. No vector
  store without a held-out retrieval/latency/memory/maintenance win.
- WCAG 2.2 AA/native controls and legal fidelity are constraints. No court login,
  payment/service/filing automation; no model parse where exact lookup suffices.

Current owners: [architecture](../current/architecture.md). Mike adaptation through
PR #383 is recorded in the [sync ledger](../decisions/upstream-mike.md); outstanding
Word review continues under document capabilities.

## Active execution order

| Priority | Work | Acceptance boundary |
| --- | --- | --- |
| 1 | [Application boundaries](application-boundaries.md), including [storage](document-versioning.md) | Account and domain API cuts complete; finish document/source ownership, typed assistant events and process edges. Same local/cloud operations, fewer change sites. |
| 2 | [Shared structure](document-structure.md) | Preserve primary profiles and quoted-content ownership; gate compound-document boundaries separately. Literal ports, direct consumers, separate corpus gates and exact shipped engine identities; no parallel semantics or ingestion/query regression. |
| 3 | [Document capabilities](document-capabilities.md) | Word baseline and safe handles before breadth; Library/Office.js parity, citation linking, deterministic quotation checks, then optional support review. |
| 4 | [Legal work products](legal-work-products.md) | Complete artifact/live proof for durable Court Records/Authorities, every AB/FC/FCA profile, reference parity and receipt-based composition. |
| 5 | [Saved research](research-sets.md) | Source reader on the left, workspace in the right dock; preserve label/passage/rule depth, thin persistence, exhaustive human/model reuse and live dock proof. |

Independent structure and profile/UI work may proceed alongside boundary work.
Shared persistence/handle seams precede their consumers. Plans do not prove gates
passed. Measure with `npm run measure:source`: boundary baseline 69,783 first-party
production lines, acceptance ≤68,400, stretch 67,700. Cuts should be net-negative
unless measured capability gains justify growth; retain the aggregate target
without moving maintained code outside counted roots. Report production, tests
and experiments separately; test deletion never pays for production growth.

## Approved backlog

- Runtime: page-first PDF preparation returns uploads before OCR, prioritizes
  requested pages, uses stable activity IDs and preserves usable partial results.
  Exercise common application behavior on SQLite/files and clean local Supabase/
  object storage; keep cloud-only administration explicit.
- Release: reconcile clean-checkout/bootstrap and tracked Authorities parser
  bindings; reproduce the offline catalogue from pinned `mike-workflows`, validate
  exported archives, record release/runtime/test/benchmark identities, medians
  and known external blocks.
- Sources: durable provider PDF/cache paths, exact locator/text-fragment fallbacks
  without model-authored URLs, universal galley viewer. Preserve Canadian, US,
  UK, journal, legislation, Hansard and GovInfo native paths; expand via existing
  search/resolve/read fixtures and improve lexical/working-set retrieval first.
- Knowledge: after stable extraction/evidence contracts, renderer-independent
  legal test/factor/application/commentary artifacts and linked memos; curated
  examples only after their product paths are release-ready.
- Evaluation: compare context/compaction with full history while preserving exact
  evidence, provider continuation and isolation. Attribute-first grounding,
  prompting, dense retrieval, multimodal providers and external engines require
  bounded comparisons, not implicit promotion or metered runs.
- Accessibility: keyboard/focus, 320 px reflow, text spacing, reduced motion,
  forced colours, contrast, announcements and manual screen-reader primary flows.
- Blocked/deferred: Muse Spark needs a real provider contract and credentials;
  role presets need materially useful implemented capabilities.

## Deferred proposal — not implementation

- Project change-impact review may later extend existing version/evidence
  dependencies. Acceptance would distinguish changed bytes from legal judgment,
  disclose unlinked coverage/unavailable baselines, enforce access and show exact
  source/dependent passages only when recorded. No background agent, graph store
  or claim of exhaustive dependency discovery.

## Release gates

Focused checks during edits; a complete candidate runs:

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
npm run check:source-boundaries
npm run check:grammar
node docs/scripts/check-docs.mjs
.\scripts\mike.ps1 smoke
```

Add applicable corpus and preservation gates. Dock changes require
`scripts/mike.ps1 smoke -WithAssistantDock`, real ChromeDriver interactions and
screenshot inspection; never the Codex in-app browser. Metered runs require
authorization; `full-sweep.ps1` requires exact `[FullSweep]`, never inferred.
