# PageIndex detection reuse and tree indexing

Status: embedded bookmarks ported (audit record below); other candidates are
planned. Project priorities remain in the
[master plan](master-plan.md), and the [shared structure plan](document-structure.md)
owns semantic contracts and corpus gates.

## Objective and order

Improve legal-document detection by copying useful PageIndex code or faithfully
porting it to Rust, building on the existing parser and structure engine. The
first task is a source-reuse audit that identifies exactly what to copy, port,
reuse locally, or leave out. Implementation follows the audit and measured
baseline.

Tree indexing is a later, separate evaluation: present source-document sections
as nested titles, summaries and range references so a model can inspect the map
and request the underlying text. Preserve that direction without starting the
retrieval work before the detection audit.

## Upstream reference and existing work

The initial source reference is [VectifyAI/PageIndex at
`6d23caf416858f2ca136840305d1f479a86f6ef7`](https://github.com/VectifyAI/PageIndex/tree/6d23caf416858f2ca136840305d1f479a86f6ef7),
committed October 1, 2026 and inspected October 4. This identifies the code being
studied; it is not a first-party consumer pin or release requirement.

Start with the current deterministic [Flash pipeline][flash-main]. Its raw
outline uses layout statistics and optional embedded bookmarks. Model summaries
and retrieval-oriented expansion are separate stages. Read the
[classic implementation][classic] for printed-contents alignment, title
verification and localized repair; do not assume its model-driven pipeline is
the current Flash detector.

Reuse the findings and limits of existing experiments:

- [Structure composer](../../legal-pdf-parser/experiments/structure-composer/PLAN.md):
  sparse corrections anchored to native source lines, heading level/parent
  changes, and provider-neutral validation. Its composition candidates are not
  independently accepted gold.
- [Heading and structure arbitration](../../experiments/jev-structure-arbiter/README.md)
  and [results](../../experiments/jev-structure-arbiter/RESULTS.md): local versus
  outline versus full-context probes, with heading demotion, wrapping and level
  errors. These are limited probes, not general corpus certification.
- [Compound witness review](../../experiments/compound-witness-review/README.md):
  producer/consumer inconsistencies, rejected-heading evidence, pagination and
  boundary hypotheses that require end-to-end reproduction.
- [Parser evidence inventory](../../legal-pdf-parser/experiments/structure-engine-parity/EVIDENCE.md):
  existing inputs, independent gold, cached extraction and full-PDF distinctions.

Keep those experiments intact. Consult their retained findings without merging
their implementations or copying unverified legacy fixtures into a new suite.

## First task: decide where to copy or port

Trace the live route from `flash/api.py` through `main.extract_toc`, per-page
processing, document statistics, classification, heading candidates, outline
assembly and embedded-bookmark reconciliation. Follow imports and callers;
directory names and apparently standalone helpers do not establish a live path.

For each candidate, record in this document:

1. Exact upstream file/functions, revision and dependency closure, including
   model types, coordinate assumptions, keyword/data tables and callers.
2. The existing local primitive, its actual production consumers, and the
   demonstrated capability gap. Distinguish unused export code from the native
   extraction-to-structure route.
3. A decision: **copy**, **port to Rust**, **reuse existing**, or **skip**, with
   the destination, behavior being retained and any deliberate legal adaptation.
4. The independent cases and measurements that would justify adoption, including
   behavior that must remain unchanged.

The following is the starting inventory, not a completed adoption decision:

| Candidate | Upstream code to inspect | Local comparison and provisional approach |
| --- | --- | --- |
| Embedded bookmarks and reconciliation | [embedded_toc.py][bookmarks]: `read_bookmarks`, `validate_bookmarks`, `classify_bookmarks`, `merge_bookmark_skeleton`, `merge_bookmark_tree`, title repair | Highest-priority port candidate. PDF extraction already opens the document and preserves embedded page labels, but no bookmark consumer was found. Read destinations through the existing PDF loader and reconcile them with anchored body headings. Copy selected Python logic as a reference if needed; port acceptance and reconciliation faithfully before adapting legal assumptions. |
| Heading candidates and unnumbered hierarchy | [heading_detection][headings]; [outline_assembly][assembly], especially `compare_heading_depth`, `should_reject_heading`, `find_parent_heading`, style groups and `find_keyword_clique` | Highest-priority port/reuse comparison. Our PDF heading levels are primarily supplied by numbered ladders. Compare mixed-style and unnumbered nesting with current heading acceptance, wrapping and body-flow vetoes. Audit whether native heading levels and existing Inspector typography evidence reach the production graph before adding another detector. |
| Contents, running furniture and line-number columns | [classification][classification]: `detect_header_footer`, `detect_toc_range`, `mark_toc_and_boilerplate`; [line_numbers.py][line-numbers] | Compare cross-page matching and contents-region detection with existing furniture, folio, contents-grid and transcript exclusions. Reuse matching local mechanics; port only demonstrated gains. Inspect destructive line-number stripping particularly carefully because source text and locators must survive. |
| Body/style statistics, grouping and reading order | [stats][stats], [blocks][blocks], [columns][columns] and [page_view.py][page-view]: `compute_doc_stats`, `cluster_lines_into_blocks`, `split_heading_body_blocks`, `detect_columns`, `assign_reading_order` | Lower-priority candidates with substantial model dependencies. Compare against current line fidelity, column arbitration, bilingual-column handling and note ordering. Copy for differential diagnosis or port a bounded algorithm when a reviewed failure justifies it; reuse available extraction evidence and preserve digital/OCR capabilities and exact source witnesses. |
| Titles, captions and outline refusal | [title][title], [labels][labels], and the validity checks in [selection.py][selection] and [main.py][flash-main] | Inspect whether they resolve current cover/title/caption false positives. Whole-outline density and chapter-count thresholds are hypotheses to test on short legal documents and attachments, not defaults to import automatically. |
| Printed contents alignment and bounded repair | [page_index_classic.py][classic]: `calculate_page_offset`, `verify_toc`, `fix_incorrect_toc`, fallback routes | Reuse the existing contents reader and printed/physical mapping first. Compare title-to-body verification and localization between confirmed neighbors. A single document-wide page offset cannot handle every compound record. Keep any model-assisted extension at the existing provider-neutral composition boundary. |
| Outline serialization and source extent | [assembly.py][assembly-output]: `outline_to_dict_tree`; bookmark `_finalize` | Inspect shared boundary pages, parent extent and leading material while evaluating detected hierarchy. Preserve exact on-page ranges and distinguish navigation extent from the heading text's own range. Retrieval-oriented serialization belongs to the later tree evaluation. |

### Audit record: embedded bookmarks (ported 2026-10-07)

1. **Upstream.** `pageindex/flash/embedded_toc.py` at `6d23caf`: `read_bookmarks`
   (pypdfium2 `get_toc`, PDFium `FPDFBookmark_GetTitle`/`GetDest`, GoTo-action
   fallback, named destinations, integer page targets, depth 15, cycle break),
   `validate_bookmarks`, `classify_bookmarks`, `_normalize_title`,
   `_title_template`, `_same_heading`/`_find_entry_node` (with
   `difflib.SequenceMatcher.ratio`), `merge_bookmark_skeleton` and
   `merge_bookmark_tree` with the FULL-tier noise filters. Live route:
   `api.page_index` → `main.extract_toc(use_embedded_toc=True)` →
   `apply_embedded_toc` after the detected outline is assembled. No model calls.
2. **Local gap.** Nothing read `/Outlines`; lopdf's own `get_toc` aborts on one bad
   entry and panics on some name trees, and the vendored Inspector has no outline
   reader. Native heading levels come only from numbered ladders, so unnumbered or
   sentence-case headings had no level, and many were not headings at all.
3. **Decision: port to Rust.** Reading lives in
   `legal-pdf-extraction-processor/src/outline.rs` (`ExtractedPdf.outline`,
   `PdfOutlineEntry` in the core model); validation, tiers and reconciliation in
   `legal-pdf-structure/src/structure/bookmarks.rs`, run after page
   classification. MIT notice and revision are in both files. Kept: decision
   order, tie handling (first of equal templates), normalization, roman-numeral
   exclusions, tier thresholds, frame/skeleton semantics, and the duplicate-title
   and overlong-title filters for FULL frames. Skipped: title repair, because
   headings keep their own source text, and page-range `_finalize`, because nodes
   keep exact source ranges.
   Deliberate legal adaptations:
   - A bookmark becomes structure only where its normalized title is found on 1–4
     consecutive lines of its target page (then the next, then the previous).
     Whole-title matches win over fragments. Body lines must match whole or differ
     only by a numbering label, such as `1 Definitions` / `Definitions` or
     `PART IV` / `Part IV Complaints committee`. A detected heading may use the
     upstream suffix and 0.7-similarity rules, but only within one heading.
     Unmatched bookmarks are abstentions, and anchors must advance through the text.
   - A matched body line is promoted to a heading unless it continues prose or
     starts lowercase. Generic titles are never promoted. A set whose titles are
     mostly longer than 100 characters indexes paragraphs and promotes nothing.
   - Detected headings under a frame heading are leveled from that heading's
     ladder level, so a sibling the bookmarks omit (`III. Facts` between bookmarked
     `II.` and `IV.`) stays a sibling. Headings before the frame, or under no found
     frame entry, keep their levels.
   - `Tab N` / `Exhibit N` / `Schedule N` sets are package navigation, not
     enumerations to ignore. They frame like a skeleton when the label is found.
   - A bookmark that targets a contents page cannot contain other bookmarks, so its
     subtree moves up one level.
4. **Measured** on bookmarked corpus PDFs with the same addon, with the outline
   present versus stripped. Columns count bookmarks found as headings, bookmarks
   whose heading parent matches the bookmark parent, and all headings.
   The corpus scan found 1,124 bookmarked PDFs among 4,024. Upstream tiers are
   335 FULL, 368 SKELETON and 421 IGNORE. Most US judgments are IGNORE because
   their outline is one file-name entry.

   | PDF (sha) | kind, tier | found | parent agrees | headings |
   | --- | --- | --- | --- | --- |
   | `53aee8d9082e` | IE judgment, FULL | 34/34 (was 0) | 34 (was 0) | 43 (was 9) |
   | `820c7c83eda4` | FCA memorandum, FULL | 25/25 (was 11) | 25 (was 4) | 44 (was 25) |
   | `dd4186ca03d7` | IE judgment, FULL | 26/27 (was 19) | 26 (was 10) | 26 (was 23) |
   | `4de2c3c5bb1c` | MB statute, FULL | 37/123 (was 8) | 29 (was 2) | 53 (was 27) |
   | `f8b67ae923ab` | AB book of authorities, SKELETON | 11/11 (was 6) | 11 (was 6) | 39 (was 34) |
   | `57ea53189046` | AB book of authorities, `TAB N` package | 14/14 | 14; case headings under tabs 14 (was 7) | 24 |
   | `f7841d037fe4` | AB brief, SKELETON | 6/7 (was 5) | 6 (was 5) | 16 (was 15) |
   | `04a4f8b839ab` | AB brief, FULL with stale nesting | 10/11 (was 8) | 4 (was 8)* | 19 (was 17) |
   | `90649fcd8719` | AB brief, SKELETON, `IV.` unbookmarked | 5/7 | 5 | 24 (was 23) |
   | `bad0ae62bd18` | IE judgment, SKELETON | 6/6 | 6 | 14 |
   | `feee97f619df` | affidavit, paragraph-index outline | 0/131 | 0 | 4 (unchanged; no promotion) |
   | `178bd799275a`, `fd81e7d9fe8d`, `0095cf419dc4` | records, `Exhibit X` / scanned | 0 | 0 | unchanged |

   *That outline nests every section under `Index` (a contents page); the native
   tree keeps them top level instead.

   Machine gold (`score_all.py`, 29 runs) has two bookmarked runs. The table below
   uses the same addon, with the outline present versus stripped:

   | Run | roles F1 | hierarchy F1 |
   | --- | --- | --- |
   | `123915cd6041` | 0.724 → 0.931 | 0 → 0.118 |
   | `bcba03d8162d` | unchanged | 0.053 → 0.080 |

   Every other run has no outline or an IGNORE tier, so reconciliation makes no
   change. Against the saved 13-run summary, hierarchy changed by +0.001. That
   change comes from concurrent work, not this port. The rest of the AU notice gap
   is a gold convention: the gold nests sections under the title, while the flat
   bookmarks do not.
   Remaining limits:
   - `legal-structure` still parents a top-level heading with no native parent to
     the enclosing statute or part section (`TAB 7 ← part3`, `Grounds of
     challenge ← art9`).
   - Synthesized statute bookmarks such as `3 Board to manage affairs,
     appointment or election`, which merges two marginal notes, are not found.
   - Exhibit stamps on scanned pages carry no text without OCR.

### Audit record: unnumbered heading hierarchy (not ported yet)

Upstream route: `assemble_outline` → `build_doc_heading_candidates`
(`scan_page_headings`, `detect_font_heading`, `detect_heading_with_body`) →
`find_keyword_clique` / `detect_body_headings`, which extend recurring non-body style
signatures to isolated blocks → `extract_sub_headings` / `find_parent_heading` with
`compare_heading_depth`. That comparison ranks special types, numbering depth,
`heading_score`, caps-heavy, centered, upright before italic, then bold. The
dependency closure includes the block model, page and document statistics, neighbor
maps, the tokenizer and keyword tries. A partial port cannot reproduce the result
honestly.

Measured gap: the Singapore Court of Appeal judgment `4105dfa1a568` has no
bookmarks. Upstream Flash, run as a reference at `6d23caf`, produces the expected
outline:

- `JUDGMENT`
  - `Introduction`
  - `Background facts`
    - `Procedural history`
  - `The parties' submissions`
  - `Issues to be determined`
  - `Issue 1: …`
    - `SUM 5 and SUM 9`
    - `The applicable law …`
  - `Issue 2: …`
    - `SUM 7`
  - `Conclusion`

Bold sets level 2 and bold italic sets level 3. The native parser finds none of the
subheadings, so its gold hierarchy F1 on this document is 0.02. The Irish judgment
`53aee8d9082e` has the same detection gap without its bookmarks: it has 9 headings,
none of them the 34 bold sentence-case section headings.

Recommended next slice: port `detect_body_headings` and `compare_heading_depth`
over the native paragraph blocks once the block segmenter lands. Run upstream Flash
as the differential oracle on the gold runs and on bookmarked PDFs with the outline
stripped. The bookmark trees are independent hierarchy evidence for that comparison.

Existing code to trace alongside that inventory:

- `legal-pdf-parser/legal-pdf-extraction/src/lib.rs` and
  `legal-pdf-extraction-processor/src/{pdf,page_labels}.rs`: extraction evidence,
  source-line identity, document loading and embedded pagination.
- `legal-pdf-parser/legal-pdf-structure/src/{structure,layout}.rs` and
  `structure/graph.rs`: classification, heading ladders, contents exclusions,
  reading order and graph parentage.
- `legal-pdf-parser/vendor/pdf-inspector/src/markdown/{heading,analysis,convert}.rs`
  and `src/structure_tree.rs`: existing style/sequence classifiers and tagged-PDF
  facts. Presence in Markdown conversion does not prove use by native consumers.
- `legal-structure/src/{instrument_contents,inference,candidates,outline}.rs`:
  contents outlines, legal profiles, ownership, resolution and navigation.

## Copying and Rust-port rules

Prefer reuse of the actual upstream implementation to an independently invented
replacement when it fills a measured gap. Preserve its decision order, tie
handling, rounding, Unicode normalization, numbering interpretation and boundary
semantics in the first port. Separately identify changes required by our legal
contracts so that port errors and intentional adaptations remain distinguishable.

A copied Python reference and its necessary support files belong in the owning
`legal-pdf-parser/experiments/pageindex-detection/` experiment if that comparison
is selected. Inspect installed dependencies before deciding how to run it. Keep
the source revision and file identities beside the harness; do not create a
temporary working repository or a second production Python parser.

PageIndex is [MIT-licensed][license]. Retain the Vectify AI copyright and license
notice with copied or substantially translated code, and record original paths
and revision. Check provenance and redistribution rights for fixtures and data
tables separately. Upstream tests establish intended upstream behavior; they
do not constitute independent legal-structure gold.

Accepted Rust code belongs to the existing owner: PDF loading, geometry and
format witnesses in `legal-pdf-parser`; format-neutral legal semantics and
queries in `legal-structure`. Preserve Inspector's upstream identity and its one
vendored patchset. Production must not import experimental code. Replace the
superseded implementation and all affected consumers together when an accepted
candidate is integrated.

## Legal adaptations to test explicitly

- A bookmark set dominated by `Tab N` or `Exhibit N` can be meaningful package
  navigation. PageIndex's repeated-template rejection would discard such a set;
  neither its rejection nor automatic promotion to constituent identity is safe
  to adopt without reviewed boundaries.
- Bookmarks can be incomplete, stale, duplicated or out of order. Distinguish
  navigation hints from evidence establishing primary structure and exact extent.
- Typography and numbering can identify subordinate quoted material. They must
  not replace the enclosing document's primary profile or create peer documents.
- Physical pages, printed pagination, source ranges and scoped semantic locators
  remain distinct. Restarts, concurrent page-number streams and two headings on
  one page must retain their own identities.
- Large heading gaps, few headings, forms, bilingual columns and sparse-text
  pages require their own evidence. A book/report heuristic cannot establish
  that legal structure is absent or a page is blank.

## Measurement and implementation sequence

1. **Complete the source-reuse decisions.** Fill the audit fields above, identify
   the smallest live dependency closure, and rank the selected slices. Keep the
   tree optimizer, summarizer and agent SDK outside this detection audit.
2. **Measure the current production route before edits.** Reuse existing corpus
   inputs and freeze complete outputs, source identities and timing/memory for
   the affected profiles. Use independently reviewed heading, parentage and
   boundary expectations; record missing gold instead of regenerating it from
   either parser. Keep bookmark-present and bookmark-absent cases distinct.
3. **Compare the selected upstream slice.** Where useful, run the copied Python
   reference and the local algorithm on equivalent evidence. Distinguish raw-PDF
   extraction differences from detection differences. Start with reviewed cases
   spanning numbered/unnumbered headings, wrapping, quotations, contents,
   furniture, forms and compound records, including negative controls.
4. **Port and validate one selected slice.** Check the owning crate, use focused
   behavioral cases and differential comparison, and preserve exact source
   text/IDs/ranges and authoritative format facts. In the parser checkout use
   `cargo quick` during iteration; link a behavioral harness only when needed.
   Use the checked-in one-job/one-worker defaults and canonical incremental
   target, with one local build/test at a time.
5. **Integrate only demonstrated improvements.** Report heading precision/recall,
   level/parent errors, boundary errors, abstention and locator outcomes separately.
   Measure production-route throughput and peak memory. Then run the affected
   candidate gates from [the structure plan](document-structure.md#distinct-fidelity-gates)
   and owning agent guides; cached extraction parity cannot certify the full PDF
   lifecycle or unreviewed compound gold.

Corpus inputs stay in `%LOCALAPPDATA%/OpenLegalData/corpus`; private benchmark
material stays in the existing private corpus or ignored
`benchmarks/local-data/<suite>/`. Public fixtures stay with their tests only after
independent provenance is established. Keep one replaceable latest output
directory per harness, clean created scratch/processes in `finally`, and retain
durable decisions here rather than accumulating raw receipts in Git.

The first implementation is ready to select when the audit names the exact
upstream code, destination owner, existing implementation it would replace,
reviewed expected outcomes and measurable adoption criteria. No comparative
accuracy or performance result has been established by this plan.

## Later: evaluate the actual PageIndex tree index

After the detection audit, separately compare the existing outline/bounded-read
path with PageIndex's source-tree presentation: nested titles, summaries,
children and source ranges. Study [tree_optimize.py][optimizer], the summary
generation in [utils.py][utils], and the actual
[structure-then-page-content tools][agent-tools]. Keep the native document and
evidence identities authoritative, with the tree as a requested navigation
projection. Summaries guide reads; answers must use retrieved source passages.

Evaluate leading/intro material, parent coverage, shared boundary pages and
reachable content before retrieval quality. Then measure useful source coverage,
exact passage/citation correctness, pages/tokens read, latency and cost against
the current route on held-out questions. Preserve all source nodes even if a
retrieval projection merges small sections. Model calls and any private-source
transmission remain subject to the existing explicit-authorization requirements.

[flash-main]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/main.py
[classic]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/page_index_classic.py
[bookmarks]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/embedded_toc.py
[headings]: https://github.com/VectifyAI/PageIndex/tree/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/heading_detection
[assembly]: https://github.com/VectifyAI/PageIndex/tree/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/outline_assembly
[classification]: https://github.com/VectifyAI/PageIndex/tree/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/classification
[line-numbers]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/phases/line_numbers.py
[stats]: https://github.com/VectifyAI/PageIndex/tree/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/stats
[blocks]: https://github.com/VectifyAI/PageIndex/tree/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/blocks
[columns]: https://github.com/VectifyAI/PageIndex/tree/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/columns
[page-view]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/phases/page_view.py
[title]: https://github.com/VectifyAI/PageIndex/tree/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/title
[labels]: https://github.com/VectifyAI/PageIndex/tree/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/labels
[selection]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/outline_assembly/selection.py
[assembly-output]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/outline_assembly/assembly.py
[license]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/LICENSE
[optimizer]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/tree_optimize.py
[utils]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/utils.py
[agent-tools]: https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/agent_tools.py
