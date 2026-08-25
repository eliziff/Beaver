# Text-fragment fidelity results

Definitive run: 2026-08-25. The corpus contains 2,371 seeds over 1,217
documents. One seed, `FCA_2026_FC_103_p20_short-exact`, is excluded because
the official source was manually confirmed to be a genuine 404. Every other
seed has a complete flattened A2AJ document and a verified cached publisher
page.

## Production contract

The production planner receives only the full flattened A2AJ document, the
quoted passage, and supplied URL/anchor metadata. It cannot inspect the live
page or use Chrome results to choose a directive. It may emit multiple nearby
directives and reports the exact source-word intervals they intend to paint.
Substantive words are retained; only classified paragraph/provision furniture
may be omitted when it cannot be targeted safely.

The final target file contains 2,371 links built from 2,371 full documents and
zero block-text fallbacks. Its SHA-256 is
`8a1bd675ee5aa0c8e86b6cfaa8969b8f2c3042bedabf272659c53975d653f448`.
Rematerializing it through the rebuilt default production Node addon produced
the same hash byte for byte.

## Final headed-Chrome gate

Artifact: `results/webdriver-exact-final-production5.jsonl`, SHA-256
`ccdc9a5f84e2222fd20a9127f18e8ab35e743d4cbac9c237c34e465b9f960f46`.
Raw results and caches remain ignored experiment output.

The gate used six BelowNormal headed-Chrome workers and 24 logical shards. It
verified source/cache identity, isolated and combined directives, initial
viewport landing, target-text paint geometry, and absence of stray paint.
PDFium is diagnostic only; Chrome's actual PDF viewer geometry is authoritative.
All owned Chrome and driver processes are closed after each shard.

| class | exact | total | rate |
|---|---:|---:|---:|
| HTML | 2,061 | 2,149 | 95.9% |
| PDF | 141 | 221 | 63.8% |
| **All gettable seeds** | **2,202** | **2,370** | **92.9%** |

The 168 strict residuals are:

- HTML: 47 initial-viewport misses, 22 intended-plus-extraneous paint results,
  13 initial-paint misses, and 6 incomplete range paints.
- PDF: 74 wrong-page landings, 4 target-geometry mismatches, and 2
  intended-plus-extraneous geometry results.

There are zero quote-absence, ambiguity, cache, source-contract, unsupported
collation, missing-label, duplicate-label, or unexpected-label verdicts. All
2,370 rows used headed Chrome and verified one of 1,216 cached assets by path,
byte count, and SHA-256.

The final corpus-wide exact-safe lower bound is 38,183 of 40,186 planned source
words (95.0%). The PDF residuals still contain individually proven exact
directives covering 819 of 1,123 words; 304 words remain unsafe or unproved.
Thirty-six PDF residuals longer than seven words underpaint by only one to
three words. These remain non-exact results rather than being relabelled as
successes.

## Why the residuals remain

Every residual plan is `sourceSafeComplete=true`: the builder planned every
substantive source word. The failures appear only after Chrome resolves DOM
seams, duplicate ranges, scroll position, PDF pagination, bilingual column
order, or viewer geometry. Flattened A2AJ erases those distinctions.

The tested source-only alternatives do not safely improve the corpus:

- strict directive-containment pruning repairs 10 PDF rows but damages 9 and
  discards 86 already proven-safe words;
- shorter-directive exclusion and whole-span targeting each exchange known
  successes for failures;
- newline splitting cannot identify HTML seams: 841 exact HTML seeds and 41
  residuals both cross source newlines;
- contextual full-exact targeting recovers none of the tested HTML residuals;
  an ordered-short rule repairs 9 of 58 tested misses but regresses 95 of
  2,040 exact rows.

Identical PDF targets also vary between Chrome runs: compared with the prior
complete run, 16 changed from residual to exact and 15 from exact to residual.
That is viewer variance, not a source-only selection signal. The current
planner is therefore the empirical minimax of the tested blind strategies: it
preserves the broadest demonstrated exact and safe-partial coverage. This is
not a proof over every conceivable future algorithm; a further production
change requires a full-source feature that separates successes and failures
without sacrificing either side.

## Harness performance

- Deterministic verifier/source-contract checks: about 4.2 seconds.
- Targeted two-seed headed proof: 434 ms of seed work, 4.22 seconds including
  Chrome startup and shutdown (9.26 seconds shell wall including imports).
- Production rematerialization, including structure derivation for 1,217
  documents: 71.7 seconds.
- Full 2,370-seed headed gate: 692.4 seconds, zero worker restarts.

The 24-shard queue eliminates long static PDF tails while preserving the
six-browser resource cap. Immutable source contracts, normalized PDF page
text, range locations, and cache identities are reused; screenshots and full
Chrome lifecycle work are reserved for the final gate.

## Production proof

The planner is implemented in `legal-structure`, exposed by the Node adapter,
and called by `buildLegalSourcePinpoint`. Focused Rust tests cover maximal
multi-directive paint, markdown seams, PDF lineation, contextual
disambiguation, and furniture-only omission. The backend integration suite
also proves that one contiguous PDF quote becomes two directives whose union
covers all six substantive source words.

The acceptance checks are the focused Rust suite, warm Node-adapter check,
fresh release addon build, byte-identical production target rematerialization,
backend legal-source integration suite, source-boundary check, backend build,
and the headed corpus gate above.
