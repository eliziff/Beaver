# Page-stream segmentation

Prepare reusable original-page gold for splitting PDF packets, then measure a
small tier-1 model. This is an experiment; it does not change parser decisions.
Original PDFs stay in the shared OpenLegalData corpus. All manifests, images,
annotations, requests and model artifacts belong in ignored
`benchmarks/local-data/page-stream-segmentation/`.

The latest context/batching check (October 25) reused **200 sampled page seams
from 100 source families**, with 199 scoreable after excluding one unresolved
counterpart convention. It held the clarified prompt and Luna max fixed,
completing 725 new calls and reusing 164 exact controls. All 889 unique requests
have verified model, prompt, schema, image and response artifacts. Every observed
difference across arms was reviewed against source images; other agreements
retain independent Sol-max references and were not all visually audited.

| Images per call | Seams requested per call | Correct / 199 | Missed starts | Extra starts | Estimated credits / 1,000 requested seams |
| --- | --- | --- | --- | --- | --- |
| 2 | 1 | 194 (97.5%) | 2 | 3 | 25.24 |
| 3, extra preceding page | 1 | 195 (98.0%) | 1 | 3 | 33.30 |
| 3, extra following page | 1 | 195 (98.0%) | 2 | 2 | 32.99 |
| 3 | All internal seams | 194 (97.5%) | 1 | 4 | 18.85 |
| Up to 8 | 1 | 197 (99.0%) | 0 | 2 | 60.47 |
| Up to 8 | All internal seams | 194 (97.5%) | 2 | 3 | 11.94 |

The eight-image arms used identical images for every focal seam. Batching was
about 80% cheaper per requested seam, but lost three correct decisions overall.
It requested 557 seams; only the same 199 focal seams were scored, so the table
does not establish accuracy on all its outputs. Costs use reported input/cache/
output tokens and [published Standard Codex credit rates](https://learn.chatgpt.com/docs/pricing),
not an invoice or subscription quota. All arms returned zero uncertain answers
on the scored seams.

The singleton was wrong on a contract acceptance signature page where the batch
was correct, confirming that singleton agreement is not the reference standard.
Eight-image singleton and batch disagreed on five seams, exposing four batch
errors and one singleton error, but both still falsely split a closing court
backsheet. Agreement alone therefore does not certify gold. Three-page context
helped only slightly over two; the earlier two-page probe also used a different
prompt, so its misses cannot be attributed to context size alone.

Private `call-economy/` retains `spec.json`, `final-results.json`,
`adjudicated-report.json`, `adjudication/results.json` and `completion.json`.
All 725 new calls completed once; a Windows aggregate-file access race required
reconstructing summaries from the independently retained call artifacts, without
replaying calls. `finalize.py` verifies and rebuilds the final reports offline.
These image-only page-edge results do not validate within-page line starts or
whole-packet segmentation, and none were promoted to canonical gold.

The earlier council check covered **200 sampled page seams in 100
previously unused source families**, one PDF per family and two adjacent seams
per PDF. The frozen pipeline used the clarified Luna-max author with up to eight
original page images, an aggressive Luna-max candidate seat, and Sol 6.1 low with
automatic intent/examples to adjudicate disputes. Independent Sol 6.1 max calls
authored the references without seeing proposals or votes. The selection included
seven medical PDFs and 43 windows around legacy boundary candidates; it is an
enriched seam sample, not whole-packet exact segmentation or natural prevalence.

Against the frozen references, the complete pipeline matched **196/199 decisive
answers (98.5%)**, with one uncertain answer; normal Luna matched **195/200
(97.5%)**. The council referred 42/200 seams (21%) to the judge. All 200 seams have
their planned outputs: 556 CLI calls produced 542 completed requests after 14
transport-only timeout recoveries at eight workers. Successful answers were never
replayed. Retained model identities, prompts, schemas, image hashes and responses
were verified.

Targeted source-image review of all five normal/reference disagreements and the
pipeline's abstention, followed by the context/batching comparison, found four
reference errors and one unresolved convention for a separately signed
counterpart page. With those corrections and that one seam excluded, the
diagnostic comparison is:

| Method | Correct / decisive | Missed starts | Extra starts | Uncertain |
| --- | --- | --- | --- | --- |
| Clarified Luna max | 197/199 (99.0%) | 0 | 2 | 0 |
| Luna council + Sol-low judge | 195/198 (98.5%) | 0 | 3 | 1 |

The council still accepted three wrong splits: both Luna seats mistook a court
backsheet and a contract acceptance signature page for new documents, and the
judge split another ordinary contract execution page that normal Luna had
correctly kept together. The council abstained on a
page where the declaration's closing printed name precedes a service certificate.
The certificate starts within that page; continuation at its top edge is correct.
The initial interactive review wrongly changed that edge to a start. That
correction is explicitly retracted in `reference-corrections.json`, preserving
the original review and frozen inputs. Thus the apparent raw-reference advantage
does not establish a better overall method: on scoreable reviewed seams the
council added a false split and an abstention. Neither satisfies the
zero-wrong-gold gate.

The corrected figures are post-run diagnostics, not independently human-authored
accuracy: other agreements retain model references and were not all visually
audited. Frozen and reviewed results remain separate in private
`best-method-expansion/` (`report.json`, `review.json`, `reviewed-report.json`,
and the subsequent `reference-corrections.json`). No
outputs were promoted to canonical gold. `review_summary.py` regenerates the
initial reviewed comparison without model calls; the later correction and
`call-economy/adjudication/results.json` must also be applied for the table above.
Do not replay `run.py` or `finish.py`.

## Two-page authoring probe

`pair_probe.py --prepare-only` freezes 64 existing-gold pairs (32 starts and
32 continuations) plus eight consecutive unknown edges in each of eight additional
public PDFs. `pair_probe.py --workers 64` compares Luna max with Sol low using
identical two-page images, instructions and per-gap enum schemas. It caps the
entire prepared run at 256 attempts, retains incremental results and revalidates
saved responses before reuse. It never promotes agreement automatically.

The October 24 probe completed all 256 responses with 255 new calls and one
retained answer. Against the existing gold, Luna matched 60/64 and Sol 58/64;
all mismatches were missed starts. Three shared misses concerned attached
material (an annex, an account-details sheet and an appendix excerpt). This
small diagnostic sample does not establish population accuracy or a decisive
model ranking. It does show that two-page agreement alone cannot certify gold.

On the new scopes, 59/64 decisions agreed, one differed and Sol abstained on four.
Visual exception review resolved the cover/body disagreement and found internal
note starts on two medical pages. Both edges around each mixed page remain
unknown, including some model agreements. Eight partial source annotations retain
56 page-edge labels. Two source variants have identical images throughout the
sampled range: this is seven independent ranges and 52 distinct retained labels.
All eight sources remain unassigned pending family reconciliation. The private
`pair-probe/` directory retains the frozen spec, results, visual review,
candidate gold and reviewed report; canonical annotations remain under
`annotations/<sha>/gold.json`. Do not repeat this paid probe to regenerate exports.

## Four-page prompt regression

The segmentation prompt now explicitly includes separately delimited nested
attachments, annexes, appendices, schedules, forms and reproduced excerpts,
with invented split/continuation/cover examples. Association ownership does not
merge constituents. The model output and gold formats are unchanged.

A prompt-only rerun used the same 24 cases and four-page contexts as the saved
context comparison, with identical images, schemas, model/effort and references.
All 48 new calls completed. On the 20 binary-reference cases, Luna max improved
from 17/20 to 20/20 and Sol low from 14/20 to 20/20. Both retained all 12 successful
controls. The remaining four cases concern mixed pages and are excluded from
binary accuracy. The private `prompt-four-page/comparison.json` holds the paired
result. This is a regression panel used to improve the prompt, not independent
accuracy certification. The unchanged page-edge output cannot locate starts
inside a page; those locations still require existing span gold.

## Within-page line starts

Line-start answers were checked on three public packets with page images
visually reviewed: stacked case reports on one page, an email chain whose
earlier message begins after a signature and disclaimer, and an exhibit email
quoting an earlier message. Six probe calls (Luna max author, then a Sol 6.1 low
judge) numbered lines from retained structure-gold lines. Both arms marked the
first report's heading after the running head, which would cut the running head
off as its own document, and the second report correctly. Sol low corrected
Luna's page-top answer on the chain; both missed the quoted email.

Those snapshots were not structure gold's current frame: its `author.extract`
orders lines as the extraction does, and the current parser binary re-read one
scan (65 line texts changed, including the chain's start). The prompt now treats
page 1's first constituent and lines after only page furniture as page starts.
Three Luna-max author calls on the current frame then marked only the second
report and the quoted email, and repeated the page-top error on the chain.
These nine calls are diagnostics, not gold. Private `within-page-probe/` and
`within-page-check/` retain the requests, frames and answers.

## Minimal annotation

Add one optional field to an existing original-source part:

```json
{"sha256":"<original PDF hash>","pages":[12,13,14,15,16],"document_starts":[15]}
```

`pages` is a sorted inventory of **physical, 1-based original PDF pages**.
`document_starts` lists every internal constituent start in that reviewed scope.
The first selected page is implicit, not a natural-document-start label.
Missing `document_starts` means unknown; `[]` means reviewed with no internal
splits. Across omitted physical pages there is no labeled gap. A listed start
must have its immediately preceding physical page in the scope.

A constituent beginning partway down a page is a line start in the same array:

```json
{"sha256":"<original PDF hash>","pages":[14,15],"document_starts":[{"page":15,"line_id":"p0015-l0027","text":"<that line's extracted text>"}]}
```

`line_id` and `text` come verbatim from the **whole packet's** extraction, as
structure gold's `author.extract` gives it; never extract a constituent alone,
round to a page edge or locate a line by geometry. Integer and line starts may
be mixed, with several on one page. An integer page starts at that page's first
extracted line. A line start also needs its preceding page in the scope, except
on physical page 1, whose first constituent is never a start. Page-only
annotations remain valid: they reviewed page edges, not the lines inside pages.
Binary consumers see only page edges; a page holding only line starts is a
continuation at its top edge.

Partial review uses smaller scopes with the same three fields. Additional gold
uses `{"sources":[...parts...]}`; provenance and disagreements live in a separate
receipt. No titles, classes, segment IDs or end pages are needed.
The format works for exhibits, medical records and other original PDFs.
Structure gold's `author.py --splits FILE` cuts a packet at these starts; an
annotation's `gold.json` is such a file.

A certificate/cover stays with the following constituent. Headings, dates and
page-number restarts alone are not document boundaries. An exhibit can contain
several documents. Existing v4 `units[].starts_document` remains its own authority.

## Prepare and annotate

Run from the repository root with the existing Python environment (PyMuPDF and
jsonschema; NumPy/LightGBM only for the tree experiment):

```powershell
python -B experiments/page-stream-segmentation/prepare.py
python -B experiments/page-stream-segmentation/annotate.py --limit 1 --windows 1
```

Both commands are offline. Preparation imports completed structure gold,
accepted affidavit source inventories, legacy original-page maps and medical
excerpt ranges. Medical ranges are expanded against the original **parent** PDF,
not treated as evidence of starts at excerpt page one. Stripped association
model PDFs are not used.

The output is `dataset.json`, `preparation.json`, and `gaps-<split>.jsonl`.
Each exported row contains original `sha256`, `right_page`, binary `label`,
`family_id` and `split`. A gap named 15 is between original pages 14 and 15.
Unknown gaps are absent from training rows and retained in the review queue.
Current completed gold is authoritative. An authoring receipt's historical file
hash can differ after corrections or reserialization; that difference is recorded
without discarding labels. The export binds the current gold's hash. Original
lookup also uses the authoring manifest, including generated scans linked to their
parents. Missing catalogue page counts are read from the PDF. Local path lookup
problems affect image rendering, not the validity of already authored labels.
Corpus collection junctions to other backing drives are preserved.

The annotation command stages windows of up to six requested pages with context
on both sides, original page images and each requested page's numbered extracted
lines. `annotations/<sha>/plan.json` locates each exact request. Each schema
enumerates the permitted answers: a requested page after page 1 (a start at its
top, including after only running heads, page numbers or stamps) or
`{"page","line"}` with any later line number of a requested page. Code maps the
number to that line's `line_id` and verbatim `text`. Array order and duplicates
are normalized without another model call. The packet frame is cached once in
`annotations/<sha>/packet-extraction.json` with its parser binary or witness
hash; `--extraction` supplies a structure-gold extraction witness for one
source. Saved line starts must match that frame. Structure gold must cut the
same frame (same binary or witness): its `split` checks IDs, not texts.

A page is requested until a line-start answer covers it: unknown edges,
pages known to hold within-page starts, and pages with only earlier page-edge
answers, unless current gold already has line starts there. A new answer never
replaces current gold; it only adds line starts to a page-edge-only decision
with the same top edge, and other differences are recorded as receipt conflicts.
A source's receipt is `complete` only when every such page is covered.
`--sources SHA...` selects originals, including ones already covered by page-edge
labels; `--limit` bounds sources and `--windows` bounds new windows across them.
It defaults to preparation only. Page 1's "no line starts" answer is retained in
the window receipt; the annotation format cannot record it.

Execute a bounded live annotation run:

```powershell
python -B experiments/page-stream-segmentation/annotate.py --execute --max-calls 20 --limit 10 --windows 10
python -B experiments/page-stream-segmentation/prepare.py
```

The call budget applies **per invocation**, including retries; validated cache
hits cost no calls. By default each window uses one authoring call. Add `--review`
for selected audit batches to obtain a second blind call over the same images.
Both modes preserve uncertainty; with review, disagreements also stay unknown.
Model agreement does not establish accuracy. Interrupted/budget-limited runs
retain accepted calls and resume.
`origin: machine_test` and a run ID identify the submission, not its contents.
Accepted scopes and later manual corrections are preserved when a run resumes;
historical model receipts do not override current gold. Use a separate `--out`
when comparing authoring models independently.

Add manually reviewed gold with `prepare.py --annotations FILE...`. The files
must live in the repository or OpenLegalData store, with originals registered in
the canonical corpus. The same optional field is also preserved when supplied
on affidavit source parts. Keep one canonical annotation owner; overlapping
disagreements are withheld rather than silently overridden.

## Partitions, baseline and scoring

Preparation reuses the existing structure family selection, catalogue gold
memberships, association families and parent/excerpt relationships. Transitive
families are indivisible. New families and conflicting inherited assignments
remain `unassigned`; they cannot train the baseline. Supply an updated reviewed
family selection with `--partitions FILE` through the existing structure-gold
partition workflow. This exporter does not certify that old test data is unseen.

The baseline consumes existing `structure-gold rows` output: `features.json`,
`rows-train.jsonl` and `rows-development.jsonl`. Generate those with the owning
[structure-gold exporter](../legal-structure-gold/grade/src/main.rs), using the
retained original extractions. No native rebuild is required for this Python
change. Additional annotated sources still need Rust feature rows before this
baseline can use them; the generic gap export also supports image/text models.

```powershell
python -B experiments/page-stream-segmentation/train_baseline.py PATH_TO_RUST_ROWS
python -B experiments/page-stream-segmentation/score.py benchmarks/local-data/page-stream-segmentation/baseline/predictions-development.json
```

The baseline pools first/last/mean existing numeric evidence once per page and
uses four surrounding pages for **every** physical gap, not just Rust's proposed
starts. It reads no gold features or test row file, masks unknown training labels,
uses one CPU thread and stops on development loss. Training and scoring retain
input/model hashes. Timings exclude PDF extraction/OCR/rendering and are not an
end-to-end speed claim. Missing feature sources remain visible in coverage.

Predictions are `{"sources":[{"sha256":"...","probabilities":{"2":0.1,...}}]}`.
The scorer reports boundary precision/recall, false/missed splits, coverage,
exact documents and exact packets by length. Partial gold and packets known to
contain within-page starts are excluded from exact packet scoring. Missing
predictions count against coverage and exact packets.
`--low 0.1 --high 0.9` demonstrates abstention; probabilities in between go to
review. Those example thresholds are not calibrated operating points.

Real-data quality, independent family holdout, selective calibration, modality
comparisons and full extraction-to-decision latency must pass before Rust runtime
integration. The initial local preparation and tests establish a usable data
path, not a trained high-accuracy model.

### Visual doc-split-v1 adaptation

`train_doc_split.py` adapts the existing boundary head of
[Nutrient's doc-split-v1](https://huggingface.co/nutrientdocs/doc-split-v1),
Apache-2.0, revision `dccadc69dd4ae69c63f42aa6715f249c6e5e6cf8`.
The public release supplies ONNX inference graphs rather than a training package.
`doc_split_model.py` reconstructs its six-layer, 21-million-parameter boundary
head from the released weights. CPU/GPU numerical parity and finite gradients
are checked before training. Both page encoders stay frozen. The initial fit
disabled text; the current trainer uses embedded PDF text with the published
tokenization and presence gate.

Training data comes from the **authored split gold**, not the general PDF
inventory. `prepare_doc_split_teacher.py` freezes the 199 corrected economy
reference seams and the separate 24-seam panel, with their saved teacher image
contexts. On the desktop, `merge_doc_split_gold.py` adds the legal-structure
cohort's final `authoring-splits.json`, its manifest and `reviewed.json` decisions.
This covers 100 PDFs / 3,972 pages, with 171 page-edge starts and 83 within-page
starts. The current export omits every document containing a within-page start.
It keeps each remaining contiguous run as a separate sequence, including runs
after omitted documents. Source page numbers remain unchanged; model positions
reset per run, and each run's forced first-page boundary has no training/scoring
target. Images and text from omitted documents never enter sequence context.
Original gold stays intact; within-page annotations are absent from model manifests.

The revised export retains 2,366 pages in 103 valid runs across the source cohort.
After source-family separation and teacher-panel deduplication, it has 1,937
training seams (128 starts) and 517 development seams (71 starts), plus the
untouched 24-seam final panel. Saved original images and frozen encoder features
are reused on the desktop. Earlier results below used the previous export and
must not be presented as results for this revised data.

The revised-data audit checked 2,454 train/development targets, 2,982 source-page
identities and 32 image preprocessing samples with zero mismatches. Eleven
focused tests cover run extraction, discarded teacher panels, physical page IDs,
first-page masks, scoring and CRF math. The stock official GPU pipeline processed
19 legal-structure development runs in 23.0 seconds, scoring all 481 known gaps:
image+text F1 28.3% at the released threshold, with 15 true splits, 46 misses and
30 false splits. This is a new-subset baseline, not a fine-tuning improvement;
the final holdout remains unscored.

The initial combined manifest had 4,063 unique fitting/development seams after merging
eight duplicates, with no conflicting seams in this frozen export. Family
metadata is used only for lineage reconciliation, not as a source of labels.
It had 3,049 training seams in 145 families, 1,014 development seams in 36
families, and a separate 24-seam final panel in eight families. The final panel
has not been evaluated. Teacher references are not human-certified gold.

Use the existing desktop environment with CUDA PyTorch, compatible CUDA ONNX
Runtime, ONNX, Pillow and NumPy. Retain the pinned upstream `head.onnx`,
`image_model.onnx` and README under `$trainingRoot/upstream`. Keep one runtime
installation with CUDA enabled. Stage the
reference export at `$teacherData`, and set `$legalSplitRoot` to the reviewed
desktop split store:

```powershell
& $trainingPython experiments/page-stream-segmentation/merge_doc_split_gold.py --teacher-data $teacherData --legal-split-root $legalSplitRoot
& $trainingPython experiments/page-stream-segmentation/train_doc_split.py prepare --out $trainingRoot --dataset "$teacherData/training.json"
& $trainingPython experiments/page-stream-segmentation/train_doc_split.py prepare-text --out $trainingRoot --dataset "$teacherData/training.json" --legal-split-root $legalSplitRoot
& $trainingPython -m unittest discover -s experiments/page-stream-segmentation -p test_doc_split.py
& $trainingPython experiments/page-stream-segmentation/train_doc_split.py train --out $trainingRoot --dataset "$teacherData/training.json"
```

Saved teacher images are resized to 512 pixels. Legal-structure cases contain
complete valid runs, without crossing omitted documents; the seam
panels retain their original image contexts. Unknown gaps never become negatives.
The trainer accepts only `doc-split-teacher.v2`, rejects PDF inventories and
checks source/family separation. Input images, cached features, original gold
receipts and model weights are hash-bound in the private training directory.
Training sums raw-logit BCE over known boundaries and normalizes by the known
boundary count per accumulated batch (target 128). Padding, unknown targets and
each sequence's forced first page are excluded. No positive oversampling or
class weighting is combined with this first native baseline.

`fit_doc_split.py` first adapts only the final 513-parameter linear layer at
1e-4 with frozen features and dropout disabled. It then adapts the full boundary
head at 1e-6, with dropout enabled. Both use AdamW, weight decay .01, gradient
clipping 1, a 10% warmup/linear decay and six-epoch early stopping patience.
Each stage starts with its incoming model eligible as epoch zero. Development
average precision selects checkpoints, with best development F1 breaking ties;
the threshold chosen there remains a development diagnostic. Reports separate
the two gold panels and raw-head versus fixed released-CRF scores. Released beta
calibration is not reused after adaptation. These are researched adaptation
choices, not a recovered Nutrient training recipe.

Text features come only from source PDFs matching the selected gold hashes.
`teacher-source-paths.json` resolves canonical or indexed-in-place OpenLegalData
paths; missing originals cause failure rather than an invented empty text layer.
Source paths, PDF bytes, text and per-page embeddings remain private on desktop.
The model and detailed results stay on the
desktop; no automatic retrieval or app installation is part of this workflow.

Current candidates are `native-fit/{classifier,head}/head.pt` and `head.onnx`;
the latter retains upstream topology and input/output names, with the trained
tensors substituted. Exact weight round-trip and numerical parity are checked
again, including real multimodal inputs before fitting. `native-fit/report.json`
owns the matched stock/candidate scores. Focused tests include
`test_fit_doc_split.py`, `test_doc_split.py`, `test_doc_split_reference.py` and
`test_doc_split_score.py`. The initial visual-only artifacts below are historical.

The corrected native staged fit used 2,868 text-bearing pages out of 2,982
selected context pages. Real-input PyTorch/ONNX logit discrepancies were at most
2.87e-6 on 267-page training and 120-page development sequences. All 13 focused
tests passed. The final linear layer selected epoch 7 of 13; full-head adaptation
selected epoch 3 of 9. Stages took 29.5 and 48.1 seconds on the RTX 3080 Ti, plus
26.0 seconds for text preparation. Seed was 7241; no final-holdout scoring occurred.

Matched raw-head development scores over all 517 known seams:

| Diagnostic | Stock native | Final layer | Full head after final layer |
| --- | ---: | ---: | ---: |
| Average precision | 34.62% | 34.73% | 35.37% |
| F1 at raw threshold .5 | 33.80% | 32.84% | 26.02% |
| Best F1 with threshold chosen on development | 46.28% | 46.03% | 46.61% |

This is not a convincing development improvement. On the 481-gap legal-structure
panel, AP rose from 28.81% to 30.00%, while best development F1 barely changed
(45.32% to 45.45%). On the 36-gap corrected-economy panel, AP fell from 68.87% to
64.13%. Fixed released-CRF smoothing did not materially improve the adapted model.
Thresholds selected on these labels are development diagnostics, not final
held-out performance or calibrated confidence. `native-fit/report.json` and
stage receipts remain on the desktop; the original model remains a baseline.

The subsequent task-definition audit inspected 11 purposively selected
development boundaries across both gold panels, including errors and difficult
successes. Eight labels appeared consistent with the existing policy, two raised
granularity questions, and one contradicted visible continuation. The latter
start was present in the original annotation, not introduced by the converter.
This assistant review is neither independent gold nor a corpus error-rate
estimate. Four sampled false splits were clear model errors under the existing
policy. Shared constituent, cover and authored-item rules were present in all
889 saved economy comparison prompts and 611 desktop authoring prompts; these
are request counts, not independent labels.

The user retained the existing definition and two unresolved granularity labels,
then authorized correcting the single visible continuation error. That one
page-edge start was removed from the three authoritative desktop gold files;
all other labels stayed unchanged. A private correction receipt retains before
and after hashes. Model manifests were regenerated; CPU experiments below use
the corrected gold. The proposed definition change was not adopted.
`native-fit/task-definition-audit/` on the desktop owns the
private sample, contact sheets, review and decision. `audit_doc_split_task.py`
recreates the sample without changing gold or opening the final holdout.

### Compact CPU visual model

The expanded page-and-line experiment uses `prepare_cpu_full_gold.py` and
`train_cpu_full_split.py`. The exporter restores full reviewed page streams and
preserves internal starts as exact source/page/line-ID targets. Page-only gold
does not imply negative internal labels. Existing family partitions are retained;
reserved final families are excluded. Conflicting historical references are
retained as provenance while the authoritative full-stream gold stays unchanged.

Before fitting, `save_private_split_gold.py` reconciles the existing private gold
store: existing full-stream labels remain in their owning records and additional
decisions are stored once per source hash. The training job requires a verified
private-save receipt. It does not copy source PDFs into that store.

Gold discovery uses the existing corpus SQLite tables `gold_records`, `gold_runs`
and `gold_artifacts`, under `page-stream-segmentation/`. Register the private
catalogue with `register_split_gold.py`; `prepare_cpu_full_gold.py` reads its B7
and sparse-reference registrations, and `prepare_structure_split_gold.py` reads
the structure registrations. The latter reuses authored unit `starts_document`
flags from older batches. Archived desktop revisions are indexed separately and
are not extra training examples. The private store retains a portable,
task-only `catalogue.sqlite`, per-source receipts and original source provenance.

The expanded export has 5,162 training page edges (240 starts), 68 internal
starts, 1,729 development edges (109 starts), and 27 development internal starts.
Eight structure-unit starts do not explicitly resolve page-edge versus line
placement, and three page labels conflict with existing direct split reviews;
the ambiguous targets are excluded while their original gold remains preserved.
Reserved final families remain excluded. There are 530 unique PDFs in the gold
catalogue; that is a provenance inventory, not 530 independent positive examples.

The joint model reuses detailed quadrant feature maps for line regions above and
below each candidate, plus page features and geometry. Multiple starts per page
are independent decisions. Separate losses and positive-page oversampling prevent
rare internal starts from being overwhelmed by negative lines. Both heads update
the shared visual encoder on the desktop GPU. New heads first fit frozen visual
features for up to 20 epochs, then the encoder and heads fit jointly for up to
eight epochs, with five-epoch patience in each stage. The transient frozen line
cache uses float16; final inference uses float32. Portable PyTorch sampling is
checked against native CPU ROIAlign because the installed TorchVision build
does not supply its CUDA kernel. `validate_cpu_full_split.py` reloads
the checkpoint independently and scores both tasks on CPU. CPU timings exclude
PDF rendering and candidate-line extraction. The original development seam panel
is reported separately from the expanded panel; thresholds remain development
diagnostics, not final-holdout certification.

`run_full_training.py --root <training-root> --fable <authoring-root>` runs
registration, export, private-gold coverage checks, focused tests, GPU fitting,
CPU validation and fit diagnostics sequentially. Its `--status` option reports
only phase/progress aggregates. Logs and the current checkpoint stay in the
desktop's `cpu-model/full-page-and-line/`; the experiment uses no hosted model
calls. A temporary hidden desktop task keeps the process alive across SSH
disconnects and is removed when the run finishes.

The expanded visual-only run was stopped after ten head epochs and three joint
epochs (938.7 fitting seconds). Its selected checkpoint was head epoch 5:
50.2% page-edge F1 and 2.5% internal-start F1 on the expanded development set.
It did not reach final CPU validation. An inference-only audit found internal F1
69.3% on training versus 2.5% on development; page-presence F1 was 85.2% versus
13.8%. Gold anchors appeared in the top five candidate scores on 97.1% of
training examples versus 29.6% of development examples. The training positives
span only 20 families (68 starts on 55 pages); development has 27 starts across
10 families. The gap persists under page-presence scoring, supporting a severe
generalization failure. These are development diagnostics, not holdout results.
Positive examples are strongly clustered: one archival correspondence/enclosure
packet supplies 28/68 training starts (41%), and four families supply 71%.
Coarse genre metadata also differs: training starts are tagged 30 legislation,
10 transcript, 14 contract, six judgment, six filing and two other; development
has 13 transcript, six contract, six judgment and two other. Genre tags describe
the source container and can obscure its actual contents. The text trainer uses
class- and family-balanced loss, computed over the sampled epoch, to prevent a
large packet's many correlated cuts from dominating the positive class. The
existing family-held-out split is preserved.

`visual_text_split.py` adds a small learned word/bigram/character branch to the
visual model. It consumes raw recognition text around each page edge and raw
OCR line, plus recognition-derived boxes. It uses fixed hashing rather than a
vocabulary fitted to development text. This is a lexical baseline, with no
pretrained language transformer. Neither corrected gold text nor typed gold
units enter its features or proposal generation. Empty OCR text preserves the
visual score. Deployment helpers predict page edges and internal cuts directly
from raw pages, without gold. Text hashing/encoding is included in CPU timing.

`prepare_raw_ocr_split.py` inventories independent extraction artifacts and maps
annotation locations onto existing recognition proposals. It never inserts a
gold line when OCR missed one. Unrepresentable annotated starts remain false
negatives in recall/AP/F1; ambiguous overlapping proposals are masked from
negative training labels. Input/target hashes and coverage are checked before
fitting. Existing cache inventory covers 362 of 522 required sources, leaving
160 sources/940 required pages without raw exports. Of 95 internal starts, 91
map to available raw proposals and four lack raw inputs. That inventory is mostly
native PDF text (6,153 pages), with 339 OCR pages, so it cannot establish OCR-only
performance. The text trainer requires OCR-sourced inputs for the deployment
contract and rejects native/gold substitutions. No text-model fit has run.

```powershell
# Supply actual production OCR exports through an additional source manifest.
& $trainingPython prepare_raw_ocr_split.py --root $trainingRoot --fable $authoringRoot --additional-manifest $rawOcrManifest
& $trainingPython train_visual_text_split.py --root $trainingRoot --sanity-only
& $trainingPython train_visual_text_split.py --root $trainingRoot
& $trainingPython validate_visual_text_split.py --root $trainingRoot
```

The additional manifest has `sources: [{sha256, path}]`; paths resolve relative
to that manifest. Each export contains `extraction.pages` or `pages`, with
physical page index, width/height, `source: "ocr"`, and raw line IDs, text and
boxes in that page image's coordinate system. Wrapped extraction source hashes
must match. Gold files are rejected. The text trainer first runs a bounded
training-subset capacity check, discards those fitted weights, and refuses a
long fit if the check fails. Passing that check does not establish generalization.

`train_cpu_split.py` trains our own boundary model around torchvision's
[MobileNetV3 Small](https://docs.pytorch.org/vision/stable/models/generated/torchvision.models.mobilenet_v3_small.html)
ImageNet initialization. No doc-split-v1 component is part of this inference
pipeline. Whole RGB pages are resized, normalized and spatially pooled to 2x2;
a learned classifier compares adjacent page vectors. Both image weights and
the classifier are adapted. The two-page model has 1,521,569 parameters and a
6.2 MB checkpoint. Training uses the desktop GPU; inference is measured on CPU.

The earlier page-edge-only export had 1,937 training seams, including 128 starts
from 66 families, and 517 development seams including 70 starts. The first compact fit reached 57.5%
best development F1. Its train-best F1 was 96.2% and training AP 98.8%, pointing
to a substantial transfer/generalization gap. These are different thresholds
on train and development, not a claim of calibrated probabilities.

Controlled follow-ups used seed 7319, full-precision CUDA, the same gold, AdamW,
class positive weight sqrt(negatives/positives), frozen BatchNorm statistics,
up to 20 classifier epochs followed by 8 joint epochs, and five-epoch stopping
patience. Checkpoints and thresholds are selected on development F1, then AP.
CPU checks load the saved checkpoint independently and verify full-precision
GPU/CPU predictions (maximum probability discrepancy below 1e-4).

| Variant / private output folder | Page context | Development best F1 | AP | Serial CPU pages/s, one thread |
| --- | ---: | ---: | ---: | ---: |
| `resolution-224` | 2 | 57.3% | 53.0% | 68.0 |
| `resolution-448` | 2 | 58.2% | 39.5% | 30.5 |
| `quadrants-224` | 2 | 61.4% | 57.3% | 28.6 |
| `context-4` | 4 | 56.0% | 43.9% | 65.4 |

The quadrant variant uses the same 1.52M weights: it combines a whole-page view
with four detailed quadrant views through the shared visual encoder. Global
2x2 pooled features and corresponding detailed quadrant features are averaged
with channel/spatial order preserved. No extra labels or text features are used.

For a boundary at physical page p, four-page context is p-2, p-1, p, p+1. Context
comes only from that case's valid sequence; missing outer pages have explicit
masks. The four-page head has 1,816,609 total model parameters. Streaming retains
four encoded pages, uses one page of lookahead and flushes the final boundary.
It never re-encodes pages merely to add context. No context crosses an omitted
document. Independent synthetic tests cover spatial order, full-page retention,
sequence edges, lookahead, last-boundary flushing and omission boundaries.

CPU speed is measured on the desktop Ryzen 5 2600X with saved-page decoding,
resize, normalization, visual encoder and boundary head included. It excludes
PDF rasterization. These are single-seed development comparisons, not held-out
accuracy; neither richer views nor extra context establishes a path to 90%+
on its own. The final 24-seam panel remains unscored.

Artifacts live on the desktop under `$trainingRoot/cpu-model/`, with shared
pretrained weights in its single `upstream/` cache. Named variant directories
retain their model, predictions, report, CPU validation and exact source.

```powershell
& $trainingPython -B -m unittest test_cpu_split
& $trainingPython -B train_cpu_split.py --root $trainingRoot --size 224 --views quadrants --context 2 --output "$trainingRoot/cpu-model/quadrants-224"
& $trainingPython -B validate_cpu_split.py --root $trainingRoot --output "$trainingRoot/cpu-model/quadrants-224"
```

The October 25 first visual fit completed six epochs in 97.4 seconds on the RTX 3080 Ti,
selecting epoch 2 by development loss. All 1,014 development seams were scored:

| Development diagnostic | Stock visual head | Fine-tuned visual head |
| --- | ---: | ---: |
| Loss | 0.7353 | 0.4192 |
| False / missed starts at 0.5 | 133 / 35 | 26 / 66 |
| Precision / recall at 0.5 | 25.7% / 56.8% | 36.6% / 18.5% |
| F1 at 0.5 | 35.4% | 24.6% |
| Best F1 with threshold selected on development | 40.0% | 35.5% |
| Average precision | 31.3% | 32.2% |

This head-only adaptation is **not a demonstrated splitting improvement**:
lower loss mostly traded fewer false cuts for more missed starts. Threshold
selection on development is a diagnostic, not held-out validation or probability
calibration. Establish better quality before optimizing a CPU candidate; the
complete multimodal baseline and adaptation of visual representations remain
separate experiments. No final-panel, whole-packet or within-page result is claimed.

`benchmark_doc_split.py` measured the original visual encoder plus head on eight
prepared images, batch two, one warmup and three measured trials. Median warm
speed was 31.25 pages/s on the desktop RTX 3080 Ti and 0.234 pages/s on its CPU
with **one thread**. The head itself took 2.5 ms per eight-page GPU context.
These timings include runtime input/output transfers but exclude PDF decoding,
rendering, OCR, the text encoder and CRF. They are neither optimized CPU results
nor laptop measurements. Desktop receipts retain every trial and model identity.

### Converter audit and published-code reference

The initial fit does not establish a ceiling for doc-split-v1. Its input windows,
disabled text branch, raw-head scoring and per-window training objective differ
from the released inference recipe. `audit_doc_split.py` checked all 4,063
converted targets against their source gold and 4,592 original-page identities,
with zero mismatches; 32 saved-image preprocessing checks passed. The model fit
16 balanced training seams from 16 families perfectly in 48 updates. The selected
checkpoint's training F1 rose from 42.3% to 75.2% while development F1 fell.
This demonstrates learning and poor transfer, not a broken label-offset mapping.
It does not certify every teacher label's semantics.

Window averaging also unintentionally changes supervision weighting: positives
are 5.08% of training seams but 11.15% of the window-averaged loss. Development
loss is seam-averaged. A future fit must specify its intended sampling, loss and
checkpoint objective explicitly instead of attributing the first result solely
to the visual encoder.

The official [demo source](https://huggingface.co/spaces/nutrientdocs/doc-split-demo)
is retained unchanged in private `upstream-demo/`, revision
`803671733cfa1c1f6591145528e03866242bd5fd`. Its `app.py` hash is
`a6b833909f86d5abb005de48c88fd01c15ecad2fe2a5111b4a0980fb84bd1b65`.
`doc_split_reference.py` compiles its original numerical statements and CRF/beta
helpers directly, excluding UI launch, hosted services and weight downloads.
It does not reimplement those computations. No original training implementation
is published in the model/demo repositories inspected.

`run_doc_split_reference.py` converts the reviewed legal-structure gold into
ordered per-page records: stream identity, zero-based position, physical page,
image, embedded PDF text, boundary and a separate supervision mask. The first
page's forced start is excluded from the loss/score; unknown labels stay unknown.
Attention masks identify real pages, not which labels are known. Within-page
starts remain in their original gold rather than being rounded to page edges.
The runner preserves complete packets (up to 312 pages in this set). It does not
inherit the demo UI's 40-page preview cap.

The published computation uses the saved teacher images and **embedded PDF
text**, not an OCR service. Cached image embeddings are bound to their weights
and assets; every supplied preprocessing tensor is compared to the upstream
expression. The CUDA runner also checks two cached vectors against the actual
image encoder and checks text batch equivalence. Only per-page encoders are
batched; the sequence head sees the full packet.

The first CPU reference evaluated the same 978 known gaps in 18 legal-structure
development packets (996 pages, 981 with embedded text). With the released CRF
and beta calibration, native image+text F1 was 26.8% at 0.5, or 42.4% with a
threshold chosen on development. The matched visual-only control was 26.1% and
44.9%. These are development diagnostics, not final-heldout results or evidence
that the release's confidence calibration transfers to this corpus.

Reference execution now requests CUDA explicitly and fails if GPU model
sessions cannot be created. `--provider cpu` is an explicit comparison arm.
The RTX 3080 Ti reference completed in 43.0 seconds versus 621.6 seconds on
CPU, using cached image embeddings in both runs. This is reference evaluation
time, not end-to-end PDF throughput. GPU verification reproduced cached image
vectors exactly; text batching differed by at most 5.59e-8.
Keep the compatible GPU runtime in the desktop's training environment rather
than silently substituting CPU execution. All converted streams, weights and
results stay on the desktop, with fixed `reference/cpu/` and `reference/cuda/`
receipt directories. The final 24-seam panel remains untouched.

## Checks

```powershell
python -B -m unittest tools.codex_runner.test_calls
python -B -m unittest discover -s experiments/page-stream-segmentation -p test_segmentation.py
python -B experiments/affidavit-association/test_association.py
```

Fixtures are independently invented. Tests exercise the real PDF renderer,
read-only catalogue preparation, bounded/resumed calls with a provider double,
sparse gold, original hashes, family leakage, abstention and a real small CPU fit.

## Luna authoring probe

`luna_blitz.py` reuses the saved public pilot's exact author prompts, schemas and
page images, comparing `gpt-6-luna` medium/high concurrently without another Sol
run:

```powershell
python -B experiments/page-stream-segmentation/luna_blitz.py --workers 16 --seconds 210 --timeout 60
```

The October 24 local probe made 50 calls over 25 windows from 12 source families
in 105 seconds. High matched 132/137 scored Sol labels (split F1 versus Sol
0.935); medium matched 121/137 (0.846). Both had one timeout. Four medium
responses also included visible context pages outside the requested targets;
the quoted medium result discards only those context outputs. The strict
results and raw responses are retained separately. Median call times under
16-way load were 28.4 seconds high and 28.3 medium. These are comparisons with
the saved Sol annotations, not independent accuracy estimates. A visual check
confirmed one high-effort error in certificate/attachment grouping.

Receipts, strict results, context-clipped diagnostics and the inspection are in
private `benchmarks/local-data/page-stream-segmentation/luna-blitz/`. High is the
candidate for a broader trial; this probe does not establish parity with Sol.

The xHigh/max follow-up reused the same frozen requests, completing another 50
calls in 148 seconds at the same concurrency. On the 24 windows shared by all
four arms (137 known gaps), xHigh matched 134 labels (split F1 0.962, median
42.2 seconds) and max matched 135 (0.974, 49.1 seconds). Both corrected the
visually checked certificate-grouping error. Each emitted context-only pages in
two responses under the frozen generic schema; the comparison applies the same
context filtering as the first probe. The new authoring schema closes that
output-range gap. Follow-up receipts and the common-window comparison live in
private `luna-blitz-xhigh-max/` beside the first probe.

Subsequent visual inspection supported Sol on both remaining max disagreements:
one was cover grouping and one missed a new document. Max is the closest Luna
arm on this sample; segmentation quality is the model-selection criterion.
The page evidence and saved model responses are retained privately in
`max-disagreements-reviewed.json` with the follow-up results.

The revised constituent prompt was then tested with four original page images
per decision on a frozen 100-case holdout: 80 existing-gold edges balanced 40/40,
plus 20 medical edges visually labeled before the calls. The panel covered 64
previously unused source families and excluded exact focal image pairs seen in
earlier probes. All 200 calls completed at 64 workers with no retries.

| Arm | Matches to frozen references | Fresh medical references | Uncertain |
| --- | --- | --- | --- |
| Luna max | 85/100 | 17/20 | 0 |
| Sol low | 85/100 | 16/20 | 0 |

The arms agreed on 94/100 cases. Subsequent visual review of all 18 disputed
edges found nine existing-reference conflicts with the requested segmentation
and cover conventions, and one unresolved cover/multiple-documents case.
The review confirmed seven Luna errors and five Sol errors, including shared
misses between distinct signed clinical notes. Luna also missed a named nested
attachment and a separately signed approval, and split two covers from their
bodies. Sol missed the transition from an archival checklist to a reproduced
source. These are counts from selective post-run adjudication, not independent
revised accuracy estimates; the other 82 edges were not re-adjudicated.

This supports Luna max as comparable to Sol low for this page-edge task with
the same review requirements. Neither meets the zero-wrong-accepted-label gate.
The frozen comparison, public provenance, reviewed gold, adjudication and
regeneration notes live in private `holdout-100/`. The 33 visually accepted
edges are also saved in the existing per-source annotation directories;
within-page seam localization remains untested by this output format.

A subsequent Luna-max diagnostic froze nine reviewed challenge edges, seven
correct controls and one unresolved edge across 13 source families. It compared
fresh identical repetitions, four versus up to eight original images, a task
clarification, and two alternative reading checks. The 115 unique calls all
completed; clamped identical contexts were reused. Against the 16 scored edges,
the saved four-page baseline matched 9, the wider original prompt 10, the
clarified four-page prompt 15, and the clarified wider prompt 16. All seven
correct controls stayed correct in these conditions. Four supplemental calls
repeated the attachment result: the clarified four-image request matched 0/3
trials, while the same clarified task with all six source pages matched 3/3.
These are tuned diagnostic results, not fresh holdout certification.

The three-seat identical-prompt council exposed 2/7 baseline errors; substituting
object-identity and content-flow checks exposed 1/7. At the user's request, a
deliberately aggressive "Ridiculous Oversplitter" then made 17 additional calls
on the same four-image inputs. It proposed 15 splits among 16 scored edges:
all ten real splits and five false positives. It exposed all five splits missed
by the normal baseline, while creating three additional disputes on correct
cases. A baseline/content-flow/oversplitter council exposed 6/7 baseline errors
and still unanimously accepted one wrong answer. Oversplitter outputs are
candidate flags; none were promoted to gold. All requests and comparisons are
retained in private `luna-variation/`, including its regeneration instructions.

An independent Sol 6.1 max subagent subsequently authored 24 further page-edge
labels across eight unused source families, balanced 12 splits/12 continuations.
Using the clarified task and up to eight original page images, a fresh Luna-max
normal author matched 24/24 labels. The Oversplitter matched 20/24 and raised four
disputes, all false alarms. All 20 agreements matched the references on this panel.

The complete pipeline—clarified Luna max, aggressive candidate flags, and
automatic-context Sol 6.1 low adjudication only on disputes—matched **24/24 fresh
seams**: 12/12 splits and 12/12 continuations, with no unresolved answers. Twenty
seams passed by agreement; four were adjudicated. Normal Luna alone also matched
24/24. Substituting either the blind Luna judge or automatic-context Luna judge
gave 23/24. This small panel does not demonstrate an improvement from the council
over the clarified author alone. The judge-only figures below are component
diagnostics, not complete-pipeline accuracy.

All four disputes, two agreement audits selected without gold labels, and the
earlier shared cover/body error then received independent judge calls. Sol max
supplied gold only; the judges were Luna max and Sol 6.1 low. Every judge received
the same clarified task, without model identities or vote counts. References
contained a selected verbatim intent excerpt and four previous reviewed examples
with original page images from separate source families.

| Judge condition | Six fresh cases | Old cover/body regression |
| --- | --- | --- |
| Luna max, no references | 5/6 | 1/1 |
| Luna max, automatic references | 5/6 | 0/1 |
| Luna max, optional reference tool | 6/6 | 1/1 |
| Sol 6.1 low, automatic references | 6/6 | 1/1 |

The optional-tool arm made zero reference reads, so its result does not establish
a benefit from reading the references. Visual inspection supported the gold on
both fresh judge errors: each wrongly split a cover from the body it introduces.
Automatic context had a lower observed score here; these single calls do not
establish a causal effect. Wrong responses did not report uncertainty.

A further ten calls checked automatic-context judging on all five previously
missed true splits: a named attachment, three separate clinical notes, and a
separately executed approval across three source families. Both Luna max and Sol
6.1 low matched 5/5. These are regressions used during prompt development, not
fresh holdout accuracy. All 86 calls in this comparison completed. No outputs were
promoted to gold. Private `council-adjudication/` retains the frozen requests,
responses and comparison; its `analyze.py` verifies the retained calls and
regenerates the comparison without model calls. Whole-packet and within-page
quality remain separate acceptance checks.
