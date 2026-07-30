# Provider structural-richness survey — 2026-07-29

Question this answers: for every provider Beaver integrates, what rich
structural information (sections, paragraphs, pages, footnotes, citation
graphs) is **already available as data** in the payloads/corpora we hold,
versus what Beaver actually consumes — i.e., where are we regex-mining
things the provider hands us for free?

Sources: read-only code survey of `backend/src/lib/**` provider clients +
recorded fixtures, plus direct probes of the local corpora (A2AJ bulk
parquets at `%LOCALAPPDATA%\ALR Quote Verifier\a2aj_corpus`, journals
`public_endpoint.db`). No network calls; local data only.

## Verdict in one paragraph

Three providers hand us native structure that Beaver throws away before
compiling blocks (CAP/CourtListener star-pagination + footnote asides; TNA
Akoma Ntoso levels + cited-authority `<ref>`s; GOV.UK ET paragraph HTML),
one provider's citation graph is stored in our own corpus but dropped at
ingest and rebuilt by regex (A2AJ cases_cited/cases_citing), and the two
lanes where we DO regex-mine (A2AJ case text, journals text) are justified
— A2AJ genuinely has no case structure to give (ALR proved this), and the
laws lane already consumes the provider's section map. The journal lane
consumes page anchors but re-derives page boundaries by regex when the
provider's `page_map_json`/`article_pages` table states them as data.

## Per-provider table

| Provider | Structure available as data | Beaver consumes | Discarded |
|---|---|---|---|
| A2AJ cases (live + bulk) | **None** (confirmed negative: no paragraph/page/offset fields; ALR `a2aj_pinpoint_recovery_plan.md` reached the same result) | text, citation, date, url, license | `scraped_timestamp_*`; server-side `start_char`/`end_char` slicing (named in a comment, never sent) |
| A2AJ laws | `unofficial_sections_{en,fr}` = provider's own **label → full section text** JSON map; `num_sections_{lang}` count | section map → the only `origin:"native"` blocks in the A2AJ lane (`sourceDocA2AJ.ts:308-346`) | `num_sections` (free ground truth for validating the spine) |
| A2AJ search / bulk | **`cases_cited_{en,fr}`, `cases_citing_{en,fr}`, `citing_cases_count`** — a ready-made citation graph, present in live search AND the local parquets | nothing | the entire graph: the bulk importer's schema drops the columns (`bulk.py:15-34`), and `build_citator_graph.py` regex-mines the graph back out of plain text while its own header documents the columns |
| A2AJ Hansard | two-level TOC (`order_of_business`/`subject_of_business`), speaker, intervention type | all, as flat metadata | no SourceDoc/locator plane at all — the TOC is never compiled into blocks |
| CourtListener + CAP | `xml_harvard` casebody: `<a id="p336" class="page-label">` **star-pagination**, `<aside class="footnote">` + footnotemarks, opinion-type articles, semantic `<p>` classes, per-block page+bbox (`data-blocks`), `<a class="citation" data-cite>` | only `<page-number>` (CourtListener's own element); CAP fixture compiles to `page 0, section 0, footnote 0`, 5 heuristic paragraphs | everything listed — and `compactOpinion` *prefers* `xml_harvard` (`courtlistener.ts:231-233`), the rendition whose anchors it can't read; also `page_count`, `sub_opinions[]`, `xml_scan` |
| TNA Find Case Law | Akoma Ntoso: `eId="para_N"` paragraphs, `eId="lvl_N"` levels + headings (the judgment TOC), FRBR metadata, judge/party/docket, `uk:hash`, **29 `<ref uk:canonical uk:type uk:year>` cited authorities** | `para_N` → native paragraph blocks; raw XML sha256 into evidence receipts | levels (`cleanSectionId("lvl_1")` fails the numeric test → `section:0` on a doc with 43 levels), subparagraphs, `<num>` labels, all `<ref>` authorities, FRBR/TLC metadata; `attachments` hard-coded `[]` so TNA's PDF/DOCX renditions are never offered |
| GOV.UK employment tribunals | `hidden_indexable_content` is HTML with `<p>[N] ...</p>` paragraph markup; attachments with `number_of_pages`; decision date/categories/landmark fields | text (tag-stripped), attachments | the HTML itself — `markup` is never passed to the compiler, so paragraph boundaries are re-derived by bracket-number regex (`origin:"heuristic"` on every block) |
| GovInfo | granules, MODS, USLM, text renditions, `pageCount` — none requested | title/docket/court/date concatenated (~48 chars) + one PDF link | everything structural; every package lands `flat_text` |
| Journals (`public_endpoint.db`) | `article_pages` (51,125 rows / 2,496 articles: article_id, page_order, **page_label ↔ pdf_page**), `page_map_json`, `pdf_page_count`, doi, issue, `text_source`, fr fields | page anchor string `page=<pdf_page>`; text with `[page N]` markers | page **boundaries** re-found by regex on `[page N]` instead of taken from the map; sections/footnotes pure regex; `pdf_page_count`, `page_export_status/notes`, doi, fr fields |
| CanLII | HTML `#parN` / `#secN` anchors on canlii.org; `name="parN"` on Decisia hosts | nothing fetched — URL construction only, anchor conventions applied blind | everything (acknowledged in-comment: per-document anchor presence cannot be known without the HTML) |

## The four highest-value "already data, currently regex" findings

1. **A2AJ citation graph → citator.** `cases_cited_*`/`cases_citing_*`/
   `citing_cases_count` exist in the live search response and in our local
   parquets. The bulk importer never persists them; the citator rebuilds
   the graph by regex-mining text with ported ToA anchor patterns. The
   provider's graph is a free differential oracle for that regex miner at
   minimum, and plausibly the primary source.
2. **CAP star-pagination + footnotes.** US reporter pinpoints are
   page-based ("at p. 880"); every CAP page boundary and footnote arrives
   as markup and compiles to zero blocks. `beaver-master-plan.md:487`
   planned this compiler; it was never built.
3. **TNA `<ref>` authorities + `<level>` TOC.** Every cited case/statute
   in a TNA judgment is a machine-readable `<ref uk:canonical>`; the
   judgment's heading tree is `lvl_N` elements. Both silently dropped —
   `section:0` on documents with 43 levels.
4. **GOV.UK ET paragraph HTML tag-stripped before compile.** The compiler
   accepts a `markup` argument; the ET lane passes only flattened text, so
   paragraphs that exist as `<p>[N]` markup are re-guessed heuristically.

## Local-corpus ground truth (probed directly this session)

- Laws parquet `unofficial_sections_en` sample (BCLAWS row): JSON map
  `{"1": "(1) On receipt of the information...", ...}` — full label→text
  section split as data, with `num_sections_en` count. The provider gives
  the section split itself; any section-spine regex for laws is redundant
  except as a cross-check.
- Cases parquets: columns are citation/name/date/url/text/cases_cited[]/
  cases_citing[]/citing_cases_count/upstream_license — **no structural
  fields**. Text-plane structure detection for cases is justified, not a
  gap.
- `public_endpoint.db`: `articles.page_map_json` =
  `[{"page":"1","pdf_pages":[1]},...]`; `article_pages` rows like
  `(132, 1, '1', 1)` — label↔pdf-page correspondence as a table.
- `lookup.duckdb` is NOT at `a2aj_corpus\lookup.duckdb` (ledger item:
  relocate via ALR `local_a2aj` before the manifest-verification work).

## Constraints on acting on any of this

- **Receipt-hash parity:** `fixtures/nativemarkup/legacy-structure.json`
  freezes rendered text, block boundaries, and `payload_sha256` per
  provider; TNA evidence receipts persist hashes over block text. Adding
  native blocks to TNA/CourtListener changes those hashes — needs a
  receipt-version bump, not an in-place edit.
- **PDF gating is already correct:** provider PDFs are fetched only when
  `structureSource === "flat_text"` — but that means TNA-class documents
  whose XML had structure the compiler failed to read get needless PDF
  ingestion.
- **Section-map divergence caveat:** when the laws section map exists,
  `compileA2AJSourceDoc` replaces document text with the concatenation of
  section bodies while `fetchA2AJDocument` still returns
  `unofficial_text` — two renditions of the same law in one process. The
  map is also never consulted for cases (correctly — it doesn't exist).
- **`SourceDocBlock` needs zero model changes** — paragraph/page/section/
  footnote kinds, anchors, and `origin: native|heuristic` already cover
  every finding above.
