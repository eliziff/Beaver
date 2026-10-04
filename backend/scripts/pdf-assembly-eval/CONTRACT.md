# PDF assembly preservation evaluator v1

This evaluator is a mechanical correctness task using independently invented,
synthetic source documents. The only objective is the exact number of passing semantic assertions,
subject to zero regression of every individual passing development baseline assertion,
an identical assertion-ID set, and completion of all scenarios.
Timing is not scored. Production sources remain untouched until the first baseline.

The initializer writes five deterministic source-document families, each containing
two separate four-page PDFs. Four families (eight sources) are development; one
family (two sources) is sealed held-out. Every source has varying media, crop and
trim boxes; four rotations; vector/text content and resources; direct, named,
legacy-name, GoTo, URI and GoToR links; nested publisher outlines; and a nested
page-label number tree with Roman, decimal, prefix and prefix-only ranges. Some
local destination coordinate numbers are indirect PDF objects. Documents and
source PDF bytes have fixed metadata and no external dependencies.

The sealed family is generated and hashed automatically at initialization, without
reading its contents or scoring it. Development runs neither read nor rehash sealed
files. Only after choosing the final production incumbent may `sealed` run, supplying
the exact combined production hash. Opening writes an exclusive seal-open receipt.
It cannot be repeated. Held-out failures must not be used for further tuning.

Frozen output semantics:

- Every requested page occurs exactly once in the requested source/subset order.
  Its decoded content stream hashes, recursively resolved resource dictionaries,
  media/crop/trim/bleed/art boxes and rotation remain exact. No content deletion can
  increase the score. Generated cover/index pages are checked separately.
- All local annotations targeting retained pages survive with their exact rectangle,
  annotation identity, optional owner-page backlink, destination view and parameters, pointing at the independently
  calculated output page. Web and remote PDF actions survive unchanged.
- Selected-page extraction retains the established `pdfAssembly.test.ts` behavior:
  local links whose target is explicitly omitted are removed. They cannot be replaced
  with dangling or silently redirected links. Omitted outline parents promote retained
  descendants. This exception applies only to pages explicitly excluded by the input.
- Generic append/assembly without an explicit label or outline override preserves
  each selected page's source label and concatenates remapped publisher outlines,
  including nested hierarchy, exact destination view/coordinates, and external URI/GoToR
  action bookmarks. Repeated assembly
  must preserve the same original-source semantics.
- Authorities book rendering intentionally overrides labels with continuous physical
  book page numbers. It preserves source page content/navigation and publisher outline
  destinations. The actual production outline reader supplies PreparedBookSource
  metadata; expected outline mappings are separately calculated from authored fixture
  specifications, never from production reader output. The generated cover, index,
  group and tab bookmarks use Fit. The generated index names, exact ranges, local
  link targets, exact ordered TOC row text, source placements, title/size of generated
  front matter, and repeated byte-identical assembly are checked. Native outlines must
  also survive when optional PreparedBookSource.outline metadata is omitted. Custom
  cover/index source outlines become children of the generated document-title and
  Table of Contents nodes respectively; their pages/content/links remain exact.
- Final brief/book export preserves the brief source pages and labels, book pages
  and assigned labels, every imported link and source outline destination. Container
  Brief/Book of authorities outline nodes use Fit. No empty-draft warnings are expected.
- Full inputs and reordered source inputs with reordered selected-page subsets are
  tested for every development family and once for each held-out family.

Expected page mappings, labels, outline trees, content identity and link semantics
come from fixture specifications plus independent PDF object readers in this harness.
Production helpers are only used to perform the operations under test. They are never
used to derive expected page mappings or read actual navigation assertions.

Run from the repository root with the existing lockfile-restored runtime:

```
npm exec --offline --no -- tsx backend/scripts/pdf-assembly-eval/evaluate.ts init
npm exec --offline --no -- tsx backend/scripts/pdf-assembly-eval/evaluate.ts dev baseline-dev
npm exec --offline --no -- tsx backend/scripts/pdf-assembly-eval/evaluate.ts dev candidate-N
npm exec --offline --no -- tsx backend/scripts/pdf-assembly-eval/evaluate.ts hash
npm exec --offline --no -- tsx backend/scripts/pdf-assembly-eval/evaluate.ts sealed final-heldout --final-incumbent=HASH
```

Raw PDFs, specs, the SHA-256 freeze manifest, per-assertion JSON receipts and append-only
attempt receipts are ignored under `benchmarks/local-data/pdf-assembly/v1/`.
The freeze manifest binds this contract, harness, fixture bytes and initial production
source hashes. A harness correction requires a new version, explicit reason and fresh
baseline; changing a gate after observing production candidates is prohibited. Exact
production patches and acceptance/rejection reasons are retained by the supervising
hill-climb attempt log. All baseline passing assertion IDs are immutable constraints.

## Integration status and remaining portability work

This source is preserved for integration review. No tests, builds, or evaluator
runs were performed for the branch handoff, and the branch is not certified as
release-ready. The output path and task-specific documentation were sanitized;
these edits change the original frozen harness identity. A documented new version
and fresh baseline are required before further evaluation. No original fixture
state, sealed data, or run receipts accompany this source.

The runner remains coupled to the Beaver repository layout, relative application
imports, fixed source-hash targets, and the repository's Node/pdf-lib/tsx runtime.
Dependency availability, native modules, and pinned submodule content still need
review in the integration environment. The output directory is fixed and needs
run-isolation review before concurrent or repeated use.

The deterministic synthetic family recipe has already been evaluated; generating
the same families does not produce a new unseen holdout. Ordinary failed semantic
assertions do not necessarily produce a nonzero process exit status, so consumers
must inspect both the score and constraints. Portability and stricter command-line
acceptance behavior remain unfinished; no fixes for them are claimed here.

An unnamed development/sealed run replaces its latest output and receipt. Explicit run names, including baseline-dev, preserve exclusive receipts and attempt history.
