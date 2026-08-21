# SourceDoc Rust cutover debt

This is a deletion ledger, not a second design. The canonical design remains
the legal-document stack in `master-plan.md`: thin provider mapping, one Rust
implementation, one in-process Node binding, and the optional install-time
store.

## Production candidate to prove

- `legal-structure`: A2AJ recovery, native-markup composition, and the literal
  journal adapters.
- `legal-structure-node`: the single in-process Node binding.
- `legal-structure-store`: retain only if its install-time writer and runtime
  cache reader pass their durable-store contracts; otherwise delete it.

Journal has exactly two inputs. `pages.jsonl` supplies its exported structure,
with `type: "text"` regions becoming native paragraphs. Plaintext uses only
standalone `[page <label>]` marker lines: remove them, split pages there, and
emit no paragraphs or other inferred structure.

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

## Remaining integration proof

- Run the established 750-document digital-born PDF lane and inspect its
  structure-quality result, not merely cached SourceDoc parity.
- Verify the provider installer actually invokes `legal-structure-store`; if it
  does not, wire that single production path or delete the unused store/cache
  surface.

Do not delete unrelated experiments or user data. Record the exact retained
receipts and deleted maintained-line count in the final cutover result.
