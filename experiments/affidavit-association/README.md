# Hard affidavit and court-record association

This experiment expands the existing private Court Records benchmark by 100 new,
source-reviewed records and retrains association methods on mixed document folders.
Each record also carries sourced chronology events for the narrative-building task.
Gold, model views and raw receipts remain in ignored
`benchmarks/local-data/affidavit-association/`; original public PDFs live once by
SHA-256 in the shared OpenLegalData corpus. The pre-expansion union has 673 record
identities across the two existing benchmark roots, of which 665 have local gold.

Embedding fine-tuning is a coherent retrieval task: an affidavit's actual exhibit
reference is the query, its associated file is positive, and competing files are
negatives. It does not train a narrative writer. Google's
[EmbeddingGemma 2 fine-tuning guide](https://ai.google.dev/gemma/docs/embeddinggemma/fine-tuning-embeddinggemma-with-sentence-transformers)
describes adapting query/positive/negative representations with the same task
prefixes at training and inference.

The earlier private experiment already reported benefits from a text-tower LoRA.
Its historical hard-tier split shared two proceedings with training, however, and
its closed file sets omitted sibling distractors. Those scores are background,
not a result for this candidate.

## Gold and difficulty

Source selection targets near-twin versions, competing affidavits, collective
references, nested records, conflicting dates, technical evidence and difficult
scans. A complete *filed exhibit* can itself be an excerpt of a larger instrument.
Missing attachments, uncertainty and contradictions stay explicit. Selection does
not use a candidate model's errors. An easy CV or a renamed old affidavit does not
count toward the expansion.

The canonical `source-gold.json` or reviewed sibling describes the complete original
source inventory, including explicitly sealed, missing and unlinked attachments.
It binds associations and chronology to original SHA-256 hashes and physical pages.
Anonymous model views are separate derivatives in `model-views.json`; their label,
complete text hash, eligibility and omission reason are checked independently. A
damaged export never invalidates correct source gold. Direct source text projections
can preserve evidence that a PDF redaction would damage. Full empty text views of
photographs remain hard targets and reveal the text model's modality limit.

Separate Codex sub-inference calls author and review annotations. Both receive
source evidence; the review also checks the materialized files. These are model
reviews, not human certification. Source and output page mappings, original hashes,
OCR derivatives, reviewed masks, quotations and call receipts accompany the gold.
Original rejections and failed attempts remain in the audit trail. Outer assignment
stamps and added folios are removed from both text and pixels; substantive dates,
names, original pagination and document content are preserved.

Bounded direct Codex collaboration batches may source-author several compact
records, with a different agent independently reviewing the complete batch.
Their provenance identifies the actual collaboration job and source views;
it never invents a CLI runner call or provider receipt. The global attempt
ledger counts each author/reviewer batch invocation. Pending author drafts do
not enter accepted inventories. A finalized lane inventory overrides retained
historical shard summaries, including earlier acceptances later withheld.

The authorized ceiling is 250 author/reviewer job attempts, including failures
and retries. The original runners ended at Canada 52, regulatory 80 and US 110
(242 total). Eight direct author/review/model-view batches bring the count to the authorized
250-attempt ceiling.
Only independently accepted source IDs and reviewed model views enter training. The aggregate audit requires
exactly 100 new IDs and rejects baseline duplicates, invalid dates, empty evidence and missing source provenance. Model-view coverage
is reported separately.

The accepted expansion contains **100 records, 606 source exhibit
labels and 1,759 sourced narrative events**, with 319 original PDF hashes checked.
Source labels include explicit sealed/missing entries. Every public target now has
a complete model view: **561 eligible attachments**, with 45 sealed/missing labels
kept in source gold. The expansion spans 36 joined proceedings, at most eight
records per proceeding. The frozen split puts 80 new records in training and 20
in held-out proceedings; the comparison uses 300 training and 149 test records.

## Second expansion: Canadian records

An additional **100 Canadian records** have been source-authored and independently
reviewed in private `expansion-2/`. They contain **605 association labels and 1,771
sourced narrative events** across 50 proceedings. Of those labels, 566 have located
original targets and 39 retain explicit availability limits. The final audit checks
109 original PDF hashes. Every counted referring record must belong to a
Canadian court or tribunal and declare `country: CA` with its Canadian jurisdiction.
Foreign proceedings do not qualify. The audit rejects missing or foreign country
and jurisdiction metadata; independent source review establishes the actual forum.

The new batch targets proceedings and subjects beyond the first expansion, with
at most four records per proceeding. Full referring bodies, every original attachment,
source-grounded narrative events and same-proceeding distractors remain required.
Selection uses source characteristics, never candidate-model errors. Authors keep
their source Gold immutable for a different agent's review. Public target text
views cover complete filed attachments, including necessary OCR.

Complete notices and written submissions can be distinct referring instruments.
Their evidence references keep the actual instrument names and nested citations;
an affidavit reproduced inside a motion record is not another new affidavit.
References outside an affidavit's own exhibit namespace remain explicit. The
audit reports misses by the current exhibit-label query parser separately from
source Gold and complete document-view coverage.

The frozen baseline excludes 773 prior record identities, including the completed
first 100, and retains their source/body identities for duplicate checks. The
previous Gold, inputs and trained-model comparison remain frozen. This batch has
its own 250-job ceiling and actual collaboration ledger in `expansion-2/jobs/`;
it does not reuse the exhausted first-batch budget. Only separately reviewed
records count toward its accepted inventory. The source-Gold audit passes;
model-view fidelity remains separately reported per record. This batch has not
been used for another training run.

## Third expansion: Canadian subject and jurisdiction balance

A further **150 Canadian records** are being gathered in private `expansion-3/`:
the requested next 100 plus 50 more. Criminal, family and real estate proceedings
now take priority in source selection. The remaining intake excludes class actions.
The selection plan compares the existing mix by actual forum, substantive subject,
language, publisher, deponent role and document/reference structure. Geographic
search targets favour underrepresented provinces and territories; actual public
source availability controls adjustments. A form, guide, repeated affidavit or
unavailable evidence pack cannot fill a quota.

Each acquisition retains the source website and listing, original and final URLs,
retrieval history, original byte hash and page inventory. Failed, rejected and
unselected candidates retain their provenance too. Derived OCR, page images and
text hashes remain bound to the original. The author and independent reviewer read
complete referring bodies and complete filed target inventories. Scanned pages
are supplied as original page images where text extraction loses evidence; an
image-verified quotation is explicitly distinguished from a mechanical text match.
Author outputs and failed runner receipts remain immutable when a separate,
documented source correction or canonical metadata normalization is necessary.

The exclusion baseline also reserves pending second-batch identities and its
replacement candidate, without calling those records accepted. This prevents
counting the same source body again while independent reviews finish. The new
batch has a separate actual job/call ledger; accepted source Gold and model-view
fidelity remain separate. No third-batch completion or new training result is
claimed while gathering and review continue.

## Training and evaluation

`data.py` freezes a new proceeding-group split before fitting. Family aliases and
normalized court-file identities and public RECAP docket identities join sibling
records. It uses all 665 complete local legacy records, preserving the saved truth
for its original 531 records and rebuilding reference contexts for all records from
complete affidavits. All mentioned paragraphs and sentences are retained; the
remaining 134 records use the same reference parser. New-record counts and file
counts are balanced across five groups of folds; fold zero is the test set. These
scores cannot be compared directly with the historical hard-tier split.

Each folder contains its target exhibits, up to 32 same-proceeding distractors
(including sibling affidavits), and six topical documents from other proceedings.
Source-word overlap selects topical near misses independently of model results.
Known duplicate document identities are excluded from the distractors. Distinct
originals remain distractors even when their full extracted text is identical or
empty; the receipt records these representation collisions. Every file gets the
same anonymous filename format and a shuffled position. Private role/provenance
and answer fields are never passed to the embedder. Declared indistinguishable
groups receive equivalence-aware scoring alongside exact source-label accuracy.
Separately reviewed counterpart files can join the folder through a record's
`distractors.json`; their source hashes, pages and masks are retained even when the
counterpart is not itself a new gold target. Its explicit `same_proceeding`
boolean distinguishes same-case siblings from cross-proceeding near twins.
Complete reviewed text projections can be read directly through `text_file` and
`text_sha256`, without exporting another PDF. The original source hash and physical
page inventory establish document identity for both PDF and text views. The audit
checks distractor originals and reports their model-view coverage separately.

The shared splitter removes recognized native ECF stamp lines with transparent
masks, preserving images, graphics and every protected filing-date span on the
page. It preserves neighbouring document titles even when extraction groups
them into the stamp's text block. Unsafe overlap with substantive native text
stops materialization and requires source-specific handling; it is not accepted
as harmless clipping. Fourteen independently invented splitter tests cover
these output contracts, including pixels and overlapping headers.

`run.py` compares a cheap lexical/field listwise head, the same head with frozen
EmbeddingGemma features, and the same head with newly LoRA-tuned features. It uses
the existing benchmark's feature extractors rather than duplicating them. The
rectangular loss treats extra files as row negatives; it does not invent a label
for an unrelated file. Fine-tuning samples up to 16 files per step, including four
negatives, with rank 16, two epochs and one fixed seed. Every complete file and reference
paragraph is covered by overlapping 512-token windows, accounting for task prefixes
and special tokens, with 64-token overlap. Inference aggregates all windows using
mean query-to-document MaxSim and pooled cosine. Training samples a query window
and selects relevant positive/negative windows across the complete source using
the frozen encoder. The selected character/token spans are retained in a private
training trace. No first-character or first-window cap defines gold or file inputs.

All new training records are retained. Legacy examples are limited to 300 total
training records, eight per proceeding and at most 25% insolvency, to reduce the
original corpus's concentration. The saved adapter, exact model snapshot and file
hashes, source-code snapshots, split IDs, feature arrays and per-record predictions live in
one latest candidate output directory. Test outcomes do not select hyperparameters.

This is a text-only candidate: it needs usable OCR and cannot interpret a photograph
from an empty text layer. The available target exhibit-label
inventory is supplied. Source-only missing attachments and unusable exports remain
explicit in coverage statistics. Missing-label discovery, abstention, page-image embeddings,
complete narrative generation and browser performance are separate measurements.

## Results

The completed comparison uses 300 training records and 149 test records from 58
held-out proceedings. The new-gold test subset has 20 records from eight proceedings.
Both the training and test folders contain same-proceeding distractors. Cross-proceeding
distractors are selected separately within the training and test partitions.

| Method | All test labels (1,307) | New-gold test labels (106) | All test proceedings (macro) |
| --- | ---: | ---: | ---: |
| Lexical/field head | 72.4% (946) | 76.4% (81) | 71.8% |
| Head + frozen EmbeddingGemma 2 | 76.7% (1,002) | 80.2% (85) | 78.1% |
| Head + LoRA-tuned EmbeddingGemma 2 | **80.0% (1,046)** | **86.8% (92)** | **80.8%** |

These are equivalence-aware assignment accuracies; exact source-label accuracies
are 72.1%, 76.5% and 80.0%, respectively. Fine-tuning adds 44 correct assignments
over the frozen encoder overall and seven on the new gold. Distractor selections
fall from 191 to 138, including a reduction in sibling-document selections from
153 to 124. The tuned new-gold macro proceeding accuracy is 88.1%.

This supports fine-tuning as an association method in this fixed, single-seed,
text-only comparison. The new subset contains only eight held-out proceedings;
it does not establish broad generalization or narrative-generation quality.

All 600 training steps completed. Both encoders processed every input window,
including 105,159 unique document windows and 11,798 unique query windows. The
coverage receipt confirms complete character coverage; the longest document spans
1,511 windows. The canonical private `candidate/` contains the adapter, fitted heads,
feature arrays, scores, selected training spans and source snapshots. All 53
artifact hashes and the frozen input hash were verified after download.

## Checks and reproduction

The existing private benchmark tooling and source corpus must be available.

```powershell
python -m unittest discover -s experiments/affidavit-association -p test_association.py -v
python experiments/affidavit-association/audit_expansion.py
python experiments/affidavit-association/data.py
```

Audit the second batch against its own frozen baseline and retain its separate
receipt:

```powershell
python experiments/affidavit-association/audit_expansion.py `
  --expansion benchmarks/local-data/affidavit-association/expansion-2 `
  --baseline benchmarks/local-data/affidavit-association/expansion-2/baseline.json `
  --out benchmarks/local-data/affidavit-association/expansion-2/audit.json
```

Run the following in the existing CUDA environment, with the frozen private input
and original benchmark helper source staged together:

```powershell
python experiments/affidavit-association/run.py `
  --inputs benchmarks/local-data/affidavit-association/inputs.json `
  --output benchmarks/local-data/affidavit-association/candidate `
  --bench benchmarks/court-record-exhibits
```

The small GPU smoke run uses independently invented long documents to check
complete chunk coverage, loading, gradients, feature extraction and adapter saving.
Its scores do not establish model quality. The source-gold audit passes and the
full candidate comparison is complete. Private audit details are in
`expansion-audit.json`; model results and artifact hashes are in
`candidate/receipt.json` under the private benchmark directory.
