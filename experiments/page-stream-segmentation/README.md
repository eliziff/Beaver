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
