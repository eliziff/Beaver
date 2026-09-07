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

System workflows remain a small pinned catalogue and do not need runtime
pagination or downloading.

## Sources workspace

- Research sets own source membership, source labels and highlight types. A source
  label classifies a whole source; a highlight type is one name, colour and
  optional parent. Source labels may overlap. A highlight has exactly one type;
  choosing another type replaces the old one. No separate pen palette, colour
  override or implicit source-label-to-highlight relationship exists.
- Library files and folders have no primary research workspace or global research
  labels. Library offers Add to research with an explicit destination choice;
  browsing or previewing a Library document neither creates a research set nor
  writes an assignment. Research-file previews show collected sources and saved
  highlights, not everything encountered during research.
- The existing Labels, Search and Memo tabs remain for now. Source labels retain
  nesting and drag/drop. Sources without labels are ordinary root entries, not an
  Unsorted pseudo-label. Choosing the active highlight type does not filter the
  source list. The more compact virtual-folder browser and memo/reader cleanup
  are the next UI phase, not additional semantics in this change.
- Read/search receipts are background evidence, not highlights or findings. A
  bound chat retains all receipts and queries but collects only explicitly saved
  or grounded-answer sources. Grounded support is not automatically highlighted.
  Chat conversion reuses actual passed claims; uncited reads never become a
  synthetic answer. Interrupted reads remain recoverable as provenance.
- The existing evidence part retains exact source/version/locator identities.
  Its passage endpoint and default passage selection expose deliberate highlights;
  the evidence endpoint also exposes background receipts. Search matches can be
  explicitly saved under a highlight type. Capture rules without a type preview
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
  reconcile before retrying and do not overwrite another writer. Citation styling
  and the broader Sources/Table visual cleanup remain separate UI work.

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
- Tracked edits are reviewable and their accept/reject operations are
  conflict-safe.

Library and project folders preserve nested paths, reject cycles and foreign
IDs, and apply recursive deletion only to resources owned by the authenticated
scope.

## Assistant, agents, and tools

- Normal chat, project chat, Word chat, read subagents, and tabular work use one
  provider-neutral turn engine and executable tool registry.
- Advertised tools have handlers. Unavailable tools are omitted; unknown tools
  return bounded errors.
- Specialists load by exact registered name without a cumulative capability cap.
- A successful legal Read supplies exact passages and usable continuation;
  model-facing compaction preserves native source, opinion and evidence identity.
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
- Library and project directory behavior is shared.
- Model and reasoning effort remain separate visible controls.
- Primary actions have stable labels and placement, keyboard operation, visible
  focus, truthful loading/progress/error states, and no reliance on color alone.
- Changed surfaces must remain usable at 320 CSS pixels, browser zoom, reduced
  motion, and Windows high contrast. Automated accessibility checks support but
  do not replace keyboard and screen-reader testing.

## Security boundaries

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
