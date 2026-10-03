# DOCX structural preservation hill climb

This review branch preserves implementation, tests and evaluator source only.
No tests were run for this branch handoff, and it does not establish release
readiness. The fixture generator contains independently invented text and XML;
generated documents, corpus fixtures, split assignments, gold/sealed data, raw
logs, credentials, binaries, caches and rejected candidates are not included.

Fresh-workspace setup remains incomplete. The scripts assume the Beaver layout,
backend dependencies, a configured Python/LibreOffice runtime and ignored
`.tmp/cloud-docx-hillclimb/` state. Before running them, a separate integration
step must supply a new 80/20 family split, generate synthetic inputs and expected
packages, create the oracle self-test receipt and baseline source archive, and
freeze a new evaluation. The commands below begin after those prerequisites;
this source-only handoff does not reproduce the previous frozen run. `freeze.py`
now creates a fresh run identity and omits the old run's correction hash and
receipt path. That cleanup has not been tested.

This extension of `benchmarks/docx_edit` uses real, independently invented DOCX
packages, the existing `DocxSession` bridge, and actual public `Edit` and
`word_python` tools through `createChatToolRunner` and `TurnToolRegistry`.
Persistence is the existing isolated local document fixture application. No edit,
verification or publication implementation is mocked. No model/API calls occur.

A split fixed before generation assigns 15 source-document structural families
80/20 to development and a sealed final set. Each family has a distinct target
layout, such as a note inside a text run, note inside a hyperlink, a bookmark
spanning formatted runs, a nested/merged table target, a list paragraph, a content
control or an internal hyperlink. Shared untouched OOXML guards cover headers,
footers, tables, horizontal/vertical merges, numbering, footnotes/endnotes,
sections, relationships, hyperlinks and bookmark destinations. These are a small
synthetic regression corpus, not a claim about prevalence in real documents.
Every task derived from a source remains in that source's split. The final set is
not used in candidate search.

Each source has five fresh-copy tasks: session roundtrip, multi-span public Edit,
rich Python edit, inline Python replacement and a section columns edit. Expected
packages are authored by small independent OOXML substitutions before production
execution. The Python oracle neither calls production extraction nor derives gold
from production artifacts. It compares entire packages and checks reference
integrity. Tool success, intended task changes, collateral preservation, verified
artifact correctness and LibreOffice open/page receipts are separate measures.
No-op saves additionally require identical bytes for every uncompressed part.
Equivalent pure-text run splitting is allowed; runs containing footnote/endnote
references retain their original grouping because splitting can change rendered
markers and numbering. This was corrected in evaluator v3 using direct rendered
gold/candidate evidence; all source, gold, task and split bytes stayed unchanged.

Raw sources, gold, outputs, local app data and receipts live only under ignored
`.tmp/cloud-docx-hillclimb/`. `freeze.json` records all evaluator, input, expectation
and split hashes plus precise scoring/normalization/acceptance rules. Both runner
and oracle verify frozen hashes. A candidate must strictly improve the integer
score and preserve every previously passing task. The attempt ledger and exact
production patches are maintained separately by the hill-climb controller.

From the repository root, after the one-time generation/self-test/freeze:

```sh
BEAVER_WORD_PYTHON="$PWD/.tmp/cloud-docx-hillclimb/runtime/venv/bin/python" \
  backend/node_modules/.bin/tsx benchmarks/docx_edit/preservation/runner.ts \
  --subset development --out "$PWD/.tmp/cloud-docx-hillclimb/runs/baseline"
python benchmarks/docx_edit/preservation/oracle.py score \
  --subset development --run .tmp/cloud-docx-hillclimb/runs/baseline
python benchmarks/docx_edit/preservation/oracle.py check-freeze
```

Use a fresh output directory for every candidate. Holdout invocation is reserved
for the final selected incumbent. A genuine harness correction requires a new
version and a fresh baseline; do not modify frozen gates to improve a score.
