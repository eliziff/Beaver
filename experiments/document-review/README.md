# Document review from real litigation records

An experiment for lawyer-facing document-review tools, using the existing
affidavit-association and chronology sources and their reviewed SHA/page maps.
It evaluates designations separately from useful filenames and review entries.
It changes no production application code or existing source gold.

Code, briefs and research live here. Documents, native authoring files, labels
and run receipts live in the private checkout at
`benchmarks/local-data/document-review/`. Public originals stay in the shared
OpenLegalData corpus. Complete filed exhibits are the review units; no new PDF
extraction or document-boundary detector is introduced. Candidate text is read
from the actual supplied PDF by our `legalpdf-read` executable.

On this workstation, the private directory is stored at
`E:\OpenLegalData\benchmarks\document-review`, with a directory junction at the
repository-relative path above. This keeps existing receipts and commands usable
without changing the location of the shared source corpus. Private authoring
helpers import the experiment code through the documented `PYTHONPATH`; they do
not infer the checkout location from the data directory.

## Collection

`sets.json` and `sets-batch-2.json` fix twenty proceedings and focused client instructions. The sizes are
**Level-3 total files**, including deliberate copies and bundles.

| Matter | Files |
| --- | ---: |
| Sears defence payments and remaining funding | 50 |
| Air Passenger Rights and the Agency voucher statement | 75 |
| Lynx Air airport improvement fees | 100 |
| Federal prison population and COVID-19 | 125 |
| NCCC participation in First Nations child-welfare reform | 150 |
| Chlorpyrifos cancellation and phase-out | 200 |
| Waterloo encampment accommodation | 250 |
| Bill 7 long-term care placement and consent | 300 |
| CHL hazing and league knowledge | 400 |
| Canacol supply contracts and restructuring | 500 |
| Commercial landlord rent receipts and operating costs | 50 |
| Homeowner roof installation and repairs | 75 |
| Individual vehicle purchase and repossession | 100 |
| Small contractor progress payments and holdback | 125 |
| Bicycle shop proposal and asset sale | 150 |
| Transport operator reporting and receivership | 200 |
| Executors and estate property | 250 |
| Individual employment accommodation | 300 |
| Consumer marketing text and consent | 400 |
| Fuel stop, convenience store and insolvency | 500 |

Target total: 4,300 files, before counting them again in nested levels. Intake currently
excludes complete exhibits above 24,000 characters and records without usable
text/source mappings. This is a selection limit, not long-document coverage.

- Level 1 contains up to sixteen complete files from one actual filing. Labels
  depend on the focused brief; being an exhibit does not establish relevance.
- Level 2 retains those files and adds up to eight distinct files from other
  filings in the same litigation. Holding back same-filing files is not a fallback.
- Level 3 retains Level 2 and adds unrelated litigation, actual photographs and
  invoices, case-specific invented records, three byte-identical copies, good/poor
  scan pairs from both origins, and two bundles containing complete copies.

Some filings are smaller than sixteen units. Invalid original-page mappings are
reported and excluded from the unrelated pool; page ranges are never guessed.

## Authoring the fictional records

The private `authorship/source-stories.json` and `histories/` fixtures contain
case-specific records bound to genuine underlying documents. They cover personal and family communications, prison health
and visits, care placement, farming, encampment access, sports reports, travel,
and commercial records. No review labels are supplied to the writer.

Authorship follows the people and setting of the matter. A legal team may be an
external firm, co-counsel across firms, an in-house team, or a combination. Do not
turn every matter into internal corporate correspondence. Give the writers their
own clients, relationships, working habits and purposes; a uniform office story
with renamed participants is insufficient.

OrgSmith's `Fact`, `DocIR`, native Word/email renderers and quoted-history helper
provide the source files. Spreadsheets use its installed XlsxWriter dependency
with actual formulas and cached totals. Complete authored DocIR, worlds and seeds
stay private; public generator code must not disclose held-out prose or enable
reconstruction of its names and numbers. Email attachments contain the exact
standalone native bytes. LibreOffice prints the native files for review. OrgSmith
is retained once at upstream revision
`744091396941fa1593af6b0b86b747786896fd42`, including its license and source markers.

Each packet includes a genuine underlying record, an operational record, a
confidential client question with complete attachments, the lawyer's reply,
ordinary lawyer administration and a personal control. Some contain spreadsheets,
corrected records, unrelated advice requests, or an actual forwarded reply to
jointly retained co-counsel. Attachments contain the exact standalone native bytes;
their complete print views are also embedded in the review PDF. Scheduling and
business messages provide nonprivileged lawyer controls. A confidential copy
must identify its actual recipient and preserve the forwarded message's headers.
Original failed histories and test packets remain available as baselines.

`check_native.py` verifies actual attachments, thread references, spreadsheet
totals and changed version facts. Directly authored fixtures are the normal
production path. Codex exec is reserved for bounded reference review, judging
and adversarial inspection; it is not required to author these records.

Archived native files deliberately retain synthetic provenance. Candidate copies
use a common PDF export: real and invented sources are rasterized alike, XMP is
removed, and fictional export metadata is assigned independently of origin and
designation. Reviewed source stamp/folio masks are replayed where supplied.
Augraphy adds copier damage to both origins. Windows input-file timestamps are
normalized and exports are independent copies, so hard-link counts cannot reveal
membership in a real-only lower level. File IDs use HMAC with a private random
seed; ordering uses private seeds too. Public code and set names cannot reconstruct
the origin from creation ordinals. Fake export dates are never authoritative
document dates. A filesystem evaluator must mount only the chosen level; exposing
sibling levels would disclose which records belong to the real-only core.

The evaluated lane currently supplies PDF review copies. Native EML/Word/Excel
sources are retained for inspection and regeneration. A mixed native-file lane
would need authentic native controls before claiming that extension or ZIP/MIME
structure cannot reveal origin.

## Decisions and scores

Relevance is `relevant`, `irrelevant` or `uncertain`. Privilege is independently
`none`, `withhold`, `redact` or `uncertain`. Each brief identifies the client,
participant roles and a stipulated privilege protocol. Public filing text does
not become a sound positive withholding example because it mentions a lawyer.
An irrelevant file can be privileged; a legal scheduling message can be unprotected.

Each output also includes a meaningful date at supported precision or null,
a useful filename stem, a one-sentence description, a concise plain-language
reason for both decisions, and supporting passages or page references.

1. Designation score: mean relevance and privilege macro-F1, scaled to 100.
   Report joint accuracy, relevance precision/recall, protected-file release
   errors, coverage, missing decisions and family-balanced accuracy alongside it.
   Missing files are errors; duplicate or foreign prediction IDs invalidate a run.
2. Review-entry quality: independent 0/1/2 judgments for date, title, description
   and explanation, scaled to 100. Accept accurate alternative wording. Wrong
   designations cap explanation credit. Keep the judgments for review; human
   calibration is needed before treating model rubric scores as definitive.

Report the class supports with each score. Public-only lower levels may have no
positive privilege examples; a high privilege score there measures avoidance of
false withholding, not successful detection of protected communications. If one
gold axis is uncertain, the other axis's established decision still counts.

Average equally over proceedings, separately for each level. Levels are paired
conditions. Resample whole matters for uncertainty, and keep document families,
substantive versions and shared distractors together in any later dataset split.

`review_models.py` keeps source-author and reviewer calls independent. References
see source text, complete page images and the existing filed-unit identification;
candidates receive observed parser text and their supplied images. Exact copies
inherit their parent; scan inheritance still requires legibility acceptance.
`reconcile` checks model agreement and flags conflicts with independently curated
source dates, including when both models agree on the same poor OCR reading.
Source-supported overrides live in an inventory-bound private `adjudications.json`.
Plain bundles retain supported component dates as alternatives; naming a bundle
with either meaningful component date does not by itself make the entry wrong.
Agreement between models is qualified, not represented as human certification.
The quality judge sees complete source pages and the actual candidate-supplied
text, so a genuine OCR defect is distinguishable from an invented caveat.

Candidate and quality runs take `--level 1`, `2` or `3` (default 3). Higher-level
documents are excluded from the model context and scoring denominator. These
bounded calls provide a text/image baseline. A lawyer-tool agent can instead
consume the selected level's actual file packet and return the same entry schema.
The corpus audit and origin tests remain separate from its designation score.

## Blind origin checks

`blindbox.py` runs a fresh Codex session with every supplied page image, observed
Legal PDF Parser text and export/filesystem metadata. Tools, network, web, apps,
plugins, memories and delegation are disabled. No Docker is needed. The model
receives anonymous IDs and no origins, truth, authoring ledger or source paths.
This is a packet diagnostic; it does not count as a filesystem agent test. The
earlier filesystem runs and their image recipe are retained for reproducibility.

Keep named development and held-out arms with their actual packets, predictions,
event transcripts, input/prompt/schema hashes, image identity, usage and tool
counts. A response without recorded filesystem inspection is not an agent test.
`--partition held_out` registers the split before execution and rejects previously
exposed source/version/component families and complete authored histories. A new
render of the same history cannot become a fresh holdout. This is a family check; template and
whole-proceeding separation still require a deliberate split. Repeated development
runs do not satisfy the audit's held-out gate.
Report accuracy, rank discrimination, Brier score and uncertainty; chance on a
small sample is not proof that origins are indistinguishable.
Collection packets contain related histories and matched pairs, so the harness
does not attach naive document-level intervals or binomial tests to them.

Measured failures drive changes. The first metadata-only diagnostic identified
28/30 origins from size differences. Common raster export reduced a later small
metadata diagnostic to 17/34. The original content-only sample remained 34/34.
The native-history filesystem pilot identified **24/24**, after inspecting all
27 page images. Both complete Sears tests identified **50/50**, including after
source-informed content repairs. The current fully authored records fail the
origin gate. A separate paired source-transformation diagnostic yielded 12/24
correct decisions, with important scope limits. See [RESULTS.md](RESULTS.md).

## Running it

Use the existing OrgSmith checkout/dependencies, LibreOffice and our canonical
`legalpdf-read` binary. `LEGALPDF_READ` and the PDF parser runtime paths govern
extraction; no Rust/addon/frontend rebuild is needed.

```powershell
python experiments/document-review/benchmark.py intake
python experiments/document-review/check_native.py
python experiments/document-review/prepare.py
python -m unittest discover -s experiments/document-review -p 'test_*.py' -v

python experiments/document-review/blindbox.py prepare --name repair --sets air-passengers prisons --pairs 12
python experiments/document-review/blindbox.py run --name repair

python experiments/document-review/review_models.py author --sets sears --effort medium --max-calls 14
python experiments/document-review/review_models.py reviewer --sets sears --model gpt-6-astra --effort medium --max-calls 14
python experiments/document-review/review_models.py reconcile --sets sears
python experiments/document-review/review_models.py candidate --sets sears --level 3 --effort medium --max-calls 4
python experiments/document-review/audit.py
python experiments/document-review/benchmark.py report
```

For deliberate native re-authoring, add `experiments/document-review` to
`PYTHONPATH` and run the private `authorship/build_source_stories.py` and
`authorship/source_packets.py`. Additional complete files from the same cases
are acquired with the shared corpus store by `authorship/extend_litigation.py`;
their captions and case identities must be checked before use. Source-bound
communications attach the actual underlying native bytes. The frozen worlds,
authored DocIR and native bytes remain the authoritative inputs; do not recreate
a held-out test by guessing its source from a public template. Normal preparation
consumes the existing private native manifests.

The unrelated source pool is frozen in `sourcing/outside-pool.json`, with its
source inventory hashes. Preparation does not change membership based on which
PDFs happen to be cached. Invalid existing source page mappings are excluded and
recorded; physical pages are never guessed. The 31 additional complete case
files have SHA-bound caption/case checks in `sourcing/case-verification.json`.

The `author` command proposes reference answers; it does not author documents.
The user authorized public filing excerpts to the signed-in OpenAI Codex service
for these benchmark runs. No API key is needed. Ordinary model calls use the
existing `tools/codex_runner`. All submissions and receipts declare
`machine_test` with a run ID. Prompts are in `prompts/` and `brief()`.

Submissions use `{"documents": [...]}`. Scoring accepted full-set gold:

```powershell
python experiments/document-review/benchmark.py score <gold.json> <submission.json> --level 3
python experiments/document-review/review_models.py quality --sets sears --level 3 --predictions <submission.json> --model gpt-6-astra --effort medium --max-calls 16
```

Unaccepted gold is rejected unless explicitly requested as a provisional
diagnostic. `audit-latest.json` separates structural errors from unfinished source
review, scan legibility and origin tests. It does not turn those gaps into a
benchmark score. Public-source contamination and the limited ten-matter sample
remain qualifications even when automated checks pass. Research and sources are
in `RESEARCH.md`.

`report` writes the latest private `development-results.json`. It keeps every
registered matter in the denominator and leaves suite averages unset until all
ten have current results. Quality judgments must match the current gold,
submission and rubric hashes. The report does not certify corpus readiness.
