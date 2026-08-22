# Source-structure cutover results

Status: retained historical proof, not current architecture. The active plan
is [Shared document structure](../roadmap/document-structure.md).

This result proves the former SourceDoc cutover corpus and deletion work. It
does not prove that the surviving provider silos or SourceDoc-only boundary are
the right shared-structure design.

## Completed proof

The cutover passed on 2026-08-20:

- `legal-structure`: 16 tests passed with all features;
- `legal-structure-store`: its resumable import, atomic promotion, and cached
  read contract passed on Windows;
- backend: 965 tests passed and the production TypeScript build passed through
  the release native binding;
- A2AJ: 248,685 exact frozen matches;
- CourtListener: 55,504 exact frozen matches;
- journals: all 19,185 rows accepted under the explicit replacement contract,
  comprising 590 unchanged rows and 18,595 contract replacements; and
- full corpus: 323,374 rows, zero mismatches, 148.289 seconds.

The frozen TypeScript receipts are immutable evidence. Do not regenerate them
or repurpose their scripts as a production runner.

## Deleted after proof

- The Rust corpus runner under
  `legal-pdf-parser/experiments/source-structure-parity-rust` and its workspace
  membership.
- Executable TypeScript freeze/oracle machinery whose compact frozen receipts
  were already complete.
- Dead SourceDoc batch, lifecycle, timing, and public-export compatibility code.

The compact `RESULTS.md`, `COURTLISTENER_RESULTS.md`, coverage, baseline
metadata, and ignored content-addressed receipts remain as evidence. Unrelated
experiments and user data were not changed.
