# Document capabilities, legal workflows, and portable features

Status/order/shared gates: [master plan](master-plan.md). Adopt a maintained,
independent document engine before extending Beaver's general Word machinery.
Reuse existing jobs/evidence/stores. The [operation inventory](../decisions/document-actions.md)
remains a requirements reference, not a mandate to implement a second Word API.

## Engine adoption: current decision

**Phase 0 tooling exists; no engine is admitted.** The
[admission experiment](../../backend/experiments/document-engine-admission/README.md)
exports the existing 12-fixture/28-task corpus and audits physical package outputs.
It installs no engine and changes no production behavior. Passing its independent
oracle tests is not evidence that SuperDoc preserves Beaver documents.

SuperDoc V2 is the candidate, not an approved dependency. Its editor package
references a separately proprietary `@superdoc/docx-engine`; the
[published engine license](https://docs.superdoc.dev/resources/docx-engine-license/)
restricts benchmarking and result disclosure. Resolve applicable rights and
support, then pin and test the exact browser/headless distribution. Do not infer
permission from the editor's AGPL label or silently choose an older release.

The target is one maintained editor for local and cloud operation without a
Microsoft Word runtime. Keep the existing Markdown composer, profiles, legal
citations and LibreOffice PDF conversion initially. Compact content is a view of
the native document, never an imported document's replacement format. Rich access
uses the chosen engine's supported API and version-matched discovery, not a large
hand-maintained Beaver property catalogue. Retain one mutation authority per draft;
rendering another engine's snapshot must not resave the authoritative DOCX.

Do not remove existing editors, add a permanent fork, or build a multi-engine
fallback router to pass admission. Existing Office.js integration remains supported
on its current scope, but WordUp/native Word is not a required cloud or local
backend. A failing admission gate leaves current production operations intact.

## Product vocabulary and workflow catalogue

Workflows is the single catalogue of coherent legal jobs, not implementation
types or individual stages. Drafting includes revision/proofreading/citation;
Fix supras is an independently discoverable document workflow. Review quotations
has one Open action; its modal offers mechanical verification or AI-assisted support review.
Legal Research includes search/read/note-up/treatment/evidence/memos. Written/
tabular outputs are variants, not duplicate workflows.

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

General/Solicitor/Litigator/All tabs: professional tabs include General; All is
the deduplicated union. Practice/jurisdiction are secondary inputs. One canonical
ID/home per job (kebab-case system IDs), including user-created category/audience
choices; no custom category trees or contextual aliases. Old subject recipes
remain choices inside the appropriate workflow. Delete Automation/Actions,
General Transactions, duplicate assistant/tabular entries and split system fetch.
One collection returns user/system definitions. Closed launchers: instructions
with assistant/tabular variants, authorities, court_records, fix_supras and quote_check; existing execution
owners, not a universal engine.

Keep direct Authorities/Court Records/Tabular entries and focused workspaces.
Contextual Workflows binds the selected resource to the same definition. Use
existing launch-site progress/Stop/retry/partial results; saved drafts live in
their compact workspace control with direct links, not another recent-work list.
Static feature preferences gate all real launch/tool/application paths without
deleting prior results. Standalone/Beaver share one UI/core through thin local-file/
Library adapters; [work products](legal-work-products.md) owns their detailed contract.

Document workflows remain visible before a qualifying input is selected. Launch
uses existing Library/project document selection. Mechanical quotation checking
uses ALR's lossless splitting rules, citation resolution and exact comparison
receipts without model inference. Its default durable output is an Excel workbook
beside the input document, preserving its project and folder. Ambiguous links,
unavailable sources and mismatches stay explicit in the report.

AI-assisted checking can establish citation links, inspect mechanical receipts
and read sources to assess propositions and the argument. It defaults to a prose
critique in chat, then offers a durable report or proposed edits. Requested Excel
reports keep the mechanical findings and add a separate model-authored explanation
column; other requested formats use existing document operations. Applying edits
remains a user-requested operation.

## Word operations and exact targets

Inspection, preview, apply and review are the required capabilities, not a new
fixed vocabulary of hundreds of wrappers. After admission, expose upstream public
operations through Beaver's scope/version/publication boundary. Load bounded
content and family-specific descriptors; preserve native target references and
return explicit unsupported/ambiguous outcomes. Do not confuse session handles
with durable version-bound legal evidence.

The rich console requires an established isolation mechanism before exposing code
execution: document-only access, bounded resources, no arbitrary filesystem,
subprocess, network or credential access. Routine reads and edits must not require
a console session or repeated visual rendering. Raw XML remains diagnostic-only
until a concrete, independently checked operation justifies deeper access.

Freeze the exact candidate bytes behind a preview. Publish those bytes only after
rechecking authorization and the source revision; never rerun the edit program at
acceptance. Engine batches need not provide universal rollback: a failed isolated
draft is discarded and only completed candidates are published. Native tracked
changes and application undo/history are separate capabilities; direct-only
operations cannot silently satisfy review mode.

- Library targets bind document/version, part/story, paragraph/object, local span,
  text/property hashes and field/hyperlink/bookmark/revision/control containment.
- Live targets bind session/inspection epoch, uniqueLocalId or tracked Range,
  text/property preconditions and available story/object facts. IDs/proxies are
  session handles, not durable Library identities. Reload/coauthoring/mismatch/
  stale epoch requires reinspection; ambiguity may exist in search, never mutation.
- Model/multi-target preview is mandatory: exact before/after, target IDs/count,
  touched parts/objects, preservation warnings, source hash/epoch and trackability.
  Apply creates a Library version/manifest or native Word tracked changes, grouped
  undo where possible. Review is default; direct mode requires explicit choice.
- Current Library operations use surgical ZIP/OOXML/relationships and the live
  add-in uses Office.js. Replacement requires the admission and end-to-end gates
  below. Runtime gaps must remain explicit; never replace an open live package
  unsafely or introduce another backend/session/store/model loop.

## Benchmarks and external references

Pin commits/licences/imported task IDs/verifier changes in one manifest.
[DocOps](https://github.com/icip-cas/DocOps) (210 Apache tasks, Word subset,
content/format/structure × L1–L4) is primary external benchmark;
[llm-docx-editing](https://github.com/nberk/llm-docx-editing) contributes MIT
capability/50-test ideas, not mutable numeric target indexes or its stack.
[dealfluence](https://github.com/dealfluence/docx-benchmark) supplies metrics/runner
ideas only: no AGPL copying or treating its small set as gold.

Start with [Beaver's existing corpus](../../benchmarks/docx_edit/README.md),
including its frozen targets and near misses, rather than duplicating it. Add
advanced native-state assertions only for concrete capability gaps. The admission
package audit is deliberately conservative: a changed expected XML part still
requires review; a body-text pass never certifies its other structures.

[SuperDoc](https://github.com/superdoc/docx-editor) is the first candidate because
of its browser/headless public API, subject to the separate engine rights above.
[OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) provides inspection/batch ideas,
not another runtime. Aspose is an alternative admission candidate if SuperDoc
fails, not a per-operation fallback. LibreOffice initially remains the existing
PDF converter, not a second editor. Reject an adoption that requires maintaining
substantial upstream internals. Keep optional Word interoperability observations
separate from the Word-free product and release gates.

Keep four lanes separate:

| Lane | Required proof |
| --- | --- |
| A: deterministic kernel, offline each affected change | Per-family and compound headers/notes/fields/hyperlinks/bookmarks/revisions/comments/controls/tables/drawings/custom-XML/macros/unknown-part fixtures; exact postconditions, text conservation, touched allowlist, untouched hashes, relationships/schema, idempotence, stale rejection, reopen/save/reopen. Render pagination-sensitive cases with the pinned independent renderer and fonts; optional Word comparisons are separate interoperability evidence, with explicit tolerances. |
| B: agent contract | Cached traces by default, live only authorized. DocOps plus selection/repetition/stale/long-document/technical-formatting/review/notes/sections/tables/fields/controls/comments/assembly adversaries. Compare provisional contract: success, targets, tokens including help, calls/retries/latency, touched parts/preservation/abstention. |
| C: existing optional Word add-in, only when changed | Small outcome-based Office.js fake for stale/capability/proxy/error behavior; ChromeDriver task-pane screenshots; opt-in Windows sideload/open/action/save smoke then Lane A checks. Selection, review/direct, comments/fields/controls/large batches/reopen/unsupported API sets; sync/proxy counts, preview/apply latency, paged reads and prompt untracking. |
| D: accepted legal gold | Exact occurrence/style/core/short-form/pinpoint/kind spans; canonical identity/resolver snapshot; hyperlink spans/destinations; quotation/source match; proposition/support; unresolved/ambiguous/no-quote/no-support cases. Profiles on/off, within/outside pinpoint, editorial/repeated matches, actual source fragments, fallbacks and paired rescue outcomes. |

Provisional DOCX/ToA rows are not a denominator. Annotate exact identities/spans/
version receipts; double-review semantic gold and adjudicate disagreements.
Keep occurrence/link/quote/support scores separate. Hard gates: no out-of-target
character/structure change or orphaned relationship/anchor; stale previews never
apply, repeated apply is a no-op; recoverable manifests; unsupported structures
fail closed; correctness improves without median simple-edit token regression.
No quality claims from demonstration-sized gold. CI fixtures stay beside tests;
large/live/external-engine experiments keep ignored raw output and RESULTS.md.

## Citation occurrences and links

Port the mature _case_name_start/_authority_bounds/_fields_for_authority/
extract_text_fields behavior from Authorities snapshot 84469a3 into Rust, not
another regex implementation. Return exact source/style spans, full styled/bare/
short citation, pinpoints, kind, confidence/reasons. Same-text style expansion
belongs to structure; missing canonical name resolution belongs to verified
providers, never guessed by regex. Preserve parity plus fragmented-run/multiple-
authority adversaries; gate corpus before deleting duplicate Python consumers.

Inputs: citation_text=core|styled (default core), link_pinpoints=true|false
(default true). UI: Citation only / Style of cause and citation; Link pinpoints
checked. Link only confirmed core or observed style-plus-core; signals,
pinpoints and surrounding punctuation stay outside. Separate pinpoint links
never overlap style/core; authority link stays canonical. These are invocation
defaults, not preference infrastructure. Never rewrite/restyle visible text.

Resolve canonical source/version, preview exact spans/destinations, apply only
hyperlinks/relationships. Receipt includes document/version/occurrence/profile,
source/resolver snapshot, destination and abstention/fallback; deduplicate ordered
destinations for one authority. Score link health/identity/span/pinpoint separately.
Generated DOCX retains evidence renderer; Authorities/linking share Rust records.

For a quote preceding a citation footnote, inspect only its stated pinpoint.
Structured match: exact, normalized, bounded_editorial, ambiguous, not_found.
Editorial means deterministic typography/whitespace/hyphenation and existing
ALR-derived small token-edit allowance, never embeddings/semantic similarity.
Only unique verified actual source words may sharpen a safe complete fragment;
otherwise use pinpoint then authority anchor. No rescue elsewhere for linking.
With pinpoints off, no quote fragment on the authority link. Record classification,
actual source span/version and text_fragment/pinpoint_anchor/authority_anchor reason.

## Quote Checking

Default mechanical pass has no model: structure yields proposition/quote/citation/
pinpoint, resolve exact source/version, compare bounded passage, persist receipts.
On failure, reuse ALR alignment: unique exact/normalized search elsewhere in the
same authority, then bounded token alignment yielding faithful brackets/ellipses
and real locator. Report wrong_pinpoint/altered_quote/ambiguous/not_found with
authored/source text, edits and proposed correction. Equal candidates abstain;
no usable structure means offsets, not invented pinpoints. No other-authority
or semantic-similarity verification. Repairs require normal preview/apply/review.
Receipt records within_stated_pinpoint vs rescue_within_resolved_source policy.

Optional adversarial agent pass: one ordinary job row per proposition, supplied
exact passage and relevant treatment context; model never chooses its source.
Verdicts supported/partly_supported/unsupported/contradicted/insufficient, reason,
most-relevant span. Existing tabular columns Proposition/Citation/Quote match/
Support/Evidence/Status, Stop/retry/progress/viewer/links. Require accepted legal
gold, high unsupported/contradicted precision, calibrated abstention, exact links,
reproducible model/provider receipts and usable cancellation/partial results.
Quotation presence is not support proof; no bespoke worker/review store/model loop.

## Sequence and stopping gates

1. **Admission.** Resolve licensing/support and an exact distributable release;
   run frozen package round trips, existing text tasks, and separately authored
   advanced compound edits. Record every failure, unsupported case and unrun gate.
   Current tooling is not a completed engine evaluation. Stop before replacement
   when fidelity, distribution rights or a maintainable fix path are missing.
2. **One integrated path.** Through existing application/projection/job owners,
   inspect a pinned Library DOCX, make a tracked text edit and a non-text edit on
   isolated candidates, verify, and publish. Establish exact targeting, evidence
   coordinate mapping, cancellation, stale rejection and retry behavior.
3. **Rich access.** Reuse upstream public API discovery and compact projections;
   qualify restricted programmable execution and review-mode enforcement. Measure
   total successful-task tokens including help and retries. No new document AST,
   general plugin system or home-grown sandbox.
4. **Browser and composition.** Use supported editor/review controls in existing
   document UI; retain semantic `Write`, profiles and small versioned building
   blocks. Prove compose/import -> edit -> review -> export -> reopen. Real-time
   coauthoring and a toolbar redesign are outside this workstream.
5. **Removal.** Delete generic editing/revision/serialization implementations and
   redundant tests only as their replacement passes. Keep legal rules, evidence
   and useful pure text transforms. Audit every remaining bespoke OOXML writer;
   a growing exception layer defeats the maintenance objective. Preserve the
   occurrence/link/quote/support contracts above and their independent gold.
6. **Release.** Verify Word-free local and cloud packaging, licensed fonts,
   independent rendering, scope isolation and bounded resource use. Reuse the
   existing converter and queue; add warm workers only for measured startup cost.
   Run fast application-boundary checks during development and the compound
   preservation corpus for dependency admission/upgrades, not a new full battery
   per small edit. Live models remain separately authorized.

The completed adoption must reduce Beaver-owned general Word machinery. Pin the
engine and documentation together, prefer supported upstream fixes, and remove
displaced code in the feature work. No permanent engine fork, parallel Word object
model, extra persistence/job service, speculative migrations or multi-engine
mutation router. Reuse component/operation/job/source/mutation primitives.
