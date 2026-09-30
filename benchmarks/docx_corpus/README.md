# Local DOCX corpus benchmark

## Original versus shared citation verification

`compare_versions.py` freezes the original committed ALR implementation, the
current ALR adapters, the installed Python binding, source hashes, gold and corpus
membership. It runs the actual deterministic functions in separate processes.
The current implementation covers split components, frozen-history references
and ALR's offline document splitting/linking/reference-chain path. The Rust bridge
also compares the original and shared LSP public functions on identical text;
the Pinpointer bridge executes both browser cores with the packaged WASM engine.
These checks do **not** establish complete PDF, browser or model-assisted parity.

Use an environment containing ALR's existing dependencies and the candidate
binding. Every output directory must be new:

```powershell
python -u -X utf8 benchmarks/docx_corpus/compare_versions.py freeze `
  --alr <canonical-alr-checkout> --wordwright <wordwright-root> `
  --engine <shared-engine-checkout> --pdf-manifest <original-750-manifest> `
  --output benchmarks/docx_corpus/private_comparison/<freeze>

python -u -X utf8 benchmarks/docx_corpus/compare_versions.py run `
  --manifest benchmarks/docx_corpus/private_comparison/<freeze>/manifest.json `
  --output benchmarks/docx_corpus/private_comparison/<run>
```

The component splitter arms mean conservative and recall-first; the reference
and document arms mean safe and aggressive supra linking. They are separate
settings, not interchangeable aggressiveness levels. Document mode is Free,
with external model/provider access disabled. Frozen-history reference records
lack note IDs and source kinds: their agreement does not establish whole-document
or inferred-short-form preservation. Raw output equality is not a gold score.

`inventory_evidence.py` inventories already saved document receipts, source/gold
matches and authentic recorded model runs without executing citation code:

```powershell
python -u -X utf8 benchmarks/docx_corpus/inventory_evidence.py `
  --manifest <freeze>/manifest.json --saved-documents <run>/baseline-safe.jsonl `
  --recorded-runs <existing-recorded-run-directory> --output <new-inventory.json>
```

`document_gold.py build` binds an existing supra-gold document name to a frozen
DOCX hash and validates reference/origin text against the document. Optional
separate adjudications contain explicit targets and source evidence; they never
rewrite existing gold or turn absent URL verification into a verified link.
`document_gold.py score` compares saved document outputs against that bundle,
reporting antecedents separately from source URLs. Partial source matches,
multiple-target references and missing/ambiguous output alignment remain visible.
Use each command's `--help` for its arguments.

Use `build-roots` before comparing ultimate antecedents. It follows unique,
accepted, source-matched original gold edges; it does not use either parser's
predictions. Those inherited judgments still need source checking when the
reference contradicts the printed note number or a compound citation contains
several authorities. Keep corrections in separate adjudication files. `score-core`
scores the saved Python extraction/resolution output against the same roots.
An authored abstention retains its alternative sources. Overlapping inventory
rows are not independent accuracy samples. ALR's chain metadata and its emitted
hyperlink are separate outcomes; a wrong chain does not establish a wrong link.

`replay_compare.py` runs the original saved-response benchmark in each frozen
implementation, across its four execution modes and two supra-linking settings.
Freeze the response payloads and their original request histories first. Report
history drift: a fixed response replay after a changed history is a controlled
comparison, not a faithful live-model run or independent correctness evidence.

`consumer_compare.mjs <config.json>` compares the real Node addon and the actual
Authorities HTML/WASI adapter against saved Python results. The config supplies
absolute paths for `native`, `wasm`, `htmlAdapter`, `wasiAdapter`, `htmlPackage`,
`inputs` and a new `output` file. Each input JSONL row contains `id`, `text`,
character-offset `notes` and Python `expected` (`status`, `extracted`, `resolved`).
Freeze the adapters, binaries, inputs and runner before execution; capture stdout
as the receipt and stderr as the run log. Native documents run in isolated child
processes so a panic cannot erase later results. Errors never count as agreement.
This exercises citation bindings, not browser UI, source retrieval, body reading
order or the complete Authorities import operation.

Current evidence is in ignored `private_comparison/evidence-inventory.json`.
The manual splitter file is authoritative under ALR's README and runner default;
the alternate review file is historical evidence, not additional gold. Original
model outputs are replay material, never independent gold. Unreviewed differences
and missing coverage must stay explicit; this harness currently reports
`preservation_established: false`.

All raw texts, frozen repositories, caches, judgments and receipts belong under
the ignored `private_comparison/` directory. Keep research artifacts out of
packages. Windows comparison workers run below-normal, serially; do not overlap
compilation with corpus runs. The small Rust bridge is not a
release-performance benchmark: its debug builds exercise four public
operations per input. Build each owner in a separate Cargo workspace using
`structure_compare.rs` as the binary, `serde_json = "1.0"` and a path dependency
named `owner` on package `legal-structure` with feature `citator`. Use
`cargo build --offline --jobs 1`, save each Cargo manifest/lockfile and source
snapshot, and record the binary hashes. Baseline review must precede building.

```powershell
python -u -X utf8 benchmarks/docx_corpus/compare_versions.py structure-run `
  --inputs <texts.jsonl> --baseline-exe <original-bridge.exe> `
  --candidate-exe <shared-bridge.exe> --output <new-run-directory>

python -u -X utf8 benchmarks/docx_corpus/compare_versions.py structure-score `
  --inputs <texts.jsonl> --run <saved-run-directory> --output <new-score-directory>

python -u -X utf8 benchmarks/docx_corpus/compare_versions.py core-documents `
  --manifest <freeze>/manifest.json --saved-documents <run>/baseline-safe.jsonl `
  --output <new-core-run-directory>

python -u -X utf8 benchmarks/docx_corpus/document_gold.py score-core `
  --manifest <freeze>/manifest.json --gold <whole-document-gold.json> `
  --run <new-core-run-directory> --mode safe --output <new-score.json>

node benchmarks/docx_corpus/pinpointer_compare.mjs `
  <original-pinpointer> <frozen-current-pinpointer> <unpacked-citation-package> `
  <requests.jsonl> <new-results.jsonl>
```

The LSP scorer checks UTF-16 source slices for citation, reference, pinpoint and
provider spans. Removed/added identity counts include changed extents or kinds;
they are not automatically lost/found authorities. All raw differences remain.
`core-documents` uses the current installed Python binding and records its file
hashes alongside the frozen manifest, runner, saved-input and text hashes. It
extracts citations and source parts once per document, then resolves the same
records with aggressive hint extraction and both safe and aggressive linking.
`candidate.jsonl` is the safe output and `candidate-aggressive.jsonl` is the
aggressive output. Change `--mode` to `aggressive` to score that output against
the same gold; the default is `safe`.
The note-only scope still excludes body-defined authorities.

Pinpointer requests contain `id`, `method`, `args` and source IDs. Derive requests
from frozen original outputs, retain every source membership when deduplicating,
and keep that input file/hash alongside the source and package receipts. The
adapter writes a receipt to stdout and progress to stderr. It replaces only the
existing transport with real WASM calls; browser retrieval and editing remain
separate verification work.

## Existing deterministic corpus benchmark

This is the corpus-scale layer missing from the existing
`legal-pdf-parser` split/link benchmark. It reuses that engine; it
does not copy or import the ALR application at runtime.

Run the two local deterministic arms over the private corpus:

```powershell
python benchmarks\docx_corpus\benchmark.py scan `
  --manifest benchmarks\docx_corpus\private_manifest.jsonl `
  --output-dir benchmarks\docx_corpus\private_results\local
```

Create a stable, document-diverse provisional review sample:

```powershell
python benchmarks\docx_corpus\benchmark.py sample `
  --cases benchmarks\docx_corpus\private_results\local\cases.private.jsonl `
  --output benchmarks\docx_corpus\private_results\gold.review.jsonl `
  --sample-size 80
```

Every row starts as `provisional`. Establish `expected_verbatim_parts` from the
source, add only genuinely equivalent `acceptable_partitions`, and record the
evidence before changing the status to `accepted`. Ambiguous source text stays
explicit; it does not create a human review queue or justify a guessed answer.
The 40/40 eligible/abstention balance makes this a challenge set, not a
representative estimate of corpus accuracy. The command refuses to overwrite
existing review work unless `--force` is supplied.

Score local arms and make a paired comparison:

```powershell
python benchmarks\docx_corpus\benchmark.py score `
  --gold benchmarks\docx_corpus\private_results\gold.review.jsonl `
  --prediction conservative=benchmarks\docx_corpus\private_results\local\predictions.deterministic_conservative.jsonl `
  --prediction recall=benchmarks\docx_corpus\private_results\local\predictions.deterministic_recall_first.jsonl `
  --baseline conservative `
  --output benchmarks\docx_corpus\private_results\local\score.json
```

For live model arms, first freeze accepted rows into the fixture format already
supported by the Legal PDF Parser:

```powershell
python benchmarks\docx_corpus\benchmark.py fixture `
  --gold benchmarks\docx_corpus\private_results\gold.review.jsonl `
  --output benchmarks\docx_corpus\private_results\live-fixture.json `
  --frozen-gold benchmarks\docx_corpus\private_results\live-gold.jsonl

python legal-pdf-parser\dev\benchmark_docx_linking.py `
  --fixture benchmarks\docx_corpus\private_results\live-fixture.json `
  --output benchmarks\docx_corpus\private_results\live-results.jsonl `
  --arm gpt-5.6-sol:hybrid --effort max
```

That last command sends the selected footnotes and proposition passages to the
configured model provider. Keep the corpus, gold, fixtures, model traces, and
results under the ignored `private_*` paths.

Score deterministic arms against `live-gold.jsonl` when comparing them with
the live fixture so every arm uses the same frozen case IDs. Confidence
intervals and p-values are suppressed for the balanced challenge design.

Small runnable check:

```powershell
python benchmarks\docx_corpus\benchmark.py self-test
```
