# DOCX capability conformance — markdown↔docx matrix

The drafting representation is **"simplified for the model, exact on the
wire"**: the model drafts simplified Markdown, a deterministic renderer
converts it to `.docx`, and source `.docx` files are read back into the
model-visible drafting view. This matrix records, per feature class, what the
REAL conversion functions preserve in each direction and what each intentional
drop costs the model.

It is a **robustness** record, not a claim about the synthetic LAB corpus
(0% auto-numbering): the load is carried by the real/pathology fixtures in
`backend/src/lib/__tests__/fixtures/docx-pathologies/generate.ts`, by one
genuine regulation from `benchmarks/docx_edit/fixtures/real/`
(`ferry-boats-remission.txt`, packed line-by-line exactly as the docx-edit-bench
`realDocument` builder packs it), and by three committed corruption fixtures in
the same `real/` directory (`corrupt-style.docx`, `truncated.docx`,
`malformed-body.docx`). Those pin the degradation contract for real-world
damage: a dangling style reference warns and extracts best-effort; a truncated
ZIP and a malformed `document.xml` fail closed with a readable typed error
instead of leaking JSZip/mammoth parser internals.

## Evidence

The suite is deterministic — no LLM calls — and asserts both directions for
every class:

```
backend/src/lib/__tests__/docxCapabilityConformance.test.ts  (20 tests)
npx vitest run src/lib/__tests__/docxCapabilityConformance.test.ts   # from backend/
```

Every class row below is backed by an ingestion test (what the model sees) and
an output test (what OOXML the produced `.docx` actually carries, checked by
opening the package with JSZip).

## The exact functions under test

**INGESTION — `.docx` → model-visible**

| Surface | Module | What it is |
| --- | --- | --- |
| `extractDocxDraftingSource` | `backend/src/lib/docxDraftingSource.ts` | The drafting-source Markdown (`pandoc-markdown-v1`): the precedent view the model reads. Pandoc-based (gfm); omits images, headers/footers, comments, embedded objects with warnings; footnotes round-trip as `[^N]` markers natively. Styles are auto-patched for Pandoc heading recognition (Normal default, lowercase heading names, outline levels). |
| `extractDocxBodyText` | `backend/src/lib/docxTrackedChanges.ts` | Accepted-view body text (insertions in, deletions out), newline-joined. The plane `find` / `context_before` / `context_after` strings match against. |
| `resolveDocxNumbering` + `applyNumberingToText` | `backend/src/lib/docx/numbering.ts` | Renders the labels ("1.", "(a)") that live only in `numbering.xml` and that no extractor synthesizes, aligned to `extractDocxBodyText` paragraph indexes. |
| `projectDocxRedline` | `backend/src/lib/docx/redline.ts` | The marked-up read mode: `{++ins++}`, `{--del--}`, `{>>author: comment<<}`, `[ink]`. Deliberately NOT the drafting default. |
| `extractDocxStories` | `backend/src/lib/docx/stories.ts` | Every story part (body, footnotes, endnotes, headers, footers, text boxes) with per-run redline state — the audit surface. |

**OUTPUT — Markdown → `.docx`**

| Surface | Module | What it is |
| --- | --- | --- |
| `parseDocxMarkdown` | `backend/src/lib/chat/tools/docxMarkdown.ts` | The simplified-markdown grammar: headings (numbered/bookmarked), paragraphs, lists, tables, controls `{{tag}}`, citations `[@id]`, footnotes `[^id]`, page breaks. |
| `renderDocxMarkdown` / `renderDocxMarkdownDocument` | same | The deterministic converter; returns the `.docx` bytes. |
| `renderMarkdownDocx` | `backend/src/lib/chat/tools/documentOps.ts` | The tool-surface wrapper (`generate_docx`) around the renderer. |

## The matrix

| Feature class | Carried by simplified markdown? | Ingestion fidelity (`.docx`→view) | Output fidelity (Markdown→`.docx`) | What the drop costs |
| --- | --- | --- | --- | --- |
| **Tables — merged / nested** | Grid yes; merges and nesting no. | Cell content and `colspan`/`rowspan`/nesting survive in the drafting HTML; the drafting view warns *"Merged or nested tables must be normalized without dropping their text."* | `<w:tbl>` + `<w:tblGrid>` + fixed layout + repeat header row + cell text; no `<w:gridSpan>`/`<w:vMerge>` can be authored. | Merge structure is capturable but not round-trippable: the model must normalize (flatten) it, and the body-text plane is already linear, so a merge-aware edit has no layout anchor. |
| **Auto-numbering** | Yes — headings number by default (`{-}` or explicit "1."/"(a)" text opts out); ordered lists carry levels. | Labels exist only in `numbering.xml`; mammoth keeps `<ol>` structure but drops the rendered numbers. `resolveDocxNumbering` + `applyNumberingToText` reconstructs `1.` / `(a)` aligned to body-text indexes. | Numbered headings emit `<w:numPr>` onto a decimal **legal** list (`%1.`, `%1.%2`, `%1.%2.%3`, `w:isLgl`); ordered lists emit letter/roman level formats (`(%2)`, `(%3)`, …). | The model must not retype numbers (they would double with the auto-numbering); it references structure, not digits. Numbering beyond decimal/letter/roman (e.g. `ordinalText`) is unresolvable on ingest — reported as a note, paragraphs carry no label. |
| **Tracked changes** | No — markdown is the accepted view. | Drafting source and body text flatten to the accepted view (insertions in, deletions out) **with no warning**; the review path is `projectDocxRedline`, which is not the drafting default. | No `<w:ins>`/`<w:del>`; `settings.xml` never turns on change recording. | A model editing a marked-up source cannot accept/reject from drafting markdown — revision intent is invisible, so edits land as plain text. This is exactly the blind spot the bench's `redline-already-deleted` / `redline-struck-carveout` tasks measure. |
| **Headers / footers** | Only the always-on page-number footer. | Literal header/footer text is dropped with explicit warnings (*"Headers are not included…"*, *"Footers are not included…"*); a page-number-only footer (field codes) is **not** flagged; `extractDocxStories` still reads the parts. | An always-on right-aligned `PAGE` footer part ships on every render; no header part and no custom footer can be authored. | Running heads and custom footers are invisible to the drafting model and must be added post-render. The drafting view does flag their absence, so nothing is silently lost. |
| **Footnotes** | Yes — `[^id]` markers + `[^id]:` definitions. | Native notes become `[^N]` markers with `[^N]:` definitions (`nativeNotesToMarkers`); multi-paragraph note bodies flatten to one line with a warning; endnotes raise *"may require manual review."* | `<w:footnoteReference w:id="N"/>` in the body plus a `<w:footnote w:id="N">` part (with the separator/continuationSeparator notes every package ships). | Multi-paragraph note bodies collapse to one native note (documented); markdown never synthesizes endnotes. |
| **Text boxes** | No. | Text-box text is **off the body-text plane** (`extractDocxBodyText` drops it) yet **mammoth carries `w:txbxContent` into the drafting HTML** — an asymmetry: the model can read a text box in the drafting view but has no body-plane anchor to edit it. `extractDocxStories` reads text boxes as their own plane; no drafting warning is raised. | No `w:txbxContent` can be authored. | The drafting model sees text-box content (no warning) while the deterministic edit plane cannot address it — a review surface should reconcile the two, because the pathology sniffer's "invisible to body-text extraction" note is accurate only for the body plane, not the drafting view. |

## Round-trip finding: render → ingest → render is clean (post-Pandoc migration)

Re-ingesting a Beaver-rendered `.docx` through `extractDocxDraftingSource`
(pandoc gfm, post-2026-08-03) is now **warning-free** for the base round-trip.
Pandoc does not produce mammoth-style "Unrecognised paragraph style" warnings.
Heading styles are auto-patched (Normal default, lowercase `w:name`,
`w:outlineLvl`) so round-tripped headings preserve `#` markers. Content
controls still produce a flattening warning (unchanged).

Out of the six scored classes: a content control `{{tag}}` does not survive a
round-trip as a control — it renders as its placeholder text (`[Tag]`) and
re-ingests as that text, losing the tag. Documented so a workflow that renders
controls and then re-ingests does not expect the marker back.

## What is intentionally NOT covered

- Nested/merged **authoring** in markdown (no grammar) — asserted absent on
  output, not built.
- **Endnotes** as a markdown construct (ingest flags them; output never
  authors them).
- **Tracked-change authoring** in markdown (accepted view only).
- **Custom headers/footers, text boxes** in markdown.

No new conversion engine was written for this suite: each class is tested
against the existing kernel modules above, and classes with no kernel
coverage (custom-header authoring, text-box authoring) are recorded here as
drops rather than implemented.
