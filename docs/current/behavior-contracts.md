# Beaver behavior contracts

Status: current user-visible contract

These are capabilities and invariants that refactors preserve. Current module
boundaries are not contracts; neither are incidental response wording, CSS
classes, database column names, or a particular provider SDK.

## One application in local and cloud compositions

- Account-free local mode starts with anonymous identity and requires no cloud
  service.
- Cloud mode adds authentication, sharing, MFA, audit, private object storage,
  and account administration.
- Library, documents, projects, workflows, chats, tabular reviews, assistant
  tools, document actions, and their browser behavior use the same application
  operations and public resource semantics.
- A deployment adapter may change persistence or identity mechanics, never the
  ordinary product rule.
- An unavailable cloud-only account capability fails explicitly. It does not
  create a second local implementation.

## Growing resources

Assistant conversations live beneath Assistant in the sidebar, with a separate
new-conversation action and a searchable, paged conversation browser. Projects,
Library, and Sources remain primary destinations; Workflows, Court Records,
Authorities, and Tabular Review stay visible under Tools. The sidebar never
scrolls; its recent-conversation list scrolls internally, showing up to five rows with no visible scrollbar
within the available height, and All
conversations provides the complete searchable list. Activity log and Recycling bin
are available from the bottom utility menu. Project conversations retain their
project navigation and context.

Projects, workflows, tabular reviews, Library directories, and project
directories provide:

- bounded pages with stable deterministic ordering;
- opaque cursors bound to the resource, normalized filters, and last row;
- owner/scope filtering before existence or payload is revealed;
- literal server-side search and exact-ID reads that do not scan a page;
- the same cursor and filter behavior in local and cloud compositions; and
- shared frontend paging/directory primitives rather than component-specific
  whole-collection caches.

System workflows ship as a pinned offline catalogue, including verified reference
files. Operators can independently install a reviewed revision without rebuilding
or restarting the application. A single atomic database replacement publishes the
snapshot only after every referenced object has passed its size, type and SHA-256
checks. Local SQLite/filesystem and cloud Postgres/object storage use the same
operation. Running assistant turns retain their captured revision. Reference
objects are immutable and retained across replacements so those turns and exports
remain valid; catalogue installation currently does not garbage-collect old blobs.

The workflow information panel downloads references bound to their exact hash.
Assistant `Read` exposes references on demand with bounded windows. Workflow ZIPs
include each variant's references and a source-revision/hash provenance file.
The bundled catalogue needs no network or storage installation on first use.

Build a package from a clean, explicitly selected source revision using Python
with the workflow repository's existing PyYAML requirement:

```sh
python -X utf8 scripts/build-workflow-catalog.py mike-workflows <40-character-commit> tmp/catalogue
npm run workflow-catalog --prefix backend -- install ../tmp/catalogue/catalogue.json <40-character-commit>
npm run workflow-catalog --prefix backend -- status
```

The install path is relative to the backend directory when using `npm --prefix`.
Configure the usual
runtime environment to select the intended local data directory or cloud store.
Installation is an operator CLI, not an authenticated-user write endpoint.
The source validator runs before packaging; unplaced new system recipes fail the
build for explicit placement in `scripts/workflow-catalog-layout.json`. Add-on
packs are not automatically installed. Add `--bundle` to regenerate the shipped
JSON and embedded reference bytes when advancing the application distribution.

## Sources workspace

- Research sets own source membership, source labels and highlight types. A source
  label classifies a whole source; a highlight type is one name, colour and
  optional parent. Source filing is additive, retaining explicit ancestor and
  descendant assignments without normalization. Removal names each filing explicitly;
  assistant removal of a human-made or human-approved filing waits for acceptance.
  Pending tool outcomes must be reported as waiting for acceptance, not completed.
  A highlight has exactly one type;
  each type lists only its directly assigned highlights; child types show their own.
  choosing another type replaces the old one. No separate pen palette, colour
  override or implicit source-label-to-highlight relationship exists.
- Library files and folders have no primary research workspace or global research
  labels. Library offers Add to research with an explicit destination choice;
  browsing or previewing a Library document neither creates a research set nor
  writes an assignment. Research-file previews show collected sources and saved
  highlights, not everything encountered during research.
- Research, Search and Memo share the existing right-hand dock. Research is one
  tree: source labels are nested folders, and every source hangs inline under each
  label it carries, with unlabelled sources at the root. Nest/reorder by dragging
  or keyboard; source drops add a label without removing other classifications.
  No Unsorted pseudo-folder exists. Switching tabs mounts no new pane, shows no
  loading placeholder and moves nothing: the toolbar and tab strip keep their box.
  Every row is one shape — chevron, marker, name, actions, number — so counts share
  one right-aligned column and a label counts each distinct source under it once.
  A source marker is a coloured folder whose tab and band carry its sublabels; it
  opens the label picker, and dragging it files the source. The picker has horizontal
  filing slots and root siblings with truncated names. A selected parent's children
  appear below it with an indented connector; no empty generations are reserved.
  Choices persist immediately, with independent ancestor and descendant filings.
  The panel keeps its opening position as children appear, without moving the dock;
  its note saves while typing. Close, Escape and an outside click dismiss it.
  Touching a row selects
  or expands it; opening a source or passage is the explicit Open control. Sources
  enter a set from search results, Library Add to research or a drop, never from an
  Add button under the tree, and New label sits in the toolbar above it.
- The compact highlight picker opens the type hierarchy only when needed. Naming
  a type creates it once with a muted colour; cancelling creates nothing. Children,
  renaming, recolouring and reordering use the same label operations. Choosing the
  drawing type does not filter the source list. Optional source/highlight filters
  narrow the existing list and preserve any narrower carried evidence scope.
- An open source is headed `Sources › category › source name`. The category
  breadcrumb returns to that category without clearing the current search query.
- Highlights stay under their source with brief quoted previews and exact
  pinpoints. Opening a passage keeps its evidence ID and pinned source version.
  Reader marks remain editable; saved marks load progressively without a second
  previous/next paragraph navigation strip. A regular text selection followed by
  Highlight saves that selection without arming the drawing tool; only a click
  without a selection toggles the tool. Marks outside detected structure still
  render, using `line n–n` as the fallback pinpoint. Full findings and notes remain
  available inside the expanded source.
- Read/search receipts are background evidence, not highlights or findings. A
  bound chat retains all receipts and queries but collects only explicitly saved
  or grounded-answer sources. Grounded support is not automatically highlighted.
  Chat conversion reuses actual passed claims; uncited reads never become a
  synthetic answer. Interrupted reads remain recoverable as provenance.
- The existing evidence part retains exact source/version/locator identities.
  Its passage endpoint and default passage selection expose deliberate highlights;
  the evidence endpoint also exposes background receipts. Search takes one phrase
  and an optional collapsed capture rule, groups its matches under each source as
  windowed passages with the phrase marked, and saves one or all of them under the
  drawing type; earlier searches stay collapsed and rerun from their own row, with
  the searched-source ledger a nested aid. Capture rules without a type preview
  matches; typed rules save them. Conflicting types for one captured receipt are
  reported, never silently combined. Missing classifications remain predicates,
  not persisted labels.
- Deleting a highlight clears its annotation, not the receipt backing citations.
  Re-reading it does not recreate the highlight. Deleting a highlight type keeps
  its passages under the ordinary Highlight type. Renaming, recolouring or moving
  a type preserves evidence IDs and citation targets.
- Open as connects Chat, Workspace and Tabular Review through existing operations.
  Findings refer to original grounded answers and supporting evidence. Importing
  highlights excludes raw reads. Source/passage selections are resolved before
  bulk labelling or extraction; scoped reads cannot reveal unrelated evidence
  through memo, query or undo payloads.
- Human and assistant edits use the same reversible history. A highlight-type
  change is atomic; undo preserves unrelated later edits. Pending proposals do
  not affect active classifications or extraction scopes.
- Memo autosave remains mounted across tabs. Interrupted saves retain the draft,
  reconcile before retrying and do not overwrite another writer. Citations render
  as ordinary linked text, not Cite chips; insertion and dragging preserve exact
  internal evidence targets. The citation picker lists collected sources, not
  background reads. Existing formatting and Markdown round-tripping remain.

## Tabular Review

- The review title has its own wrapping row above compact actions (Docs,
  + Column). Column names use the full column width and wrap above their controls.
  Format icons are neutral; categorical values use muted fills. The existing
  table selection, prompts, proposals, generation, cancellation and export remain.
- The cell inspector is a dialog below the page header, leaving the review's own
  actions clickable, with a fixed header and regenerate footer and one
  keyboard-scrollable result region. It shows the result text and the ordinary
  citation pills chat uses, and nothing else: no embedded source viewer, quote
  selector, highlighter, repeated bibliography, coverage badge or raw receipts.
- Citation pills are deduplicated by receipt ID, not by source: different pinpoints
  remain separate. Opening one hands the passage to the shared source reader,
  following the cited source and original version, which may differ from the table
  row's document. Failed regeneration retains the answer and offers retry.
- A cell mapped from existing research is presented as that research, without
  Answer or Explanation framing; only model-extracted cells carry it.

## Research interoperability

- The Sources legislation reader displays the final provision marker, such as
  `(a)` for `231(4)(a)`, with one indent per parenthesized level. Decimal labels
  such as `(6.01)` remain aligned with sibling subsections. Full addresses remain
  the citation and selection targets; parser text-range ownership does not
  determine the printed marker.
- Sources and Chat Open as Table open ready to propose. Table and workspace
  proposals reuse Chat's activity indicator, preserving the previous preview
  while a replacement is prepared. It shows progress (reading, asking with characters received
  and elapsed time, checking, one corrected attempt) until the preview. The research question describes the whole table; model columns divide
  it into legal issues, factors and outcomes, never raw passage dumps. Labels,
  highlight types, notes and grounded findings supply the bounded inventory.
- The title and columns are editable, columns can be removed or added, and Change
  the proposal / Propose again requests a revised structure. Columns indicate
  whether cells come from research or need extraction. Excerpts are not new
  analytical answers; absent classifications never imply No/Not found.
- Proposals map only original item/row IDs, including individual Chat claims.
  Invalid/cross-row/overlapping mappings receive one corrected attempt; a failed
  table proposal falls back to deterministic columns with a visible explanation.
  New questions stay pending. Accepting never performs another model call.
- Chat Open as uses the composer's current model and reasoning effort.
  Workspace proposals store one nested design with separate source-label and
  highlight-type trees. The model supplies names, children and compact member
  references; the host supplies category IDs and resolves durable memberships.
  Editors and history use that same design; previews are computed, not stored
  alongside it. There is no flat labels/assignments proposal compatibility path.
  Organization uses plain generation with no chat tools. Applying
  an organization replaces selected filings and removes unused omitted categories,
  preserving assignments and necessary ancestors outside the selection. Filing
  table findings remains additive.
  Source labels may carry the organization without semantic typing of every saved
  passage. Omitted passage memberships remain or return to the plain `Highlight`
  type; a passage belongs to at most one semantic highlight type.
  The proposal's combined category budget scales with selected source count:
  twice the number of sources, with a minimum of 12 and maximum of 50.
  Validation protects references, hierarchy scope and single-type passage ownership,
  not category wording, group size or similarity to existing organization.
  A structural correction receives the previous proposal and its error internally;
  users review the result without troubleshooting validation messages.
  Organization previews are pending batches in the workspace's existing history:
  they preserve the design, feedback, saved manual edits and preceding proposal ID
  without applying labels. Revising supersedes the earlier pending proposal;
  applying accepts the reviewed version, and stale material requires review again.
  Subsequent generation and workspace chat, including a selected-source chat,
  receive previous designs and corrections. The ordinary research tool's
  `organize` action creates the same pending proposal for modal review.
  Organize opens a matching pending draft from that history without generating
  another proposal. The dialog renders the existing Sources workspace trees and
  label palette, with a local draft mutation lane instead of live writes.
  Closing saves manual edits to the pending draft; Apply rechecks the original
  scope and fingerprint. No proposal cards or editor are appended below chat.
  Inline organization review is deferred.
  Model and effort changes persist in the chat draft even with an empty message;
  saving the selection does not require sending a turn.
  Open as Workspace shows existing label and highlight-type hierarchies before
  generation, with Open workspace and Propose changes actions. An unorganized
  workspace offers Propose labels. Proposing launches the step
  on the available question and answer excerpts in order, each naming
  the passages it cites, plus every passage quoted once and every source named once,
  with a typed request added only when the user supplies one. The model answers in
  keys and ids and never retypes the research. It groups related material into
  meaningful hierarchies suited to the user's purpose, starting with recurring
  concepts across sources rather than a category per observation. Children serve
  useful navigation or comparison; single-source distinctions remain allowed
  when they serve a distinct purpose. These are organizing instructions, not
  category-count validation rules. Existing category IDs can
  be used directly in assignments without repeated declarations. Proposed renames
  and parent changes retain those identities and use ordinary label operations.
  Omitted existing parents are preserved; an explicit null moves a category to the
  root. Grouping parents need no direct assignments. Apply labels accepts the
  reviewed plan; generating a preview does not apply it.
- Open review rechecks the preview fingerprint and source revision. Stale previews
  require review again. Accepted inputs and cell answers are persisted together
  through the normal table repository, preserving source versions, receipts and
  origin references. Later research relabelling, recolouring or changes to a
  prior answer do not silently rewrite that table. Explicit remapping is separate;
  changed prompts or removed mappings clear affected cells for extraction.
- Chat conversion includes only grounded findings and materially used sources,
  not every document read. Selected-message requests reuse earlier read receipts
  without promoting those reads. A turn's answer retains its own question even
  when user/assistant timestamps match. Missing support fails explicitly.
- A result's Save highlights explicitly saves just its supporting receipts in one
  selected highlight type, preserving original evidence IDs. It never promotes
  every incidental read. Existing source labels and other highlights are untouched.
- Categorical columns propose source labels for the chosen rows through the
  existing reversible research changes. Not-found results supply no labels.
  Ambiguous text columns open scoped Chat for a reviewed semantic proposal.
- Discuss column / Discuss result carries selected completed cell references plus
  original support into Chat. All columns still means the selected rows of this
  table, not every workspace finding. Read findings and read_table_cells honor
  that result selection; original document reads remain available within source
  scope when further context is needed. A narrowed claim selection keeps the
  original claim index, so a narrow scope cannot read a broader cell or finding.
- Add source in a virtual folder uses the shared paged Library/project picker and
  adds pinned document versions to that source label. Multi-document addition
  commits atomically: a missing or foreign version leaves no partial collection.
  Library Add to research likewise chooses an explicit research set and,
  optionally, a source label within it, merging with a source's existing labels.
  There is no global workspace assignment.
- Adding a source to an existing table preserves existing row IDs and their
  completed results; only the new rows are pending.
- Conversion refuses oversized selections (500 rows / 25,000 inventory entries)
  rather than silently dropping work. Assisted inventory is bounded separately.
  Existing Library placement, sharing, table history and regeneration remain the
  owners; no new ontology or synchronization service is introduced.

## Documents and versions

- Original document bytes and immutable versions are authoritative.
- Each version has a stable document/version identity, monotonic version number,
  filename, media type, size, source hash, timestamp, and provenance where
  applicable.
- Reads and downloads honor an explicitly requested version rather than silently
  substituting the current one.
- Expected-parent or stale-receipt conflicts make no write.
- Replacing source bytes invalidates incompatible derived products.
- Deleting one version cannot remove bytes still referenced by another.
- PDF renditions and projections are derived, receipt-bound products. Their
  failure never corrupts or replaces the original.
- Evidence binds document, version, source hash, locator, and exact passage.
- DOCX generation/editing preserves unsupported package content, records owned
  mutations, and fails closed on unsafe boundaries.
- Tracked edits are reviewable; their accept/reject operations are
  conflict-safe.

Library and project folders preserve nested paths, reject cycles and foreign
IDs, and apply recursive deletion only to resources owned by the authenticated
scope.

Organize proposes a library's or a project's folders from one model reading of
its files, framed by the instruction the lawyer types; the proposal streams its
progress, names folders without definitions, files each document once, and is
refused when it files nothing or leaves every document in one folder. Nothing is
created or moved until the lawyer applies the proposal, and a proposal made
before the files changed is refused.

## Assistant, agents, and tools

- Normal chat, project chat, Word chat, read subagents, and tabular work use one
  provider-neutral turn engine and executable tool registry.
- Advertised tools have handlers. Unavailable tools are omitted; unknown tools
  return bounded errors.
- Specialists load by exact registered name without a cumulative capability cap.
- A successful legal Read supplies exact passages and usable continuation;
  model-facing compaction preserves native source, opinion and evidence identity.
- The tool schema states how to read economically: a run of paragraphs is one
  Read with locator and end_locator (one evidence_id per unit), a passage inside a
  held source is found with pattern, one search serves a question, and a source the
  search omits is not installed.
- Grounded answer segments are written once with their supporting evidence
  IDs. The runtime validates and renders them through the common claim and
  citation contracts.
  Bound workspace tools infer their current draft; general workspace operations
  remain available through `manage_work_products` with the same scope checks.
- The backend reconstructs authoritative history and state from durable records
  rather than trusting a browser-supplied transcript.
- Turn submission uses optimistic transcript versions. Conflicts do not create
  duplicate turns.
- Opening a saved chat draft is read-only and preserves history order. Draft
  changes autosave; failures retain the text with an inline retry. Older history
  refreshes cannot replace newer results.
- Provider/tool work is cancellable, preserves usable partial events, and
  records one terminal outcome.
- Tool calls and results remain exactly paired. Document mutations are
  serialized per affected document while independent reads may proceed.
- Legal answers expose only grounded final prose and exact citations; rejected
  drafts are not presented as verified work.
- Provider-internal events remain private. One bounded public event stream feeds
  one frontend decoder and reducer.
- Chat, subagents, and tabular review are different presentations of ordinary
  agent jobs, not separate model loops.

## Legal sources and evidence

- Providers enter through the shared search, resolve, and bounded-read plane.
- A2AJ searches prefer installed full-text indexes. Missing FTS falls back to
  the A2AJ search API for cases or legislation; an empty local result does not.
- Missing optional search corpora return an explicit `not_installed` state.
  Library displays one plain sentence without a result count or failure alert.
- Provider-native identifiers, structure, coverage, URLs, and provenance are
  preserved when available.
- Reconstructed structure fills genuine gaps but never overwrites authoritative
  native facts.
- Exact evidence carries the source/version identity, source hash, human locator
  where available, passage coordinates, and safe presentation link.
- Text-fragment and native-anchor URLs are built deterministically from verified
  source text. Models do not author source URLs.
- A failed external pinpoint falls back to a truthful provider anchor or the
  internal source viewer; it never fabricates precision.
- Quote presence, link validity, and semantic support are distinct findings.

## Durable jobs and work products

- Opening Court Records from a blank chat starts a blank intake; an existing
  record opens only when selected explicitly. Authorities reopens the last
  selected draft within the current project or Library scope. Leaving either
  workspace preserves its saved drafts.
- Long work uses the shared durable job queue with progress, cancellation,
  restart recovery where supported, and usable partial results.
- Progress reports stable job/activity identities and never requires a second
  feature-specific run history.
- Generated documents are saved as immutable versions or Library work products
  with exact input versions and receipts.
- Authorities uses one maintained browser workspace and engine in its
  standalone and Beaver hosts.
- A standalone/embedded capability may change file-selection and save adapters;
  its analysis/build rules and primary UI remain singular.

## Browser and host behavior

- Beaver is one Vite/React Router application served from the Express origin.
- The Word task pane mounts the normal application at its Word route and reuses
  authentication, profile, chat, tools, jobs, and UI components.
- Word edits use native tracked changes in Review mode. A client call is marked
  started before mutation; replay of an unconfirmed batch reports uncertainty
  instead of repeating edits. Completed calls return their saved outcome.
- Library and project directory behavior is shared.
- Model and reasoning effort remain separate visible controls.
- Primary actions have stable labels and placement, keyboard operation, visible
  focus, truthful loading/progress/error states, and no reliance on color alone.
- Changed surfaces must remain usable at 320 CSS pixels, browser zoom, reduced
  motion, and Windows high contrast. Automated accessibility checks support but
  do not replace keyboard and screen-reader testing.

## Security boundaries

Deployment operators may declare OpenAI-compatible endpoints through
`MIKE_MODEL_CONFIG_JSON={"models":[...]}`. Each declaration requires `id`,
`provider: "openai-compatible"`, `location: "local" | "cloud"`, and `baseUrl`.
Selections use `configured:<id>`. Optional fields are `label`, `apiModel`,
`apiKeyEnv`, `apiKeyProvider`, `apiKey`, `contextWindow`, `imageInput`,
`tolerateTextToolCalls`, and `maxTokensField` (`max_tokens` by default, or
`max_completion_tokens`). Invalid/duplicate declarations fail closed without
echoing their contents. The authenticated catalogue exposes no endpoint or key.
Declared key sources must resolve; a personal provider key wins over deployment
fallbacks. Endpoints without a key declaration send no Authorization header.
Local endpoints default to tool-markup recovery through the SDK middleware;
set `tolerateTextToolCalls: false` for an endpoint with reliable structured calls.
Recovered calls retain ordinary tool authorization and argument validation.

- Retrieved documents, OCR, provider text, fields, metadata, and summaries are
  untrusted data. They cannot authorize tools, change system instructions, or
  cross user/project/document scope.
- Local paths, credentials, provider internals, and raw stack errors are not
  exposed in public responses.
- Upload, archive, download, subprocess, URL, and object-storage boundaries
  validate size, type, path, ownership, and control characters.
- Cloud service credentials stay at deployment adapters. Local files never
  become cloud credentials.

## Proof

Test the smallest public outcome that protects each changed contract:

- application/repository contract tests for local and cloud compositions;
- route tests for authorization, validation, status, and public payload;
- focused turn/event/tool tests for assistant behavior;
- exact provider/structure fixtures and applicable corpus gates;
- DOCX package-part, accepted/redline, and render checks;
- frontend reducer/component/browser checks for visible behavior; and
- launcher-owned smoke for the complete local product.

Tests that merely assert an import, mock call order, implementation branch, CSS
class, or exact incidental copy do not make that implementation durable.


## Scoped memory

Memory is off by default. Settings > Memory owns private app memory; a project's
Memory action owns its shared memory. Viewers can read project memory; editors
and owners can edit it. Save uses a revision check and preserves the editor's
draft on conflicts. Pause keeps the text; Delete clears it without changing the
enabled setting. Both actions fence pending curation, as do manual edits.

The assistant receives enabled memory in an earliest synthetic user message,
not as system instructions. Current conversation outranks project memory, which
outranks app memory. Shared chats never receive private app memory. Provider
continuations are bound to the memory snapshot and audience. Memory is optional:
loading it times out after 800 ms without blocking the answer.

Only successfully persisted terminal turns schedule learning. Failed, cancelled,
empty and paused turns do not. The existing durable job queue waits for five
minutes of inactivity, then curates bounded, attributed user statements in
conversation order. It does not scan older conversations or pass private app
memory, document contents, or assistant responses into a project curator.
Curation uses the user's configured title model and credentials. Permission,
enabled state, epoch and revision are checked again before committing. Account
exports include accessible memory; account deletion removes private app memory.

## Export integrity

Project > Export manifest captures every accessible document version's source
SHA-256, working revision, provenance, part hashes and edit decisions in one
database snapshot. It does not include document bytes or storage keys. Account
exports use the same integrity envelope. The digest covers the entire JSON body
(including format and version), excluding only its `integrity` member, with
recursively sorted object keys and array order preserved.

`MANIFEST_SIGNING_KEY` optionally supplies a dedicated 32-byte Ed25519 seed as
64 hex digits. Unset means unsigned; malformed configuration fails the export.
Generate a new key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Keep it separate from encryption credentials and retain old public keys when
rotating it. The signature covers UTF-8 `beaver-export-v1`, a NUL byte, and the
32 digest bytes. Public keys are base64 DER SPKI; signatures are base64.

Obtain the signing identity independently from the authenticated deployment's
`GET /api/exports/signing-key`, save its JSON as `trusted-key.json`, and verify:

```sh
node scripts/verify-export.mjs manifest.json trusted-key.json version-id=downloaded-file.docx
```

The verifier checks supplied file bytes against their captured source hash and
size. Omit file arguments to check only the manifest. Use `-` instead of a key
file for a checksum/embedded-signature check; this does not establish the
exporter's identity. A trusted key requires a signature and rejects an unsigned
downgrade. Signing attests the exported snapshot, not earlier document custody.

## Durable uploads

New Library/project/standalone and document-version uploads reserve a 24-hour session with immutable
file metadata and a retry key. Refreshing or losing the completion response does
not duplicate the document. Transferred files continue processing on the existing
job queue; unfinished transfers need the original file selected again. The Uploads
action shows up to 100 recent sessions, unfinished first, with retry/cancel actions.
Folder uploads retain their destination on each session. File bytes are never
stored in browser storage; only retry identifiers are retained there.

Both storage adapters verify size, SHA-256 and document type before publication.
The shared document transaction rechecks destination access and commits the
document together with session completion. Cancellation and expired sessions
cannot publish. Upload bytes use the existing object-cleanup owner and are held
until session expiry; published documents use ordinary immutable version blobs.
Version uploads bind the expected head and working revision; edits made while
the file transfers cause a conflict instead of being overwritten. Adding and
replacing a version commit their session receipt in the same transaction as
the version mutation, so duplicate workers cannot apply the upload twice.

Custom workflows accept reference documents through the same upload sessions.
The workflow page lists, downloads, versions and removes them; reference access
inherits the workflow's roles and organization deny rules. A workflow turn lists
captured document-version resources for the existing Read operation. Workflow
ZIP exports include these files and relative reference paths, with a 64 MB limit.
Deleting a workflow removes its documents through the shared blob-cleanup owner.
System workflow assets remain pinned to their installed catalogue snapshot.

S3 direct transfers use five-minute signed, checksum-bound, conditional PUTs;
filesystem mode uses authenticated multipart staging through the same session.
Configure bucket CORS for the deployment's exact browser origin, PUT, and the
`content-type`, `if-none-match`, and `x-amz-checksum-sha256` headers. Configure a
one-day expiry lifecycle for the `documents/uploads/` prefix (including noncurrent
versions if bucket versioning is enabled), so even a transfer completed after its
session expired is collected. Never apply that expiry rule to published blobs.
These use [S3 presigned checksum uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
and [conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
