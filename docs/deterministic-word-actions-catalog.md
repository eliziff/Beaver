# Deterministic Microsoft Word actions for Mike

Status: research and implementation catalog
Date: 2026-07-26

This catalog defines which Microsoft Word operations Mike can safely perform
without asking a language model to rewrite a document. It is deliberately an
action catalog, not a proposal to expose the entire Word object model.

The short answer is:

- most explicit text, style, numbering, layout, field, note, table, and review
  operations are deterministic once the target and desired result are known;
- ambiguity should be resolved before mutation through a bounded preview with
  stable match IDs;
- legal meaning, house-style choice, heading inference, substantive comments,
  and meaningful alternative text still require human or model judgment; and
- every mutation must be bound to an immutable Library version and preserve
  unsupported OOXML or fail closed.

## Classification

| Class | Preferred surface | Meaning |
| --- | --- | --- |
| **A** | Direct UI/profile action | High-value, predictable, and understandable without model reasoning. The assistant may invoke the same backend operation, but it should also be available directly. |
| **B** | Bounded model-invoked deterministic tool | The model may choose an explicit target or supplied value. The server performs and validates the mutation; the model never authors OOXML. |
| **C** | Preview/lint, then confirm | Detection or intent can be ambiguous. Mike may find candidates deterministically, but mutation requires confirmed match IDs or an explicit profile. |
| **D** | Human/model judgment | The desired semantic result cannot be inferred safely from formatting or text alone. A deterministic tool may apply an approved result, but it must not make the decision. |

Classes describe the safest default interaction, not whether a transformation
is technically possible. For example, changing selected text to uppercase is
class B; deciding that an imported line is a legal heading is class D.

## Current Mike baseline

The status labels used below are:

- **Existing**: implemented in the current worktree.
- **Partial**: a narrower form exists, usually only for generated documents or
  the main document story.
- **Gap**: no bounded general-purpose operation exists.

Current support is useful but narrow:

| Capability | Status and boundary |
| --- | --- |
| New DOCX generation | **Existing.** `generateDocx` creates a title, Heading 1–4 paragraphs, a five-level native legal numbering definition, fixed indents and spacing, simple tables, page breaks, and portrait/landscape documents. It is generation, not preservation-safe editing of imported DOCX files. |
| Targeted search | **Existing.** `find_in_document` and `library_find` return bounded context, but not durable, version-bound match handles suitable for later mutation. |
| Tracked substitutions | **Partial.** `applyTrackedEdits` emits `w:ins`/`w:del` and supports multiple substitutions in main-body and table paragraphs. It does not edit headers, footers, comments, footnotes, or endnotes; edits cannot cross paragraphs; inline content controls are not visible; and touching a pre-existing insertion may accept its wrapper. |
| Accept/reject revisions | **Existing, narrow.** `resolveTrackedChange` accepts or rejects one known revision ID and creates another document version. |
| Citation hyperlinking | **Existing.** `library_link_docx_citations` is a bounded workflow that inspects and splits footnote citations, resolves verified provider links, and writes a new Library version. A model is used only for unresolved citation splits. |
| Updating supra references | **Existing.** `library_fix_docx_supras` adds bookmarks around ordinary footnote references and converts unambiguous `supra note N` text to native `NOTEREF ... \h` fields. It is idempotent and reports restarted, split, or otherwise unsafe cases instead of guessing. |
| General styles, fields, notes, comments, sections, headers, content controls, and accessibility mutation | **Gap.** The installed `docx` package exposes some generation primitives, but Mike has no preservation-tested, version-bound general mutation surface for these features. |

The implementation evidence is
`backend/src/lib/chat/tools/documentOps.ts`,
`backend/src/lib/docxTrackedChanges.ts`,
`backend/src/lib/docxCitationLinking.ts`,
`backend/src/lib/docxDeterministicCleanup.ts`, and
`backend/src/lib/chat/localAssistantTools.ts`. The design evidence is
[Document mutation, spreadsheets, and content controls](document-mutation-token-efficiency-and-content-controls.md)
and [ALR macro portability](alr-macro-portability-audit.md). The macro audit is
evidence for useful Word idioms, not a runtime dependency.

## One bounded mutation protocol

Mike should not add a separate prompt-visible function for every row in this
catalog. Four small operations are enough:

```text
word_inspect({
  document_id, expected_version_id,
  scope?, checks?, query?, limit?
})

word_preview({
  document_id, expected_version_id,
  op, scope?, target_ids?, selector?, args?,
  expected_count?
})

word_apply({
  preview_id, expected_version_id,
  tracked?, idempotency_key?
})

word_review({
  document_id, expected_version_id,
  op, change_ids?, comment_ids?, decision?
})
```

`op` and `args` are closed, validated unions. Tools should be capability-loaded
only when a DOCX is in scope so their schemas do not occupy every assistant
turn.

### Required common behavior

Every action below inherits these requirements:

1. **Version binding.** Inspection and preview name an exact source version.
   Apply fails if that version is no longer current.
2. **Stable targets.** A target identifies the OOXML part/story, paragraph or
   object identity, text hash, and local span. Raw character offsets alone are
   insufficient.
3. **Two-phase mutation.** Preview returns exact before/after material, target
   IDs, count, warnings, and a content hash. Apply consumes that receipt.
4. **Immutable recovery.** Apply creates a new Library version and a mutation
   manifest. Mike's dependable undo is restoring the prior version. If an
   Office-hosted desktop action is later added, Word's custom `UndoRecord` may
   group the local UI action, but it does not replace Library versioning.
5. **Preservation.** Change only the necessary package parts and relationships.
   Preserve unrecognized ZIP parts byte-for-byte where possible. Reject
   encrypted, rights-managed, protected, digitally signed, malformed, or
   unsupported targets rather than flattening them.
6. **Story awareness.** `main`, `tables`, `footnotes`, `endnotes`, `headers`,
   `footers`, `comments`, `textboxes`, and `content_controls` are distinct
   scopes. `all_supported` means an enumerated set in the receipt, never an
   implicit whole package.
7. **Structure awareness.** Do not edit through fields, hyperlinks, bookmarks,
   drawings, content controls, or tracked-change boundaries unless the
   operation explicitly supports that structure.
8. **Idempotence.** A convergent action reports no change when its desired
   property already holds. An insertion uses an idempotency key and detects the
   same semantic object before adding another one.
9. **Validation.** Reopen the output, validate package relationships and
   touched XML, extract the affected text, and compare untouched-part hashes.
   Complex features require Word round-trip fixtures before release.

The catalog abbreviates the recovery behavior as:

- **PV1**: preview by default, apply to a new immutable version, restore the
  prior version to undo; text edits may be emitted as tracked changes.
- **PV2**: lint/preview only until confirmed match IDs are supplied, then PV1.
- **PV3**: direct profile UI may apply after a concise document-level preview;
  imported documents still create a new version.
- **PV4**: review-state action creates a new version and retains the original
  revision/comment IDs and receipt.

## 1. Text and editorial mechanics

| Action | Class / support | Scope and preconditions | Word/OOXML mechanism and idempotence | Preservation risk; preview/version/undo | Model fallback | Compact tool operation |
| --- | --- | --- | --- | --- | --- | --- |
| Exact find and replace | **A / Partial** | Explicit stories, exact version, unique target or confirmed match IDs. Current support is main-body/table paragraphs only. | Word `Find.Execute` is the desktop analogue; server mutation replaces text within supported `w:p`/`w:r`/`w:t` structures. Receipt makes a repeated apply a no-op. | High at run, field, hyperlink, bookmark, revision, or inline-`w:sdt` boundaries; fail closed there. **PV1.** | Model is unnecessary unless the requested replacement text itself must be drafted. | `op:"replace_text", target_ids, args:{replacement}, expected_count` |
| Batch find/replace | **A / Partial** | A finite list of exact replacements, explicit scope, per-rule expected counts, and no overlapping targets. The existing edit tool accepts a list but lacks durable handles and story scope. | Resolve all matches first, detect overlaps, then apply in descending local-offset order under one receipt. Idempotent by source hash plus rule IDs. | One broad `ReplaceAll` can corrupt citations, defined terms, quotations, or fields. Preview a rule-by-rule count and representative contexts. **PV1.** | Model may propose rules; code finds, deduplicates, and applies them. | `op:"batch_replace", args:{rules:[{find,replacement,match_case,whole_word,expected_count}]}` |
| One-space/two-space sentence normalization | **C / Gap** | Language and house-style profile must be explicit. Exclude abbreviations, initials, decimal numbers, ellipses, citations, protected quotations, nonbreaking spaces, field results, and URLs unless individually confirmed. | Lexical scanner identifies terminal-punctuation plus whitespace spans and replaces only confirmed whitespace runs. Convergent once the requested one- or two-space form holds. | Sentence boundaries are not mechanically certain in legal prose; a global regex is unsafe. **PV2.** | Model reviews only unresolved candidate snippets; it never receives the whole document solely to change spacing. | `checks:["sentence_spacing"]`; then `op:"sentence_spacing", target_ids, args:{spaces,profile_id}` |
| Dash and hyphen normalization | **C / Gap** | Explicit style profile and confirmed occurrences. Protect minus signs, negative numbers, statutory/citation ranges, hyphenated names, XML field instructions, and verbatim quotations. | Replace selected Unicode/code-point sequences (`-`, `‐`, `‑`, `–`, `—`) without touching surrounding text. Convergent per target. | Hyphen, en dash, em dash, and minus have different legal and mathematical meaning. **PV2.** | Model classifies only ambiguous snippets, returning target ID plus desired dash kind. | `checks:["dash_usage"]`; then `op:"set_dash", target_ids, args:{kind}` |
| Straight/smart quotation-mark and apostrophe normalization | **C / Gap** | Language/locale and quote style must be explicit. Exclude primes, measurements, code, field instructions, citation punctuation, and verbatim evidence unless confirmed. | Contextual scanner proposes replacements among straight, opening/closing curly, apostrophe, and prime characters. Convergent after confirmation. Word's AutoCorrect behavior is evidence, not a safe imported-document algorithm. | Apostrophes and primes are easily confused; run boundaries can separate paired marks. **PV2.** | Model resolves only unmatched or ambiguous marks using bounded context. | `checks:["quotation_marks"]`; then `op:"set_quote_mark", target_ids, args:{style,locale}` |
| Mechanical case conversion | **B / Gap** | Exact text targets and an explicit operation: upper, lower, sentence case, or toggle. Protect case-sensitive identifiers and defined terms unless selected. | Replace selected text using locale-pinned Unicode casing; Word's `Range.Case` is the desktop analogue. Convergent except toggle, which must be receipt/idempotency-key guarded. | Casing can change acronyms, case names, party styles, bilingual text, and identifiers. **PV1.** | Model chooses targets only; it should not retype the surrounding paragraph. | `op:"set_case", target_ids, args:{mode,locale}` |
| Legal or publication title case | **C / Gap** | Named style guide, locale, protected terms/acronyms/case names, and heading targets. No profile means no automatic mutation. | Rule engine handles small words, punctuation, hyphenated compounds, and protected tokens; uncertain tokens remain findings. Convergent for a pinned profile/version. | “Capitalize Each Word” is not legal title case and can alter defined terms or authorities. **PV2.** | Model decides only unresolved tokens or supplies a proposed profile; a user may require final review. | `checks:["title_case"]`; then `op:"title_case", target_ids, args:{profile_id,protected_terms}` |
| Tabs, repeated spaces, empty paragraphs, and nonbreaking-space cleanup | **C / Gap** | Explicit checks and scopes. Protect tables, alignment tabs, signature blocks, transcript formatting, citations, fields, and intentional blank paragraphs. | Tokenize `w:t`, `w:tab`, `w:br`, paragraph marks, and `xml:space`; normalize confirmed patterns without rebuilding paragraphs. Convergent. | Visual whitespace can encode layout or filing form structure. **PV2.** | Model sees only patterns marked ambiguous, such as a possible signature line. | `checks:["whitespace","empty_paragraphs"]`; then `op:"normalize_whitespace", target_ids, args:{profile_id}` |
| Direct run formatting | **B / Gap** | Exact run/span IDs and supplied properties such as bold, italic, underline, small caps, font, size, colour, highlight, language, or hidden text. | Patch `w:rPr` on existing or minimally split runs; merge equivalent adjacent runs only when safe. Setting an already-equal property is a no-op. | Splitting/merging runs can disturb fields, hyperlinks, revisions, bookmarks, proofing IDs, or complex scripts. **PV1.** | Model can select a supplied format; it must not regenerate paragraph text. | `op:"set_run_properties", target_ids, args:{bold?,italic?,underline?,small_caps?,font?,size_half_points?,color?,highlight?,language?}` |
| Deterministic editorial lint | **C / Gap** | A named, versioned profile and bounded checks such as duplicate word, repeated punctuation, forbidden phrase, undefined abbreviation, spacing, or inconsistent term. | Read-only scanners return stable finding IDs, rule IDs, snippets, and confidence; there is no mutation until selected findings map to another catalog action. Re-running on unchanged bytes is identical. | A legal “inconsistency” may be intentional, quoted, or jurisdiction-specific. **PV2.** | Model explains or resolves only findings that code cannot classify. | `checks:["duplicate_word","repeated_punctuation","term_consistency",...], scope, limit` |

## 2. Styles, hierarchy, layout, and pagination

| Action | Class / support | Scope and preconditions | Word/OOXML mechanism and idempotence | Preservation risk; preview/version/undo | Model fallback | Compact tool operation |
| --- | --- | --- | --- | --- | --- | --- |
| Apply an existing named paragraph or character style | **A / Partial** | Explicit paragraph/run targets; style ID must exist and its type must match. Current generation assigns title/heading styles, but imported documents cannot be restyled generally. | Set `w:pPr/w:pStyle` or `w:rPr/w:rStyle`. Reapplying the same style ID is a no-op. | Direct formatting may continue to override the style; clearing it must be a separate explicit option. **PV3.** | None for explicit targets. Model judgment is required only to infer which style belongs. | `op:"apply_style", target_ids, args:{style_id,clear_direct_formatting:false}` |
| Create or update a style definition / apply a house-style profile | **A / Partial** | A versioned profile with stable style IDs, based-on/next relationships, font theme policy, and collision strategy. Current generation hardcodes a small profile. | Add or patch `word/styles.xml`; paragraph/run/table references remain by style ID. Profile application is convergent and records its profile version. | Renaming/deleting styles, changing `basedOn`, or overwriting a same-named foreign style can reflow the entire document. Never replace the styles part wholesale. **PV3.** | Model may help design a profile offline; runtime applies only a stored profile. | `op:"apply_style_profile", args:{profile_id,collision,include:["styles"]}` |
| Infer styles from visual formatting | **D / Gap** | Imported document lacks usable semantic styles; candidate groups have consistent formatting and enough context. | Deterministic clustering may propose groups, but assigning “Heading 2”, “Quotation”, or “Body Text” is a semantic decision. Once approved, `apply_style` performs the mutation. | Wrong inference changes navigation, TOC, numbering, accessibility, and pagination across the document. **PV2** for proposals, then PV1. | Model/human reviews bounded samples per cluster and approves a mapping. | `checks:["style_candidates"]`; approved mapping uses `op:"apply_style"` |
| Set heading hierarchy and outline levels | **A / Partial** | Explicit paragraph targets and levels 1–9. Current generation supports Heading 1–4; imported-document targets must be supplied. | Apply heading styles and/or `w:pPr/w:outlineLvl`; ensure style definitions contain appropriate `keepNext`/`keepLines`. Convergent. | Skipped or false heading levels harm navigation and TOC; numbering may be coupled to heading styles. **PV3.** | None for supplied levels; code checks skipped levels and duplicate IDs. | `op:"set_heading", target_ids, args:{level,style_id?,numbering_profile_id?}` |
| Infer heading hierarchy from text or appearance | **D / Gap** | Imported document lacks reliable semantic styles; candidate paragraphs and bounded surrounding structure are available. | Font/spacing/numbering rules can produce deterministic candidates, but only an approved level map is passed to `set_heading`. Re-running the detector on unchanged bytes is identical. | False headings or wrong levels change navigation, TOC, legal-numbering interpretation, and accessibility. **PV2** for proposals, then PV1. | Model/human reviews bounded candidates and assigns or rejects levels. | `checks:["heading_candidates"]`; approved mapping uses `op:"set_heading"` |
| Apply a native list or legal-numbering profile | **A / Partial** | Explicit paragraph sequence, hierarchy levels, restart/continue rule, and named numbering profile. Current generation has one five-level legal scheme. | Maintain `word/numbering.xml` abstract numbering and instances; set `w:pPr/w:numPr` with `w:numId` and `w:ilvl`. Reapplying the same mapping is a no-op. | `numId` collisions, restart semantics, and style-linked numbering can renumber unrelated text. Preserve existing definitions and allocate IDs safely. **PV3.** | None once levels are supplied. | `op:"apply_numbering", target_ids, args:{profile_id,levels,sequence}` |
| Convert manually typed markers to native numbering | **C / Partial** | A contiguous confirmed paragraph range and recognized markers. Current generation strips some decimal, letter, and Roman markers before creating a new document; it does not convert imported DOCX files. | Parse marker text, preview inferred levels, remove only the confirmed marker spans, then attach a numbering instance. Convergent after native numbering is present. | A number may be substantive text, a statutory quotation, exhibit label, paragraph number, or citation. **PV2.** | Model reviews only ambiguous marker sequences and hierarchy changes. | `checks:["manual_numbering"]`; then `op:"convert_to_numbering", target_ids, args:{profile_id,levels}` |
| Indentation, first-line/hanging indent, and tab stops | **A / Partial** | Explicit paragraph/style targets, measurement units, bidi direction, and whether direct properties or a style should own the value. Current generation uses fixed legal indents. | Patch `w:pPr/w:ind` and `w:tabs`, preferably through a named style. Exact values are convergent. | Removing tabs or changing hanging indents can break lists, signature blocks, tables of contents, and filing layouts. **PV3.** | None for explicit values; ambiguous visually aligned text goes to lint/review. | `op:"set_paragraph_layout", target_ids, args:{left?,right?,first_line?,hanging?,tabs?}` |
| Line spacing and paragraph spacing before/after | **A / Partial** | Explicit paragraph/style targets, units, and line rule. Current generated headings/body use fixed `after` values only. | Patch `w:pPr/w:spacing`, preferably in styles. Exact values are convergent. | Direct paragraph properties can defeat house styles and cause broad reflow. **PV3.** | None once a profile/value is chosen. | `op:"set_spacing", target_ids, args:{before_twips?,after_twips?,line?,line_rule?}` |
| Widow/orphan control, keep lines together, and keep with next | **A / Gap** | Explicit style/paragraph targets. A useful legal profile normally applies `keepNext` to headings and `keepLines` selectively, not to every body paragraph. | Set/remove `w:widowControl`, `w:keepLines`, and `w:keepNext` in `w:pPr` or style `w:pPr`. Boolean properties are convergent. | Excessive keep rules can produce large blank areas or apparently missing text after repagination. **PV3** with page-count/reflow warning. | Model is unnecessary for profile-driven application; it may suggest exceptional paragraphs for review. | `op:"set_pagination_controls", target_ids, args:{widow_control?,keep_lines?,keep_next?}` |
| Page or column break | **B / Partial** | Exact insertion target and break kind. Current generation can insert page breaks before generated sections. | Insert a break run (`w:br` with type) at a safe run boundary; detect an identical adjacent break before insertion. | A break inside a field, revision, content control, or table cell can be invalid or render unexpectedly. **PV1.** | Model chooses the explicit semantic location; code performs insertion. | `op:"insert_break", target_ids:[insertion_id], args:{kind}` |
| True section break and page setup | **A / Partial** | Exact paragraph boundary; section kind; margins, size, orientation, columns, vertical alignment, and header/footer linkage policy. Current generation supports one document-wide portrait/landscape setting but not true section mutation. | Insert/move `w:sectPr` at the correct paragraph/body location and patch `w:pgSz`, `w:pgMar`, `w:cols`, and `w:type`. Receipt prevents duplicate breaks. | Section properties control pagination, note settings, headers/footers, and page numbering. Moving a `sectPr` can alter every later page. **PV3** with section map before/after. | Model/human chooses intended filing layout; code validates mechanics. | `op:"set_section", target_ids:[boundary_id], args:{start,page_size?,orientation?,margins?,columns?,link_headers?}` |
| Headers and footers | **B / Gap** | Explicit section IDs; primary/first/even kind; supplied content or stored template; linkage-to-previous policy. | Add or patch header/footer parts, relationships, `w:headerReference`/`w:footerReference`, and `w:titlePg` where required. Detect the same template/content hash. | Unlinking a section can duplicate content; replacing a part can erase logos, fields, shapes, or filing information. Important substantive content should remain in the main story for accessibility. **PV1** with rendered-page preview. | Model may draft supplied text, but a template/profile should handle routine filing headers. | `op:"set_header_footer", target_ids:[section_ids], args:{kind,position,template_id?,content?,link_to_previous}` |
| Page numbers | **B / Gap** | Explicit sections, header/footer position, number format, starting/restart rule, first-page behavior, and chapter-number policy. | Insert a `PAGE` field in a header/footer and set section `w:pgNumType`; preserve or explicitly change linkage. Idempotent by section/position/field identity. | Page numbers depend on section layout and field recalculation; stale cached results are not proof of rendered pagination. **PV1** plus Word-rendered verification where exact filing pagination matters. | Model is unnecessary once the numbering instruction is explicit. | `op:"set_page_numbers", target_ids:[section_ids], args:{placement,format,start?,restart?,show_first_page}` |
| Create or edit a simple table | **B / Partial** | Exact insertion/table ID, rectangular cell data, row/column counts, and style/profile. Current generation creates simple tables with a header row. | Use `w:tbl`, `w:tblPr`, `w:tblGrid`, `w:tr`, and `w:tc`; preserve cell paragraph structure. Idempotent updates address table/cell IDs rather than recreate by position. | Merged cells, nested tables, widths, vertical merges, formulas, fields, and tracked changes make replacement unsafe. **PV1** with structural and rendered preview. | Model can supply cell values; code owns table markup. | `op:"upsert_table", target_ids?, args:{rows,style_id?,header_rows?,autofit?}` |
| Restructure a complex table | **C / Gap** | Confirmed table and row/column/cell IDs; merge/split plan; no unsupported nested or vertically merged structure unless explicitly handled. | Perform a validated grid transformation and update `gridSpan`, vertical merge state, cell properties, and contained paragraphs. Receipt describes every moved cell. | Content can move to the wrong logical cell; screen-reader structure and layout can degrade. **PV2** with full grid preview. | Model/human resolves intended logical structure; code applies an approved grid plan. | `checks:["table_structure"]`; then `op:"transform_table", target_ids, args:{operations:[...]}` |

## 3. Numbering, references, notes, fields, and content controls

| Action | Class / support | Scope and preconditions | Word/OOXML mechanism and idempotence | Preservation risk; preview/version/undo | Model fallback | Compact tool operation |
| --- | --- | --- | --- | --- | --- | --- |
| Create, rename, or remove a bookmark | **B / Partial** | Exact target range; valid unique name; paired start/end; no crossing bookmark ranges. Current supra cleanup creates a narrow internal bookmark form. | Insert paired `w:bookmarkStart`/`w:bookmarkEnd` with a unique numeric ID; rename dependent field instructions atomically. Detect same name/range. | Bookmarks can span runs and paragraphs; broken/crossing pairs invalidate references. Deletion can orphan fields and hyperlinks. **PV1.** | Model supplies a semantic label only; code validates name, range, and dependencies. | `op:"bookmark", target_ids, args:{action,name,new_name?,on_dependency}` |
| Insert or maintain REF, PAGEREF, NOTEREF, or SEQ fields | **B / Partial** | Valid bookmark or sequence target, whitelisted field type/switches, explicit display/cached-result policy. Current support creates only a narrow `NOTEREF ... \\h` pattern for supra notes. | Emit a simple `w:fldSimple` or complex begin/`w:instrText`/separate/result/end field; preserve cached result and mark dirty when appropriate. Detect equivalent field instructions. | Arbitrary field instructions are an injection and preservation risk. Page-dependent results require Word recalculation. **PV1.** | Model chooses a whitelisted intent such as “cross-reference this bookmark”; it never writes field-code text. | `op:"upsert_field", target_ids, args:{type,target,switches:[...]}` |
| Update field results | **B / Gap** | A supported Word/LibreOffice rendering host or an explicit “mark dirty only” mode; exact field IDs. | Set dirty/update flags or invoke the trusted local document application to recalculate fields, then reopen and validate. Re-running on current fields is convergent. | Server-side OOXML alone cannot calculate pagination-dependent `PAGE`/`PAGEREF` results reliably; automation can alter layout or security state. **PV1** with pre/post field inventory and render. | No model fallback. Report that exact page fields remain pending if no calculation host exists. | `op:"update_fields", target_ids, args:{mode,types?}` |
| Insert, edit, or delete a footnote | **B / Gap** | Exact insertion/reference ID or existing footnote ID; supplied content; numbering policy known; ordinary footnotes part present or safely creatable. | Maintain `word/footnotes.xml`, relationships/content types, the body `w:footnoteReference`, and `w:footnoteRef` in note content. Allocate IDs without disturbing separators. Idempotency key prevents duplicate insertion. | Reference/body mismatch, special separator IDs, restarted numbering, fields, hyperlinks, and revisions can corrupt notes. **PV1** with paired-reference validation. | Model may draft note text or choose an explicit insertion location; code owns IDs and parts. | `op:"footnote", target_ids, args:{action,content?,numbering?}` |
| Insert, edit, or delete an endnote | **B / Gap** | Same as footnotes, but endnote scope/numbering and section policy must be explicit. | Maintain `word/endnotes.xml`, `w:endnoteReference`, special separator entries, relationships, and document/section endnote properties. Idempotency key prevents duplicates. | Same pairing risks as footnotes, plus end-of-document/section placement expectations. **PV1.** | Model supplies content or target only. | `op:"endnote", target_ids, args:{action,content?,numbering?}` |
| Convert footnotes to endnotes or the reverse | **C / Gap** | Confirmed complete set or selected paired note IDs; numbering/restart mapping; no unsupported custom marks or dependent `NOTEREF` fields unless mapped. | Move note bodies between parts, replace reference element types, remap IDs, update settings/section properties and dependent fields in one transaction. | Legal citations, cross-references, numbering, and note order may change. Word rendering is required for release confidence. **PV2.** | Model/human decides whether conversion is editorially intended; code presents dependency and numbering plan. | `checks:["note_dependencies"]`; then `op:"convert_notes", target_ids, args:{to,numbering_policy}` |
| Link citations in footnotes | **A / Existing** | Owned Library DOCX; resolvable citation spans; verified provider sources. The current workflow already bounds deterministic splitting and model fallback. | Preserve note text and add standard hyperlink relationships/markup around verified citation spans. Provider results and exact spans produce the idempotence receipt. | Incorrect splitting or a provider mismatch can link the wrong authority; unresolved citations must remain unchanged and reported. New immutable version is already used. **PV3.** | Existing bounded Codex splitter handles only unresolved splits; it does not construct URLs. | Existing `library_link_docx_citations({document_id})` |
| Convert plain supra-note numbers to native cross-references | **A / Existing** | Ordinary footnotes with stable numbering; unambiguous `supra note N`; no restarted numbering or unsafe split/field/hyperlink/revision boundary. | Existing cleanup bookmarks the target `w:footnoteReference` and inserts `NOTEREF bookmark \\h`; it recognizes already-linked fields. Convergent. | Restarted numbering and ambiguous note numbers can target the wrong authority, so these are reported rather than changed. New immutable version is already used. **PV3.** | Model reasons only about reported exceptions. | Existing `library_fix_docx_supras({document_id})` |
| Insert or refresh TOC/TOA/index fields | **C / Gap** | Heading/citation/index-entry structure is already correct; whitelisted field type and switches; a field-update host is available for final rendering. | Insert whitelisted `TOC`, `TOA`, or `INDEX` field instructions and cached result/dirty state; update through Word when available. Detect an equivalent existing field. | A TOA is only as accurate as its legal citation/TA-entry classification; field refresh can reflow many pages. **PV2** with entry inventory and rendered diff. | Model/human resolves substantive classification or long/short citation form; deterministic Table of Authorities tooling should supply accepted entries. | `checks:["authority_entries"]`; then `op:"upsert_field", args:{type,switches:[...]}` |
| Create a content control | **B / Gap** | Explicit target range, supported type, stable tag/alias, unique ID, placeholder/value, and locking/binding policy. Round-trip fixtures must exist for that type. | Add `w:sdt` with `w:sdtPr`, content, ID, tag/alias, lock, and optional data binding; create custom XML parts/relationships only when requested. Detect same tag/ID. | Inline and block controls have different containment rules; careless wrapping can cross fields/bookmarks/revisions and make current text extraction miss content. **PV1.** | Model selects a stored control type/tag or supplies approved field semantics; it never authors `w:sdt` XML. | `op:"content_control", target_ids, args:{action,type,tag,alias?,lock?,value?,binding?}` |
| Fill, clear, or lock an existing content control | **A / Gap** for known template fields | Existing control selected by stable ID/tag; expected current value; control type and lock state supported. | Patch only `w:sdtContent` or `w:sdtPr/w:lock`; update mapped custom XML node when bound. Setting the same value/state is a no-op. | Repeating sections, nested controls, rich text, dates, dropdown item values, and bindings require type-specific validation. **PV3.** | Model may provide a drafted value, but direct form UI should handle ordinary fields. | `op:"content_control", target_ids, args:{action,value?}` |
| Bind a content control to custom XML | **B / Gap** | Existing supported control, declared namespace/prefix mapping, explicit XPath, and a package-owned custom XML store. | Set data-binding properties and create/update the target custom XML node and relationships. Idempotent by control ID, store item ID, and XPath. | Broken namespace/XPath or external template assumptions can display stale or blank values; avoid arbitrary XPath supplied by untrusted documents. **PV1.** | Model chooses a stored semantic field; code resolves an allowlisted binding definition. | `op:"bind_content_control", target_ids, args:{binding_profile_id,field_key}` |

## 4. Review, document stories, and accessibility

| Action | Class / support | Scope and preconditions | Word/OOXML mechanism and idempotence | Preservation risk; preview/version/undo | Model fallback | Compact tool operation |
| --- | --- | --- | --- | --- | --- | --- |
| Insert tracked text changes | **A / Partial** | Exact supported text targets, author, timestamp policy, and nonoverlapping edits. Current support is main-body/table paragraph text only. | Existing code emits `w:del`/`w:ins` with IDs and deleted-text markup. A receipt prevents reapplying the same proposed change. | Existing revisions, paragraph-crossing edits, fields, inline controls, and non-main stories remain unsafe. **PV1.** | Model drafts only replacement text/reason; deterministic code emits revision markup. | `op:"replace_text", target_ids, args:{replacement}, tracked:true` |
| Accept or reject tracked changes | **A / Partial** | Explicit change IDs from an exact version. Current `resolveTrackedChange` handles individual known IDs. | Collapse the selected insertion/deletion according to its revision type while leaving other revisions intact. Already-resolved IDs return no change. | “Accept all” may include another author's substantive edits or formatting/section revisions that the narrow implementation does not understand. **PV4.** | None; the model can summarize changes but should not accept them without an explicit instruction. | `word_review({op:"resolve_changes",change_ids,decision})` |
| Add a comment | **B / Gap** | Exact range, supplied author/initials policy, comment text, and no crossing anchors. | Add a comments-part entry and matching `w:commentRangeStart`, `w:commentRangeEnd`, and `w:commentReference` IDs. Idempotency key prevents duplicate comment insertion. | Comment anchoring across unsupported structures can orphan a comment; personal metadata must follow the local privacy policy. **PV1.** | Model may draft the substantive comment; code handles anchoring and identity. | `op:"comment", target_ids, args:{action:"add",text,author?}` |
| Resolve, reopen, or delete a comment | **A / Gap** | Explicit comment IDs and exact version; extended-comment state support must be detected. | Patch the applicable comments/comments-extended state or remove the comment and every matching anchor/reference atomically. Already-resolved/deleted is a no-op. | Deleting a comment can remove review history; unsupported modern threaded replies must fail closed. **PV4.** | None once the user chooses the action. | `word_review({op:"resolve_comments",comment_ids,decision})` |
| Compare two versions / generate a redline | **A / Gap** | Two immutable DOCX versions and a declared comparison mode. Exact Word-equivalent comparison requires a trusted Word host; a text-only diff must be labelled as such. | Produce a new comparison artifact and receipt without modifying either source. Word automation may generate native revisions; a server fallback may generate a bounded structural/text report. Same inputs/config produce the same artifact ID. | Layout, fields, moves, tables, comments, and formatting changes may be missed by text-only comparison. **PV4** because both originals remain immutable. | Model may summarize the redline after deterministic comparison, not perform the diff. | `op:"compare_versions", args:{left_version_id,right_version_id,mode}` |
| Search or replace in headers, footers, notes, comments, or text boxes | **B / Gap** | Explicit story list and the same exact-match preconditions as main text. Each story parser must be preservation-tested before exposure. | Apply story-specific traversal while retaining relationships and anchors. Receipt lists each touched part. Idempotence follows exact replace rules. | Treating the ZIP as one text stream can corrupt relationships or replace hidden/legal metadata unintentionally. **PV1.** | Model selects the requested story; code never silently expands to all stories. | `op:"replace_text", scope:["headers","footers","footnotes",...], target_ids, args:{replacement}` |
| Accessibility and structural lint | **C / Gap** | Read-only access to all supported stories/objects and a versioned rule set. Checks include heading order, missing object descriptions, table header rows, complex tables, vague link text, colour-only cues where detectable, and document language/title presence. | Inspect styles, `w:outlineLvl`, table properties, drawing nonvisual properties, hyperlinks, and package metadata. Unchanged bytes/profile yield identical findings. | Automated checks cannot determine whether structure, reading order, link wording, or alt text is actually meaningful. **PV2.** | Model/human reviews semantic findings; Microsoft's Accessibility Checker remains the final desktop check when available. | `checks:["accessibility"], args:{profile_id}` |
| Set known document metadata and language | **A / Gap** | Supplied title, subject, author policy, keywords, description, default language, or per-range language; no inference from private content unless requested. | Patch package core/extended/custom properties and `w:lang` at document/style/run scope. Exact supplied values are convergent. | Metadata can leak client names or authors; changing proofing language can alter Word behaviour. **PV3.** | Model may suggest values, but the user/profile supplies authoritative metadata. | `op:"set_metadata", args:{title?,subject?,description?,keywords?,author?,language?}` |
| Set supplied image/object/table alternative text | **B / Gap** | Exact object/table IDs and human-approved title/description or decorative flag. | Patch drawing nonvisual `docPr` description/title or applicable object/table properties without replacing media. Reapplying the same value is a no-op. | Multiple drawing vocabularies and legacy VML require separate handlers; marking meaningful content decorative is harmful. **PV1.** | Model may draft a suggestion, but it remains unapproved until the user accepts it. | `op:"set_accessibility_text", target_ids, args:{description?,title?,decorative?}` |
| Generate meaningful alternative text or decide decorative status | **D / Gap** | Object pixels, surrounding context, document purpose, and privacy constraints are available. | No purely deterministic mechanism establishes the content and purpose of a legal exhibit, diagram, seal, signature, or table. An approved result is applied with the preceding B action. | Hallucinated or incomplete descriptions can misstate evidence; transmitting confidential images to a provider is a separate authorization decision. **PV2** for suggestions only. | Multimodal model or human drafts; human review is the default for evidentiary images. | `word_inspect(... checks:["missing_alt_text"])`; approved text uses `op:"set_accessibility_text"` |

## Legal-specific protected zones

Generic word-processing automation becomes unsafe when it treats legal text as
ordinary prose. The preview engine should mark these zones and require an
explicit override or a specialized operation:

- verbatim quotations, block quotations, transcript excerpts, `sic`, and
  ellipses;
- case names, neutral citations, reporter citations, statutory citations,
  pinpoints, docket numbers, exhibit labels, and filing numbers;
- defined terms and party names, including intentionally unusual
  capitalization;
- native list numbers that encode a pleading, contract, regulation, statute,
  schedule, clause, or subclause;
- footnote/endnote references and bodies, `REF`, `PAGEREF`, `NOTEREF`, `SEQ`,
  `TOC`, and `TOA` fields;
- revision and comment ranges, particularly where authorship and review state
  matter;
- signatures, initials, dates, seals, stamps, and court-filing headers;
- hyperlinks and evidence-backed text fragments; and
- bilingual or multilingual spans whose punctuation, casing, and quotation
  rules differ.

These are not blanket prohibitions. They are signals to route the action to a
specialized deterministic tool, exact target confirmation, or class D review.

## Recommended implementation order

The smallest useful sequence is:

1. add version-bound match handles, story identifiers, preview receipts, and
   stale-version rejection around the existing search/tracked-edit core;
2. add scoped exact/batch replace and the read-only editorial/accessibility
   lint profile;
3. add style, paragraph-layout, pagination-control, and numbering profiles;
4. extend the preservation-tested story walker to footnotes/endnotes and then
   headers/footers;
5. generalize the proven bookmark/field machinery from supra cleanup;
6. add comment and content-control support only with round-trip fixtures; and
7. add Office-hosted field refresh, native compare, and render verification as
   optional capabilities, not required runtime dependencies.

Do not start with a generic “edit OOXML” tool. It would move token cost and
document-corruption risk back to the model.

## Acceptance tests

Each implemented action needs fixtures that combine the target feature with
unrelated package content:

- fragmented runs, tabs, breaks, Unicode, right-to-left text, and multiple
  languages;
- fields, hyperlinks, bookmarks, inline/block content controls, drawings, and
  text boxes;
- footnotes, endnotes, headers, footers, comments, and nested/simple tables;
- pre-existing text and formatting revisions from multiple authors;
- custom styles, numbering restarts, section-specific page numbers, and linked
  headers;
- macros in `.docm`/`.dotm`, custom XML, unknown extension parts, and custom
  properties;
- legal quotations, citations, defined terms, exhibit labels, and statutory
  numbering; and
- reopen/save/reopen in Word, text/structure equivalence, untouched-part hash
  checks, and visual PDF comparison where pagination can change.

Hard gates:

- no silent character loss or change outside confirmed targets;
- no orphan relationship, bookmark, note, comment, field, or content-control
  reference;
- stale previews cannot apply;
- a second identical apply is a no-op;
- every mutation produces a manifest and recoverable version; and
- unsupported structures are reported, not flattened.

## Official sources

Only official standards, Microsoft documentation, and Microsoft support
material were used for Word/OOXML mechanics.

### Package and WordprocessingML structure

- ECMA-376, Office Open XML:
  <https://ecma-international.org/publications-and-standards/standards/ecma-376/>
- Microsoft, “Structure of a WordprocessingML document”:
  <https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document>
- Microsoft, “Working with paragraphs”:
  <https://learn.microsoft.com/en-us/office/open-xml/word/working-with-paragraphs>
- Microsoft, “Working with WordprocessingML tables”:
  <https://learn.microsoft.com/en-us/office/open-xml/word/working-with-wordprocessingml-tables>

### Styles, paragraphs, numbering, and pagination

- Microsoft, “Apply a style to a paragraph”:
  <https://learn.microsoft.com/en-us/office/open-xml/word/how-to-apply-a-style-to-a-paragraph-in-a-word-processing-document>
- Microsoft, “Create and add a paragraph style”:
  <https://learn.microsoft.com/en-us/office/open-xml/word/how-to-create-and-add-a-paragraph-style-to-a-word-processing-document>
- Microsoft, `NumberingProperties` (`w:numPr`):
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.numberingproperties?view=openxml-3.0.1>
- Microsoft, `Indentation` (`w:ind`):
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.indentation?view=openxml-3.0.1>
- Microsoft, `SpacingBetweenLines` (`w:spacing`):
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.spacingbetweenlines?view=openxml-3.0.1>
- Microsoft, `WidowControl`:
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.widowcontrol?view=openxml-3.0.1>
- Microsoft, `KeepLines`:
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.keeplines?view=openxml-3.0.1>
- Microsoft, `KeepNext`:
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.keepnext?view=openxml-3.0.1>
- Microsoft Support, “Change the line spacing in Word”:
  <https://support.microsoft.com/en-US/Word/change-the-line-spacing-in-word>

### Find, replace, punctuation, and case

- Microsoft, Word `Find` object:
  <https://learn.microsoft.com/en-us/office/vba/api/word.find>
- Microsoft, Word `Find.Execute`:
  <https://learn.microsoft.com/en-us/office/vba/api/word.find.execute>
- Microsoft, Word `Find.Replacement`:
  <https://learn.microsoft.com/en-us/office/vba/api/word.find.replacement>
- Microsoft, Word `Range.Case`:
  <https://learn.microsoft.com/en-us/office/vba/api/word.range.case>
- Microsoft Support, “Change the capitalization or case of text”:
  <https://support.microsoft.com/en-us/Word/change-the-capitalization-or-case-of-text>
- Microsoft Support, “Smart quotes in Word and PowerPoint”:
  <https://support.microsoft.com/en-us/word/smart-quotes-in-word-and-powerpoint>

### Fields, bookmarks, notes, and content controls

- Microsoft, `BookmarkStart`:
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.bookmarkstart?view=openxml-3.0.1>
- Microsoft, `SimpleField`:
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.simplefield?view=openxml-3.0.1>
- Microsoft, `FieldChar`:
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.fieldchar?view=openxml-3.0.1>
- Microsoft, Word `Fields.Add`:
  <https://learn.microsoft.com/en-us/office/vba/api/word.fields.add>
- Microsoft Support, “List of field codes in Word”:
  <https://support.microsoft.com/en-us/word/list-of-field-codes-in-word>
- Microsoft Support, “Create a cross-reference”:
  <https://support.microsoft.com/en-us/word/create-a-cross-reference>
- Microsoft, `Footnotes`:
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.footnotes?view=openxml-3.0.1>
- Microsoft, `FootnoteReference`:
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.footnotereference?view=openxml-3.0.1>
- Microsoft, `Endnotes`:
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.endnotes?view=openxml-3.0.1>
- Microsoft, “Working with content controls”:
  <https://learn.microsoft.com/en-us/office/vba/word/concepts/working-with-word/working-with-content-controls>
- Microsoft, Word `ContentControl` object:
  <https://learn.microsoft.com/en-us/office/vba/api/word.contentcontrol>
- Microsoft, “Bind a content control to a node in the data store”:
  <https://learn.microsoft.com/en-us/office/vba/word/concepts/objects-properties-methods/bind-a-content-control-to-a-node-in-the-data-store>

### Sections, headers, footers, page numbers, and review

- Microsoft, `SectionProperties` (`w:sectPr`):
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.sectionproperties?view=openxml-3.0.1>
- Microsoft, Word `Section` object:
  <https://learn.microsoft.com/en-us/office/vba/api/word.section>
- Microsoft, Word `Sections.Add`:
  <https://learn.microsoft.com/en-us/office/vba/api/word.sections.add>
- Microsoft, “Remove the headers and footers from a word processing document”:
  <https://learn.microsoft.com/en-us/office/open-xml/word/how-to-remove-the-headers-and-footers-from-a-word-processing-document>
- Microsoft, Word `PageNumbers` object:
  <https://learn.microsoft.com/en-us/office/vba/api/word.pagenumbers>
- Microsoft, “Retrieve comments from a word processing document”:
  <https://learn.microsoft.com/en-us/office/open-xml/word/how-to-retrieve-comments-from-a-word-processing-document>
- Microsoft, Word `Document.TrackRevisions`:
  <https://learn.microsoft.com/en-us/office/vba/api/word.document.trackrevisions>
- Microsoft, Word `Revisions` collection:
  <https://learn.microsoft.com/en-us/office/vba/api/word.revisions>
- Microsoft, Word custom undo records:
  <https://learn.microsoft.com/en-us/office/vba/api/word.undorecord.startcustomrecord>

### Accessibility

- Microsoft Support, “Rules for the Accessibility Checker”:
  <https://support.microsoft.com/en-us/office/rules-for-the-accessibility-checker-651e08f2-0fc3-4e10-aaca-74b4a67101c1>
- Microsoft Support, “Make your Word documents accessible to people with
  disabilities”:
  <https://support.microsoft.com/en-US/accessibility/word/make-your-word-documents-accessible-to-people-with-disabilities>
- Microsoft Support, “Everything you need to know to write effective alt
  text”:
  <https://support.microsoft.com/en-US/Accessibility/office-accessibility/everything-you-need-to-know-to-write-effective-alt-text>
- Microsoft, drawing `DocProperties.Description`:
  <https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.wordprocessing.docproperties.description?view=openxml-3.0.1>
- Microsoft, Word `Table` object (`Title` and `Descr` properties):
  <https://learn.microsoft.com/en-us/office/vba/api/word.table>
