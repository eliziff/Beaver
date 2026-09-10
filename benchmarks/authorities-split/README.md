# Authorities split benchmark

Scores Beaver's **deterministic** authority splitter — the native
`legal-structure` primitive, no model — against the footnote gold Eli built for
ALR-Quote-Verifier.

## Run it

```powershell
cd backend
npx tsx ../benchmarks/authorities-split/run.ts
```

Flags: `--gold a.jsonl,b.jsonl` (gold file names inside the ALR benchmarks
folder), `--limit N`, `--report <path>`, `--details <dir>`.

Environment:

- `ALR_QUOTE_VERIFIER_ROOT` — the ALR checkout. Defaults to
  `C:/Users/elias/Desktop/Martys Qote Verifier/ALR-Quote-Verifier`.
  Gold is read **in place**; no gold file is copied into this repository.
- `LEGAL_STRUCTURE_NATIVE` — honoured by `backend/src/lib/structureNative.ts`,
  so a scratch build of the addon can be pointed at without rebuilding over the
  running server's locked DLL.

Outputs `report.md` (committed) and `runs/*.details.jsonl` (per-item, ignored).

## What the gold is

From `<ALR root>/dev/benchmarks/`:

| file | rows | what it holds |
| --- | --- | --- |
| `fast_split_manual_gold.jsonl` | 423 (405 `accepted`) | app-style manually reviewed footnotes: `footnote_text` plus `expected_verbatim_parts`, the accepted partition into citations, plus optional `acceptable_partitions` for subjective boundaries |
| `fast_split_gold_all.jsonl` | 451 (433 `accepted`) | the combined historical + manual corpus (superset, includes the 12 hand-written seed cases) |
| `field_gold_provisional.jsonl` | 423 rows / 566 parts | per-part field truth; this benchmark uses `pinpoint_fragments` (CanLII anchors, `par38` / `sec49.2`), `page_pinpoints` (integers) and `kind` |
| `fast_split_seed.jsonl` | 12 | hand-written sanity cases; useful as a fast smoke set |

Rows whose `status` is not `accepted` are skipped (18 `needs_review` rows in
each split corpus). Field values marked `needs_human` are never scored, as ALR's
own harness requires. `*_pre_regold_*` files are history and are not read.

## How scoring maps

The gold is a *partition of the footnote text*; Beaver's native output is a set
of *occurrence spans*. `bench.ts` projects one onto the other:

1. **Anchors** = `citationOccurrencesInText` occurrences ∪
   `authorityReferencesInText` supra/ibid references, sorted, with anchors
   nested inside an earlier anchor dropped.
2. **Cut rule** for the gap between two adjacent anchors: no cut when the next
   anchor sits inside brackets or quotes (so `(citing X; Y)` stays whole);
   otherwise cut at the last top-level `;` in the gap (the semicolon is dropped,
   which is what the gold partitions do), else at a sentence-final period (kept
   with the left part, and not an abbreviation period such as `e.g.` or `v.`);
   otherwise no cut.
3. Every character of the footnote lands in exactly one part, so ALR's
   character-neutrality checks apply unchanged.

The cut rule is part of *this harness*, not of Beaver: the native primitive
reports where authorities are, and the harness turns that into a partition so
the ALR gold can score it. Failures are reported in two buckets accordingly —
missing anchors (detector) versus wrong cut (harness rule).

Metrics mirror `dev/benchtools/benchmark_fast_splitter.py`:

| metric | ALR name | rule |
| --- | --- | --- |
| strict exact | `strict_exact_accuracy` | partition equals canonical gold after whitespace collapse and trailing-`;` strip |
| tolerant exact | `tolerant_exact_accuracy` | canonical **or** any `acceptable_partitions` entry, and character-neutral |
| count | `count_accuracy` | part count matches some accepted partition |
| undersplit / oversplit | `under_splits` / `over_splits` | produced fewer / more parts than canonical |
| char-neutral | `core_loss_gain_neutral_accuracy` | no substantive character lost or invented, ignoring whitespace and `;` |
| span P / R / F1 | *(new)* | produced vs gold parts matched as multisets of normalized text; replaces ALR's `mean_fuzzy` (a difflib ratio, not reimplemented here) |

Pinpoints are scored on the gold *part* text, so split errors do not contaminate
them. Native pinpoints (`{kind, text}`) map to gold as
`paragraph → par<n>`, `section → sec<n>`, `page → <int>`. ALR gold expands a
page range into every page while the native grammar emits the two endpoints, so
the headline page metric collapses each side's contiguous numeric runs to their
endpoints before comparing. Paragraph/section fragments are compared on the
first fragment, which is the one ALR gold records.

## Not covered yet

- The model lane (the Authorities assistant's boundary corrections on the same
  items) is not built. Only the deterministic lane exists.
- ALR's link / supra-target correctness (`gold_link_verification.json`,
  `supra_gold_candidates.jsonl`) is out of scope here.
