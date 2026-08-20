# Shared structure cutover ownership

This oracle freezes detector behavior; it is not a second implementation. The
temporary `__*PortOracle` exports call the current private helpers directly and
must disappear with the TypeScript detectors.

## Current synchronous owners

| Owner | Current call | Required cutover |
| --- | --- | --- |
| `a2ajLocalBulk.document` | eagerly calls `compileA2AJSourceDoc` | retain fetched text/section map; derive lazily through the one persistent `legal-structure` process |
| `legalSources/a2aj.sourceDoc` | compiles whole text on first locator request | await the shared client and cache by canonical evidence hash |
| `legalSources/a2aj.mappedSection` / `scopedDocument` | compiles provider-map excerpts | send `legislation` evidence with its native section claim; preserve excerpt scope |
| `legalSources/courtlistener.attachOpinionStructure` | compiles rendered CourtListener markup | render/provider-integrate in TypeScript; send native claims, exclusions, profile, and text once |
| GovInfo / GOV.UK ET / TNA fetchers | compile inside already-async fetch paths | await the shared client; preserve unavailable/flat and native-only outcomes exactly |
| `journal.document` / `viewer` | merge final-contract native blocks with reconstructed missing kinds | keep package/SQLite integration here; send native claims and only recover uncovered kinds |
| Legal PDF Parser adapter | owns PDF extraction and provider-native geometry | call the same shared crate in-process; its standalone binary is only for TypeScript clients |

The provider-neutral profiles are `case_rooted_complete`,
`case_contiguous_complete`, `case_lossy`, `legislation`, and `journal`.
Adapters, not Rust text inference, supply `report_start_page`,
`require_report_start`, and `allow_hyphenated_sections`. Harvard CAP maps to
`case_lossy`; ordinary CourtListener maps to `case_contiguous_complete`.

## Cutover invariants

- One dependency-light `legal-structure` binary per backend process; no
  `spawnSync`, per-document process, Legal PDF Parser sidecar, or hidden
  TypeScript detector fallback.
- Provider rendering, fetch, markup identities, section maps, final-contract
  registration, and native claims remain adapter concerns. Detection and
  monotone selection live only in the shared Rust crate.
- Native blocks keep label, aliases, parent, anchor, origin, and exact ranges.
  Recovery fills holes and never relabels heuristic output as native.
- Preserve exact SourceDoc UTF-16 public bytes during ownership refactoring.
  The wire uses Unicode-scalar offsets; this oracle freezes both projections.
- `statuteSpine.ts` still serves `legalTextSkeleton.ts`; do not count or delete
  it until that consumer is separately routed through the engine and proven.
- Candidate acceptance must cover every binding in `vectors.json`; synthetic
  controls and the prior `coverage.json` hash cannot substitute for a real
  candidate result.
