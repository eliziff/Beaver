# Document capabilities, legal workflows, and portable features

Status: accepted implementation plan

Date: 2026-08-29

This plan joins five related product goals:

1. token-efficient, precise Word authoring and editing;
2. broad, preservation-safe access to Word formatting and OOXML features;
3. first-rate citation linking and source verification; and
4. cheap composition and opt-out for features built from Beaver's existing
   primitives; and
5. one maintained implementation for capabilities that also ship as focused
   standalone applications.

The governing decision is simple: **one compact document-operation language,
two executors, and no feature runtime**. The Library executor edits immutable
DOCX packages. The Word executor applies the same operations to the live Word
document through Office.js. Both use Beaver's existing application operations,
jobs/agents, tool registry, evidence records, and persistence ports. A focused
standalone product may host the same capability through a thin local-file shell;
it does not get a second engine or maintained UI.

The detailed deterministic operation catalog remains
[Deterministic Microsoft Word actions](../decisions/document-actions.md). This
document decides how to expose, implement, test, and compose that catalog.

## Product vocabulary and workflow catalogue

**Workflows** is the sole user-facing umbrella for repeatable legal work.
Assistant recipes, tabular reviews, deterministic document operations,
Authorities, and Court Records do not compete as separate product categories.
They are implementation or workspace varieties behind the catalogue.

A catalogue entry must represent a coherent job that a lawyer would
intentionally start, with meaningful inputs, state, and a result. Do not promote
every primitive or stage into another feature. In particular:

- revising, proofreading, citation linking, and supra/ibid repair are stages of
  Drafting;
- exact quotation comparison and proposition-support review are integrated
  stages of one Quote Checking workflow;
- searching, reading, noting up, treatment checking, evidence collection, and
  memo production are stages or results of one Legal Research workflow;
- written and tabular presentations are result choices, not duplicate
  workflows; and
- Authorities and Court Records are first-class workflows because each has
  durable drafts, substantial review/assembly state, and distinct outputs.

Every workflow has one canonical definition and one canonical catalogue home.
The selected document, its author, the matter, and the desired result are
inputs; they do not create differently named copies in several branches.
Contextual launch points reference the same definition. A running job, saved
draft, or output is state beneath that workflow, not another category.

The initial catalogue is:

| Category | Canonical workflows | Audience |
| --- | --- | --- |
| Drafting and document preparation | Drafting | General |
| Document review and comparison | Document Review; Document Comparison | General |
| Research and verification | Legal Research; Quote Checking | General |
| Templates | Templates | General |
| Agreements | Agreement Work | Solicitor |
| Due diligence | Due Diligence | Solicitor |
| Transactions and closing | Transaction Management | Solicitor |
| Corporate records | Corporate Approvals | Solicitor |
| Written submissions | Submission Drafting | Litigator |
| Evidence and discovery | Evidence Review | Litigator |
| Court and hearing materials | Court Records; Authorities | Litigator |

The catalogue has **General | Solicitor | Litigator | All** audience tabs.
General contains genuinely cross-practice work. Solicitor and Litigator include
the General workflows plus their applicable work. All is the deduplicated
union. `General Transactions` is deleted rather than retained as a catch-all.
Practice area and jurisdiction remain secondary filters or workflow inputs.

Stop using **Automation** and **Actions** as user-facing product categories.
The contextual label is **Run workflow**. `DocumentAutomation.tsx` and
`AutomationRun.tsx` are replaced by the ordinary workflow launcher and shared
run presentation; no action registry or parallel run model is introduced.

Tabular review remains a view over ordinary agent jobs and row-shaped results.
Chat, subagents, deterministic operations, work-product workspaces, and tabular
review keep their existing execution owners behind one small closed launcher
union. The catalogue is discovery and composition, not a universal workflow
engine, feature registry, or plugin runtime.

## Boundaries

```text
Beaver workflow catalogue/panel      standalone shell
          \                           /
             one capability UI/core
                       |
       application operation + existing jobs
                       |
  existing domain primitive/executor (DOCX, Office.js, PDF, citations)
                       |
       versions, sources, evidence, receipts
```

Core Beaver supplies:

- accounts and account-free local identity;
- Library documents and immutable versions;
- application operations and persistence ports;
- jobs, agents, cancellation, progress, and run history;
- the model tool registry and lazy tool loading;
- legal structure, source resolution, evidence receipts, and links; and
- the workflow catalogue and contextual launch surface.

A feature may compose those primitives. It may not create its own chat
store, worker, tabular engine, file store, source registry, user table, or
local/cloud branch.

Hosting is orthogonal to Beaver's feature preference. **Authorities** and the
**Court Record Builder** remain independently runnable products while
also appearing inside Beaver. Each has one maintained browser UI and one build
or analysis core. Its standalone shell supplies local-file inputs, downloads,
and local preferences; its Beaver adapter supplies owned Library versions,
immutable outputs, and receipts through the existing application operations
and persistence ports. Beaver's account-free/cloud choice remains entirely at
the composition root. Do not duplicate business logic, settings, progress UI,
or product screens between the two hosts.

| Capability | One maintained implementation | Standalone edge | Beaver edge |
| --- | --- | --- | --- |
| Authorities | TypeScript workspace/build application preserving the current product's parity fixtures; shared Rust owns citation and structure primitives | Local files, IndexedDB draft/file-handle bindings, download | Library versions, durable work products, immutable outputs, receipts |
| Court Record Builder | Production profile, layout, assembly, form, and receipt modules over the same small work-product model | Local PDF/DOCX inputs, IndexedDB draft/file-handle bindings, download | Exact Library versions, durable work products, immutable outputs, receipts |

The exact cutover, persistence, composition, and live-proof contract is in the
[durable legal work-products plan](legal-work-products.md). The Python
Authorities application is the current behavior oracle during that replacement,
not a second maintained product architecture.

## One lean Word operation contract

Keep the four model-visible operations already chosen in the action catalog:

```text
word_inspect   -> bounded content, targets, findings, or requested capabilities
word_preview   -> exact proposed changes and a version-bound receipt
word_apply     -> apply one receipt and return the resulting version/change IDs
word_review    -> accept/reject changes and resolve/reopen comments
```

The current `apply_word_edits({original,replacement,replace_all})` contract is
a disposable prototype. `original` cannot safely be both content and locator.
Delete it when the first handle-based slice lands; do not add fuzzy matching,
occurrence guessing, or a larger prompt around it.

### Keep schemas small without limiting formatting

The top-level schema stays small. Operation detail is loaded on demand:

```text
word_inspect({capabilities:["paragraph_format","sections"]})
  -> compact descriptors for set_paragraph_format and set_section_format

word_preview({
  target_ids:["p:..."],
  op:"set_paragraph_format",
  args:{keep_next:true, spacing_after_pt:6, outline_level:2}
})
```

`op` and `args` are validated by a closed server-side operation catalog. The
model sees only the requested capability family, not every Word property on
every turn. Common requests use short profiles such as `legal_body`,
`factum_heading`, or `table_header`; technical requests use the typed property
map for the relevant run, paragraph, list, table, section, field, note,
content-control, drawing, or package-metadata family.

This balances the two goals:

- token efficiency comes from semantic profiles, bounded reads, handles, batch
  operations, and capability loading; and
- breadth comes from adding preservation-tested properties behind the same
  operation, without adding model tools or exposing XML.

Literal support for every possible OOXML extension would require arbitrary XML
patching. That is not a model tool. Unsupported properties fail with the exact
target, QName/property, and reason; a property becomes supported only with a
round-trip fixture. A developer-only package inspection utility may remain
available for diagnosis, but models never author raw OOXML or XPath patches.

### Targets, not text guesses

A target is minted by inspection or by the user's current selection.

For an immutable Library version it contains:

- document and version ID;
- package part/story;
- paragraph/object identity;
- local span, visible-text hash, and relevant property hash; and
- structural boundaries such as field, hyperlink, bookmark, revision, or
  content-control containment.

For a live Word session it contains:

- document-session and inspection epoch;
- Office.js paragraph `uniqueLocalId` or a tracked Range owned by that session;
- exact text/property preconditions; and
- the same logical story/object metadata where Office.js exposes it.

Office.js local IDs and tracked proxies are useful session handles, not durable
Library identifiers. On reload, coauthoring change, target mismatch, or a stale
inspection epoch, the executor rejects the action and re-inspects. It never
broadens the match. Ambiguity may be reported while searching for candidates;
it cannot survive into mutation.

### Preview and review

Preview is mandatory for model-authored or multi-target changes. It returns:

- exact before/after material;
- target count and target IDs;
- affected package parts or Word objects;
- preservation warnings;
- source version/session epoch and content hash; and
- whether Word can represent the result as tracked changes.

Apply consumes the preview receipt. Library apply creates one immutable version
and mutation manifest. Live Word apply uses native tracked changes by default
and groups the operation for undo where the host permits it. Direct mode is an
explicit user choice, not a separate tool path.

## Two production executors

| Concern | Library package executor | Live Word executor |
| --- | --- | --- |
| Authority | Immutable DOCX bytes and version ID | Current Word document and session epoch |
| Mechanism | Minimal ZIP/OOXML part and relationship changes | Office.js Range, Paragraph, content-control, comment, field, and review APIs |
| Strength | Maximum package coverage, deterministic preservation checks | Native selection, layout, undo, tracked changes, and immediate review |
| Limitation | Cannot reproduce every layout/field result without an office host | API support varies by Word version/platform and does not expose all OOXML |
| Fallback | Fail closed or use an optional validation/render host | Re-inspect, use a supported native operation, or produce a new Library version; never replace the whole live package unsafely |

Both are adapters behind the same application operation. Feature code never
chooses SQLite/Supabase or local/cloud. The Word task pane uses the ordinary
backend session, tools, jobs, profile, and document operations.

Do not introduce .NET, Java, LibreOffice, or a commercial SDK into the request
path merely to obtain a larger object model. The current package surgery plus
Office.js is the smallest architecture that covers both local/cloud Library
work and native Word review. Optional office hosts may validate rendering,
refresh fields, or compare documents at test/release time.

## What the outside landscape tells us

| Option | Useful lesson | Beaver decision |
| --- | --- | --- |
| Microsoft Office.js | Native live selection, ranges, IDs, styles, comments, content controls, and tracked changes; API-set support varies by host. | **Production live executor.** Detect capabilities at runtime and keep package editing server-side. |
| Direct OOXML / Open XML SDK-style operations | Broadest access to package parts and exact properties; preservation and relationship correctness are our responsibility. | **Production Library executor.** Keep changes surgical and fixture-gated; do not add a second language runtime yet. |
| [`nberk/llm-docx-editing`](https://github.com/nberk/llm-docx-editing) | A reduced form and deterministic edit tools beat raw model-authored XML; its 50 tests cover formatting, controls, notes, and long documents. Mutable numeric indexes are the weak point. | Reuse benchmark ideas/fixtures where licence and gold permit; use Beaver handles, not shifting indexes or its application stack. |
| [DocOps](https://github.com/icip-cas/DocOps) | 210 Apache-licensed native-document tasks with deterministic artifact verifiers and content/format/structure × L1-L4 taxonomy. | **Primary external benchmark source.** Pin a commit and run/adapt the Word subset; keep Beaver's legal and preservation gold as separate lanes. |
| [`dealfluence/docx-benchmark`](https://github.com/dealfluence/docx-benchmark) | Measures success, token use, XML integrity, and untouched formatting across MCP tools. | Borrow metrics and the tool-neutral runner shape. Do not copy AGPL code into Beaver, and do not treat its small scenario set as gold. |
| [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) | An Apache-licensed .NET/Open XML SDK engine with compact path/query/set/batch operations, atomic batches, validation, and dump/replay. | **Design reference, not a workstream.** Borrow its progressive inspection, atomic batch, dump/replay, and QA ideas. Run it as an isolated comparator only when a Beaver benchmark failure poses a concrete engine question. |
| [SuperDoc](https://github.com/superdoc/docx-editor) | Its V2 correction is important: keep OOXML authoritative and use one document API in browser and headless modes. | Promising future web executor, but AGPL/commercial licensing and editor duplication require a separate decision and fidelity gate. |
| [ZetaOffice/zetajs](https://github.com/allotropia/zetajs) and [aiworkdeck's spike](https://github.com/zeweihan/aiworkdeck/tree/master/experiments/zetaoffice-spike) | Native document-model search, cursors, bookmarks, and `RecordChanges` avoid the “plain-text offset to rich-text coordinate” failure. The browser runtime is a full LibreOffice WASM build, needs cross-origin isolation/fonts/IME work, and is hundreds of MB. | Borrow the native-handle/redline lesson. Do not ship a second office suite for a Word add-in. Test it only as a future browser-editor or validation experiment. |
| ONLYOFFICE / Collabora Online | Mature embedded office editors and plugin APIs. | Too much deployment, UI, and plugin surface for the present need. Revisit only if Beaver decides to own a full collaborative browser editor. |
| Aspose.Words | Wide commercial object model, rendering, comparison, and revisions. | A possible paid oracle/competitor in experiments, not a core dependency or source of truth. Word remains the final interoperability host. |

The transferable aiworkdeck result is architectural, not its implementation:
plain-text offsets are the wrong locator, native search/anchors are correct,
and tracked changes should be the default. Its plugin specification has grown
into manifests, copied SDKs, JAR loading, permissions, packs, versioning, job
tables, bridges, and compatibility rules. Beaver should not recreate that.

OfficeCLI does not supply a missing Beaver architecture. Its useful novelty is
the product shape around Open XML: dump a subtree, edit a compact batch, replay
atomically, and fall back to raw package inspection for diagnostics. Beaver can
adopt those ideas without adding a .NET binary or a third executor. If a later
benchmark failure justifies comparison, pin one release in an isolated
experiment and judge it by the same preservation fixtures; otherwise do no
OfficeCLI work.

## Word manipulation benchmark

No single score can establish document safety. Build four independent lanes.

### Lane A — deterministic operation kernel

Run on every affected change, with no model and no network.

- One focused fixture per supported operation/property family.
- Compound fixtures combine the target with unrelated headers, footnotes,
  fields, hyperlinks, bookmarks, revisions, comments, controls, tables,
  drawings, custom XML, macros, and unknown extension parts.
- Verify exact postconditions, visible-text conservation, touched-part allowlist,
  untouched-part hashes, relationship integrity, OOXML/schema validity,
  idempotence, stale-receipt rejection, and reopen/save/reopen behavior.
- Render pagination-sensitive fixtures through installed Word where available
  and LibreOffice as a secondary oracle; compare PDF/page images with explicit
  tolerances. A renderer disagreement is a finding, not automatic truth.

### Lane B — agent contract and token efficiency

Run offline from cached traces by default; live provider runs require explicit
authorization.

- Start with the Word tasks from DocOps and the capability categories from
  `llm-docx-editing`; pin source commit, licence, imported task IDs, and any
  verifier changes in one upstream manifest.
- Add Beaver tasks for precise selection, repeated text, stale handles, long
  documents, high-detail formatting, tracked review, footnotes/endnotes,
  sections, tables, fields, controls, comments, and cross-document assembly.
- Compare the compact operation contract against the current provisional path.
  Add an external engine only to answer a specific benchmark failure, and count
  its command/help payload in the token projection.
- Record task success, exact target selection, input/output tokens, tool calls,
  retries, latency, touched parts, preservation score, and abstention quality.

### Lane C — Word add-in host

- Unit-test the Office.js adapter with a small fake that asserts public results,
  stale-handle behavior, capability degradation, proxy cleanup, and truthful
  error reporting.
- Use ChromeDriver and screenshots for the `/word` task-pane UI.
- Maintain an opt-in Windows Word smoke that sideloads the manifest, opens fixed
  fixtures, executes representative actions, saves the result, and subjects it
  to Lane A verification. Cover selection, review/direct mode, comments,
  fields, content controls, large batches, reopen, and unsupported API sets.
- Measure Office.js sync count, tracked-proxy count, time to first preview, and
  apply latency. Page large reads and untrack proxies promptly.

### Lane D — legal document actions

Keep separate accepted gold for:

- citation occurrence and authority-span boundaries;
- full style of cause, bare citation, short form, pinpoints, and authority kind;
- canonical authority identity and resolver snapshot;
- hyperlink source span and expected destination;
- quotation boundaries and exact source match;
- citation-link profile (`core` or `styled`, plus pinpoint links on/off), exact
  linked spans, and absence of linked signals/surrounding punctuation;
- quote matches inside the stated pinpoint, the same quote outside it,
  bounded editorial differences, repeated candidate passages, source-word
  text fragments, deterministic link fallback reasons, and paired
  Verification rescue outcomes;
- proposition boundaries and support verdict; and
- explicit unresolved, ambiguous, no-quote, and no-support cases.

The current provisional DOCX/ToA rows are not a denominator. Gold needs exact
annotated spans and identities, source/version receipts, double review for the
legal semantic subset, and adjudication of disagreements. Mechanical quote
matching and semantic support must never be collapsed into one score.

### Benchmark hard gates

- no character or supported structure changes outside confirmed targets;
- no lost or orphaned package relationships/anchors;
- stale previews never apply and repeated apply is a no-op;
- every mutation is recoverable and has a manifest;
- unsupported structures fail closed;
- the handle-based contract beats the provisional contract on correctness and
  does not regress median model tokens on simple edits; and
- no “top-rate” claim until the accepted legal and formatting gold is large
  enough to expose failures, not merely demonstrate examples.

Keep deterministic CI fixtures beside production tests. Keep live-model,
external-engine, and large-corpus runners under `experiments/`, with ignored raw
outputs and durable `RESULTS.md` findings.

## Top-rate automatic citation linking

The current Authorities code contains a general primitive in the wrong place.
Move it once; do not create another regex implementation.

### 1. Make `legal-structure` own citation occurrences

Port the general behavior represented by `_case_name_start`,
`_authority_bounds`, `_fields_for_authority`, and `extract_text_fields` from
the preserved Authorities snapshot `84469a3` into Rust beside the existing citator and
footnote structure code. The result for each occurrence should include:

```text
exact source span
authority/style span
full styled citation (including style of cause when present)
bare citation
short form
pinpoints
authority kind
confidence and deterministic reasons
```

“Expand citation to style of cause” has two distinct meanings:

1. **same-text expansion**: start from a citation regex match and expand within
   the occurrence to the existing style of cause/title; this belongs in
   `legal-structure`; and
2. **canonical-name resolution**: when the document contains only a bare
   citation, retrieve the authority's canonical name from a verified provider;
   this belongs in the source resolver.

Do not make a regex invent a name it cannot observe. Preserve the current
Authorities fixtures as parity tests, add adversarial fragmented-run and
multi-authority fixtures, then delete the Python duplicate after both consumers
use the Rust binding. Because this can affect corpus output, require the
legal-structure fidelity gate before promotion.

### 2. Link without rewriting

Expose two orthogonal choices, not four named modes:

| Input | Choices | Default | Exact effect |
| --- | --- | --- | --- |
| `citation_text` | `core` or `styled` | `core` | `core` links only the bare citation; `styled` links the observed style-of-cause/title plus bare citation. Neither includes a signal, pinpoint, or surrounding punctuation. |
| `link_pinpoints` | `true` or `false` | `true` | Each exact pinpoint span receives its own passage link when enabled. It remains plain text when disabled. |

Thus the ordinary result links the citation core and its pinpoints. The
authority/style link always goes to the canonical source anchor. A pinpoint
link goes to the most precise verified destination below. Styled and pinpoint
spans remain separate, so hyperlinks never overlap. These are action inputs
with ordinary defaults, not persisted profile infrastructure. The UI is one
choice—**Citation only** or **Style of cause and citation**—plus a **Link
pinpoints** checkbox that starts checked.

The Link citations action should:

1. inspect exact occurrence spans through `legal-structure`;
2. resolve the bare citation to a canonical source/version using existing
   providers and evidence records;
3. apply the two-field link profile and preview every precise visible span and
   destination;
4. add only hyperlinks and relationships to confirmed spans; and
5. return a receipt containing document version, occurrence, profile,
   canonical source, resolver snapshot, destination kind, and any fallback or
   abstention reason.

When a proposition immediately preceding a footnote contains a quotation,
linking composes the machinery Beaver already has:

1. take the exact quote spans from the proposition/footnote parser;
2. retrieve only the resolved source passage bounded by the citation's stated
   pinpoint;
3. ask the existing quote verifier for a structured result: `exact`,
   `normalized`, `bounded_editorial`, `ambiguous`, or `not_found`, including
   the actual source-word span and edit reasons;
4. for an exact, normalized, or uniquely bounded editorial match, pass the
   actual source words—not the draft's wording—to the existing text-fragment
   planner; and
5. use the fragment only when its plan is source-safe and complete. Otherwise
   use the ordinary pinpoint anchor, or the authority anchor if no pinpoint
   resolved.

“Bounded editorial” means deterministic typography/whitespace/hyphenation and
the small word-edit allowance in the existing Authorities/ALR-derived quote
alignment, moved behind the shared structured verifier. It never means
embeddings or semantic similarity. It must be unique inside the stated
pinpoint. Linking never searches the rest of the decision to rescue a bad
pinpoint. A match rescued elsewhere is useful to Verification, but is never a
link destination. If `link_pinpoints` is false, quote fragments are not
attached to the authority link; the authority link remains a canonical source
anchor.

The receipt records `text_fragment`, `pinpoint_anchor`, or `authority_anchor`,
the quote classification, actual source span/version, and fallback reason.
This lets Verification later report a suspect quote without changing where an
already safe citation link points.

It must not normalize or restyle visible citation text as a side effect. One
authority with several passages gets one ordered, deduplicated destination
receipt. Link health, authority identity, occurrence span, and pinpoint quality
are scored separately.

Generated DOCX citations continue to use the existing evidence-citation
renderer. Authorities and automatic linking consume the same Rust occurrence
record rather than importing one another.

## Verification feature

Verification is a document action backed by ordinary jobs/agents and displayed
as an ordinary tabular review. It has two deliberately separate passes.

### Mechanical pass — default and deterministic

For every cited proposition/quotation:

1. derive proposition, citation, quotation, and pinpoint spans through
   `legal-structure`;
2. resolve the exact source and version;
3. retrieve the bounded cited passage through the evidence/source plane;
4. reuse the existing quote-verification and repair machinery to classify
   exact, normalized, altered, omitted, or not found inside that passage;
5. when the bounded check fails, run the deterministic rescue ladder below;
   and
6. persist the finding with source and document receipts.

This pass uses no model and can run locally whenever the source is local.

#### Rescue after a failed bounded check

Verification should rescue; automatic linking should not. Reuse the
ALR-derived alignment and correction ideas already present in Beaver rather
than adding a new fuzzy matcher:

1. search the rest of the same resolved source/version for unique exact and
   normalized occurrences;
2. if none exists, locate the best bounded token-alignment candidate and build
   the source-faithful exact or editorial quotation with brackets/ellipses;
3. derive the candidate's real paragraph/page/section locator where source
   structure permits it; and
4. report `wrong_pinpoint`, `altered_quote`, `ambiguous`, or `not_found` with
   authored text, actual source span, match/edit explanation, and a proposed
   quote and/or pinpoint correction.

Rescue stays within the cited authority. It never treats semantic similarity
or a quote found in some other authority as verification. A repair is a
previewable suggestion, not an automatic rewrite; acceptance uses the ordinary
Word preview/apply path and tracked changes. Multiple equally good source
windows remain ambiguous. If a source has no usable locator structure, report
the verified source offsets and do not invent a pinpoint.

The same structured quote matcher therefore has two policies: linking asks
only for `within_stated_pinpoint`; Verification asks for that first and then
`rescue_within_resolved_source`. The receipt records which policy and search
scope produced the result.

### Semantic pass — optional and adversarial

When requested, enqueue one ordinary agent row per proposition. Give the model
only the proposition, exact cited passage, treatment context where relevant,
and the narrow question it must decide. The model never chooses or retrieves
its own source.

Use one small verdict contract:

```text
supported | partly_supported | unsupported | contradicted | insufficient
reason
most_relevant_source_span
```

The review table needs only: Proposition, Citation, Quote match, Support,
Evidence, and Status. Existing tabular generation, Stop, retry, run progress, source
viewer, and evidence links do the rest. No Verification worker, chat store,
review database, or bespoke model loop is permitted.

Acceptance requires high precision on unsupported/contradicted findings,
calibrated abstention, exact evidence links, reproducible provider/model
receipts, cancellation, usable partial results, and a human-accepted legal gold
set. Quote presence is never presented as proof that a proposition is supported.

## Boring feature composition

Do not build a feature registry, plugin contract, lifecycle, event bus, or JSON
UI renderer. Built-in features are ordinary statically imported code. One small
`features` object in the shared user preferences records which optional product
areas are enabled. The existing composition roots check the relevant boolean:

1. navigation, routes, and focused panels;
2. contextual workflow launch points;
3. model-visible tool schemas and handlers; and
4. server application operations that can start new work.

Disabling a feature removes its launch points and rejects new invocations. It
does not delete prior documents, receipts, or results. The preference goes
through the existing repository, so account-free local and cloud modes behave
the same and feature code never selects a persistence adapter.

Adding a built-in feature means adding one explicit default and wiring its real
entry points. That small repetition is intentional: TypeScript can find it, a
reviewer can understand it, and there is no indirect registration protocol to
debug. Only introduce a shared function or component after two production
features need the same behavior.

The reusable construction kit is Beaver's existing code, kept host-neutral
where useful:

- buttons, inputs, dialogs, tables, page headers, document viewers, downloads,
  and accessible loading/error states;
- Library/version selectors and local-file inputs as thin host edges;
- application operations, jobs, progress, cancellation, outputs, and receipts;
- agents and tabular review for model work; and
- legal structure, source resolution, quote checking, and document mutation.

Do not force Authorities and Court Record Builder through a common
`PortableFeature` interface. They share only the small `WorkProduct` draft,
binding, output, and receipt model required for resumability and composition;
their domain builders and screens remain explicit. Authorities replaces its
localhost/iframe product shell with one TypeScript browser UI mounted by the
standalone local-file entry and Beaver Library entry. Court Record Builder uses
the same host pattern. Its PDF assembly composes the existing parser/OCR host;
editable proposed orders pass through as DOCX without a second Word mutation
engine. Specialized Authorities delivery may append its linked table through
the shared Word operation contract.

Automatic hyperlinking remains a Drafting stage, while Authorities may consume
the same occurrence results. Its parser, resolver, and document operation remain
core primitives because verification and generated documents also need them.
Quote Checking uses the existing tabular/job surfaces where its integrated
review produces structured findings.

## UI plan

- **Workflows** is the single catalogue destination. Remove separate top-level
  Automation, Actions, Tabular Review, Authorities, and Court Records discovery
  surfaces; their existing focused routes remain launch targets and resumable
  workspaces where required.
- The catalogue begins with **General | Solicitor | Litigator | All**, then
  progressively reveals the concrete categories and canonical workflows in the
  table above. It never starts with assistant/tabular/system implementation
  types or one alphabetical dump.
- **Continue working** shows recent runs and saved work-product drafts by
  projecting existing state. Do not add another history store.
- One workflow appears once per filtered result set and once in All. Search,
  category browsing, Library shortcuts, and project shortcuts resolve the same
  workflow ID and cannot create alias definitions.
- Consolidate paired assistant/tabular system entries into one workflow with a
  result choice such as written review, review table, or both. Show execution
  details only when they materially change cost, availability, or behavior.
- A contextual **Run workflow** panel shows compatible workflows for the
  selected resource and opens the same catalogue definition with that resource
  already bound.
- Each invocation uses the existing job/run progress, Stop, partial-result, and
  result-link UI where it was launched. Work-product workflows open their
  ordinary draft workspace. Do not create feature-specific progress chrome.
- User-created workflows choose one canonical category and the audiences for
  which they are applicable, with additional applicability metadata only where
  needed. They do not create a
  custom category tree.
- **Features** in Settings enables optional product areas and explains what each
  adds. Account-free local and cloud accounts see the same choices.
- Authorities, Court Records, Legal Research, Quote Checking, and other
  workflows may have focused panels, but catalogue launch, progress, evidence
  navigation, and review controls remain shared primitives.

## Implementation order and gates

### Phase 0 — upstream closure (complete in this working tree)

- Record every Mike PR through #383 as `have`, `skip`, or the two remaining
  Word review items in `docs/decisions/upstream-mike.md`.
- Keep one cursor and one ledger; use `Upstream-Mike` commit trailers.
- No migrations or compatibility machinery.

Gate: no non-Word `todo` remains and focused auth/profile/model/tabular/folder
checks pass.

### Phase 1 — consolidate existing products and surfaces

- Add the shared feature preference and make Authorities its first complete
  vertical slice: navigation, focused panel, contextual action, assistant tool,
  and job submission all honor the same value.
- Keep the current Authorities browser/job path stable only as the parity
  baseline. Do not build an interim gateway architecture; replace it through
  the work-product plan once the shared persistence seam is ready.
- Replace the hard-coded Automation category, separate Actions terminology, and
  implementation-type tabs with the canonical Workflows catalogue. Reclassify
  the current system entries, delete `General Transactions`, consolidate
  assistant/tabular pairs as result variants, and reuse existing job/run views.
- Serve that browser from one `GET /api/workflows?audience=&q=` collection;
  delete the split `/system` collection, type filtering, and client-side merge.
  The checked-in system IDs are the kebab-case names in the catalogue table
  (`document-review`, `court-records`, and so on).
- Keep launch dispatch closed and explicit: `instructions` carries one or more
  assistant/tabular result variants, while `authorities` and `court_records`
  open their focused workspaces. Old subject-specific recipes remain choices
  inside the apt canonical workflow, never catalogue aliases.
- Keep Court Record Builder's production domain/UI modules behind the existing
  standalone-file and Beaver-Library adapters. Compose them directly from
  existing Beaver components; experimental prototypes are reference material,
  never a second maintained product.

Gate: both products retain their standalone flows, their Beaver entry points
resolve through one canonical workflow definition, the audience/category
catalogue never duplicates a workflow ID, existing job/work-product state powers
Continue working, local/cloud composition and court-record fixtures agree,
source boundaries pass, and no second UI, engine, store, worker, or progress
system exists.

### Phase 2 — benchmark baseline and handle kernel

- Pin the DocOps Word subset and selected MIT benchmark tasks in one upstream
  manifest; add Beaver's adversarial preservation and repeated-text fixtures.
- Implement target handles, inspection epochs/version binding, preview
  receipts, manifests, and stale rejection around the existing DOCX walkers.
- Replace the exact-string Word prototype with inspect/preview/apply/review.
- Establish Lane A and cached Lane B baselines before broadening operations.

Gate: exact selected and searched targets, no ambiguous mutation, recovery,
idempotence, and token baseline recorded.

### Phase 3 — first-class Word editing

- Implement the highest-value shared operations first: bounded replace/batch,
  insert/delete, run and paragraph formatting, styles, numbering, tables,
  sections/page setup, comments, tracked changes, and review.
- Use semantic profiles for common legal formatting and capability descriptors
  for technical properties.
- Implement the same operation results in the Library and Office.js executors;
  expose honest host capability gaps.
- Add real-Word smoke and task-pane ChromeDriver coverage.

Gate: the representative Word benchmark passes in both executors with no
preservation regression, and Review mode is the default.

### Phase 4 — citation occurrence primitive and top-rate linking

- Start as soon as Phase 2 handles/receipts and the shared hyperlink operation
  are safe; do not wait for every Phase 3 formatting family.
- Port and parity-test authority field extraction into `legal-structure`.
- Route Authorities and hyperlinking through the Rust result.
- Add the two-field link profile, structured quote-match result, verified
  source-word fragments, deterministic anchor fallback, and exact-span gold.
- Upgrade linking receipts and accepted gold, then run the corpus fidelity gate.

Gate: exact occurrence/style spans, correct canonical identity/destination,
correct default core-plus-pinpoint links, zero text rewriting, no fragment from
outside a stated pinpoint, and accepted legal gold at the declared sample size.

### Phase 5 — Verification feature

- Land the bounded check plus the deterministic ALR-style rescue ladder first.
- Add the optional proposition-support agent pass using ordinary tabular jobs.
- Build accepted quote and support gold; keep their scores separate.

Gate: source/version receipts on every finding, cancellation and partial
results, strong unsupported/contradicted precision, and no source chosen by the
model.

### Phase 6 — breadth driven by failures

- Expand headers/footers, notes, fields, cross-references, controls, drawings,
  accessibility, advanced tables/numbering, metadata, and rare OOXML properties
  in benchmark-failure order.
- Evaluate SuperDoc, ZetaOffice, OfficeCLI, Open XML SDK, or Aspose only in
  isolated experiments against the same fixtures. Promote a dependency or new
  executor only if it materially improves fidelity/coverage enough to justify
  its runtime, licence, and maintenance cost.

Gate: every promoted property has a compound round-trip fixture and measurable
coverage gain. No speculative operation families.

## Explicit deletions and non-goals

- Delete the exact-string `apply_word_edits` contract when Phase 2 lands.
- Delete hard-coded Automation catalogs, the separate Actions product
  vocabulary, `General Transactions`, and duplicate assistant/tabular catalogue
  entries when the workflow catalogue lands.
- Do not create a Word-only backend, chat store, model loop, preference store,
  or cloud path.
- Do not create a tabular or verification runtime beside ordinary agents/jobs.
- Do not expose raw OOXML, XPath, UNO, COM, or Office.js objects to a model.
- Do not embed LibreOffice/ONLYOFFICE/Collabora merely to obtain more editing
  methods.
- Do not build feature registration, external plugin loading, a marketplace,
  SDK, permissions DSL, semver compatibility layer, migrations, or transition
  states for hypothetical third-party code.
- Do not claim legal verification from string presence or link validity.

That is the balance: four small tools for models, a growing tested operation
catalog for experts, native Word behavior in the add-in, maximal safe package
coverage in the Library, and optional features that are thin compositions of
Beaver rather than new systems.
