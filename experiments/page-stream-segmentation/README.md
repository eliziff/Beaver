# Page-stream segmentation

Prepare reusable original-page gold for splitting PDF packets, then measure a
small tier-1 model. This is an experiment; it does not change parser decisions.
Original PDFs stay in the shared OpenLegalData corpus. All manifests, images,
annotations, requests and model artifacts belong in ignored
`benchmarks/local-data/page-stream-segmentation/`.

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

Partial review uses smaller scopes with the same three fields. Additional gold
uses `{"sources":[...parts...]}`; provenance and disagreements live in a separate
receipt. No titles, classes, extracted text, segment IDs or end pages are needed.
The format works for exhibits, medical records and other original PDFs.

A certificate/cover stays with the following constituent. Headings, dates and
page-number restarts alone are not document boundaries. An exhibit can contain
several documents. Within-page starts need existing span gold, not a rounded
page start. Existing v4 `units[].starts_document` remains its own authority.

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

The annotation command stages six-gap windows with context on both sides and
original page images. `annotations/<sha>/plan.json` locates each exact request.
Each new request's schema enumerates its permitted physical page numbers, so
visible context pages cannot be emitted as target labels. Array order and
duplicate entries are normalized without another model call.
`--sources SHA...` selects originals; `--limit` bounds sources and `--windows`
bounds new windows across them. It defaults to preparation only.

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
