# Shared document structure

Status/order/gates: [master plan](master-plan.md). One standalone Rust
`legal-structure` engine, opaque NativeDocument and canonical DocumentStructure.
Beaver acquires immutable bytes/provider records and requests only the bounded
text/range/table/citation/navigation/mutation product needed; purpose-specific
operations do not derive unrelated structure.

Evidence: [structure inventory](../decisions/document-structure-evidence.md),
[cutover results](../decisions/source-structure-cutover-results.md), and
[parser parity inventory](../../legal-pdf-parser/experiments/structure-engine-parity/EVIDENCE.md).
Superseded plans remain at Beaver `54f89938` and parser `2b2c341e`.

## Codex checkpoint — November 8, 2026

The inherited refactor is Beaver `46f1f6c05`, parser `d67b08e`, structure
`0eecd9a` and AuthoritiesHelper `7612185`, with additional AuthoritiesHelper
work already in progress. This checkpoint marks the start of the Codex follow-up;
it does not certify the refactor.

The first regression pass found:

- Backend source type checking passed; 109 Authorities core, source, build,
  server and runtime tests passed.
- Nine stored-source tests still imported the deleted projection service.
  OCR and text-access tests also retained assumptions about its backend cache.
- The browser parse worker and Authority Linker still sent stringified citation
  requests. Opening a host-recognized PDF also passed native OCR options to the
  WebAssembly engine, which has no native OCR provider.
- The standalone workflow reached PDF/Word imports, draft reopening, highlight
  editing and exports, but the stress run failed. Import timings exceeded the
  existing budgets, and the fully attached highlight scenario left three SCC
  sources unresolved. The harness previously continued through the missing-PDF
  warning without checking that none were missing.
- The short missing-paragraph fixture returned `unavailable` instead of
  `not_found`. Preserve its expected result while investigating the parser.
- Microsoft Word could not start in the restricted test shell (`0x80070520`),
  so that run provides no Word-host validation.

Before closing the refactor, inventory every live consumer and run its historical
behavior gates against the same source combination. Preserve independent gold
and frozen expected products; explain each mismatch before changing an
expectation. The distinct parser gates below remain required. Focused tests,
successful exports and implementation presence do not establish parser parity,
complete consumer fidelity or release readiness. Disposable run logs and browser
reports are in `.tmp/refactor-regression/`; keep durable findings here.

Follow-up, November 9:

- Citation edits and leaving Citations no longer cancel gathering. The source
  operation retries its existing revision conflict against the saved draft.
  Browser checks preserve edits and all arriving source rows. The checkpoint is
  `8e8c551e7`; the gathering correction is `7a4130603`.
- Host-prepared PDFs reopen by their native cache key (`e850e021b`). Actual WASI
  tests retain text, recognition geometry and routed pages through an engine
  restart. AuthoritiesHelper `2cdca1c` also fixes the parse worker and Linker's
  typed citation requests. These are transport checks, not corpus parity.
- Stored-source, Word drafting/redline, email, workbook, A2AJ and citation-receipt
  tests now exercise the native products. Word recovery retains the final
  unclosed paragraph through the existing XML reader. XLS display formats needed
  an upstream calamine extension; its tests pass and the original MIT licence has
  now been retained unchanged with the maintainer's permission.
- Native build-cache inputs now include all parser crates and structure
  subcrates, citation build inputs and legal-text (`a02911b21`). The owner Cargo
  manifests use the sibling main checkouts, avoiding an older Git dependency
  silently differing from the application build.
- Large-statute reading repeatedly scanned UTF-16 prefixes and every preceding
  line/provision. It now reuses the existing `ScalarText` index and sorted start
  positions. The invented 5,400-section case went from about 21 s to 165 ms for
  A2AJ reading and 23 s to 322 ms for text outlining. All text and complete outline
  hashes match the saved pre-change products for 40, 400 and 5,400 sections and a
  Unicode-prefix case. These are sequential local samples, not corpus throughput
  measurements. Reproduce with `node scripts/benchmark-statute-reading.mjs REPORT
  BASELINE`; private receipts are `benchmarks/local-data/parser-refactor/statute-{before,after}.json`.
- Cold Authorities imports no longer spend time on sample citations, dummy PDFs or
  an unused cover preview. Parsed citation keys go straight to alias lookup;
  the citation owner skips irrelevant rule grammars and builds its case-name
  matcher as a contiguous NFA instead of expanding a DFA. The owner passes all
  267 grammar, citation and CLI tests. The native production loader and first
  citation reading take 352–414 ms (500 ms budget); 50 changing subsequent inputs
  have a 0.775 ms median and 1.395 ms 95th percentile, which now owns the timing
  gate. Three repeated browser runs in fresh profiles put the
  complete file choice to citation review at about 3.7 s for public Bhasin and
  1.6 s for the varied Word brief; the complete run reads Bhasin in 4.2 s and
  Word in 1.6 s, inside the unchanged 5 s cold-import budget.
  Browser builds enable WASI SIMD through the existing Cargo helper. No result
  cache or test warm-up was added.
- The shared source-PDF writer no longer measures each character of a word that
  already fits, or searches the complete statute for every bookmark. Local
  rendering of the invented 5,400-section Act drops from 4.0 s to 2.6–2.7 s. Our
  parser reopens all 961 pages with identical extracted words and all 25,205
  logical outline entries, including their page assignments. Source offsets
  change with kerning and wrapping; those raw outline hashes are retained rather
  than blessed as parity. The added margin test and all 53 focused build tests
  pass. Reproduce with `node scripts/benchmark-statute-source-pdf.mjs REPORT
  BEFORE`; private receipts are `statute-source-*` beside the reading benchmark.
  This renderer still performs substantial PDF layout in TypeScript; these
  changes reduce its work without adding a second layout implementation.
  After retaining first-match behavior at shared bookmark starts, all 53 build
  tests, backend type checking and the complete statute comparison pass again.
  The rebuilt HTML's focused large-statute browser workflow also passes, including
  its excerpt text, bookmarks, index and final-PDF links.
- The first broad consumer run had 536 passes, 15 failures and one skipped test
  across 68 files. The latest hermetic backend run covers 158 files and 1,128
  tests: 1,082 passed and 46 skipped, with no failures. Removed journal fields and
  an internal ID used as a printed page label were corrected in the tests.
  Backend and frontend type checking pass. Live opt-in tests are not included.
  The separate Word editing runtime passes all 65 tests in 15 files, using the
  pinned lxml 6.0.2 in a disposable environment and the installed LibreOffice.
  The earlier system-Python prerequisite failure is resolved; the disposable
  environment was removed in `finally`. Microsoft Word export checks below
  remain a separate gate.
  The duplicate short paragraph
  fixture's expected diagnostic is now `unavailable`: source inspection and the
  primary-count policy show its conflicting `[29], [30], [29]` establishes no
  paragraph index. The older `ambiguous` assertion came from the removed raw-label
  lookup. Both versions abstain with no geometry; a missing label in a valid
  `[28], [30]` count still returns `not_found`.
- The complete standalone browser run passes all 22 available scenarios in
  6 min 8 s; the long-article local fixture is absent. It checks cold PDF and Word
  imports, a first citation on page 24, pinpoints, drafts/reloads, folder pickup,
  source edits during slow gathering, cancellation, court/output matrices,
  120 authorities, scans and repeated builds. All existing timing, layout and
  input-to-paint budgets pass. Reports retain a run ID and the tested HTML hash;
  `--repeat` runs fresh profiles. The 120-authority book builds in 1.45 s; four
  scans finish recognition in 4.9 s after pause/resume and reload, then build in
  0.9 s. The chooser now depends on the host's available actions (`8d007a7f8`),
  so background results cannot unmount it or open source guidance over an upload.
  The scan export defect was traced to invisible text starting at the bottom of
  the page: subsequent lines fell outside its crop. The corrected writer and
  statute fallback checks pass all 40 PDF assembly/Authorities build tests.
  The editor's browser OCR adapter also retained old `pageNumber`/`rect` fields;
  it now emits the shared `number`/`bbox` product directly. Embedded OCR asset URLs
  also go unchanged to workers instead of being reparsed on the UI thread. All
  58 OCR-owner tests and the full scan/export/editor browser assertions pass.
- All 13 generated Word outputs in the full run open read-only in hidden Microsoft Word outside the
  restricted shell, without repair or field errors. The host shows their tables,
  italics, citation fields and tab references. Word's own inserted tables also
  pass, including the complete copy/reference matrix. Three repeated matrix runs
  additionally open 24 documents in Word without errors. Its keyboard check proves
  focus stays in source help and returns to the requesting button when dismissed;
  Escape is measured through the existing input-to-paint helper before checking
  the scheduled focus restoration. Sources screenshots at
  1280×720 and 1440×900 retain aligned, accessible controls.
- The large-statute browser test must wait for its PDF to attach: Sources now
  opens while gathering continues. Building earlier correctly emits a missing
  source placeholder, not an excerpt. With that wait, the 961-page invented Act
  is ready in about 16 seconds (unchanged 30-second budget), and all excerpt,
  provision text, bookmark, index and final-PDF link assertions pass. The public
  Criminal Code branch still lacks its recorded HAR. The table citation's written
  name is now clipped to its owning cell during import, so source resolution no
  longer changes its span or layout. Real Word tests also resolve supra/ibid past
  an author's symbol note: an omitted printed note number no longer falls back
  to the note's internal identity and collides with numbered note 1. All 31
  focused import/domain tests pass; no mock note IDs stand in for actual Word files.
- Parser certification remains open. The frozen 748-document cache is absent
  from its recorded scratch path. The existing full gold-input run, with one
  worker and local OCR but no oracle layout, produced 22 complete inputs before
  being interrupted for integration checks. These remain in the canonical
  `gold-inputs/d8f66d9741bdcc64` cache and the run must resume; no grade is claimed.
  Gold checkout `ab7bed6af0de3f1901815ac30b99b1e179836e88` has unchanged gold files.
  The PDF Inspector workflow had lost its independent source assertions and
  frozen-hash comparison in parser `4ee3081`. They are restored (`dc0c24c`),
  with native paragraph labels and unchanged frozen hashes. All 13 source PDFs
  have been resolved locally and checked against their recorded SHA-256 values.
  The candidate CLI reads all 13 documents/711 pages, but every frozen product
  hash differs and three of eight source-reviewed documents initially fail.
  The complaint loses its detached `II. DEFENDANT` heading and merges `COUNT 1`
  into `VI. CLAIMS FOR RELIEF`; table claims hide BCE and Waitangi footer notes.
  Traced repairs now pass all eight independent source checks, including all 34
  complaint paragraphs. The pairer preserves the source's physical note kind
  rather than replacing it with the numbering run's inferred endnote mode.
  Nine complete products match the saved pre-repair candidate exactly; four
  change. Every line released from table ownership belongs to a recovered note.
  Visual review confirms BCE page 63, the Waitangi table note on page 14 and
  risk-assessment footnote 101 on page 35 (also added to source gold).
  Six native consumer checks pass with the original Latimer and BCE files,
  including page geometry and public/evidence reads of footer notes 89–90.
  Private pre-change products and provenance are retained beside the statute
  receipts. No frozen expected hashes were updated and no parity is claimed.
- Authorities Lite now uses the shared native PDF reader (`665bf00`). It asks the
  shared engine for paragraph geometry and printed pagination instead of importing
  the deleted pagination module and assembling a second PDF text in JavaScript.
  A bounded opening read preserves folder identification without reading every
  page's content. The existing `pages` option limits OCR, not native extraction,
  so it cannot supply that operation. The new read reuses the existing extractor
  and line assembler, including source geometry for vertical margin stamps.
  Parser and addon metadata checks pass. Seven actual WASM checks pass, including
  aliases, paragraphs, nested items, opening witnesses and cache restoration after
  asynchronous engine replacement. All 18 Lite domain/network checks pass.
  The packaged file passes the real Latimer
  viewer, automatic paragraph 33 marking, printed-page 3 navigation, manual marks,
  undo/redo, export and reopening. PDF parsing uses the existing worker pool with
  a memory-only store. Two host-recognition tests pass after the shared host change.
  The original scan check also passes, including automatic paragraph 2 marking,
  selection, export and reopening. The index already recovered its missing opening
  bracket; the reader discarded measured OCR lines without word boxes. Whole-line
  geometry is now retained, clipping a recovered marker's logical range to the
  original recognition. Visual review and the strengthened excerpt assertion retain
  all three lines, including the paragraph's beginning. Word-level quote geometry
  stays unavailable where only line boxes exist; the host test checks both outcomes.
  Both browser exports also reopen through the native PDF reader with their
  requested paragraphs intact. Private regeneration instructions and hashes are
  in `benchmarks/local-data/parser-refactor/lite`. The unused Lite Rust ABI crate
  and separate alias-table dependency are removed.
  The final cold-engine refresh exposed a Lite upload race: engine startup could
  parse a pasted list before its queued debounce, whose second parse replaced the
  selected row while the file picker was open. Parsing now cancels that queued
  duplicate (`db71e9d`). The browser check holds the picker open across the delay
  and requires unrelated-citation rows to exist before checking their bindings.
  Both public-PDF and scan workflows pass with this check; the scan passes twice
  in fresh profiles, and both exports reopen through the current native parser.
- Authority Linker's offline file-browser check passes: body/footnote selection,
  numbered and whole pinpoints, subsection links, ibid, preserved text/italics/links
  and phone layout, with no network requests (AuthoritiesHelper `b0957e1`). Its old
  section-only assertion was stale after the existing subsection-link behavior.
  Pinpointer now builds from sibling main checkouts and reads canonical native
  labels (`9a8951f`). Its actual WASM/DOM check fails before the label repair and
  passes afterward for paragraphs, subsections, report pages and UTF-16 citation
  offsets. The old JavaScript paragraph fallback had hidden the label failure.
  Packaged extension binaries were not replaced. Lite's JavaScript paragraph
  assembly is removed, and so is Pinpointer's fallback paragraph detector: a
  case's paragraphs are the engine's.
- The existing A2AJ census completes all 346,150 inputs with zero errors on one
  worker in 777.3 seconds. Input fingerprints match the saved `fix` reading, whose
  build origin is unknown; node/count fingerprints have substantial differences.
  Source review of three of the 260 records with fewer paragraphs finds a short
  decision misread as an endnote and paragraph labels joined to headings lost
  when the count's opening is recovered. Structure `e3b31f0` uses the existing
  citation spans to exclude reported years and one count-reading helper for
  ordinary and joined labels. Focused Rust checks and six provider tests pass;
  public native reads retain paragraphs 1, 63, 218 and 230 in those originals.
  Replays compare directly to the unchanged pre-repair candidate. The latest
  completed run reads all 346,150 inputs without errors in 849 seconds, but is
  rejected: short called note lists can bypass the rejection through mixed-style
  recovery, and a catalogue's footnote call displaces six real late paragraphs.
  Structure `18a69ea` applies the same note evidence to every count and requires
  pre-body calls for every short note number. Seven owner tests pass, including
  attributed originals 2003 FC 993, 2024 ONCA 71 and Tremblay, [1946] SCR 448.
  Public native paragraph reads pass on ten reviewed provider texts. The repair's
  replay completed all 346,150 inputs with zero errors in 1,296.2 seconds. Its
  586 node/count changes include 34 paragraph losses without a corresponding
  note increase; these remain unaccepted. Independent review of `75270:fr`
  (2018 Trib conc 13) finds a nine-paragraph order followed by an annex containing
  another judgment. Both the historical count of 70 and candidate count of 34
  promote appended numbering; neither establishes the primary order's nine
  paragraphs. Keep this as a compound-boundary failure, not regenerated gold.
  The private review and exact binary provenance remain beside `source-fix.*`.
  These node/count comparisons supplement the
  separate historical 323,374-record A2AJ/CourtListener/journal gate.
- ALR's actual local CLI imports an invented two-quotation Word article, reads
  its A2AJ sources and verifies both quotations at paragraphs 1 and 63. Its
  exported workbook reopens through the native reader with two
  `OG_PINPOINT_MATCH` results, the original pinpoints and matching quotation links.
  No AI or remote sources are used. The isolated application data is removed in
  `finally`; receipts and regeneration are in `benchmarks/local-data/parser-refactor/alr`.
  ALR's local main remains clean at `57366b4`. Remote synchronization could not
  be verified because Git authentication failed and the connected lookup returned
  404. No ALR source was edited. This local CLI proof does not establish GUI,
  live-provider or full historical manuscript parity.
- Lite's existing caption test exposed a shared citation bug: a parallel reporter
  citation could be included in a case name. Common-law-cite `a7d5784` reads the
  authored name's span directly. Its owner grammar, citation and CLI tests pass,
  including three new caption conformance cases. The native addon and Lite WASM
  are rebuilt with the subsequent cold-path fixes. Full, Lite and Word-only WASM
  builds pass their browser consumers, the six engine/transport tests pass, and
  ALR's refreshed local CLI again verifies both source quotations and its workbook.
  Pinpointer's current source WASM passes citation offsets and paragraph,
  subsection and printed-page DOM ranges. Its builder now remaps Cargo's configured
  user profile even under a restricted account (`73b188c`); inspection of the
  rebuilt binary confirms personal source paths are absent. Packaged extension
  binaries remain untouched.

Follow-up, November 11 (architecture; corpus gates pending on the desktop):

- A PDF is read one way: legalpdf `read_pdf` (parse cache, or parse and cache, failing where the cache cannot be
  written). The engine's `openSource` is the one open: it reports recognition progress and, without bytes, finds a
  reading cached under the key its request names. `preparePdf` (sourceDocument.ts) opens through it and returns the
  document with its summary, so callers no longer reopen a reading from the disk cache.
- `preparePdfDocument` exists only for engines that parse for another engine (a page's parse workers). Browser
  hosts go through one composition, `hostPdf` in shared/structure-engine.mjs: reopen by the key `pdfCacheKey`
  computes without bytes, else one host parse per key, the host's recognizers supplying OCR. The parse pool keeps
  no request memo of its own.
- The A2AJ store builds the engine's own document (`make`); there is no second document type for it.
- Authorities asks the engine for a source PDF's page count and the pages needing recognition (document route
  `pdf-pages`, runtime operation `source-pages`) instead of reading the PDF again with pdf.js.
- A structure's revision is the digest of its JSON written without one; the old splitter that kept an earlier
  digest is gone, so revisions computed before November 11 differ.
- legal-pdf-parser's structure stage is one crate (`legal-pdf-structure`): its 17 crates were one dependency chain.

## Profile-preserving refactor contract

Revised 2026-09-05. This section replaces earlier guidance to resolve structure
"locally, never by document genre" or to replace document profiles with a
universal candidate resolver. Profiles are overwhelmingly the correct policy
boundary. The refactor removes accidental implementation dependencies while
preserving the primary structure of each document, not flattening all detected
numbering into equally authoritative structure.

- An ordinary document has a primary structural profile governing its own
  paragraphs, sections, numbering, and interpretation of subordinate content.
  A profile is semantic policy, not just a hint to discard when a local sequence
  resembles another genre. Validated source metadata and native structure can
  establish it; absent reliable evidence, preserve uncertainty rather than
  inventing a confident classification.
- Quoted legislation, agreements, reasons, and other embedded passages may have
  internal structure. Their numbering does not become the enclosing document's
  paragraph/section spine or create a new peer document. Preserve quotation
  containment and source attribution when supported. Do not infer quotation or
  document boundaries from numbering or typography alone.
- A compound record has package structure and constituent documents occupying
  bounded spans, each with its own primary profile. A motion record's tabs,
  exhibits, and appended decisions are a separate boundary problem, not ordinary
  local role resolution. A tab may group multiple documents; a page break,
  numbering restart, or style change alone does not establish a constituent.
- Local evidence resolves roles within that ownership and profile context.
  It may expose a conflict or support a boundary for further validation; it
  must not silently switch the governing profile for each numbered run.
- Navigation and references must distinguish package locators, constituent
  locators, and quoted internal labels. Repeated paragraph 1s in separate
  documents must not collide; quoted section 5 must not satisfy a request for
  section 5 of the enclosing document. Preserve physical pages and source ranges
  independently of printed pagination and semantic numbering.

## Implementation sequence

These are planned changes, not claims that compound-document support is complete.
Preserve the existing release gates below; each stage must leave a usable engine.

1. **Freeze behavior and trace policy ownership.** Inventory the live adapters,
   profile selection, `inferred_blocks`, `detect_paragraphs`, candidate resolver,
   assembly, and query consumers. Record where profile choices, quotation
   exclusions, native claims, numbering scopes, and source ranges originate and
   where each is consumed. Freeze independently pinned complete outputs and
   production-route timing/memory before editing semantics. Reuse existing
   corpora and primitives; identify missing quotation/compound gold explicitly.
2. **Separate mechanics from policy without changing results.** Keep the current
   profiles and their proven acceptance/refusal rules. Share identical coordinate,
   grammar, validation, and assembly mechanics; keep profile-specific sequence
   selection, ambiguity rules, and native format witnesses explicit. Do not force
   non-PDF callers to fabricate page/line evidence. Route real callers through
   existing typed inputs, with no detector registry, universal evidence bag, or
   replacement semantic graph. Require exact full-output parity for this stage.
3. **Make enclosing versus quoted ownership reliable.** First audit existing
   containment, exclusions, coverage, and provenance contracts. Extend them only
   where a demonstrated product outcome cannot be expressed. Preserve quoted
   content for exact reading/search while preventing its numbering from taking
   over primary navigation or reference resolution. Fix all affected producers
   and consumers together. Any intentional correction needs independently
   reviewed expected output, not a regenerated baseline that blesses the change.
4. **Design and gate compound records separately.** Before implementing a split,
   establish reviewed boundaries on real motion records and combined submissions,
   including tabs that contain several documents, unmarked attachments, excerpts,
   repeated pagination, and cross-page boundaries. Determine which existing
   source manifests, bookmarks, tab destinations, native boundaries, and content
   evidence actually establish identity and extent. Specify package/constituent
   ownership, bounded primary profiles, offset mapping, reference scope, and
   behavior when boundaries remain ambiguous. Reuse the canonical document and
   persistence contracts; no parallel package store or speculative segmentation
   framework. If evidence is insufficient, retain exact page/text access and
   report uncertain boundaries without manufacturing peer documents.
5. **Cut over and publish a verified combination.** Exercise ingestion, saved
   artifact reopening, bounded reads, navigation, citations, notes, tables, and
   references through every affected consumer. Remove superseded production
   paths in the same cut, preserving capabilities. Enforce query/document
   identity where lazy indexes currently depend on caller discipline. Check
   the owner checkouts used by each affected consumer. Ordinary development
   does not require revision pins or binding releases.

### Additional acceptance cases

Use reviewed real-document cases, supplemented by small behavioral tests:

- A judgment quoting numbered statutory or contractual provisions retains its
  own paragraph spine; quoted numbering remains subordinate and readable.
- Long quotations, nested lists, and appended material cannot displace the
  primary spine merely by winning a document-wide sequence/length ranking.
- A genuine constituent boundary establishes a new bounded primary profile;
  a quotation, ordinary heading, page break, or restart does not do so alone.
- A motion record preserves package tabs, constituent identity and extent,
  repeated local locators, and exact physical-page/text mapping on reopening.
- Ambiguous quotations or constituent boundaries preserve source facts and
  disclose uncertainty instead of silently promoting numbering.

Report quotation and compound-boundary accuracy separately from detector parity.
Existing corpus gates cannot prove these new distinctions unless their expected
products actually include them. No corpus counts or passing receipts may be
claimed for unreviewed compound gold. Do not weaken existing profile fidelity,
throughput, memory, or authoritative-source preservation to pass new cases.

## Ownership and cutover

- Rust owns semantic text, stable IDs/nodes/notes/definitions/references/tables,
  diagnostics, shared grammars and bounded queries. Adapters preserve native
  markup/IDs/locators/coverage/provenance; never flatten authoritative structure
  and redetect it.
- Parser owns PDF loading/geometry/images/OCR/rich witnesses and calls the local
  structure crate in-process, producing the same native document, not a second
  graph. Beaver owns fetching/versions/persistence/evidence/mutation policy/UI.
- Retain format-specific semantics: PDF geometry, DOCX XML/session state, grids,
  instrument refusal and provider coverage are not a generic fact bag. Share
  neutral evidence only where two live contracts really coincide and code shrinks.
- Node has one small typed loader/wire boundary. Handles in, requested product out;
  no TS detector/resolver/projector/cache/semantic mirror, SourceDoc/navigator/
  sidecar/baked skeleton, intermediate JSON protocol or forwarding service.
  Durable native artifacts may reopen a handle, never a parallel TS graph.
- Deduplicate identical byte/scalar/UTF-16 coordinates with explicit planes/
  rounding, exact ECMAScript whitespace, shared grammars/normalization, stable
  assembly/validation and queries. Keep differing ambiguity/refusal rules separate;
  no detector traits/registries/strategy hierarchies/witness buses.
- Per cut trace producers/consumers, port mature behavior literally, compare
  complete corpus products by mismatch class, rewire all callers and delete
  duplicates/test-only/compatibility paths. Independent evidence and explicit
  receipts justify quality changes; historical detector parity is not ground truth.

## Distinct fidelity gates

| Gate | Required corpus/product |
| --- | --- |
| Instrument | 872 detector inputs: 124 agreements + 748 settled extracted texts; complete instrument product. |
| Digital-born PDF ratchet | Separate 748 cached extractions, 24,707 pages/1,221,262 lines; complete derived PDF regression product, not comprehensive structure gold. |
| Full PDF lifecycle | Roughly 1,500 documents/111,542 pages: extraction/routing, digital and OCR, structure, page/line witnesses, tables/images, diagnostics and production rehydration. The ratchet cannot substitute. |
| Providers | Frozen 323,374 A2AJ/CourtListener/journal rows, 18 Canadian gold documents, 79 pinned USLM documents: native facts, UTF-16 ranges, exact lookup/bounded queries. |
| Other capabilities | Registered DOCX/table/numbering/definition/reference/citation/amendment corpora; complete typed products. |

Measure cold/warm detection, N-API/serialization, real ingestion/query throughput
and peak memory using production loading, not isolated loops. Require exact output
and materially improved replaced paths; tracked source/test LoC stable or lower.
Batch edits with warm affected-crate checks, then full candidate corpus/release
gates. Standalone Rust/Python use direct bindings; keep one Node addon.

PDF paragraph lookup and geometry now read declared paragraph graph nodes, including
layout candidates resolved by the parser. The rebuilt-PDF range and detached-label
fixtures pass; all 30 arbitrary addresses in the range fixture are checked. Lookup
evidence retains graph IDs. The application no longer fills missing ranges from
neighbouring paragraphs or page/column guesses. This focused proof does not replace
the full corpus gates above.

### Consumer reconstruction audit (October 2026)

| Consumer | Reconstructed information | Owning-layer improvement and acceptance proof |
| --- | --- | --- |
| ALR `verifier_core/pdf_adapter.py::mark_numbered_paragraphs` | Joins layout units, redetects a monotone paragraph spine, then rebuilds paragraph spans and proposition caps. | Consume declared paragraph IDs, exact spans and note-to-proposition bounds from the maintained parser. Prove quoted/restarted numbering, unnumbered briefs and appended exhibits without a second spine detector. |
| Beaver `backend/src/lib/authoritiesImport.ts::scanReview` | Merges PDF body units after citation extraction reveals a citation crossing their boundaries; adjusts note-reference offsets. | Parser body units should preserve semantic continuation across line/page breaks and expose stable ranges. Compare citation membership and note anchors before removing the merge. Citation resolution remains the citation engine's job. |
| Shared `shared/pdf-page-binding.mjs::reporterMarginLabels` and `resolvePdfPagination`, called by `documentProjectionService.ts::paginationFor` | Rechecks page edges, repairs spaced OCR folios, reconciles embedded labels and interpolates reporter pagination. | Parser should expose observed folio candidates and uncertainty from native/OCR geometry. The citation engine can supply reporter-start evidence to a shared resolution operation. Prove covers, roman labels, duplicate folios and metadata conflicts before deleting the host heuristics. |
| Beaver folder PDF pickup | Formerly used PDF.js to read page text and vertical margin stamps. | Now uses shared native `pdfOpening` through the application/runtime port (`dbc346eab`). Both Beaver and standalone routes identify source content independently of filenames and reject PDFs above 2,000 pages with HTTP 400. The separate device-file viewer and recognition paths retain their capabilities. |

Authorities' `documentReadingOrder` calls already delegate ordering to the shared
engine; constructing citation offsets for that call is adapter work, not a second
ordering detector. Likewise, the engine's `renderSourcePdf` (assembly/statute.rs) lays out provider text
into a new PDF, so its text-outline calls are not reconstruction of an existing PDF.


## Release and retained follow-on requirements

- Maintain first-party owners directly on main; record the source combination
  used for semantic corpus proof without per-edit publication or consumer pins.
  Inspector is one vendored third-party patchset with explicit upstream updates
  preserving our modifications. No corpus/cache/generated/runtime commits.
- Preserve digital/OCR separation and optional bounded Luna repair: anchored,
  typed, validated and provenance-bearing. OCR never licenses redetection of
  authoritative provider facts.
- Finish literal citation ports; protected spans, provisions, parsed citations,
  note-body cross-references and splitting stay distinct absent exact shared proof.
  Preserve Phase 4 authored citation/split gold and acceptance.
- ALR Quote Verifier becomes a thin independent consumer after engine completion,
  not an engine copy or Beaver runtime dependency.

Done means every live consumer uses the one engine, all distinct gates pass,
there is no repeated parse/parallel semantics, LoC is stable or lower, and actual
production-route speed/memory improve. Further capabilities are not prebuilt.
