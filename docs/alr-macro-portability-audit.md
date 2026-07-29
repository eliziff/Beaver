# ALR Macro portability audit

Status: static, read-only audit completed 2026-07-26. No macro was executed and
no production code was changed.

Source:
the local ALR Macro template (`ALR_MACRO_TEMPLATE`)

SHA-256:
`683A931DADC4358A5E3494C7DCA0501090C07B96093A7306B01962A0AEE7AA1C`

This is a portability assessment, not a malware certification. The package was
opened as OOXML/OLE and the VBA source was inspected statically.

## Bottom line

Do not port the macro or its Ribbon wholesale. Most of it is publication- and
house-style-specific, depends on desktop Word's selection/story APIs, or
duplicates deterministic primitives Beaver should expose more generally.

Three ideas are broadly valuable:

1. extract footnotes into structured records while preserving meaningful run
   properties such as italics;
2. create native Word bookmarks/cross-reference fields instead of asking a
   model to renumber or relink references;
3. provide a small scope-aware, tracked batch-replacement primitive for
   mechanical editorial changes.

A fourth, optional idea is profile-based editorial linting that proposes
tracked fixes. It belongs in an explicitly selected house-style profile, not
Beaver's default prompt.

## Inventory

The template is 708,117 bytes and contains 37 ZIP package entries.
`vbaProject.bin` expands to 2,107,392 bytes. The VBA project contains 15
modules, approximately 384,568 source characters, 8,968 lines, and 165
procedures.

| Module | Source chars | Lines | Assessment |
| --- | ---: | ---: | --- |
| `McGill_maps.bas` | 148,554 | 2,401 | Large static abbreviation/dictionary data; too publication-specific for Beaver core. |
| `ALR_Suggester.bas` | 80,597 | 2,149 | Many law-review pattern transforms; mine for optional lint rules, do not port the monolith. |
| `ALR_Typesetting.bas` | 47,999 | 1,387 | ALR styles, layout, and typesetting; reject from Beaver core. |
| `ALR_SupraTools.bas` | 37,943 | 988 | Niche citation semantics, but its use of native Word cross-references is portable. |
| `ALR_Ribbon.bas` | 33,687 | 947 | Word/Ribbon UI glue around small deterministic operations; port only operations with independent value. |
| `FootnoteExport.bas` | 3,262 | 100 | Useful concept; reimplement in the neutral DOCX parser rather than importing VBA. |

Approximate API/idiom counts help characterize the design:

| Idiom | Occurrences |
| --- | ---: |
| Word Find/Execute | 32 |
| `wdReplaceAll` | 20 |
| `TrackRevisions` | 31 |
| grouped `UndoRecord` | 31 |
| Word fields | 21 |
| cross-reference calls | 3 |
| hyperlinks | 3 |
| footnote operations | 96 |
| regular expressions | 7 |
| `Scripting.Dictionary` | 15 |
| content controls/custom XML calls | 0 |

The main template document contains 45 non-empty paragraphs, about 4,884
characters, one content control, three fields, five bookmarks, and two
hyperlinks. The only content control is Word's native table-of-contents
building-block control; it is not a custom data-bound form. The package's
custom XML contains an empty bibliography source store, not a Beaver-usable data
model. The glossary contains five ALR building blocks, and the package carries
76 styles plus a substantial numbering definition.

No `Document_Open`, `AutoOpen`, `Document_Close`, or `AutoClose` procedure was
found. Ribbon callback and other Office event wiring is still present, so that
observation should not be mistaken for a security guarantee.

## Features worth translating

### 1. Structured footnote extraction

`FootnoteExport` walks Word footnotes and emits JSONL, retaining italics with
inline tags. That is exactly the kind of deterministic extraction that should
replace model rereads of an entire document.

Do not copy the procedure verbatim. It iterates character by character, assumes
a simple sequential numbering view, and is coupled to active desktop Word.
Implement the idea in the neutral OOXML parser:

```text
footnote_id
display_label
reference_order
body_runs[{text, bold, italic, underline, hyperlink}]
body_text
anchor/body location
custom_mark?
paired_proposition?
source_hash + parser_version
```

The existing DOCX tracked editor reads only `word/document.xml` and explicitly
leaves footnotes alone
([`docxTrackedChanges.ts:9`](../backend/src/lib/docxTrackedChanges.ts#L9)).
The universal legal-document layer should read `word/footnotes.xml` and its
relationships once, persist the records by content hash, and expose bounded
lookup by number/label. This complements the PDF footnote map rather than
creating a macro subsystem.

### 2. Native cross-reference fields

`AutoAddSupraCrossReferences` recognizes “supra note N” and calls Word's native
`InsertCrossReference` with the footnote number and hyperlink flag. The useful
idea is that reference rendering should be a document dependency, not prose
the model must keep synchronized.

Beaver should use the equivalent OOXML/`docx` primitives for generated material:

- bookmarks around addressable clauses, sections, tables, figures, and
  footnotes;
- `REF` for current labels/text;
- `PAGEREF` for page references;
- `SEQ` or native list/numbered-item references for numbering;
- internal hyperlinks to the bookmark.

The macro first flattens existing fields in some workflows. Do **not** copy that
strategy. It is destructive, loses dependency information, and can convert a
maintainable document into static text. Preserve unknown fields and update only
fields Beaver owns.

The prompt currently directs the model to scan and update affected references
([`prompts.ts:53`](../backend/src/lib/chat/prompts.ts#L53)). Native fields are a
strictly better default for documents Beaver generates. For an imported document
with manual references, a deterministic scan can propose tracked fixes, but it
must not assume every phrase such as “section 7” is a cross-reference.

### 3. Scope-aware mechanical edits

Several macro commands validate the active Word story or selection, use native
Find/ReplaceAll, preserve revision tracking, and group the action into one undo
record. Examples include:

- `DePeriodizer`, a literal replacement in a selected/story scope;
- dash and custom-mark cleanup;
- `ConvertToTitleCase`, which combines Word title case with follow-up small-word
  substitutions;
- revision accept/reject/highlight navigation.

The portable primitive is not any one command. It is:

```text
apply_text_transform(
  document_version,
  scope={body | footnotes | headers | selection/match_ids},
  operation={literal_replace | regex_replace | normalize},
  expected_count?,
  tracked=true
)
```

Beaver already has most of the safe DOCX substitution engine
([`docxTrackedChanges.ts:787`](../backend/src/lib/docxTrackedChanges.ts#L787)).
It should add explicit scope, occurrence/replace-all, and expected-count
guards. The model supplies the desired rule once; code finds every occurrence
and reports counts. For ordinary user edits, this is much cheaper and safer
than asking the model to enumerate every instance.

Do not reproduce Word's `Selection` object in the browser. A bounded
`match_id` list from Beaver's viewer is the portable selection.

### 4. Optional quote-span utilities

`ChiefHighlighter` expands a highlighted/quoted range deterministically, and
`QuickQuoteCopy` finds the nearest quoted/highlighted span and cleans it. A
neutral quote-range utility could support quote verification, citation
linking, and “replace this quotation” actions without sending surrounding
pages to a model.

This should reuse the same quote normalization and source-span representation
as the universal legal parser and ALR quote-linking workflow. It should not be
a standalone Word-macro port. Implement it only when a concrete UI operation
needs it.

### 5. Optional editorial lint profiles

Some `ALR_Suggester` rules are deterministic enough to become tracked
suggestions: spacing in number ranges, hyphen/en-dash normalization,
punctuation adjacent to note markers, and a few mechanical capitalization
patterns. These can remove trivial model work.

They are not universal truths. Canadian, American, British, journal, court,
client, and publisher styles differ. Represent them as small declarative rules
under an explicit profile, record the rule ID on each suggestion, and let the
user accept/reject them. A held-out corpus must measure false positives.
Never silently enable the ALR profile for general legal drafting.

## Features not worth porting

| Feature | Decision | Reason |
| --- | --- | --- |
| ALR typesetting, headers, footers, styles, and building blocks | Do not port to core | Publication-specific and best retained in the template that needs it. |
| `McGill_maps.bas` dictionaries | Do not port | Large, static, citation-style-specific data would add maintenance and prompt/tool bloat. |
| Supra/ibid semantics as general Beaver behavior | Do not port wholesale | Citation rules and house practices vary; deterministic cross-reference infrastructure is the reusable part. |
| Ribbon, forms, hotkeys, and progress UI | Do not port | Desktop Word UI code cannot serve Beaver's browser/cloud/local targets. |
| Perma CSV/UI workflow | Do not port | Beaver's provider-aware deterministic link pipeline is the cleaner boundary. |
| Excel automation/export in the macro | Do not port | Bounded SheetJS workbook operations should own spreadsheet changes. |
| Existing-field flattening | Explicitly reject | It destroys maintainable references. |
| Raw VBA import or runtime dependency on the `.dotm` | Explicitly reject | Windows desktop Word coupling, macro trust prompts, and a separate release surface. |
| Model-authored OOXML | Explicitly reject | The model should emit semantic values/rules; deterministic code owns package markup. |

## Content controls

The macro does not contain a reusable content-control system: it makes no
content-control or custom-XML API calls, and its sole document control is a
built-in TOC wrapper. It therefore provides no implementation to port.

If Beaver later adds tagged/data-bound controls, that work should be designed
against its local/cloud document contract and tested across Word,
LibreOffice, and the browser viewer. See
[Document mutation, token efficiency, and content controls](document-mutation-token-efficiency-and-content-controls.md#content-controls-and-automatically-linked-objects).

## Smallest implementation sequence

1. Extend the existing tracked substitution tool with bounded scopes,
   occurrence/replace-all, expected counts, and match handles.
2. Add neutral DOCX footnote extraction to the universal document artifact and
   expose lookup by footnote label/ID.
3. For newly generated DOCX files, use bookmarks and native fields for
   cross-references Beaver owns. Preserve all unknown fields in imported files.
4. Only after real demand, add a small editorial-lint profile containing
   independently benchmarked rules.
5. Leave the `.dotm` as the ALR-specific desktop tool. Share test cases and
   semantic rules where licensing/ownership permits, not runtime code or UI.

That sequence captures the macro's useful determinism without coupling Beaver to
Word automation or turning a specialized law-review toolbar into a general
document platform.
