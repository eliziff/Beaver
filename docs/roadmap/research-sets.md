# Saved research

Status/order/gates: [master plan](master-plan.md). Research is an ordinary movable
Library file, personal or project-scoped—not another store or custom move system.
Retain nested colour labels, versioned Library and public source references,
exact passage/evidence receipts, notes and query receipts. Bodies remain in the
source store/provider. Humans/models use the same selection and label operations.
Chat evidence stays in its transcript until the user opens a workspace or table;
that action binds the chat. Subsequent read receipts remain background provenance;
explicitly collected or grounded-answer sources enter the research collection.
Only an explicit save makes evidence a highlight. Chat, Workspace and Table are connected by the shared Open as menu.

Use the main left pane for source text and the shared right-hand dock for the
workspace. Search results occupy the main pane until a source is opened. On
narrow screens the workspace is a collapsible overlay; opening a source reveals
the reader. The previous four-panel UI snapshot is retained at
`.tmp/research-four-panel-20260905.zip`; its layout is no longer an acceptance
requirement. Preserve its capability depth: nested coloured labels/folders and
drag/drop, saved source lists, passage highlights, notes, capture rules and
Search Saved sources. Reading stays primary; collection interaction must work
in full Sources and its narrow assistant placement without clipping or jumps.
Library previews contents and offers Open in Sources, not another workspace UI.
Library stays neutral: no canonical labels workspace, membership decoration or
research-specific global classification. Add to research chooses a destination
explicitly; every research set can classify the same document differently.
A highlight type is its name, colour and optional parent, not a separate pen and
category. One deliberate highlight has one type. Choosing a type never silently
filters the source list. There are no Unsorted/Unclassified pseudo-folders.
Collection selection/name/rename are cohesive; autosave, ordinary Library placement
and existing folder interactions remain. No export concept.

The entire workspace is one Beaver Library/project file. Its source references,
verified evidence parts, source labels, highlight types, query receipts and optional Markdown
memo move and version together. Internal parts are an implementation detail;
creating or editing the memo must not create a second Library document.

Grounded answers share claims with supporting evidence IDs and an optional typed
value. Chat answers remain in their transcripts and extraction results in their
table cells. A table arrangement refers to those answers, original passages and
label assignments instead of copying them. The workspace renders the same results
and supports. Models read them with the original evidence IDs. Generated prose
never becomes a substitute primary source receipt.

Extraction freezes the selected source or passage membership before running.
Nested labels, selected results and saved passage IDs use the same selector as
bulk label operations. Library inputs pin version and source hash; public reads
retain their component hashes and report incomplete coverage explicitly. Exact
capture rules and semantic extraction keep their existing capabilities. Table
formats, full explanations, flags, per-cell regeneration, missing-only runs,
cancellation, exports and sharing remain supported.

The existing audit store records the initiating user, human/model executor,
model and available turn/call/job IDs, workspace revisions, source/passage IDs
and label changes. Provenance is metadata, not extra decoration on every row.

Organization follows the user's work. The model can create useful sets, nested
labels, questions and mixed table arrangements through the same operations as the
UI. Inputs are documents and original passages, without a decision-specific
domain model. A chosen arrangement names rows, columns and grouping and retains
separate supported branches of the same source. Opening an arranged table needs
no model call; arranging unorganized research uses the existing visible table
assistant. There is no fixed message-to-column or label-to-single-column map.

Reversibility is the default safeguard for both human and assistant changes.
History records meaningful field changes and their actor. Undo applies an inverse
only while the touched values still match, preserving unrelated later work.
Reversible work within the request applies directly; suggestions or changes
requiring a user decision use an explicit proposal. Pending proposals do not
change active labels, assignments or extraction scopes. Workspace changes and
table configuration/results commit their history with their own state through
the existing persistence ports; the UI shares History, Review and Undo controls.

Conversational readers and table extraction share the scoped reader, grounded
answer validation and model turn loop. Keep their scheduling specific to their
jobs: resumable conversational delegation and durable cell generation have
different completion and retry requirements. Consolidate further only where
the same behavior is implemented twice.

The optional memo uses normal-looking linked citations rather than Cite chips, with
bold, italics, underline, lists, headings and tables. Sources and saved passages
can be dragged into it or inserted with Insert citation. Humans and models update the same
memo through research operations; stale memo writes must not overwrite newer text.
Workspace navigation and memo recovery follow the
[behavior contract](../current/behavior-contracts.md#sources-workspace).
Queries/audit are collapsed retrieval aids
for verification and cross-model continuation, not prominent default UI.
Personal notes may inform NoteUp; project-only notes must not leak.
Remaining integration gap: NoteUp does not yet read personal saved annotations.

Read returns a bounded inventory; retrieve exact passages/previous searches on
demand, with complete paged traversal for exhaustive human/model research rather
than silently bounded analysis. Validate labels/highlights/notes/rules/query selection and memo
citations with real clicks/screenshots in both Sources placements. An authorized
live Luna-low research run must collect cases into nested labels, highlight
relevant passages, draft a memo and survive reload/model-context transfer.

## Remaining research-overhaul work

The research foundation and combined Sources/Memo/Table surface cleanup are
specified in the [current behavior contract](../current/behavior-contracts.md#sources-workspace).
These surfaces do not yet implement all the semantic conversions below.

4. Sources/Table reuse: carry classifications, saved evidence and grounded findings
   into meaningful pre-populated reviews; explicit reverse promotion.
5. Chat conversion: preserve grounded intellectual work, propose semantic mappings
   where needed and carry exact scopes between surfaces.
6. Minimal Library integration and complete round-trip browser validation.

The foundation removes `library_labels_id` and uses local schema version 17.
It follows the repository's pre-release schema replacement policy: no migration
framework or automatic old-store reset. Validate against a fresh isolated store.
