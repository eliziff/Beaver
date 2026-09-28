# Printed pagination validation

## Single-parser candidate and reporter hypothesis (2026-09-28)

The expanded sample contains 268 hash-verified Canadian publisher originals,
10,299 physical pages, from 1970 through 2023. It remains SCC/SCR/RCS-heavy; it does not
meet the requested 350-original target or establish other reporter-family coverage.
The separate 105-document, 22-court general-judgment cohort is not included in
this denominator. Acquisition stopped at a renewed SCC publisher challenge.

The hypothesis tested is **the submitted citation's reporter start belongs to
physical PDF page 1**, not a detector-selected anchor. Sampling is independent
of predictions: page 1 and up to two distinct later pages selected from the
source hash. Blind text-layer readings come first. Only unresolved images go
to the existing Luna max/schema harness, one batch at a time.

Across 770 sampled pages, 767 readable folios agreed. All sampled folios agreed
for 267 documents. The remaining publisher original, Bhasin v. Hrynew
([2014] 3 SCR 494), is a judgment-format PDF without reporter folios; its three
samples were absent, not successful predictions. One apparent disagreement
was a damaged text mapping (visible `74`, extracted `7` plus a soft hyphen);
blind image review resolved it. The text reader now leaves such format-character
lines unresolved. These are independent readings with exception review, not a
claim of error-free gold or fresh held-out product accuracy. Citation metadata
alone does not identify which PDF edition was downloaded.

Candidate native geometry matched the frozen released output on 100 unique
PDFs / 4,452 pages, including all physical pages and paragraph 1. A separate
restore-only process matched again without supplying PDF bytes to the native
geometry API. Pagination metadata now comes from the same lopdf load; geometry
uses retained pre-structure evidence. These checks do not count PDF writing as
parsing for pagination.

A real three-page scan ([1975] 2 RCS 233) exercised native preparation,
recognition of page 1, expansion to pages 1+3, and a new selection of cached
page 3. The extraction cache content stayed identical; recognition entries
increased from one to two and then stayed at two. The opening-page text and
geometry were stable (coordinates compared to 1e-6 PDF units because JSON
round trips can change the last floating-point bit). Times were 11 ms, 1,427 ms,
998 ms and 8 ms respectively. This proves reuse for that path, not OCR accuracy
across the whole corpus.

A genuinely empty-cache, no-OCR production pagination run of 100 PDFs took
59.4 seconds (median 51 ms, p95 2,392 ms). A fresh-process reopen took 2.3 seconds
(median 12.9 ms, p95 62.9 ms). Cold sampled RSS at ten-document checkpoints
peaked at 338 MiB; this is not a measured instantaneous peak. Native preparation
is included. Phase profiling remains necessary before calling cold performance
acceptable. Profiling subsequently attributed 17.0 seconds of the ten slowest
PDFs to cache writing. Buffering JSON token writes before the existing gzip
compressor reduced that to 1.36 seconds, without whole-document JSON buffers.
The follow-up 100-PDF cold run took 29.4 seconds (median 32.7 ms, p95 1,157 ms);
fresh-process reopen took 2.9 seconds. All 100 binding outputs were identical.
Cold RSS peaked at 355 MiB at the ten-document sampling points. This follow-up
used the diagnostics build with phase logging disabled. The final default-feature
production binary then completed the same 100-PDF cold operation in 25.4 seconds
(median 34.1 ms, p95 999.3 ms); fresh-process reopen took 2.3 seconds
(median 12.3 ms, p95 62.2 ms). All cold/reopen bindings matched, with no errors.
Cold RSS peaked at 378 MiB at ten-document checkpoints, not an instantaneous
peak measurement. Only 53 documents received labels without OCR; speed is not coverage.
Receipts live under ignored `tmp/pdf-pagination/`: `canadian-reporter-expanded*`,
`geometry-{baseline,candidate,reopen}.json`, `partial-ocr-candidate2-check.json`,
`canadian-product-single-parser-stage2-{cold,reopen}.json`, and
`canadian-product-single-parser-buffered-{cold,reopen}.json`, and
`canadian-product-production-final-{cold,reopen}.json`.

The full Authorities-operation run (182 originals) initially matched 176 independent
pinpoint destinations and abstained on six. Reviewing the failures found four
readable headers missed by the margin adapter's physical-page window. The shared
adapter now also considers the outermost text rows, preserving the known-reporter,
side-edge and citation-veto checks. A complete cache-backed replay matched 180/182,
with no incorrect destinations: display, selected physical page and generated
highlight agreed with the saved independent folio, and restoring the prepared
profile preserved recognition coverage. This is a regression replay on inspected
data, not fresh held-out validation.

The two remaining abstentions are Bhasin's non-reporter PDF and [1987] 2 SCR 485,
whose OCR omits the opening folio. Neither is silently assigned citation-derived
labels. A separate application optimization skips recognition preparation when
none of the requested pages still needs OCR. The initial operation run took
256.2 seconds including recognition; the cache-backed replay took 42.5 seconds.
These are different cache conditions and are not a direct speedup measurement.
Receipts: `product-stage3/`, `product-stage4-review/`, `product-stage5-review/`,
and `product-stage5/` under the ignored output directory.

Two subsequently acquired originals, Blacklaws ([2013] 1 SCR 403) and Krause
([1986] 2 SCR 466), also matched independent pinpoint destinations through the
product operation. Blacklaws used its text layer; Krause required three blind
image readings (12.86 seconds for the Luna batch). Combined receipts now cover
184 originals: 182 correct destinations and the same two abstentions, with no
incorrect destinations. These additional operation timings include existing
cache conditions and are not cold benchmarks. Receipts: `product-stage6/` and
`browser-acquired-manifest.json`.

A further browser-downloaded original, R. v. Jones ([1994] 2 SCR 229),
passed the same independent and product checks. Its 70-page scan needed three
blind image readings (12.4 seconds); the product recognized only physical pages
1 and 66, correctly resolving printed page 294 to page 66 for display,
navigation and the generated highlight. Combined product receipts now cover
185 originals: 183 correct destinations, two abstentions, no incorrect
destinations. Receipts: `browser-jones-manifest.json`, `product-stage7/`, and
`limited/browser-jones-vision.resources.json`. The publisher Worker still
returned a challenge on recheck; only the verified browser-saved PDF was added.



A subsequent production-Worker batch acquired ten more originals before the
publisher challenge returned. All ten passed the independent and product checks,
bringing the total to 195 originals: 193 correct product destinations and the same
two abstentions. The new sample spans 1975?2015; it still adds no other reporter
family. Text resolved 12 sampled pages; only the remaining 18 went to blind vision
(49.8 seconds including rendering and harness overhead, sampled peak 429 MiB).
The ten-document product operation took 16.7 seconds including selective OCR;
its sampled process-tree peak was 826 MiB. All five scans recognized only their
opening and pinpoint pages. These are operation receipts, not a new cold/reopen
benchmark. `stage8-manifest.json`, `product-stage8/`, and `limited/stage8-vision*`
record the inputs and results. `acquire-stage9.log` records the subsequent
single challenged attempt and host stop.

The next two acquisition batches added 73 originals (2,501 pages). All 214
independently sampled folios agreed with the submitted reporter start on physical
page 1. Text-first inspection left 109 images for the blind vision harness;
those sequential batches took 242 seconds, including rendering and harness
overhead, with a sampled process-tree peak of 651 MiB. The 73 product checks
resolved 72 correct destinations and abstained once, bringing the aggregate to
265 correct destinations, three abstentions and no incorrect destinations.
The new abstention is [1975] 1 SCR 411: retained OCR merged its opening folio
into the header as `CO.4 1 1`. Existing normalization only repairs a spaced
folio when it stands alone; the conservative result remains unresolved.
The eight sequential product batches took 121.3 seconds including selective
recognition and existing-cache reuse, with a sampled peak of 808 MiB. This is
not an empty-cache timing. Receipts: `stage10-manifest.json`, `product-stage10/`,
and `limited/{stage10-vision,product-stage10-*}`. A subsequent bounded acquisition
attempt encountered the publisher challenge immediately and stopped that host;
82 more originals remain necessary to reach 350. Reporter-family coverage has
not broadened beyond SCC/SCR/RCS.

The embedded Beaver manual-book workflow passed with source replacement,
export, save/reopen and 320-pixel layout checks. A separate real reporter PDF
check navigated printed page 349 to physical page 3 and repeated it after
refresh and reopening the saved source. Screenshots exposed mobile header and
source-button clipping, fixed using the existing responsive layout. Receipts:
`browser-beaver-manual-final/beaver/20260928T082829941065Z/` and
`browser-beaver-reporter-reopen/beaver/20260928T082909492518Z/`.
The rebuilt downloadable full HTML also passed both workflows, including the
inspected 320-pixel screenshot (`browser-standalone-mobile-final-file/` and
`browser-standalone-mobile-reporter-file/`). Its SHA-256 is
`dba715cfc2252401b3f0fb3b7b5078437e0fe8378f3d73b5921c1120a4dd9a90`.
An initial localhost-hosted run was rejected by the publisher Worker's origin
allowlist; these passing checks use the supported downloadable-file origin.
Lite built from Helper `d222fa4636f1e4d066e5a4b8d5973170873f70c9`, pinning
Beaver `4f39c855faf223247be197a7e579a14c57973235`, passed printed navigation,
highlight editing, annotated export, viewer reopen and real PDF-worker checks
with the same reporter original (`lite-browser-final-pin.log`). The tested HTML
SHA-256 is `8b6c1780b5e785d97f66e1af0d74618b260f698cae2e383406de1d06da470c7c`.
These artifact checks do not close the outstanding corpus or automatic-acquisition
release gates.

The live standalone Des Groseillers import retrieved the hash-matching original
automatically, displayed no recovery notice, and preserved the authority after
replacement upload; printed 349 navigated to physical page 3 (`recovery-live/`).
The broader automatic run subsequently retrieved Grant, Oakes, Ahluwalia and
Jordan originals plus the expected Neufeld reconstruction. It generated the book
and the inspected Grant paragraph-29 margin mark. The old harness incorrectly
excluded that legitimate 228-point-tall mark with a 100-point height ceiling;
the check now verifies narrow margin geometry beside the paragraph label.
Standalone response timing and refresh observation now follow the worker bridge,
and the workflow check handles the actual recognition and replacement-review
steps. This is partial gate evidence (`browser-automatic-refresh-observation/`
and `browser-automatic-final-gate/`), not a passing complete run: the next run
encountered unavailable publisher originals (`browser-automatic-replacement-flow/`).

The subsequent automatic run reached profile builds after source replacement,
but exposed unconditional OCR-model initialization under the `full` policy,
even for already readable PDFs. The shared operation now inspects retained
evidence first and initializes recognition only when unread pages remain. This
also fixes the opposite case: a saved partial OCR profile no longer bypasses
the remaining pages when whole-PDF recognition is requested. Seven focused
checks and the backend build pass. A real three-page scan expanded its retained
page-1 recognition to all three pages and preserved the text on reopen in five
seconds (sampled process-tree peak 683 MiB; `full-policy-check.json`). The rebuilt
full HTML (`standalone-full-policy/authorities.html`) has SHA-256
`10f1b079eb8d169e146c4e1475a4feb6045f114cbbd498d8553be997bcc8f0df`;
the repeated automatic run passed the initial book and the Alberta profile
builds, then stopped on a genuinely scanned Oakes PDF under the Federal Court
profile's full-recognition policy (`browser-automatic-full-policy/`). The HTML
does not include the native OCR runtime. Its user-facing recognition options
and profile defaults still need to account for that capability before the
complete gate can be claimed. No model or recognition capability was added by
this shared-operation fix.

## Decisia PDF route check (2026-09-27)

`publisherPdfCandidate` in `backend/src/lib/legalSourcePresentation.ts` derives an
opportunistic `/1/document.do` URL from an approved Decisia case URL. It never
proves that a PDF exists. The downloader validates the response and falls back to
the case page's actual download control on an ordinary 404.

`publisher-cached.py` joins independently stored A2AJ case URLs to 114 cached
original SCC PDF receipts; `publisher-cached.mjs` checks that the primitive
derives each receipt URL and that all 114 files still match their hashes and parse
as PDFs. Result: 114/114 URL matches and 114/114 valid cached originals.

`publisher-candidates.py` selected three cases per each of 16 Decisia hosts
deterministically from the installed Canadian A2AJ inventory. After a user
completed Norma's CAPTCHA, `publisher-rule.mjs --after-clearance` made sequential
requests. Of 48 cases, 24 were valid PDFs with publisher controls matching the
derived URLs, five derived URLs returned 404, seven encountered the renewed
challenge, and 12 were skipped after a host challenge. This is a sample, not a
success rate for the whole inventory. The live run's extra HTML control request
per PDF contributed to the challenge returning; the production direct path
does not make that extra request after a valid PDF.

The five 404s were investigated individually in `tmp/pdf-pagination/404-investigation/`.
Three Competition Tribunal case URLs from A2AJ themselves return JSON 404;
eight further Tribunal `cdo` source URLs from 2012, 2021 and 2026 did too,
while the Tribunal navigation page still loaded. This implicates stale or
unavailable source routes, not a different PDF suffix. Two older federal case
pages load (2005 FCA 226 and 2004 CF 1217), but their `/1/document.do`
URLs return 404 and the deployed Worker reports no PDF control. The user
opened both case pages in the browser and confirmed neither offers a PDF.
These cases must never be counted as formula successes or treated as proof
that every Decisia case has a PDF.

For no-PDF detection, an additional deterministic sample of 12 pre-2007 FC/FCA
cases was checked live. Eleven derived PDF URLs returned 404, while the
corresponding inner judgment pages returned HTTP 200 with an explicitly empty
`div.documents` control. The twelfth returned a PDF. The two browser-confirmed
no-PDF cases had the same empty control; a positive FCA control contained the
published PDF anchor. A direct PDF 404 alone is insufficient: the outer case
page must be checked before its inner page. One Tribunal case returned outer
404 but its inner page challenged, so probing the inner page alone would
incorrectly present a CAPTCHA workflow for an unavailable case URL.

## Cross-court original PDF folios (2026-09-28)

The Canadian general-judgment sample contains 77 SHA-256-verified Decisia
originals across 19 court codes (2,318 physical pages), plus 4 Alberta Court of
Appeal, 12 Manitoba Court of Appeal and 12 Manitoba Court of King's Bench direct
official originals (748 pages). Source URLs, bytes, hashes and page counts are in
`tmp/pdf-pagination/canadian-diverse-originals/` and
`tmp/pdf-pagination/canadian-direct-originals/`. These 105 form a separate evaluation
cohort from the reporter-offset sample. Together with 130 SCC reporter originals and one
overlap, the local Canadian corpus has 234 unique originals across 22 court codes.

The Decisia acquisition manifest also retains 85 no-published-PDF outcomes, 13
actual validation-form CAPTCHA challenges and 16 cases skipped after a host
challenge. A blocked case-content iframe is not evidence of no PDF. A controlled
production check on SCC item 14385 returns the exact publisher verification
iframe instead of silently recording no PDF. The isolated browser at the same
URL showed only a generic 403, so clearance could not be performed unattended.

`assess-diverse.py` verifies each hash and reads only standalone numeric text
lines in page margins, with no citation, product prediction, OCR or model input.
It samples PDF page 1 and two hash-seeded later pages, and scans all pages for
repeated numeric folios. Of 228 Decisia sampled pages, 48 were readable and 180
were not; 17 documents had at least two consistent offset readings, two had
conflicting offsets, nine had one reading and 49 had none. Of 82 direct-official
sampled pages, six were readable and 76 were not. Missing text-layer folios are
pending visual review, not evidence that printed folios are absent.

The two offset-conflicting documents are composite CITT decisions:
[1991 source](https://decisions.citt-tcce.gc.ca/citt-tcce/c/en/item/352139/index.do)
prints `- 2 -` on physical pages 4 and 6, and
[1999 source](https://decisions.citt-tcce.gc.ca/citt-tcce/a/en/item/353427/index.do)
prints `- 2 -` on physical pages 2 and 4. A CIRB original also repeats a numeric
folio. These are real reasons to keep the physical PDF page visible and require
the user to choose when a printed label is repeated.

With OCR and layout disabled and `reporterOriginal=false`, the production
pagination operation processed all 105 general originals. It matched all 54
independently readable sampled folios, made no contradictory prediction and left
256 samples unscored by the independent text rule. It detected all three
repeated-label groups in the Decisia set and returned zero unsafe unique
destinations. Receipts are `production-non-ocr-candidate6.json` in the Decisia
folder and `production-non-ocr-candidate1.json` in the direct-original folder.
This is same-corpus regression evidence, not a held-out accuracy estimate.

The rebuilt Beaver and standalone Authorities browser views also passed a live
navigation check on the original five-page *Des Groseillers v. Quebec* PDF
(SHA-256 `74d903bab11d2b1de8843c27e34dd3ddfa3bb1e892b4bdff5bb424a4efde5d90`).
Entering printed page `349` landed on physical PDF page `3 of 5`; the rendered
page itself shows folio `349`. Both browser receipts and screenshots are under
`tmp/pdf-pagination/browser/real-reporter-ui/`. This verifies the visible
interaction for one independently read original; the corpus results above
measure the wider binding behavior.

The single-parse candidate repeated that check with the final production native
module and rebuilt full standalone WASI HTML. The standalone check also refreshed
the browser, reopened the saved source and navigated to printed `349` again.
Receipts are in `tmp/pdf-pagination/browser-reporter-final/` and
`tmp/pdf-pagination/browser-standalone-reporter-final/`; the latter HTML's SHA-256
is `1ed6c3fa12f745d716fae6ccb468e0aa7bd63e496ca361deabadb7e58c71a1b4`.
This proves persisted navigation, not retention of the WASI in-memory extraction
cache across refresh. Lite also passed on the same original in downloaded HTML
and localhost HTTP: printed navigation, text and area highlights, undo/redo,
editable annotated export and viewer close/reopen. Its downloaded-HTML check
also rejected an unrelated neutral citation and an incorrect reporter first page.
The browser check forbids PDF.js's main-thread worker fallback. Receipts are
`tmp/pdf-pagination/lite-browser-final.log` and `lite-hosted-browser-final.log`;
the Lite HTML SHA-256 is
`86aa4db8c3991fb23379505d3de8610c1e2f3dc91a59e86cf052f86347ace75e`.
The broader release and corpus gates remain open.

The same full standalone HTML passed the manual book lifecycle in 15.1 seconds:
source/cover/supplement upload and replacement, exported replacement content,
saved-book reopen, authority identity correction, rebuild, and desktop/mobile
layout checks. No severe browser errors or CanLII requests occurred. The receipt
is `tmp/pdf-pagination/browser-standalone-manual-final/standalone/20260928T081257540922Z/result.json`.
This manual-upload check does not certify automatic publisher acquisition.

## Citation-only Authorities check

The current question is whether an acquired original reporter PDF starts on the
citation's first reporter page, allowing `printed = citation start + PDF page - 1`
without detection or OCR. Target **350 unique Canadian original PDFs associated with reporter citations**,
not 350 acquisition attempts. US PDFs, reconstructed PDFs and acquisition failures
do not count toward that target. The earlier 350-PDF US-heavy manifest is historical
supplementary evidence and does not validate the Canadian app's coverage.

`canadian-candidates.py` selects from the app's installed Canadian citation inventory.
The available reporter fields expose SCR/RCS; provincial and Federal Court reporter
families remain an explicit coverage gap. Seven date bands each target 50 originals,
with a seeded order fixed before acquisition. Failure in one band is not filled from
another jurisdiction. `authorities.cjs --citation-only --canadian` uses the production
Authorities resolver sequentially, passing canonical case citations and retaining
reporter forms. It reuses acquisition receipts and performs no page detection or OCR.
It rejects non-Canadian candidates and keeps separate Canadian receipts and manifests.
`citation-only.py` writes the citation-only predictions and manifest, and scores
saved blind visual readings. Existing independent readings are reused, including
those for sources where the detector previously abstained. New readings use page 1
and two seeded later pages, with neither citations nor predictions supplied to Luna.
The primary prediction uses the first reporter start in the resolved citation forms;
the score also compares the originally submitted reporter citation separately.
These can differ when resolution returns a PDF from a parallel reporter. Neither
choice is selected using the visual answers.

```powershell
python benchmarks/pdf-pagination/canadian-candidates.py
.\benchmarks\pdf-pagination\limited.ps1 -Name canadian-authorities -NodeArgs @('benchmarks/pdf-pagination/authorities.cjs','--citation-only','--canadian')
# Cached public originals can be validated while publisher downloads are unavailable.
python benchmarks/pdf-pagination/canadian-cached.py
python benchmarks/pdf-pagination/citation-only.py --manifest canadian-cached-manifest.json
.\benchmarks\pdf-pagination\limited.ps1 -Name canadian-vision -Executable python -NodeArgs @('benchmarks/pdf-pagination/run.py','check','--manifest','canadian-citation-only-manifest.json','--prediction-dir','canadian-citation-only','--workers','1','--batch-size','5','--max-batches','1')
python benchmarks/pdf-pagination/citation-only.py --manifest canadian-cached-manifest.json
```

Raw exact-text disagreements require image review; absence of a printed folio is
not itself an incorrect offset. Preserve raw model readings and record adjudication
separately. Repeat the single-batch vision command until no readings remain pending;
each invocation cleans up its model process tree before another starts. The blind
prompt receives only images and opaque identifiers, with no citation predictions.
Page identities and original model responses are saved for audit.

The Canadian reporter cache contains 130 SHA-verified public SCC originals;
uploaded and private documents are excluded. One hundred have independent
readings from blind image review or citation-blind margin text. In those 100,
284 of 287 sampled pages have visible labels matching the citation-only offset;
there are no numeric disagreements. The other three samples are from *Bhasin v.
Hrynew*, `[2014] 3 SCR 494`: PDF pages 1, 44 and 61 have no visible reporter
folio despite a reporter citation in the front matter. Its binding remains
unverified. Thirty other cached originals await visual readings. This SCR/RCS
evidence does not certify other Canadian reporters, and the 350-reporter-original
target remains incomplete while publisher access is challenged.

The final candidate's 100-original non-OCR operation took 37.9 seconds on its
first recorded pass (median 208.3 ms, p95 1292.1 ms) and 15.6 seconds in a new
process with the native cache populated
(median 50.5 ms, p95 553.3 ms), with no failures. Against independent readings
in that timed cohort, it resolved 127 of 211 readable sampled folios exactly,
left 84 unknown without OCR and made no wrong prediction. The actual cited-page
operation on 88 originals produced 87 exact independent PDF-page/display/highlight
matches; *Bhasin* refused to invent a binding. Median operation time was 2.89 s
and p95 was 6.44 s, including scoped recognition and cached-artifact restoration.
The first pass did not isolate a fresh native cache, so its "cold" filename is not
evidence of a true cold parse. `measure-canadian.cjs` now requires a distinct,
unused cache directory per run ID before measuring a cold pass. Receipts are
`canadian-product-candidate3-{cold,reopen}.json` and
`product-oracle-candidate3/` under ignored `tmp/pdf-pagination/`. These are
candidate runs on previously inspected public PDFs, not fresh held-out proof.

The primary sample follows production Authorities citation resolution, PDF
acquisition, draft save/reopen, pagination and highlight generation. Reconstructed
PDFs are reported separately from original reporter PDFs. Acquisition failures are
retained in receipts rather than disappearing from the denominator.

`authorities.cjs` consumes `tmp/pdf-pagination/authorities-candidates.json` with
public citation/provider records, writes individual acquisition receipts, and
builds `authorities-manifest.json`. `authorities-predict.cjs` reuses the native
projection and recognizes up to three opening pages, stopping when the reporter
anchor is found. It checks display/highlight destination agreement without
recognizing every later page.

The supplementary sample comprises 300 existing public judgment/report PDFs.
`run.py prepare` uses the existing public corpus ledger; it writes URLs, SHA-256
identities, page counts and deterministic development/held-out assignments. Journals
are excluded from preparation and scoring. Earlier mixed-corpus artifacts are
historical evidence only. Keep PDFs and generated results out of source control.

```powershell
# Compile once, then check the existing Brassard original before the full original set.
.\benchmarks\pdf-pagination\limited.ps1 -Name backend-build -NodeArgs @('backend/node_modules/typescript/bin/tsc','-p','backend')
.\benchmarks\pdf-pagination\limited.ps1 -Name brassard -NodeArgs @('benchmarks/pdf-pagination/authorities-predict.cjs','--product','--only','8471c9ebee8339944e4f08cb308f9cfe38b64b7996d0443a73e86704bdf44b87')
# Run this only after the single judgment succeeds within the limits.
.\benchmarks\pdf-pagination\limited.ps1 -Name authorities -NodeArgs @('benchmarks/pdf-pagination/authorities-predict.cjs','--product')
python benchmarks/pdf-pagination/run.py score --manifest authorities-manifest.json
python benchmarks/pdf-pagination/run.py score
```

`limited.ps1` uses one logical CPU core, Below Normal priority and one job at a
time. It samples the owned process tree once per second and stops if its combined
working set exceeds 1 GB. This is a monitored stop threshold, not an operating-system
reservation or instantaneous memory cap. There is no minimum-free-RAM gate.
Resource receipts and command logs go under `tmp/pdf-pagination/limited`.
Never raise the thresholds automatically. Use argument strings without spaces in
this local runner; paths in the commands above are relative to the repository root.

The existing visual checker defaults to one Codex process, using `gpt-6-luna` with max reasoning.
`--workers` accepts 1–4; do not overlap model checks with browser builds or tests
on a memory-constrained machine. Below Normal priority does not cap memory usage.
Each receives only page images, their physical page identifiers, the short prompt
and strict output schema. It sees neither citation predictions nor expected labels.
It samples physical page 1 plus two distinct later pages, independently of
product predictions. Small documents naturally yield fewer distinct pages.
Results, event logs and images are retained by PDF hash and resumed on rerun.

Scores are exact-text comparisons with independent model readings, **not adjudicated
gold**. Report abstentions, non-readable pages and label disagreements separately;
do not count reconstructed page numbers as successful reporter offsets. The first
supplementary run flattened detected/embedded provenance in its predictor; the
corrected predictor preserves it. Existing prediction receipts are never overwritten
implicitly. Any retest needs a separate output directory or an explicitly archived
baseline. Do not tune against held-out failures and then call the same data fresh
held-out validation. The conservative embedded-label guard was added after reviewing
these failures, so its score on the same saved visual readings is a regression
rescore, not a fresh held-out estimate. The corrected supplementary predictor calls
the product operation directly. `--product` runs the actual cited-page OCR operation
on the acquired originals and saves separate receipts under `product-final`.
It also checks generated highlights and restores each prepared artifact to check
that reopening preserves routing coverage. A non-OCR profile can report pending
pages in `ocrRoutedPages`; this is not evidence that those pages were recognized.
The run records actual requested pages and nonempty OCR text separately and refuses
requests larger than the opening-page allowance plus the single cited page.
`--only SHA256` selects one acquired source and `--output DIRECTORY` selects a fresh
run directory. Do not reuse receipts from before a code change as candidate results.

Real acquired-PDF checks are the main acceptance evidence. Small regression tests
only cover deterministic mapping contracts; they are not a substitute for the
acquisition, OCR and independent visual results.

The recorded pre-fix Authorities baseline comprises 350 acquisition attempts:
48 originals, 158 reconstructions and 144 without an attachment. The lower-level
check anchored 31 originals, with matching highlight destinations. Blind vision
read 150 sampled pages from the originals: 81 displayed labels agreed and 69
readable pages had no resolved label. The actual cited-page operation subsequently
completed for only 2 of the 48 originals. These measurements must not be conflated.
The subsequent full operation rerun passed for all 31 anchored originals, with 17
explicit unresolved-page abstentions. It checked display, selected-page OCR,
highlights and cached-artifact restoration. Median preparation was 2,991 ms;
the batch took 140.2 seconds with a sampled peak working set of 912 MB on one core.
These OCR-inclusive operation results are separate from the citation-only hypothesis
and are not Canadian corpus-scale evidence. The earlier 3 GB free-memory gate was
an agent-chosen limit and has been removed; the process-tree guard remains.
