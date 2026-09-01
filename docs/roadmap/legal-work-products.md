# Durable legal work products: Court Records and Authorities

Status: in implementation; production build, artifact, and live UI proof remain
release gates

Date: 2026-08-31

This spoke replaces the current Court Records MVP and the Python-hosted
Authorities product path with two durable, composable legal work products.
The user-facing name for a saved work product is **Draft**. A draft records
intent and input bindings; Library documents and immutable versions remain the
content store.

The outcome is deliberately narrow:

- a lawyer or paralegal can create, leave, reopen, revise, and rebuild a Court
  Record or Authorities draft without reconstructing the project;
- Alberta and Federal Court/Federal Court of Appeal output profiles are exact,
  source-backed, and production-tested;
- the standalone browser and Beaver use the same feature UI and build core;
- Beaver drafts can follow current Library versions and consume another draft's
  named output;
- grounded legal-source receipts can become Authorities entries without
  rediscovering or reparsing their citation identity; and
- Python leaves the Authorities product request path. Rust continues to own
  citation and legal-structure primitives.

## Fixed decisions

1. **One core and one UI per work product.** Standalone and Beaver provide
   storage/input/output adapters. They do not fork business rules, screens,
   progress, or build behavior.
2. **Only one new product-level abstraction.** `WorkProduct` is a saved typed
   draft with input bindings and named outputs. There is no Filing Builder,
   feature runtime, plugin system, workflow graph, event bus, or graph database.
3. **Documents remain documents.** Source bytes and generated outputs use the
   existing `DocumentStore`, immutable versions, hashes, object storage, and
   `documentProjectionService`. A work product is not another file store.
4. **Latest is convenient; builds are exact.** Beaver document bindings follow
   the current version by default. Every build receipt freezes the resolved
   document ID, version ID, hash, role, order, and build settings.
5. **Freshness is computed.** Open, Refresh, and Build resolve current inputs.
   No watcher service or persisted `stale` flag attempts to mirror document
   state.
6. **The interface prepares the right thing.** It asks only for information
   needed to construct the selected document. It does not assess eligibility,
   recommend what a lawyer should file, or show a compliance scorecard.
7. **Existing legal primitives win.** Citation recognition/identity and legal
   structure remain Rust-owned. PDF inspection, OCR routing, and OCR execution
   remain in the existing parser/runtime. This work only orchestrates them.
8. **Authorities is replaced, not duplicated.** TypeScript takes ownership of
   the current review/build workflow; after parity and live proof, delete the
   Python worker, iframe, filesystem job state, and project-file path.
9. **No automatic CanLII fetching.** Beaver may construct a known-valid CanLII
   page/PDF link and accept a user-downloaded PDF into the waiting authority.
   It never scrapes, bulk-navigates, or server-fetches CanLII.
10. **No compatibility layer.** Beaver has no users. Replace the MVP state,
    routes, and project formats outright; do not add migrations, dual reads, or
    import shims.

## Release scope

The release must complete the generic workflow plus the Alberta and federal
inventory below. Existing profiles in
`frontend/src/app/court-records/profiles.ts` are the implementation baseline,
not the ceiling: Phase 0 must add any missing variant in these same
record/package families that the governing sources require. Internal profiles
stay distinct even where the selection UI consolidates their names.

### Alberta

- Court of King's Bench affidavit with exhibits;
- chambers applicant and respondent filing sets;
- desk applications;
- special applications, applicant and respondent;
- originating applications/review and appeal sets, applicant and respondent;
- Commercial List applicant/respondent sets and compendium;
- Court of Appeal appeal record;
- appellant, respondent, and intervener Extracts of Key Evidence; and
- Court of Appeal condensed book.

For Court of King's Bench chambers and desk applications, the registry keeps
Justice and Applications Judge profiles distinct. Effective September 15,
2026, Applications Judge matters follow the court's Digital Orders process and
therefore do not include a proposed-order file; Justice profiles continue to
accept the applicable PDF or editable DOCX proposed order. The selection UI may
consolidate those choices, but it must resolve one exact internal profile before
building.

### Federal

- Federal Court and Federal Court of Appeal affidavits with exhibits;
- moving and responding motion records;
- applicant and respondent application records;
- Federal Court of Appeal appeal book and condensed book;
- Federal Court trial record;
- Federal Court of Appeal leave motion and response records;
- informal motion letter; and
- compendium.

Federal Court and Federal Court of Appeal variants may share source data and
renderers only when the governing requirements are the same. They remain
separate resolved profiles where court name, form, role, order, cover, output,
or technical requirements differ.

British Columbia is not a release target for this spoke. The profile/source
schema and selection model must allow BC to be added as data without changing
the builder workflow or creating BC-specific components.

## Explicit non-goals

- no filing, court login, payment, service, email submission, or docket
  automation;
- no legal advice, document eligibility questionnaire, or editorial warnings
  about whether the selected filing is appropriate;
- no general “Filing Builder” or universal product engine; Beaver's existing
  Workflows area is the shared discovery layer, not another runtime;
- no new citation parser, citation normalizer, CanLII resolver, OCR engine,
  PDF parser, DOCX parser, or office-conversion path;
- no background filesystem watching;
- no browser extension, general Downloads-folder surveillance, or automated
  CanLII request;
- no committed downloaded corpus or unlicensed court filing collection;
- no user-facing official-source, preparation-audit, searchable-PDF, or
  successful-validation panels; and
- no `RESULTS.md`, experimental production path, or feature flag used as a
  transition mechanism.

## Existing foundations to retain

| Need | Existing owner |
| --- | --- |
| Stable document identity and immutable versions | `documentApplication.ts`, `DocumentStore`, relational document repository |
| Cross-format reading and PDF preparation | `documentProjectionService.ts` |
| DOCX conversion and preservation-safe operations | `convert.ts`, DOCX sessions/operations, Word application operations |
| PDF inspection/OCR | `legal-pdf-parser`, existing Library preparation jobs, existing browser OCR runtime |
| Citation occurrences and lookup keys | `legal-structure` through `structureNative()` |
| Grounded authority/source identity | `LegalEvidenceReceipt` and document evidence bindings |
| Court profile/build primitives | current Court Records profiles, validation, forms, layout, and assembly modules |
| Long-running work | existing application jobs, progress, cancellation, and events |
| CanLII URL construction | existing `canliiUrls.ts`; unknown mappings fail closed |
| Legal-source resolution | existing provider registry, A2AJ/OpenLegalData stores, and provider PDF bridge |
| Authorities behavior gold | current Authorities review/build tests and browser workflow |

The current Court Records `localStorage` state and in-memory `File` entries are
the MVP to replace. The Authorities Python filesystem job/project store is
behavioral reference material, not a persistence primitive to preserve.

## Production model

### Work product

Use an explicit discriminated union, not an open registry:

```ts
type WorkProductKind = "court-record" | "authorities";

type WorkProduct = {
  id: string;
  kind: WorkProductKind;
  title: string;
  projectId: string | null;
  revision: number;
  state: CourtRecordDraft | AuthoritiesDraft;
  outputs: Record<string, WorkProductOutput>;
  createdAt: string;
  updatedAt: string;
};
```

`revision` is an optimistic-concurrency boundary. A stale browser or assistant
operation must reload and merge; it may not overwrite newer user input.

### Input bindings

Three input references cover the requested workflows:

```ts
type WorkProductInput =
  | {
      kind: "local-file";
      handleId: string;
      lastSeen: { name: string; size: number; modified: number; sha256?: string };
    }
  | {
      kind: "document";
      documentId: string;
      version: "latest" | { versionId: string; sha256: string };
    }
  | {
      kind: "work-product-output";
      workProductId: string;
      role: string;
    };
```

- `local-file` is standalone-only storage state. The feature core receives the
  selected bytes through its host; it never sees or branches on filesystem
  paths.
- `document` is the normal Beaver binding. `latest` is the default; an advanced
  per-item “Use this version” action may pin a finalized source.
- `work-product-output` connects, for example, an Authorities draft's `book`
  output to a Court Record's authorities slot.

The resolver keeps a visited set and rejects a direct or indirect cycle with
the exact drafts involved. No general graph machinery is needed.

### Named outputs

Each product exposes a small closed role set:

- Authorities: `table`, `book`, `annotated-document`, and `manifest` where the
  selected build actually produces them;
- Court Records: `record`, plus profile-defined separate-file roles where the
  court requires a filing set.

In Beaver, the first successful build creates one Library document per output
role. A subsequent build adds an immutable version to that same document. A
nested draft therefore follows a stable output document rather than a filename
or one-off download.

In standalone, inputs and draft state are authoritative. Keep only the current
blob for each named output so reopened and nested drafts remain usable without
retaining an unbounded local version history. Older outputs can be rebuilt from
the retained inputs.

### Resolution and build receipts

On Open, Refresh, and Build, resolve every input to one of:

```ts
type InputStatus =
  | { status: "ready"; snapshot: ResolvedInput }
  | { status: "changed"; previous: ResolvedInput; current: ResolvedInput }
  | { status: "missing"; reason: "deleted" | "permission" | "unavailable" }
  | { status: "review"; reason: string };
```

Do not persist these statuses. Persist the last exact build snapshot in the
output version's provenance/receipt. It contains:

- work-product ID, kind, revision, and profile ID;
- every exact document/version/hash or local-file hash in build order;
- every nested work-product ID, output role, and resolved output version/hash;
- court-source receipt IDs and profile-effective dates;
- relevant user-entered values and deterministic build settings;
- automatic OCR/conversion/assembly steps actually performed; and
- output role, filename, MIME type, page count, and hash.

The current Court Record receipt becomes this shared work-product build
receipt rather than a separate audit format.

### Persistence

Beaver adds one relational resource and its normal local/cloud repository
contract:

```text
work_products
  id, user_id, project_id, kind, title,
  state_json, outputs_json, revision,
  created_at, updated_at
```

Use project authorization where `project_id` is present and private user scope
otherwise. Do not add separate local/cloud applications or a second object
store.

Project-bound uploads and generated outputs use the existing workflow-file
target operation and remain under that Project's configured location. Drafts
without a Project use the configured/default Library target. Reuse a contained,
workflow-named directory rather than creating UUID-named top-level folders;
storage defaults belong in settings, not on each Draft.

Standalone uses IndexedDB with three narrow object stores:

- `drafts` for the same typed draft state; and
- `fileHandles` for structured-cloned `FileSystemFileHandle` objects; and
- `outputs` for the current generated blob per draft role, replaced atomically
  on rebuild rather than accumulated as a local version history.

The production standalone launcher must use one stable secure localhost origin,
including a stable port. On reopen, call `queryPermission()` and `getFile()`.
If permission is no longer granted, request it from a user action. If the file
was moved, deleted, or denied, retain its slot, description, and prior metadata
and offer **Relink file**. Do not store raw paths or silently substitute a file
with the same name.

The supported standalone runtime is Chromium. A browser without File System
Access may still complete a one-shot build through ordinary file inputs, but it
does not receive a second resumability implementation.

Ship standalone as one compact loopback launcher with its static assets and
required deterministic runtimes together. It binds only to localhost, opens
the browser UI, requires no account or cloud service, and performs no model
work. Do not bundle Beaver's cloud server, assistant code, or a parallel feature
implementation. External court/source links remain ordinary user-initiated
navigation.

## Version-bound citation ledger

An Authorities draft must accept a known grounded authority without parsing a
DOCX to rediscover it.

Define a compact `AuthoritySeed` projected deterministically from an existing
`LegalEvidenceReceipt`:

```ts
type AuthoritySeed = {
  key: string;
  kind: "case" | "legislation" | "commentary" | "other";
  provider: string;
  stableSourceId: string;
  sourceSha256: string;
  citation: string;
  name: string | null;
  version: string | null;
  externalUrl: string | null;
  evidenceIds: string[];
  locators: Array<{ kind: string; label: string }>;
};
```

`key` comes from the existing Rust citation identity operation. The model may
select evidence IDs; it may not author provider identity, hashes, citations,
or URLs.

Extend generated DOCX provenance from its current evidence binding to a
version-bound citation ledger containing:

- each authority seed;
- the generated citation marker/target ID;
- each occurrence's source unit/locator and displayed form; and
- its pinpoints and evidence IDs.

Authorities consumes this ledger directly when it matches the selected
document version/hash. An imported or externally changed document uses the
existing Rust occurrence scan. A Beaver mutation that cannot prove citation
targets were untouched marks the ledger unavailable for that new version; it
does not carry stale identities forward silently.

This avoids semantic reparsing for Beaver-generated grounded documents. A
layout pass may still be required to calculate cited-at pages in a rendered
document; that is pagination, not citation rediscovery.

## Court profile and source contract

### Profiles stay exact

UI consolidation must never merge court requirements. A resolved
`CourtProfile` continues to own:

- jurisdiction, court, division, language, document family, role, and variant;
- court and document identity plus a separate data-driven selection descriptor;
- moving/responding/applicant/respondent/intervener variant;
- required, ordinary, conditional, and forbidden document roles;
- filing order;
- output mode and editable-DOCX exceptions;
- cover/form geometry and electronic/paper colour;
- pagination, page labels, hyperlinks, bookmarks, and initial bookmark view;
- contents/index columns and document-date requirements;
- measured page/file/volume limits; and
- source receipt IDs.

Adding a court should require profile/source data and output fixtures, not a
new React component or assembly branch unless the court genuinely requires a
new output primitive.

### Auditable official sources

Every non-generic preset field must trace to legislation, a court rule,
practice direction, official guidance, or an official/real filing example.
Enhance the existing court-output receipts to record:

- stable source ID, title, authority type, URL, parent URL, and exact locator;
- jurisdiction/court/document profiles affected;
- date verified and effective period;
- response hash plus ETag/Last-Modified when the source supplies them;
- whether the source is normative or merely a layout example; and
- a hash and provenance note for each visual example used.

The v2 receipt manifest maps every source to exact supported profile IDs. The
audit script validates that coverage offline, uses conditional requests only
when a receipt is due or explicitly selected for refresh, and preserves the
last verified response when a refresh fails. CanLII receipts are manual-only;
the script rejects any attempt to request them. It does not run at product
startup. Downloaded source files remain ignored unless their licence permits a
small committed fixture. Receipts and fixture hashes are internal; **Official
sources**, **Preparation details**, and effective-date boilerplate never appear
in the builder UI.

### Real-document visual truth

For every generated cover, form, contents page, colour, bookmark pattern, and
pagination rule:

1. identify the governing official text;
2. locate an official sample or a high-quality real filing where available;
3. record its source/hash in the receipt;
4. render the generated output to images; and
5. compare text, order, geometry, spacing, colour, page labels, links, and
   bookmarks against that reference.

“Court-like” is not an acceptance standard. When the court supplies an exact
form, reproduce that form. When examples vary, implement the governing rule and
record which real example informed discretionary layout.

## Court Records user experience

### Beaver catalogue entry

The standalone products keep their direct focused entry. Inside Beaver,
[the canonical Workflows catalogue](document-capabilities.md#product-vocabulary-and-workflow-catalogue)
provides consolidated discovery while the focused Court Records and Authorities
entries remain directly available:

- **Court and hearing materials** contains one **Court Records** definition and
  one **Authorities** definition;
- Court Records document families and court formats are choices inside Court
  Records, not separate catalogue workflows;
- Table of Authorities, Book of Authorities, or both are result choices inside
  Authorities, not separate catalogue workflows;
- each focused workspace owns its compact saved-draft control and accepts a
  direct draft link;
- Library, project, assistant, and nested-draft launch points resolve those same
  two workflow IDs with inputs already bound; and
- Beaver keeps the focused Authorities/Court Records navigation without adding
  duplicate workflow definitions or a second draft list.

This catalogue integration does not force the two products through a common
builder. They share only the small work-product model and launcher contract
already specified here.

### Draft entry and autosave

- Keep the original document-first affidavit flow recognizable.
- Add one compact **Drafts** control for New, Open, Duplicate, Rename, and
  Delete. Do not create a separate work-product dashboard.
- Autosave meaningful changes. Do not show repetitive Saved badges or toasts.
- Reopening restores profile, fields, party groups, document order,
  descriptions, bindings, and nested drafts.
- Healthy inputs are silent. Missing or changed inputs appear inline where the
  user can act.

### Document and format selection

Do not show every internal profile in a dropdown or a page of cards.

Use two compact selectors:

1. **Document** opens a searchable native dialog containing user-level document
   families such as Affidavit, Motion record, Application record, Appeal book,
   Extracts of Key Evidence, Condensed book, Trial record, or Filing set.
2. **Format** shows only applicable court and variant choices for that document:
   General, Alberta King's Bench, Alberta Court of Appeal, Federal Court, or
   Federal Court of Appeal, followed only when needed by Position/Party such as
   Moving/Responding or Applicant/Respondent.

Use buttons, `<dialog>`, labelled search, and native radio groups rather than a
custom listbox. The final selection resolves to one exact profile ID. “Motion
record” is one document choice; moving/responding is a variant. The same rule
applies to application records and other fundamentally shared families.

### Case and party data

Replace fixed first/second-party fields with:

```ts
type CasePartyGroup = {
  id: string;
  role: string;
  roleBelow?: string;
  parties: Array<{ id: string; name: string }>;
};
```

- Initialize the actual court roles: Applicants, Respondents, Plaintiffs,
  Defendants, Appellants, or other profile-defined labels.
- Each group supports multiple parties on one aligned row pattern.
- **Add party** extends a group; **Add intervenor group** adds the ordinary
  third group where relevant.
- Filing party is selected from the entered parties and is never retyped.
- Motion position is separate from underlying case roles.
- Covers and counsel blocks render the actual filing party on the correct side.
- Preserve the exact existing two-party geometry when there is one party on
  each side; extend deterministically for multiple parties/intervenors.

Group court/file information, parties, filing identity, hearing details, and
counsel/service details by meaning. Rows share alignment edges and compact
content widths; unrelated controls do not occupy one giant grid.

Offer an explicit **Save filing details** option for the lawyer's stable name,
organization, address, phone, fax, and email. Store it through the existing
preference port—locally in standalone/local mode and in the user's preferences
in cloud mode—and prefill only empty fields. It is not copied into unrelated
draft state when the option is off.

### Dates and descriptions

- Remove native calendar inputs. Use a compact labelled text input with an
  example format and tolerant deterministic normalization.
- Do not show or store a generic “Index date.”
- Every uploaded item has an editable **Contents description** (or **Document
  name** for separate-file sets). It feeds the table of contents and bookmark.
- Default the description, in order, from the prescribed slot nature, reliable
  embedded PDF title/bookmark, then a cleaned filename. Never infer a legal
  date from filesystem timestamps.
- Ask separately for **Document date** only when the exact profile has a
  distinct date field or contents column. Federal Court/Federal Court of Appeal
  application records governed by Rules 309/310 are required initial cases;
  the Phase 0 matrix decides the others from their governing sources and real
  examples.
- Default a distinct document date only from an existing verified typed value
  or an unambiguous structured form field, and keep it editable. Never use a
  filesystem timestamp or a model guess. Where the court does not require a
  separate value, the lawyer can include a date in the arbitrary description.

### Document slots and files

- Show all ordinary profile slots in filing order. Do not hide standard items
  under Additional/Optional disclosures.
- Mark only genuinely mandatory items **Required**.
- Always show **Add another document** for a manually described repeatable
  item.
- Use **Add file** everywhere. Every user-supplied slot accepts PDF or DOCX.
- A non-repeatable role replaces its current file after confirmation rather
  than silently duplicating it.
- Preserve editable proposed orders or other court-required editable files as
  DOCX in separate-file outputs.
- For combined PDFs, route DOCX through the existing Beaver conversion
  operation. Standalone exposes the same capability through its host; it does
  not implement a browser-only converter.

### Preparation without visible audit noise

File selection automatically:

1. validates supported type and bounded size;
2. checks encryption/security restrictions;
3. inspects page count, text layer, metadata title, and bookmarks;
4. invokes the existing OCR operation when required; and
5. updates the entry when preparation completes.

Success is silent. Do not show Searchable badges or instructions asking the
lawyer to open a PDF and test it. A locked file gets one inline action-oriented
error. OCR shows existing progress and cancellation; this work does not alter
the OCR engine or expose provider settings.

### Build and output

- The normal UI should make invalid combinations unavailable rather than
  produce a late validator lecture.
- On Build, focus the first missing required field/slot and show its inline
  instruction. Do not list successful checks.
- Keep one scroll owner at each supported viewport. The build action remains
  reachable without nested-page scrolling.
- Combined records preserve exact order, cover/form, contents, tabs,
  continuous pagination, page labels, links, bookmarks, and initial view.
- Separate filing sets preserve source file type where required and receive
  deterministic court filenames.
- Word-native operations such as appending/updating a table of authorities or
  native authority fields use the existing DOCX/Office operation language and
  create a new document version. Filing-package assembly does not rewrite a
  source DOCX merely because it contains that source.

## Authorities TypeScript replacement

### Preserve the working workflow

The replacement must retain the current user capability before deleting
Python:

- import DOCX/PDF or start a manual book;
- deterministic citation and pinpoint occurrence review;
- split, merge, relink, reorder, exclude, rename, and supra/Ibid correction;
- exact source resolution and manual source attachment;
- Table of Authorities, Book of Authorities, or both;
- tab order, bookmarks, indexes, covers, inserted PDFs, and source-PDF review;
- native/linked DOCX table options and annotated source outputs;
- passage marking and discrepancy review; and
- bounded progress, cancellation, errors, and durable outputs.

Do not redesign this workflow merely because the implementation language
changes. Move the existing useful workspace into the main React application,
remove the iframe, and apply the same compact visual/accessibility system as
Court Records.

### Ownership after cutover

- TypeScript owns draft state, review operations, source orchestration, build
  orchestration, DOCX/PDF assembly, HTTP/application operations, and React UI.
- Rust owns citation occurrence structure, citation keys, reference grammar,
  and shared legal/PDF structure.
- Existing legal-source applications own A2AJ/OpenLegalData/provider lookup and
  PDF rendition status.
- Existing document operations own DOCX inspection/mutation/conversion.
- Existing PDF primitives own extraction/OCR; `pdf-lib`-style assembly may
  merge, bookmark, paginate, link, or overlay proven geometry.

Do not transliterate Python citation regexes or source resolvers into
TypeScript. Port product decisions and rendering that have no existing owner;
delete Python-owned copies once the Rust/TypeScript owners pass the parity
fixtures.

Python corpus-import or development scripts outside the product request path
are not part of this removal.

### CanLII handoff

When an authority needs a PDF and existing resolution can construct a
known-valid CanLII case URL, derive the sibling `.pdf` URL only from that
already-validated `canlii.org` route and neutral-citation slug. This is a small
URL transformation after host/path validation, not new citation parsing or a
second court-route table.

1. show one **Download from CanLII** link generated by the existing URL helper;
2. retain the authority as the pending attachment target;
3. accept the returned PDF through the ordinary **Add PDF** control, drag/drop,
   or an optional browser-local return funnel;
4. validate that it is a PDF and bind it directly to that authority without
   asking for citation/name/tab again; and
5. persist the binding in the Authorities draft and its build receipt.

Unknown or unsafe mappings provide no constructed link. The server never
fetches CanLII. The optional return funnel is session-only and browser-local:
after the explicit link click, it checks only a directory the user selected,
only for the exact expected filename (including the browser's duplicate-name
suffix), and binds that one recent PDF through the ordinary upload path. It
does not watch the filesystem generally, run without the pending click, or make
a CanLII request. Browsers without the directory-picker API keep **Add PDF**.

Record the current CanLII terms/link contract and one expected neutral-citation
HTML/PDF pair in the internal source audit. Verify it with a single
user-initiated live navigation, never an automated retrieval loop.

## Nested composition and refresh

### Normal refresh seams

Refresh occurs only:

- when a saved draft opens;
- when the user selects Refresh; and
- immediately before Build/Export.

Safe updates—new current Library version, new filename, prepared PDF becoming
ready—apply automatically. A change that affects reviewed semantic state
creates a focused review task.

### Authorities refresh

When its source document version changes:

- use a matching citation ledger directly;
- otherwise scan the new projection with the existing Rust occurrence API;
- carry authority-level decisions by resolved provider identity/citation key;
- carry occurrence-level decisions only when the structural target, source
  text hash, and local ordinal match unambiguously; and
- put unmatched additions/removals in the existing review UI. Never broaden a
  match to preserve a decision.

### Affidavit exhibit refresh

Add one narrow deterministic extractor for exhibit references in an affidavit
projection. It returns label, displayed text, exact source locator, and
confidence/ambiguity—not a file guess.

- A newly mentioned unambiguous label may create a suggested empty exhibit
  slot in order.
- An attached exhibit whose mention disappeared is flagged for review but not
  removed.
- Filename similarity may help sort candidates only after the user selects
  files; it never establishes exhibit identity.
- Ambiguous, duplicated, or non-lettered references abstain.

This is a genuine new legal-structure feature and receives its own accepted
corpus. It must live with the shared structure grammar if it generalizes; the
Court Records UI may not grow a private regex parser.

### Nested build

A parent resolves child drafts in dependency order. If a child is current, use
its latest named output. If it is deterministically rebuildable, rebuild it and
continue. If it has missing inputs or review items, open/focus that child and
stop before producing a stale parent. Every parent receipt records the exact
child build/output version used.

## Beaver assistant operation

Standalone contains no LLM path.

Beaver exposes one specialist operation/tool over the same application used by
the UI, provisionally named `update_work_product`. It can:

- create or select a Court Records or Authorities draft;
- select a valid profile/template ID;
- bind authorized Library documents to valid slot IDs;
- bind a named output from another authorized work product;
- add authority seeds from evidence IDs registered in the current turn; and
- fill case/party/counsel/document-description fields that are still empty.

It cannot:

- overwrite a non-empty user field;
- invent profile, slot, document, output, provider, citation, or URL IDs;
- upload a local file, call OCR/parser internals, or construct application
  URLs;
- bypass project/user authorization; or
- build/file a package without the ordinary application operation and current
  draft revision.

The tool returns a typed host event containing the draft ID and revision. The
frontend opens or refreshes the ordinary draft UI. There is no assistant-only
builder screen or duplicate draft model.

This is the reusable interaction seam for future focused apps: a product is
identified by kind, ID, project, and expected revision; its domain operation
accepts semantic field, slot, and resource IDs; and the normal host reconciles
the returned revision into its controlled UI. Adding another app extends the
explicit work-product union and switch with one domain adapter. It does not add
a UI-schema renderer, DOM-driving tool, plugin registry, or assistant-owned
copy of the product state.

Beaver may render that same workspace either as the main surface or as a
right-dock tab. From the main Authorities or Court Records surface, the existing
Assistant can open beside it with the current draft and bound resources in
context. These are host placements, not separate products: the standalone host
does not provide an Assistant capability and therefore renders no disabled
control, empty rail, or reserved space. The workspaces never import chat/model
code or branch on local versus cloud deployment.

## Interface quality contract

### Layout and hierarchy

- One page-level heading; section headings descend semantically and visually.
- Use the existing serif/sans pairing and a small repeatable type scale; no
  one-off heading sizes.
- Group with spacing and shared alignment edges before borders/cards.
- Keep controls visually distinct from explanatory/output content.
- Inputs use 16 px text on narrow viewports and compact widths appropriate to
  their content on desktop.
- Long descriptions wrap; IDs, filenames, and party names remain fully
  reachable rather than irreversibly truncated.
- The original affidavit 1–2–3 reading order remains obvious.

### Writing

Every visible sentence must help the lawyer choose, enter, fix, or build
something. Buttons are verb-first and use one term consistently.

Remove implementation/process prose including:

- source/effective-date chatter;
- “preparation details” or audit receipts;
- explanations of ordinary court rules that do not affect the current action;
- successful technical status labels;
- “open and confirm” PDF inspection instructions; and
- generic “additional documents” copy where the actual slots can be shown.

Errors identify the item and the next action. Empty states orient and provide
one next step. Placeholders are examples, never labels.

### Accessibility

- Native buttons, links, inputs, radios, and dialogs before ARIA widgets.
- Complete keyboard flow, Escape-close/focus return for dialogs, visible
  `:focus-visible`, and no positive tabindex.
- Labels for every field; inline errors use `aria-invalid` and
  `aria-describedby`; Build focuses the first error.
- Stable polite progress region for OCR/build/library updates.
- No state conveyed by colour alone; hit targets meet WCAG 2.2 AA.
- Reflow at 320 CSS px, 200% zoom, text-spacing overrides, forced colours, and
  reduced motion without hidden content or horizontal task scrolling.

### Visual restraint

- Reuse the existing Tailwind/component system and icon set.
- No repeated nested card chrome, decorative gradients, excessive badges, or
  animation on routine actions.
- Exact property transitions only; reduced motion is honored.
- Court-output previews are evidence for the generated file, not decorative
  “court-like” mockups.

## Performance and maintainability budgets

- Draft list and profile catalog are local bounded data; opening the route does
  not query the Library.
- Library search starts only when its picker opens, returns the first bounded
  page (currently 24), and keeps server-side search/pagination.
- PDF.js, assembly, DOCX rendering, and Authorities build code remain lazy
  chunks; no parser or court sample enters the initial UI bundle.
- Removing the Authorities iframe/Python bootstrap must reduce first-use
  process latency, not replace it with eager browser initialization.
- Hash only at trust/build boundaries or after cheap metadata reports a
  possible local-file change.
- Each new court is data plus fixtures unless it requires a genuinely new
  output primitive.
- Use one explicit switch over the two work-product kinds; no registry/factory
  abstraction.
- Run `npm run measure:source` at each phase. Any shared abstraction must remove
  more duplicated policy than it adds; do not pay for feature growth by
  deleting meaningful tests.
- Record browser/load/build medians against the current machine baseline and
  reject material regressions rather than choosing hardware-independent vanity
  thresholds.

## Implementation sequence

### Phase 0 — freeze legal and product truth

1. Inventory every current AB/FC/FCA profile, governing source, official form,
   real sample, output artifact, and current automated test; build a gap matrix
   against the full release inventory above rather than assuming the current
   profiles are complete.
2. Re-check official rules/practice directions, including federal statutory
   requirements, through the existing source-audit receipt format.
3. Verify CanLII's current terms and deterministic neutral-citation HTML/PDF
   link contract without bulk navigation or downloading a corpus.
4. Record real-sample hashes/locators and render current outputs to reference
   screenshots.
5. Freeze the current Authorities capability/parity matrix and representative
   review/build fixtures before removing Python.
6. Record current UI/library/startup/build timings and production LOC.

Gate:

- every release profile has complete normative sources and at least one
  permitted visual reference where a real example exists;
- every requirement is classified as normative, official example, or chosen
  presentation;
- no source/audit prose is added to the product UI; and
- no experiment or `RESULTS.md` is created.

### Phase 1 — work-product kernel and resumability

1. Add the `WorkProduct` union, input/output contracts, repository/application,
   route, and domain frontend client.
2. Add the one `work_products` table to both relational compositions.
3. Add the IndexedDB standalone store and retained file-handle adapter.
4. Add resolve/open/save/duplicate/delete operations with optimistic revision.
5. Save Beaver outputs as versions of stable Library output documents.
6. Replace Court Records localStorage/in-memory persistence with the draft
   operation; delete the old state format.

Gate:

- standalone survives browser/app restart with real handles;
- moved/deleted/permission-revoked files retain their slots and relink cleanly;
- Beaver latest/pinned resolution returns exact immutable snapshots;
- local/cloud repository contract tests pass; and
- no feature code imports a relational, filesystem, Supabase, or IndexedDB
  adapter directly.

### Phase 2 — rebuild the Court Records interaction

1. Replace the profile catalog/dropdown with Document + Format dialogs and one
   data-driven profile resolver.
2. Add repeatable party groups, intervenors, filing-party selection, and
   correct counsel-side rendering.
3. Add explicit reusable filing details.
4. Flatten all ordinary document slots into filing order, add the permanent
   other-document slot, and use Add file for PDF/DOCX.
5. Replace index-date/native-date controls with the description/date policy.
6. Automate preparation/OCR orchestration and remove successful technical
   badges/instructions.
7. Rebuild hierarchy, grouping, responsive layout, error focus, and the one
   scroll owner.
8. Register the one canonical Court Records launcher; saved drafts remain in
   the focused workspace and open through exact draft links.

Gate:

- the generic affidavit retains a clear three-step flow;
- Motion/Application consolidation resolves to every exact legal profile;
- multiple parties and intervenors render in UI, cover preview, and output;
- every standard slot is visible and only true requirements say Required;
- a keyboard-only user completes every primary flow at 320 px and desktop; and
- screenshot review has no unresolved layout, hierarchy, copy, or control-state
  finding.

### Phase 3 — complete exact Alberta/federal outputs

1. Finish every release profile's forms/covers, colours, contents, ordering,
   pagination, page labels, bookmarks, links, volume behavior, filenames, and
   separate-file semantics.
2. Route combined-build DOCX inputs through the existing conversion operation.
3. Preserve editable proposed orders and other mandated DOCX outputs.
4. Fix multi-party/intervener form layout and counsel placement.
5. Add renderer-independent structural assertions plus rendered-page visual
   comparisons against the recorded real examples.

Gate:

- every listed AB/FC/FCA profile builds from representative real PDF/DOCX
  inputs;
- PDFs open, text/search, links, page labels, bookmarks, initial view, covers,
  colours, and pagination are inspected programmatically and visually;
- separate filing sets contain the correct ordered files and types;
- source audit reports no unexplained changed/unreachable normative source; and
- outputs are exact/professional, not merely plausible.

### Phase 4 — replace Authorities with TypeScript

1. Define the TypeScript Authorities draft/review model from the frozen parity
   fixtures.
2. Route extraction through document projection and Rust citation occurrences.
3. Route resolution through existing legal-source applications.
4. Port only unresolved review/grouping/rendering behavior that has no existing
   owner.
5. Build Table/Book/annotated outputs with existing DOCX/PDF primitives and
   stable Library output versions.
6. Move the working workspace into React and remove the iframe.
7. Implement the persisted pending-authority CanLII manual handoff.
8. Register the one canonical Authorities launcher; saved drafts remain in the
   focused workspace and open through exact draft links.
9. Switch every UI/route/tool caller, then delete the Python worker/bootstrap
   product path and helper project state.

Gate:

- the frozen Authorities parity matrix passes against real DOCX/PDF fixtures;
- no Python process starts during import, review, source attachment, build, or
  download;
- no TypeScript copy of Rust citation/structure grammar exists;
- CanLII handoff performs zero server fetches and binds the selected PDF to the
  right authority in one return action; and
- current Authorities workflow screenshots and live behavior remain at least
  as clear and complete as the existing product.

### Phase 5 — citation ledger, nesting, and refresh

1. Persist authority seeds/targets in generated-document provenance.
2. Add direct receipt/ledger ingestion to Authorities.
3. Add work-product-output bindings and dependency resolution.
4. Implement conservative Authorities refresh across source versions.
5. Add and corpus-gate deterministic affidavit exhibit mentions.
6. Add topological nested build with exact child-output receipts.

Gate:

- a grounded receipt becomes a reviewed Authorities entry without a citation
  scan;
- a generated DOCX ledger is used only for its exact version/hash;
- changing a brief updates its Authorities draft and then its parent Court
  Record without reselecting sources;
- ambiguous occurrence/exhibit changes abstain and appear in focused review;
- cycles fail before any output mutation; and
- the parent receipt identifies the exact child build used.

### Phase 6 — Beaver assistant handoff

1. Add the single application operation and specialist tool.
2. Resolve evidence IDs and document/draft IDs server-side.
3. Enforce empty-only field fill, valid profiles/slots, authorization, and
   expected revision.
4. Emit the existing typed host event pattern so the normal UI opens/refreshes.
5. Add the two Beaver host placements: draft in the right dock, and the existing
   Assistant beside a full draft workspace with draft context attached.

Gate:

- the tool can create and populate representative Court Records and
  Authorities drafts from existing Library/evidence resources;
- user-entered non-empty fields never change;
- invalid/unauthorized IDs fail without partial mutation;
- standalone bundles and UI contain no assistant/model code path; and
- no assistant-only product state or screen exists.

### Phase 7 — production proof and deletion

Run focused tests continuously. For the complete candidate:

1. exercise every behavior in the live-proof matrix below with ChromeDriver;
2. capture desktop/narrow/high-zoom screenshots and generated-PDF page images;
3. inspect keyboard, screen-reader names/status, forced colours, text spacing,
   and reduced motion;
4. compare performance/LOC with Phase 0;
5. confirm all displaced MVP/Python/iframe paths are deleted; and
6. run the repository release checks, ending with the production launcher
   smoke using Authorities.

Do not run `full-sweep.ps1` without the exact authorization token required by
the repository guide.

## Live-proof matrix

| Scenario | Required observed result |
| --- | --- |
| Standalone restart | Reopen a named draft with profile, fields, order, descriptions, and real local handles intact. |
| Missing local source | Delete/move one file; reopen; its exact slot remains and Relink file restores it without losing metadata. |
| Changed local source | Modify a retained file; Refresh detects it and the next receipt contains the new hash. |
| Beaver latest version | Add a Library version; a latest binding resolves it, while a pinned binding remains exact. |
| Generic affidavit | Complete the original three-step flow with multiple exhibits and build successfully. |
| Multiple parties | Build representative applicant/respondent/intervener and multi-party covers without overlap or wrong counsel side. |
| Every court profile | Build and inspect every AB/FC/FCA profile listed in release scope. |
| DOCX source | Add Word through Add file; combined PDF converts through the existing operation; editable separate DOCX remains editable. |
| Locked PDF | Show only the affected file and recovery action; no internal inspection instruction. |
| Textless PDF | Start existing OCR automatically, show progress, then build the prepared source. |
| Authorities parity | Import, review, correct, attach sources, build Table/Book/both, reopen, edit, and rebuild without Python. |
| CanLII handoff | From a known neutral cite, manually open the constructed PDF link once, select the downloaded PDF on return, and see it attached to the pending authority with no server fetch. |
| Grounded receipt | Add a case/legislation receipt directly; prove the citation occurrence scanner was not invoked for that seed. |
| Nested build | Brief v1 → Authorities → Court Record; create brief v2; refresh/rebuild children and export a parent receipt naming all new versions. |
| Exhibit refresh | Add/remove/duplicate exhibit mentions and observe conservative suggestions/review with no guessed file binding. |
| Assistant fill | Populate empty fields/slots in Beaver; prove existing values remain byte-for-byte unchanged. |
| Responsive/accessibility | Complete primary flows by keyboard at 320 px and 200% zoom with visible focus and announced progress/errors. |
| Load performance | Open Court Records and Authorities, then Library picker; bounded/lazy behavior meets or improves the recorded baseline. |
| Workflow catalogue | Find each product once in Workflows, reopen its draft from the focused workspace, and prove every contextual launch resolves the same workflow ID. |

## Required automated gates

During slices, use the smallest affected tests plus TypeScript/build and source
boundaries. The complete candidate runs:

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
npm run check:source-boundaries
npm run check:grammar
node docs/scripts/check-docs.mjs
.\scripts\mike.ps1 smoke
```

Additional feature gates:

- work-product repository contract over SQLite and Postgres;
- IndexedDB/File System Access browser restart tests in real Chrome;
- Court profile/source receipt audit;
- exact Court Record structural and rendered-output tests;
- Authorities parity fixtures and live Chrome workflow;
- Rust citation/ledger no-reparse behavior test;
- nested resolution/cycle/stale-child behavior tests;
- generated DOCX/PDF open/parse/search/bookmark/link checks; and
- accessibility automation plus the manual keyboard/screen-reader pass.
- workflow catalogue deduplication, audience filtering, and contextual binding
  tests.

## Deletion/cutover list

The feature is not complete while these displaced paths remain:

- Court Records `localStorage` workspace state and non-resumable entry model;
- fixed first/second party cover ownership;
- profile catalogue disclosure/current all-profile selection UI;
- native calendar/index-date UI and successful Searchable badges;
- hidden Additional/Optional document sections;
- user-facing official-source/preparation/check instructions;
- duplicate workflow aliases for Authorities/Court Records document or output
  variants; their focused top-level entries remain;
- Authorities iframe host and private Python stdio workspace proxy;
- Python Authorities browser/server/job/project persistence and managed runtime
  from the product launch path;
- duplicated Python citation/source-resolution logic superseded by existing
  Rust/TypeScript owners; and
- any temporary compatibility route, old DTO, feature flag, or dual-read path
  introduced during development.

## Stopping rule

Stop when both work products are resumable, composable, exact for the release
profiles, and proven live; Authorities has no Python product dependency; known
grounded citations travel by receipt rather than text rediscovery; the UI has
no unresolved functional/layout/accessibility finding; and adding BC requires
data/fixtures rather than another architecture.

Do not continue into a Filing Builder, general workflow graph, universal court
ontology, background watcher, or new jurisdiction in this spoke.
