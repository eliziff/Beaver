# DOCX pipeline landscape audit — read/write/edit tooling for LLM agents

Status: research complete on 2026-08-03 against the public ecosystem and the
working tree. No production code was changed for this part; the report is a
comparison and a recommendation, not an implementation.

## Scope and decision rule

The question is which **existing** repositories and tools let an LLM agent read,
write, and edit `.docx` files, scored against Beaver's four criteria:

- **lean** — minimal token overhead in the model-visible representation;
- **performant** — fast on real legal documents;
- **consistent** — the same input produces the same result (determinism is a
  hard requirement, not a nice-to-have);
- **robust** — survives real-world legal DOCX pathology (auto-numbering,
  merged/nested tables, tracked changes, text boxes, headers/footers, content
  controls).

The directions are **ingest** (`.docx` → what the model reads), **output**
(markdown → `.docx`), and **edit** (surgical change to an existing `.docx`).

The adoption rule is the one already in `AGENTS.md`: a new dependency must
delete more risk or code than it adds and must have a named production caller.
Most candidates below fail that rule as a **swap**, so the useful outcome is
usually "steal one proven mechanism as a **supplement**" or "**ignore**".

## Current Beaver stack (the baseline)

| Direction | Surface | What it is |
| --- | --- | --- |
| Ingest | `extractDocxDraftingSource` (`docxDraftingSource.ts`) | mammoth (npm `1.9.0`) → simplified HTML (`beaver-precedent-html-v1`); warnings per drop class. |
| Ingest | `extractDocxBodyText` / `extractDocxBodyStructure` (`docxTrackedChanges.ts`) | Own OOXML walk → accepted-view text + native table-coordinate plane. |
| Experimental analysis | `resolveDocxNumbering` + `applyNumberingToText` (`backend/experiments/docx-analysis/numbering.ts`) | Reconstructs the `1.` / `(a)` labels that live only in `numbering.xml`; retained outside production because it has no product caller. |
| Ingest | `projectDocxRedline` (`docx/redline.ts`) | CriticMarkup read mode: `{++ins++}`, `{--del--}`, `{>>comment<<}`, `[ink]`. |
| Experimental analysis | `extractDocxStories` (`backend/experiments/docx-analysis/stories.ts`) | Audits every part (body, notes, headers, footers, text boxes) with per-run redline state; retained outside production because it has no product caller. |
| Ingest | `scanDocxPathology` (`docx/pathology.ts`) | Pre-extraction counters + routing notes (unicode traps, redline-likely, text boxes). |
| Output | `parseDocxMarkdown` + `renderDocxMarkdown` (`chat/tools/docxMarkdown.ts`) | Custom simplified-markdown grammar → the `docx` npm package (`9.7.1`). |
| Edit | `applyTrackedEdits` / `insertTrackedBlocks` / `resolveTrackedChange` (`docxTrackedChanges.ts`) | Deterministic find/context/exact-offset anchors → native `<w:ins>`/`<w:del>`; typed refusals on ambiguity. |
| Edit | `docxTextOps` | Scope-resolved text ops against the same body-text plane. |
| Kernel | `docx/core.ts` | `fast-xml-parser` preserve-order tree + `jszip`; per-part bounds; backslash-path handling. |

The pipeline is already a "markdown projection + surgical OOXML edit" design,
which is the same architecture the best LLM-docx tools converged on.

## The comparison table

| Candidate | Direction | Better than Beaver | Worse / misses | Token overhead | Surgical vs re-render | License | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **markitdown** (microsoft) | Ingest | One API over many formats (PDF, PPTX, XLSX, OCR, audio); OMML math → LaTeX; mammoth is its DOCX engine, so parity | Markdown out (no drafting HTML, no per-drop warnings); no numbering reconstruction; no tracked changes; merged-cell tables emit malformed markdown (issue #20); Python runtime | Lean markdown, but loses the structural warnings Beaver's view adds | N/A (read-only) | MIT | **Ignore** for the core (same engine, less structure); possibly a supplement for multi-format math ingest |
| **pandoc** | Ingest / output | `--track-changes=all` → CriticMarkup; robust grid tables; reads/writes nearly everything | AST less expressive than DOCX → lossy round-trip; does not reconstruct `numbering.xml` labels; markdown→docx re-renders and loses Beaver's decimal legal numbering, content controls, footnote authoring; GPL binary, not a Node library | Lean markdown, but lossy on legal structure | Re-render for output | GPL-2.0-or-later | **Ignore** as a swap; CriticMarkup read mode already exists as `projectDocxRedline` |
| **python-docx** | Ingest / output | The OSS workhorse for Word generation; comments support | No tracked changes, no content controls via API; read is an object-tree walk, not lean | High (full tree walk) | Re-render | MIT | **Ignore** (Node stack, no tracked changes, not lean) |
| **docx2python** | Ingest | Reads headers, footers, footnotes, endnotes, comments, images, checkbox selections, list positions; MIT | Extraction-only (does not write); nested-list output (paragraphs at depth 4) is not lean; no tracked-change marks; no numbering labels | High (nested structure dump) | N/A (read-only) | MIT | **Ignore** — `extractDocxStories` already covers the parts it reads |
| **Adeu** (`dealfluence/adeu`) | Ingest + edit | The closest "docx as code": token-efficient CriticMarkup projection, edits → native `<w:ins>`/`<w:del>`, unified-diff, a published fidelity spec, semantic appendix of defined terms; Python + TS core (`@adeu/core`) | Diff-and-map-back is search/replace on the projection — ambiguous matches are a class of failure Beaver's anchors refuse explicitly; its read projection has no numbering-reconstruction guarantee or drafting warnings | Lean CriticMarkup, comparable to Beaver's drafting view | Surgical (map edits to OOXML), but softer determinism than Beaver's typed refusals | MIT | **Supplement** — reference the fidelity spec and the version-diff idea; do not swap the edit kernel |
| **docx-cli / bun-docx** (kklimuk) | Ingest + edit | Stable locators (`p3:5-20`); "git is the history"; annotated markdown read; claims 2.2–2.6× fewer tokens vs default skills | CLI/Skill process boundary, not a library; benchmark is against "default skills", not a kernel like Beaver's | Lean annotated markdown | Surgical (in-place XML mutation) | MIT | **Supplement** — the stable-paragraph-locator addressing idea |
| **safe-docx** (UseJunior) | Ingest + edit | TypeScript-native, fully local; ECMA-376 conformance; revision extraction as structured JSON; saves clean + tracked copies; production use in Am Law firms | MCP process boundary; read projection is markdown, not the drafting HTML; edit model is replace-text without Beaver's table-coordinate plane | Lean | Surgical | MIT / Apache-2.0 | **Supplement** at most — the "save both" and revision-JSON outputs; the rest is already in the kernel |
| **docx-mcp** (SecurityRonin) | Ingest + edit | 200+ tools; OOXML validation; change-log generation | Huge tool surface (token overhead); Python process boundary; 200 tools violates the lean criterion | High (tool surface) | Surgical | MIT | **Ignore** (process boundary + token overhead) |
| **docx-knife** | Edit | Stable paragraph IDs (`p_000001`); cross-run `TextMap` that maps every visible char back to its `<w:t>` node; atomic batch with rollback | Python; read projection is not Beaver's drafting view | Lean | Surgical | MIT | **Supplement** — the cross-run TextMap + stable anchors are the one mechanism genuinely missing from the kernel |
| **pablospe/docx-editor** | Edit | Hash-anchored paragraph refs (`P2#f3c1`); cross-`w:ins`/`w:del`-boundary editing | Python; batch_edit API is a different contract | Lean | Surgical | MIT | **Ignore** — a Python re-implementation of the kernel's tracked-edit path |
| **omselkara/docx-editor** | Ingest + edit | LXML fast paths; atomic batch with auto-rollback; LCS diff | Gemini CLI Skill surface; Python | Lean | Surgical | (per-repo) | **Ignore** — same concept, different language |
| **OOXML + lxml surgical editing** | Edit | The canonical pattern: unzip, edit only the target part, rezip, leave every other byte identical; the Rust `ooxml_edit` engine formalizes a per-part SHA-256 blast-radius manifest | lxml is Python; the raw-XML discipline is labour-intensive without a kernel like Beaver's | Depends on the reader | Surgical by construction | MIT-family | **Already the architecture** — Beaver's `docx/core.ts` does exactly this; add the per-part hash receipt |
| **`docx` npm (9.7.1)** | Output | Native ceiling beyond what Beaver uses: tracked-changes authoring (`InsertedTextRun`/`DeletedTextRun`), comments parts, `Textbox`, first/even/odd headers, content controls, fields | A renderer, not a reader — no ingest story at all | N/A (not model-facing) | Re-render (for authored docs) | MIT | **Keep** — the ceiling confirms output-side tracked changes are an option, not a gap |

## Candidate notes

### markitdown (`microsoft/markitdown`)

The DOCX converter is **mammoth under the hood** (the Python port, `mammoth~=1.11`),
with a pre-pass that turns Office math (`m:oMathPara`) into LaTeX and a
post-pass that runs the resulting HTML through `markdownify`. For DOCX that
means it is the same engine Beaver already uses, with three differences:

1. it emits **markdown**, not Beaver's drafting HTML, so the per-drop warnings
   (`[Image omitted]`, "Headers are not included", merged-table normalization,
   tracked-changes-accepted, text-box asymmetry, content-control flattening)
   are gone from the model-visible view;
2. it does **not** reconstruct auto-numbering labels (`numbering.xml`), which
   `resolveDocxNumbering` exists to do;
3. merged/nested tables are a known failure — issue
   [#20](https://github.com/microsoft/markitdown/issues/20) shows malformed
   rows on merged cells, and the maintainers point to pandoc as the workaround.

Its genuine strengths are breadth (one `convert` API over PDF/PPTX/XLSX/OCR/EPUB
and more, MIT) and math fidelity. Neither is a reason to replace the DOCX lane.
Token overhead is lean markdown, but "lean" that quietly drops the structure
warnings Beaver's drafting view uses to keep the model honest is worse, not
better, for legal drafting.

### pandoc

Pandoc is the reference for format conversion, and its
`--track-changes=all` → CriticMarkup is a fine redline read mode. But:

- it is a **GPL-2.0-or-later whole program** (Haskell), not an embeddable Node
  library — integrating it means shelling out to a binary, which the
  engineering budget treats as a new provider/process boundary;
- its AST is less expressive than DOCX, so `.docx → markdown → .docx` is
  documented as lossy; complex tables degrade through the pipe-table → grid-table
  → HTML-table fallback (HTML tables are the only carrier of `colspan`/`rowspan`);
- it does **not** synthesize `numbering.xml` labels, and its markdown→docx
  output cannot express Beaver's decimal **legal** heading numbering
  (`%1.`/`%1.%2`/`%1.%2.%3` with `w:isLgl`), content controls, footnote
  authoring, or the always-on page-number footer.

The redline read mode is a **supplement idea Beaver already implements** in
`projectDocxRedline` (`{++ins++}`, `{--del--}`, `{>>comment<<}`).

### python-docx and docx2python

python-docx (MIT) is the default OSS Word library and is excellent for
generation and structured reads, but it has **no tracked-changes API** and **no
content-control API**, and a read is an object-tree walk — not token-lean. Its
best feature for this audit is that it can read comments. docx2python (MIT) is
extraction-only (no writing), returns a nested list with paragraphs at depth 4,
and does read headers/footers/footnotes/endnotes/comments and list positions —
a broader surface than mammoth, but Beaver's `extractDocxStories` already reads
every one of those parts with per-run redline state. Neither earns a swap.

### Adeu — the closest "docx as code"

Adeu is the project that most explicitly matches Beaver's architecture:
project the DOCX to a token-efficient Markdown/CriticMarkup representation, let
the LLM edit the projection, then map the edits back to native Word tracked
changes. It adds a published fidelity spec (`docs/FIDELITY.md`), a unified-diff
tool, a "semantic appendix" of defined terms, and both Python and pure-TypeScript
cores (`@adeu/core`). License is MIT.

The comparison that matters is in the edit determinism. Adeu's `ModifyText` is
search-and-replace against the markdown projection (`match_mode="all"`,
`regex=True`); Beaver's `applyTrackedEdits` matches against the actual OOXML
accepted-view text with `find` + `context_before`/`context_after` and
**exact byte offsets** (`exact_start`/`exact_end`), and refuses ambiguous or
absent anchors with a typed diagnosis that quotes the document's own wording.
So Adeu is the best *product* in the space, but it is a *softer* matcher than
the kernel Beaver already ships. The token overhead of its projection is the
same class as Beaver's drafting view. It is a reference to copy ideas from, not
an engine to import next to the existing one (that would be two
implementations of one workflow).

### docx-cli / bun-docx, safe-docx, docx-mcp

These are the "agent-native" tools: a CLI/Skill (`docx-cli`, MIT) with stable
locators like `p3:5-20`, a TypeScript MCP server (`safe-docx`, MIT/Apache-2.0,
ECMA-376 conformance, revision-JSON and save-both outputs), and a large Python
MCP server (`docx-mcp`, MIT, 200+ tools with OOXML validation). All are surgical
and formatting-preserving, all use markdown projections, and all are MIT.

The blocker for a swap is the process boundary (MCP/CLI) plus, in docx-mcp's
case, a 200-tool surface that is the opposite of lean. The one idea worth
stealing from this family is **stable paragraph locators** — addressing text by
a paragraph id plus offsets (`p3:5-20`) rather than by text matching. Beaver
anchors edits by normalized find/context/exact offsets and refuses ambiguity;
a stable-locator fallback would give the matcher a positional address when text
matching is genuinely ambiguous, which is exactly the failure `diagnoseAnchor`
spends a large error budget on today.

### docx-knife and the OOXML/lxml family

`docx-knife` (MIT) is the most instructive of the Python surgical editors: it
assigns **stable paragraph ids** (`p_000001`) that survive edits to other
paragraphs, and its **cross-run TextMap** concatenates visible text across all
`<w:t>` nodes while mapping every character back to its source node — so
find/replace works even when a word is fragmented across runs. Beaver's
`flattenParagraph` already solves the cross-run fragmentation for the *accepted
view* and maps offsets back via `charRun`/`charTextNode`/`charOffset` arrays,
so the TextMap concept is present in a different shape. The genuinely missing
piece is the **stable paragraph id** and the per-part hash "blast radius"
manifest (formalized by the Rust `ooxml_edit` engine: mutate only the targeted
part, prove every other part is byte-identical). Beaver pins a `source_sha256`
for the whole package but not per-part hashes.

### The `docx` npm package ceiling (9.7.1)

Beaver's renderer uses `Document`, `Packer`, `Paragraph`, `TextRun`,
`Table`/`TableCell`/`TableRow`, `Bookmark`, `ExternalHyperlink`, `Footer`,
`FootnoteReferenceRun`, `HeadingLevel`, `ImportedXmlComponent` (for content
controls), the `LevelFormat`/`LevelSuffix` numbering config, `PageBreak`,
`PageNumber`, `PageOrientation`, `WidthType`, `AlignmentType`, `BorderStyle`,
and `TableLayoutType`. The conformance fixtures (`fixtures/docx-pathologies/generate.ts`)
prove the packager also emits `InsertedTextRun`/`DeletedTextRun`,
`CommentRangeStart`/`CommentRangeEnd`/`CommentReference`, `Textbox`, and
`TableCell` with `columnSpan`/`rowSpan`.

The unused ceiling is therefore: **native tracked-changes authoring**,
**comments authoring**, **text boxes**, and **first/even/odd headers**.
Beaver deliberately does not author tracked changes on output (markdown is the
accepted view; revisions are produced by `applyTrackedEdits` against an existing
document). If markdown ever carried revision markers, the renderer could emit
`<w:ins>`/`<w:del>` directly instead of via the separate edit path — the
ceiling confirms that is an option, not a gap. Nothing else in the `docx`
package is unused in a way that costs Beaver capability.

## What is already inside Beaver (and often overlooked)

The tools above converged on Beaver's architecture independently. It is worth
recording that the following "new" ideas from the ecosystem already exist in the
tree:

- CriticMarkup redline read mode → `projectDocxRedline`;
- tracked-change application → `applyTrackedEdits` (with deterministic anchors
  and typed refusals that none of the surveyed tools match);
- text-box awareness → `scanDocxPathology` counts them, `extractDocxStories`
  reads them, and (as of 2026-08-03) the drafting source warns that their text
  is visible but not body-addressable;
- content-control awareness → `scanDocxPathology` counts `w:sdt`, and the
  drafting source now warns when a control flattens to its placeholder;
- story-part reading → `extractDocxStories`;
- surgical OOXML editing with a bounded package contract → `docx/core.ts`.

## Recommendation

### Adopt (swap in)

**Nothing.** Every candidate fails the "deletes more risk than it adds" test
against the existing kernel, and most are Python or process-boundary
re-implementations of what the tree already does. In particular:

- **Do not adopt markitdown for DOCX ingest.** It is the same mammoth engine
  with fewer structural guarantees (no drafting warnings, no numbering
  reconstruction, malformed merged-cell tables). Its multi-format breadth is a
  different surface, not a DOCX improvement.
- **Do not adopt pandoc for output.** Its markdown→docx cannot express Beaver's
  legal numbering, content controls, or footnote authoring, and GPL + whole
  program conflicts with the Node kernel.
- **Do not adopt Adeu / docx-cli / safe-docx / docx-mcp as engines.** They are
  either softer matchers (Adeu), process boundaries (CLI/MCP), or huge tool
  surfaces (docx-mcp). Beaver's edit kernel is already the most deterministic
  matcher in the surveyed set.

### Supplement (steal one proven mechanism)

1. **Stable paragraph locators as an alternate addressing mode** for the
   tracked-edit matcher (from `docx-knife` / `docx-cli` / Adeu). When
   `diagnoseAnchor` reports an ambiguous or absent match, a positional fallback
   (`paragraph 3, chars 5–20`) would give the model a second way to pin an edit
   that does not depend on verbatim text. This is the single highest-value idea
   in the landscape for the edit direction.
2. **Per-part hash receipt** (from the `ooxml_edit` blast-radius manifest). A
   per-part SHA-256 before/after around an edit would let Beaver *prove* which
   parts an edit touched — a strict strengthening of the whole-package
   `source_sha256` today, and useful for the durable-edit-receipt invariant in
   `AGENTS.md`.

Optional third, only if the output direction grows a "track changes on the
render" need: author `<w:ins>`/`<w:del>` directly from the `docx` npm package's
`InsertedTextRun`/`DeletedTextRun` instead of routing through `applyTrackedEdits`.
The ceiling is already in the dependency.

### Ignore

markitdown (for DOCX), pandoc (as a swap), python-docx, docx2python, docx-mcp,
pablospe/docx-editor, omselkara/docx-editor. Each is either the same engine with
less control, a Python re-implementation of the kernel, a process boundary, or
a token-expensive surface.

## Direction verdict

- **Ingest (`.docx` → model):** keep mammoth + the kernel planes. No surveyed
  tool reads DOCX with more legal-structure honesty than the current stack; the
  closest (markitdown) is the same engine with the warnings stripped out.
- **Output (markdown → `.docx`):** keep `parseDocxMarkdown` /
  `renderDocxMarkdown`. Pandoc and markitdown both lose the legal numbering and
  control grammar; the `docx` npm package's unused ceiling (tracked changes,
  comments, text boxes, first/even/odd headers) is optional capability, not a
  gap.
- **Edit:** keep `applyTrackedEdits` + `docxTextOps` + exact offsets. It is the
  most deterministic matcher in the surveyed ecosystem. The one worthwhile
  adoption is a stable-paragraph-locator fallback, plus a per-part hash receipt
  to prove the edit's blast radius.
