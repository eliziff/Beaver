# Document mutation, token efficiency, and content controls

Status: audit complete against the dirty workspace on 2026-07-26. No
production code was changed.

## Bottom line

Beaver's DOCX editor has a sound deterministic core, but the model-facing
workflow spends far more context than that core requires. The largest strict
win is to stop treating a full-document read as the admission ticket for every
question and edit. A targeted match, a stable document-version identifier, and
a deterministic edit result are enough for many operations.

Spreadsheet support is farther behind: Beaver can read a workbook and generate a
new static workbook, but it cannot make a bounded mutation to an existing
workbook. The UI is explicitly read-only. As a result, a task that should be
`Budget!F22 = Budget!E22*1.05` either cannot be done or must be expressed as a
new whole workbook, with avoidable model context and a serious risk of losing
formatting, formulas, links, names, comments, and other workbook state.

Beaver does not currently offer general Word content-control creation or
data-bound document assembly. The installed `docx` dependency can create a
checkbox content control and has useful native field/bookmark primitives, but
Beaver's own text extractor cannot see text inside an inline content control.
Content controls are therefore a conditional future feature, not the first
fix. Bookmarks, Word fields, template placeholders, and bounded edits offer
more value with less machinery.

The companion [ALR macro portability audit](alr-macro-portability.md)
shows which deterministic editing ideas are worth carrying over from the
law-review macro. The broader
[deterministic and durable work audit](durable-work.md)
covers retrieval and persistence outside Office document mutation.

## What was measured

These measurements serialize the current TypeScript tool schemas and prompts
as UTF-8. Token counts are rough four-characters-per-token estimates, not
provider billing records; tokenization and prompt-cache discounts vary.

| Item | UTF-8 bytes | Rough tokens |
| --- | ---: | ---: |
| Base `TOOLS` schema set | 8,502 | 2,125 |
| `read_document` + `find_in_document` + `edit_document` | 3,076 | 770 |
| DOCX/XLSX generation schemas | 2,464 | 615 |
| Core DOCX/XLSX read/find/generate/edit subset | 5,539 | 1,385 |
| System prompt without research appendix | 6,997 | 1,750 |
| System prompt with research appendix | 11,468 | 2,867 |
| Citation reminder appended to a typical document read | about 550 | 138 |

The schemas are sent as part of the provider request. Beaver constructs
`baseTools` from all ordinary tools and workflow tools even when no document is
available (`streaming.ts:193`).
OpenAI continuation uses `previous_response_id`, which is good, but still
supplies instructions and tools on loop iterations
([`openai.ts:250`](../../backend/src/lib/llm/openai.ts#L250)). Claude and Gemini
also receive their system/tool definitions in their iterative loops
([`claude.ts:152`](../../backend/src/lib/llm/claude.ts#L152),
[`gemini.ts:192`](../../backend/src/lib/llm/gemini.ts#L192)). Provider-side prefix
caching can reduce the billed cost of repeated identical prefixes, but it does
not make needless schemas or full-document results free: they still occupy
context, affect cache eligibility, and must be handled by the orchestration
loop.

A 100,000-character document is roughly 25,000 input tokens. The current edit
path can read that document before the edit and then ask for the whole edited
document again, retaining approximately 50,000 document-text tokens in the
turn before the final answer. That is the dominant cost; shaving prose from a
small schema does not compensate for it.

## Current DOCX flow

### What is already good

- `applyTrackedEdits` performs deterministic, minimal substitutions and emits
  real `<w:ins>`/`<w:del>` tracked changes
  ([`docxTrackedChanges.ts:787`](../../backend/src/lib/docxTrackedChanges.ts#L787)).
  It normalizes whitespace, smart punctuation, and dashes, and refuses a match
  when the anchor is ambiguous.
- The matcher already falls back to `find` alone when the text is globally
  unique ([`docxTrackedChanges.ts:877`](../../backend/src/lib/docxTrackedChanges.ts#L877)).
  This means mandatory before/after context is a schema policy, not an engine
  requirement.
- Multiple edit calls in one assistant turn reuse one document version instead
  of producing version spam
  (`streaming.ts:216`,
  `toolDispatcher.ts:1742`).
- Repeated full reads of the same version in one turn are suppressed
  (`streaming.ts:222`).
- `find_in_document` returns bounded match windows and is the right primitive
  for pinpointed questions ([`toolSchemas.ts:226`](../../backend/src/lib/chat/tools/toolSchemas.ts#L226)).
- Project templates are copied byte-for-byte and then edited instead of being
  regenerated (`projectChat.ts:42`).
  That correctly preserves unfamiliar OOXML parts.
- The bounded Library citation-linking operation is a good model-facing
  pattern: the model supplies a document identifier while deterministic code
  performs splitting, routing, verification, and link construction
  (`localAssistantTools.ts:106`).

### Where tokens are wasted

The context builder says the model **must** call `read_document` at the start of
every response involving document content, even when it has previously read
the same version (`contextBuilders.ts:152`).
That rule conflicts with the purpose of bounded lookup. A user asking whether
one defined term appears should not have to hydrate the whole contract before
calling find.

Generation then tells the model to reread the file it just generated before
answering (`toolDispatcher.ts:589`).
Editing likewise tells it to reread the complete edited document before making
factual claims (`toolDispatcher.ts:1803`).
Those rereads are sometimes justified, but they should not be unconditional:

- A generator can return the title, section/table count, byte hash, validation
  result, and download identity deterministically.
- An edit engine already knows which exact spans succeeded or failed. It can
  return changed excerpts from the serialized output.
- A targeted verification can re-extract only the affected paragraphs. A full
  reread is warranted only when the answer depends on the document as a whole
  or the mutation could have global effects.

The edit schema requires both `context_before` and `context_after` for every
substitution ([`toolSchemas.ts:448`](../../backend/src/lib/chat/tools/toolSchemas.ts#L448)),
even though the implementation turns missing values into empty strings
([`docxTrackedChanges.ts:974`](../../backend/src/lib/docxTrackedChanges.ts#L974)).
For a unique name, date, or defined term, forcing the model to quote two more
anchors consumes output tokens and increases the chance it will mistype the
source. Context should be optional and requested only after an ambiguous
match.

`find_in_document` currently reaches the ordinary read path and reparses the
file ([`documentOps.ts:1666`](../../backend/src/lib/chat/tools/documentOps.ts#L1666)).
That is a latency problem more than a model-token problem, because the tool
returns bounded context. A small per-version parsed-text cache would make
successive finds cheap without changing the model contract.

### Correctness limits hidden by the simple tool surface

The tracked editor considers body paragraphs only; headers, footers, comments,
and footnotes are explicitly left alone
([`docxTrackedChanges.ts:9`](../../backend/src/lib/docxTrackedChanges.ts#L9)).
Edits cannot span paragraphs. Its accepted view skips prior deletions and
flattens prior insertions, so touching an existing insertion can effectively
accept/rewrite it. Those are reasonable initial constraints, but the tool
description should disclose them and route unsupported jobs to a specialized
operation.

Block-level `<w:sdt>` containers are traversed, but `flattenParagraph` reads
only direct runs and runs inside `<w:ins>`
([`docxTrackedChanges.ts:208`](../../backend/src/lib/docxTrackedChanges.ts#L208)).
An inline content control inside a paragraph is therefore invisible. A
controlled probe using the installed `docx.CheckBox` produced valid
`<w:sdt><w:sdtPr><w14:checkbox>…` markup, while Beaver's extractor returned only
the surrounding text. This is why content-control authoring must not be exposed
before extraction and edit tests cover it.

Generated legal documents use native automatic numbering, which is better than
typing clause numbers into text ([`documentOps.ts:119`](../../backend/src/lib/chat/tools/documentOps.ts#L119)).
However, the editing prompt still tells the model to scan and update affected
cross-references ([`prompts.ts:53`](../../backend/src/lib/chat/prompts.ts#L53)).
The extractor does not expose rendered list labels, so the model cannot
reliably infer every renumbering consequence from raw paragraph text. Native
bookmarks and fields should carry that dependency.

## Current XLSX flow

The read path is deliberately compact and useful for display-value questions:
it emits trimmed A1-addressed Markdown and uses each cell's formatted display
value ([`spreadsheet.ts:8`](../../backend/src/lib/spreadsheet.ts#L8)). Empty tails
are removed. The bulk tabular extractor also asks for all requested columns in
one document call rather than one call per cell
([`tabular.ts:889`](../../backend/src/routes/tabular.ts#L889)).

The limitations are material:

- Formulas are intentionally hidden; only cached/formatted results are exposed
  ([`spreadsheet.ts:10`](../../backend/src/lib/spreadsheet.ts#L10)).
- There is no range-reading tool. The entire used range of every used sheet is
  serialized even if the user asks about one cell.
- There is no spreadsheet mutation tool.
- The browser spreadsheet is explicitly `allowEdit={false}` and hides the
  formula bar
  ([`SpreadsheetView.tsx:490`](../../frontend/src/app/components/shared/views/SpreadsheetView.tsx#L490)).
- The generator manually constructs a minimal OOXML package with every value
  as an inline string
  ([`documentOps.ts:731`](../../backend/src/lib/chat/tools/documentOps.ts#L731)).
  It cannot express a typed numeric/date model, formulas, named ranges,
  comments, hyperlinks, tables, data validation, or dependable style
  preservation.
- Tabular model calls silently take only the first 120,000 characters of a
  document ([`tabular.ts:1525`](../../backend/src/routes/tabular.ts#L1525),
  [`tabular.ts:1686`](../../backend/src/routes/tabular.ts#L1686)). That is a
  bounded-context safeguard, but not retrieval; evidence near the end of a
  large source is simply unavailable.

SheetJS is already installed and its common spreadsheet format represents
formulas, hyperlinks, comments, defined names, macros, and hidden sheets. The
official [common spreadsheet format](https://docs.sheetjs.com/docs/csf/),
[cell model](https://docs.sheetjs.com/docs/csf/cell/),
[formula support](https://docs.sheetjs.com/docs/csf/features/formulae/),
[defined names](https://docs.sheetjs.com/docs/csf/features/names/), and
[hyperlink support](https://docs.sheetjs.com/docs/csf/features/hyperlinks/)
cover most of the bounded mutation surface Beaver needs. This does not require a
new spreadsheet framework.

## Ranked implementation plan

| Rank | Verdict | Smallest change | Expected effect |
| ---: | --- | --- | --- |
| 1 | Strict win | Permit `find_in_document` without a preceding full read. Treat document ID + immutable version/hash as freshness proof. | Avoids hydrating tens of thousands of tokens for pinpointed questions. |
| 2 | Strict win | Replace mandatory post-generate/post-edit full reads with a deterministic manifest and changed excerpts. Keep explicit full verification for whole-document claims. | Removes the second full copy of document text from common mutation turns. |
| 3 | Strict win | Make edit context optional; add `replace_all`, `occurrence`, or an opaque `match_id` returned by find. Retry with more context only on ambiguity. | Turns common find/replace into one small, reliable call. |
| 4 | Strict win | Add `read_spreadsheet_range` and `patch_spreadsheet_cells` using installed SheetJS. Preserve untouched package state and reject unsupported formulas/features explicitly. | Makes ordinary spreadsheet changes bounded instead of impossible or regenerative. |
| 5 | Strict win | Gate document tool schemas when the turn has no accessible document and no request to generate one. | Saves about 770 schema tokens per provider call for read/find/edit alone. |
| 6 | Strict latency win | Cache extracted DOCX text and parsed workbooks by document version/content hash; invalidate on any new version. | Avoids repeated unzip/XML/workbook parsing without changing answers. |
| 7 | Strict template win | Use the installed `docx.patchDetector`/`patchDocument` for tagged template filling; expose only a placeholder-to-value map. | Preserves template structure while minimizing model output. |
| 8 | Strict for generated docs | Generate bookmarks and `REF`/`PAGEREF`/`SEQ` or native numbered-item references for dependencies such as “section 7.3.” | Lets Word maintain renumbering rather than the model hunting references. |
| 9 | Conditional | Add tag-addressed content-control filling and custom XML binding for recurring forms. | Useful for genuine form/document-assembly workflows, but needs broader OOXML support. |
| 10 | Reject as a core pattern | External Excel-linked OLE objects. | Path, trust, Office-version, browser, and cloud fragility outweigh the convenience. |

### Minimal tool contracts

Do not create a generic document programming language. Four small operations
cover the high-value cases:

```text
find_in_document(doc_id, query, max_results) -> match_id + bounded context

edit_document(
  doc_id,
  edits=[{match_id | find, replace, occurrence?, replace_all?, reason?}]
) -> new_version + successful changed excerpts + failures

read_spreadsheet_range(doc_id, sheet, range, include=formulas|values|both)
  -> bounded A1 grid + workbook version

patch_spreadsheet_cells(
  doc_id,
  expected_version,
  patches=[{sheet, cell, value? | formula?, number_format?}]
) -> new_version + changed cells + validation warnings
```

`match_id` must encode or resolve server-side to the document version and exact
normalized span. It should fail closed if the version changes. `replace_all`
must return a count and changed excerpts. A patch should never silently
rebuild an unsupported workbook; preserve untouched ZIP parts or reject the
operation.

## Content controls and automatically linked objects

### Can Beaver create content controls now?

Not as a supported feature. The installed `docx` library exposes a
high-level [`CheckBox`](https://docx.js.org/api/classes/CheckBox.html), but not
a complete high-level API for plain-text, rich-text, date, combo, dropdown,
repeating-section, and XML-bound controls. Beaver itself has no tool contract,
tag index, custom-XML binding layer, or round-trip test suite for those
controls.

Microsoft Word supports rich/plain text, picture, combo/dropdown, building
block, date, group, checkbox, and repeating-section content controls
([content-control overview](https://learn.microsoft.com/en-us/office/vba/word/concepts/working-with-word/working-with-content-controls),
[`WdContentControlType`](https://learn.microsoft.com/en-gb/office/vba/api/word.wdcontentcontroltype)).
Controls can be bound to a custom XML part so that document display and
structured data update together
([binding guide](https://learn.microsoft.com/en-us/office/vba/word/concepts/objects-properties-methods/bind-a-content-control-to-a-node-in-the-data-store),
[custom XML overview](https://learn.microsoft.com/en-us/visualstudio/vsto/custom-xml-parts-overview)).
Repeating sections are more delicate: Word may recreate their contents from
the bound XML when a document is reopened, so edits not represented in the
data store can be lost
([OOXML repeating-section specification](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-docx/b1768ff2-c9fe-4660-86e5-73cd8c94b0a0)).

### Where controls would save model work

Controls are worthwhile when the same stable template is repeatedly populated:

- party names, addresses, dates, matter numbers, and signature metadata;
- a repeating party, asset, schedule, or line-item section;
- a clause-selection form where a deterministic rule chooses approved text;
- a document whose metadata must also be available as structured data.

The model should never emit `<w:sdt>` or custom XML. A deterministic template
scanner should expose tags such as `party.legal_name`, validate a small
key/value payload, update every occurrence, and update the bound XML part when
one exists. Unknown or duplicate tags should be reported, not guessed.

Before that feature is enabled, Beaver needs fixtures for inline/block/table
controls, locked controls, nested controls, tracked changes inside controls,
bound/unbound controls, and Word/LibreOffice/browser round trips. The extractor
must see the accepted display text without destroying control structure.

### Better first choices

For many legal documents, native fields and bookmarks solve the actual problem
with less risk:

- A [`Bookmark`](https://docx.js.org/api/classes/Bookmark.html) gives a clause,
  party, or defined term a stable internal target.
- `REF`, `PAGEREF`, `SEQ`, and numbered-item references let Word render linked
  numbering and page references. The installed `docx` package already exposes
  bookmark, internal hyperlink, simple-field, page-reference, sequential
  identifier, table-of-contents, and numbered-item-reference primitives.
- `patchDetector` and
  [`patchDocument`](https://docx.js.org/api/functions/patchDocument.html)
  can fill tagged template placeholders while retaining the rest of the
  package.

Field values may need recalculation by Word or LibreOffice; a static browser
renderer may show only the cached value. The generator should set update-on-open
where appropriate and retain a valid cached display value.

### Why external linked objects should not be the default

Word can embed an object or link to an external source
([Microsoft linked vs. embedded objects](https://support.microsoft.com/en-US/Word/linked-objects-and-embedded-objects)).
External links introduce machine-specific paths, missing-file states, update
prompts, and trust boundaries. Office commonly blocks external content for
security reasons
([external-content security](https://support.microsoft.com/en-us/office/security-privacy/block-or-unblock-external-content-in-office-documents)),
and Excel workbook links require explicit maintenance
([workbook-link management](https://support.microsoft.com/en-us/excel/manage-workbook-links)).

For Beaver's local-plus-cloud and browser-plus-desktop targets, the robust
default is a deterministic table or chart snapshot plus durable source
metadata and a normal hyperlink. Regenerate the snapshot from the source on
request. Use OLE only as an opt-in desktop export for a user who explicitly
needs live Office linking.

## Equivalence tests

The optimization is complete only when the bounded path is demonstrably
equivalent to the current full-context path where equivalence is promised.

1. **DOCX find/edit corpus:** unique replacements, repeated terms, smart
   quotes, non-breaking spaces, insert-only/delete-only changes, tables,
   existing revisions, bookmarks, hyperlinks, and ambiguous anchors.
2. **Full-read comparison:** for each bounded edit, compare the resulting OOXML
   and accepted-view text with the current full-read/edit result. Unrelated ZIP
   parts must remain byte-identical where the library permits.
3. **Version safety:** a `match_id` from version N must be rejected against
   version N+1. `replace_all` must report its exact count.
4. **Post-edit verification:** changed excerpts must equal a fresh extraction
   from the serialized output. A whole-document invariant can still trigger an
   explicit full read.
5. **Spreadsheet corpus:** formulas, dates, currencies, comments, hyperlinks,
   names, hidden sheets, merged cells, tables, macro-enabled files, and
   external links. A one-cell patch must preserve every untouched feature or
   reject the file before writing.
6. **Content controls:** do not ship authoring until Word, LibreOffice, and the
   browser viewer preserve the supported controls and Beaver can read/edit their
   displayed values.
7. **Token benchmark:** record actual provider input/output/cache tokens for
   targeted lookup, one replacement, replace-all, and one-cell spreadsheet
   patch on 10k/100k/300k-character files. The bounded path should make its
   cost essentially independent of unrelated document length.

## Recommended boundary

The model should decide **what** change is wanted and, when necessary, select
between semantically different replacements. Code should locate exact spans,
apply repeated replacements, preserve OOXML, maintain fields/numbering,
validate versions, and report what changed. That boundary uses Beaver's existing
deterministic strengths and avoids building a second word processor.
