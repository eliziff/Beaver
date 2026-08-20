# Shared structure cutover ownership

This static oracle freezes the public UTF-16 behavior captured at baseline
commit `16d4c5fecb83ba5552ca3840acaf0f5c95d82b9c`. It is not a second
implementation: fixture and expected-value hashes are immutable, while the
candidate runner exercises only the shipping provider adapters and shared Rust
engine. Git history is the retired TypeScript detector oracle.

## Provider ownership after cutover

| Owner | Provider responsibility | Shared-engine call |
| --- | --- | --- |
| A2AJ local/provider adapters | retain fetched text and ordered section maps; promote aligned native provider claims | `case_rooted_complete` or `legislation`, with explicit excerpt scope where applicable |
| CourtListener / GovInfo / GOV.UK ET / TNA | render markup, retain native claims and exclusions, select factual profile | one persistent `legal-structure` client; preserve native/unavailable/flat outcomes |
| Journal | own SQLite/final-contract registration, canonical page/region claims and URLs | `journal`, recovering only uncovered kinds |
| Legal PDF Parser adapter | own PDF extraction and provider-native geometry | the same shared crate in-process |
| Agreement skeleton/amendment/cross-reference | own segmentation competition and consume section `content_start` | batched `legislation` graphs, with no synchronous fallback |

The provider-neutral profiles are `case_rooted_complete`,
`case_contiguous_complete`, `case_lossy`, `legislation`, and `journal`.
Adapters, not Rust text inference, supply `report_start_page`,
`require_report_start`, and `allow_hyphenated_sections`. Harvard CAP maps to
`case_lossy`; ordinary CourtListener maps to `case_contiguous_complete`.

## Cutover invariants

- `structureWire` owns the provider-neutral wire/types/scalar validator;
  `sourceStructureAdapter` owns pure materialization and projection;
  `structureEngineClient` alone owns the child-process protocol. Provider
  preparation/finalization must not import the client or combined host.
- Native-claim-only consumers may negotiate `native_claims`. The shipping
  SourceDoc recovery host fails closed unless the hello also advertises
  `raw_recovery`; provider adapters cannot silently turn a native-only graph
  into recovered output.
- The two invalid legacy CAP/TNA terminal ranges are repaired only by exact
  provider/identifier/representation/text/claim receipts in the native-markup
  adapter. Generic materialization rejects every other invalid range.
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
- The old A2AJ/native/journal detectors and `statuteSpine.ts` are retired;
  production and tests must not import experiments or recreate their grammar.
- Corpus harnesses submit provider-prepared batches; the client negotiates the
  25-document/128-MiB caps instead of paying one protocol round trip per row.
- Candidate acceptance must cover every binding in `vectors.json`; synthetic
  controls and the prior `coverage.json` hash cannot substitute for a real
  candidate result.
- Corpus proof launchers explicitly set and record BELOW_NORMAL process
  priority for themselves and inherited sidecars. This is a proof-run
  contract, not a permanent production scheduling policy.
