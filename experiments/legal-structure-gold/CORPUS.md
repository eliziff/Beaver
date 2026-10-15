# Structural gold source selection

Run `python experiments/legal-structure-gold/freeze_corpus.py` to prepare
`benchmarks/local-data/legal-structure-gold/family-selection.json`. The output
is private and ignored. Source PDFs remain in the canonical OpenLegalData corpus;
this command reads the catalogue and prepares membership, without parsing PDFs,
authoring answers, training, scoring or invoking models.

The catalogue selects completed canonical `legal-gold-package.v2` runs with
`digitalborn` or `ocr` mode: the original 1,161 structural sources. Record-only
packages and legacy `legal-structure-gold.v3` exports do not substitute for these
answers. The catalogue selected run identifies each existing gold artifact. Filesystem
modification times never select answers. Family components combine shared source
URLs, substantive document/page text, form-template observations, and existing
record source/owner memberships. Explicit reviewed source-version, proceeding,
template or duplicate-page memberships can extend this evidence. Related sources
outside the selected dataset still participate in transitive family grouping.

Connected families receive a deterministic 80/10/10 hash partition; these are
provisional train/development/test memberships until the final gold and exposure
audit are frozen. Known exposed sources force their whole family to development.
Text equality is a conservative leakage witness, not proof of identical rendered
pages. Blank and short pages do not establish text equality. Scanned pages and
unrecorded source versions/templates require additional evidence.

Long-source selection requires an existing canonical file with more than 30
catalogued pages. Four primary groups each request twelve PDFs; a PDF counts once.
Catalogue document kinds establish judgment, legislative and compound eligibility.
Explicit reviewed evidence establishes bilingual/multicolumn eligibility. English/
French lexical co-occurrence only nominates review candidates. Selection prefers
OCR sources and distinct families, then uses a fixed salted hash order.

Use `--review PRIVATE_JSON` to supply evidence in this shape:

- `documents`: source SHA keys with `groups` (values from `judgments`,
  `legislation`, `compound`, `bilingual_or_multicolumn`), nonempty `evidence`,
  and optional `family_reviewed` / `duplicate_pages_reviewed` Boolean flags.
- `families`: records with `kind` (`source_version`, `template`,
  `proceeding`, `duplicate_page`), `members` (canonical source SHAs), and
  nonempty `evidence`.
- `exposed_sources`: canonical source SHAs previously inspected for model
  selection or error-driven development.

To regenerate the prepared local selection with its recorded layout evidence, run
`python experiments/legal-structure-gold/freeze_corpus.py --selection benchmarks/local-data/legal-structure-gold/family-selection.json --review benchmarks/local-data/legal-structure-gold/family-selection-review.json`.

Review evidence belongs beside the private manifest. Do not publish source
identities, text, paths, or private receipts in this document. A prepared manifest
reports shortages and missing coverage explicitly; it does not certify untouched
test data or replace the roadmap gold authoring and evaluation gates.

## Final input freeze

Once source-family, visual duplicate-page and exposure reviews are complete and
all selected sources have current structural authoring, run:

```text
python experiments/legal-structure-gold/freeze_corpus.py --freeze --selection benchmarks/local-data/legal-structure-gold/family-selection.json --review benchmarks/local-data/legal-structure-gold/family-selection-review.json
```

This writes the private `family-frozen.json`. It preserves the prepared member set
and long-source group assignments, refreshes current artifact/family evidence, and
refuses a changed partition until the prepared selection is explicitly revised.
Use `--selection` without `--freeze` to prepare that revision for review. It never
authors answers, trains or scores.

The review adds `exposure_review: {sources: [SHA, ...], evidence: ...}` covering
every selected source; `exposed_sources` still identifies known prior exposure.
A review assertion is retained evidence, not authentication of who performed it.

Freezing requires full-page canonical structural gold and current settled-policy
authoring evidence. Initial source/structure authoring and structural reauthoring
share the same proof; an additional structural pass is not required for newly
authored sources. Source, artifact, selection, review, policy and authoring
identities are bound in the manifest. The trainer verifies that binding and opens
only training gold; it cannot accept a prepared manifest by changing its status
string.

Source preparation and structural acceptance reject PDFs that require dynamic
XFA rendering, including apparently successful viewer-fallback pages. Explicit
static XFA (`dynamicRender=forbidden`, without `NeedsRendering=true`) is supported;
unknown or ambiguous declarations remain unresolved. The same check covers
cached authoring, interrupted structural publication and newly selected structural
packages. Freeze checks the hash-verified PDF under its explicit corpus home.
Metadata support does not certify page completeness; the source author still
needs complete page evidence.

The current prepared selection contains 1,209 sources: 1,161 canonical structural
packages plus the unchanged 48 long PDFs. The private
`structure-authoring-plan.json` binds the existing-source batch to current
artifact hashes and runner directories: 1,254 chunks, at most three attempts per
chunk (3,762 calls). It records pending model authorization; generating this
plan does not authorize dispatch or alter gold.

Capability-aware preparation produced 1,250 prompt files for 1,157 supported
sources, with zero preparation errors, model calls or gold changes. Four selected
dynamic XFA sources need complete source-backed page appearance before authoring;
their ordinary page trees show viewer-fallback notices. Three independently
inspected static XFA sources remain supported. The cohort remains unchanged. `long-source-modes.json` records evidenced mode
proposals for the 21 previously unknown long sources; `long-authoring-inputs.json`
contains the unchanged 48 inputs (27 OCR, 21 digitalborn). One source has retained
PDF syntax diagnostics. These are source-preparation artifacts, not quality scores
or approval to send documents to a provider.

## Historical exposure review

The private `exposure-audit.json` records confirmed historical parser comparison,
error analysis, OCR training/validation and prior exposure declarations. It
identifies 158 directly exposed sources in the 1,209-source cohort, plus external
related sources: 177 confirmed source identities in total. The historical
audit identified 135 families containing 315 cohort sources to exclude
from an untouched final split. `family-selection-review.json` retains those
confirmed identities and binds the partial audit; it does not assert a completed
exposure review. Subsequent visual evidence expanded that closure to 316 selected
sources across 135 families; the refreshed selection assigns all to development.

The other 1,051 sources lack confirmed direct exposure in this bounded audit;
their historical exposure remains unknown. Retained association predictions
link another 23 cohort sources, but their training or selection use is unresolved.
The private `exposure-association-resolution.json` traces those identities through
eight records and 67 prediction/input file keys to current source/split manifests;
retained historical artifacts match their archive hashes. Those current manifests
are not bound by the historical run, and current projected text does not exactly
match its inputs. The receipt therefore establishes present identity linkage,
not historical source-byte, checkpoint, training or selection provenance.
Gold authoring alone is not parser/model-selection exposure. Missing historical
training memberships, indirect family relationships and visual duplicate-page
review still require evidence before any source can be called untouched. The
original prior-exposure declarations remain bound to the private
`exposure-review-before-audit.json` snapshot.

Prepare additional visual family witnesses with
`python experiments/legal_pdf_corpus/page_fingerprints.py --selection benchmarks/local-data/legal-structure-gold/family-selection.json --prepare`.
The corpus owner stores source/configuration-keyed grayscale raster hashes and
dHash evidence, retaining render diagnostics. Exact equality means equality at
the configured raster resolution (256-pixel longest edge by default), not proof
of identical original pages. At most three-bit dHash differences nominate review
candidates. The exporter retains all raster occurrences grouped by equal dHash,
plus every cross-source neighbouring-signature relationship within three bits,
without expanding their page-pair Cartesian products. Dimensions and signature
set-bit counts remain review evidence; they never automatically label blank pages
or exclude differing proportions. Omit `--prepare` to refresh this compact index
from cached fingerprints without rendering. Preparation sets no family or
duplicate-page review flags.

Local visual preparation covers all 1,209 selected sources and 10,780 pages,
with no missing/incomplete source coverage. The current private export contains
19 exact low-resolution raster groups and a complete compact comparison index:
10,709 rasters in 10,440 signature groups, including 92 groups with cross-source
occurrences, plus 8,364 cross-source neighbouring-signature relationships. Every
cached page participates; equal-signature matches and all cross-source signature
relationships within three bits are represented without truncation. This is
complete coverage of that candidate rule, not proof that all duplicate pages
have been found or that visual families have been reviewed. Diagnostics are
retained for 116 sources (223 source/page diagnostic records). No visual match
was automatically accepted as reviewed family membership.

The bound historical audit includes nine confirmed exposure identities absent
from the current catalogue. They remain recorded in `exposed_sources`; only
catalogued sources project to known families. An unknown identity without
confirmed bound audit evidence is rejected.

The exposure refresh preserves all 1,209 source identities and all 48 long-source
group assignments. It moves 287 sources to development (271 from provisional
training and 16 from provisional test), leaving 733 train, 395 development and
81 provisional test. `selection-refresh.json` binds the prior/current manifests
and split changes; `family-selection-before-exposure.json` preserves the exact
selection used by earlier mode, authoring-input and audit receipts. Their original
hashes remain historical bindings; no authoring or audit rerun is implied.

These partition counts do not certify an untouched test set. Complete family,
visual-page and exposure review and revised gold are still required.

Targeted visual review of the five exact-raster groups crossing existing families
confirmed two substantive scanned duplicate-page pairs. Both occurrences of each
pair were inspected, and all occurrences in all five groups were rendered and
hashed at a 1,400-pixel longest edge. Two blank-page groups and one generic
intentionally-blank notice group provide no family linkage. The private
`exact-raster-visual-review.json` binds those decisions and evidence; only the two
substantive pairs were added as `duplicate_page` family records. This targeted
review does not establish whole-document or whole-cohort review coverage.

To reproduce the targeted visual receipt, resolve each recorded SHA through the
canonical corpus and verify its bytes, open its one-based page with the recorded
PyMuPDF version, set antialiasing to 8, and render RGB with annotations and no
alpha using `Matrix(1400 / max(page.rect.width, page.rect.height), same_scale)`.
Hash `pixmap.samples` with SHA256 and retain the raster dimensions. The private
`exact-raster-visual-review.json` records every occurrence and renderer identity;
its decisions distinguish visual inspection from equality of the rendered pixels.
Review rasters were disposable and removed after inspection. For reused pages,
keep low-resolution candidate fingerprints separate from the inspected RGB
render identity. Earlier receipts may retain the candidate fields at the top
level and the visual identity under `review_render` or `reuse.page`; follow the
bound prior receipt to that inspected render. New three-bit receipts record this
resolution explicitly. Do not interpret a candidate hash as a 1,400-pixel render
hash merely because the enclosing receipt records the review configuration.

The earlier 1,254-prompt preparation followed the source-anchored reading-stream
and remote-continuation changes. The current plan binds the final capability-aware
refresh: 1,250 prompts, at most 3,750 calls, with four source blockers.
`source-capability-preparation.json` and `authoring-readiness.json` record final
code hashes and unchanged gold. `source-availability-review.json` and
`source-xfa-capability-review.json` preserve dynamic/static source evidence; the
named pre-static-XFA preparation snapshot preserves the latter review's original
binding. No model dispatch occurred.

Targeted perceptual review covers equal-signature through three-bit candidate
relationships touching the recorded provisional-test selections. The two-bit
stage covers 107 relationships across 193 unique candidate pages; the three-bit
stage covers 282 relationships across 316 pages. Their private plans and three
per-stage review receipts bind source/render identities, prior visual evidence
and per-relationship decisions. Supported evidence includes distinctive form
and publication templates, related proceedings, source versions, duplicated
pages and shared embedded decision material inside compilations. Generic
layouts and XFA fallback notices did not establish links; underlying-form and
visually unclear-page uncertainty is retained explicitly.

Current preparation contains 1,209 sources in 946 families: 745 train,
392 development and 72 provisional test. The three-bit refresh reduced families
from 952 to 946: five provisional-test and two development sources moved to
training; one training compilation moved to development through an exposed
family containing shared embedded judgment material. No source moved into
provisional test. Source membership and all 48 long-source group assignments
remain unchanged; three long-source family metadata records changed, including
the compilation partition.

`selection-refresh.json` binds the latest state and nests earlier refresh
receipts; named pre-review selection snapshots preserve referenced identities.
The current provisional-test split has 7 equal-signature, 21 one-bit, 82 two-bit
and 276 three-bit cross-family relationships: all 386 have complete occurrence
review coverage. Eleven perceptual receipts bind the unchanged candidate artifact
directly or through recorded plans. Review coverage remains limited to that
selection and candidate rule.
No broad review flags or untouched-history claims were added. Broader
source-family relationships, diagnostic/underlying-content uncertainty and
historical exposure remain incomplete; no final freeze or quality evaluation
was performed. All owned review renders were removed.
