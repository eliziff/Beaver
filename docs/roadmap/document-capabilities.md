# Document capabilities, legal workflows, and portable features

Status/order/shared gates: [master plan](master-plan.md). Retain concise Markdown
composition and surgical DOCX edits; use LibreOffice/UNO for rich document work.
All paths use existing jobs/evidence/stores. Microsoft Word is not a cloud dependency.
The detailed operation inventory remains [deterministic Word actions](../decisions/document-actions.md).

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

Current paths: `Write` composes semantic Markdown with profiles, notes, fields
and evidence; `Read` provides compact content; `Edit` and `edit_docx_advanced`
retain surgical tracked text changes. The optional live Word add-in stays intact.
Do not replace those paths with a whole-document LibreOffice round trip merely
to change a phrase. Do not build a second full Word object model or browser editor.

The new `word_uno` specialist is a bounded Linux local/cloud implementation:
inspect native Writer objects; describe typed properties on demand; preview
coordinated property/text changes; publish the exact candidate using the existing
version store's compare-and-swap. It does not require Word or call a model itself.
[Runtime, reproduction and measured limits](../../backend/experiments/libreoffice-uno/README.md)
are recorded beside the focused integration checks.

- Targets bind a source byte hash and an explicit document version. Reinspect
  after changes. Native object indexes/names are not durable legal evidence.
- Preview produces a separate DOCX with a source/candidate-bound receipt. Export,
  reopen, text and protected-content checks run before it is saved. A failure
  discards the candidate; the source never becomes a scratchpad.
- New UNO changes are direct, not native tracked changes. Application Direct
  mode is required to publish over the source. Manual mode can inspect/download
  the separate copy; it cannot silently turn a direct edit into a reviewed one.
- Apply consumes the exact candidate bytes, checks the base version/working
  revision/hash again and uses existing persistence. It does not re-execute the
  edit program. Cancellation and mutation fences use the ordinary agent runtime.
- Operations are constrained document-local properties and exact replacements.
  No Python `eval`, arbitrary UNO invocation or public listener is exposed.
  An isolated general programmable console remains follow-on work, not a shipped
  capability. Cloud deployments still need OS-level document-process isolation.

The writer's native property discovery avoids a second handwritten API reference.
The small write policy is a security/capability boundary, not a claim of every Word
parameter. A property that fails export/reopen is refused even if UNO accepted it.
Windows/macOS gateway support, broad native revision emission and full browser/
database integration qualification remain outstanding. Existing platform features
outside this new specialist are unchanged.

## Benchmarks and external references

Reuse the existing [DOCX edit corpus](../../benchmarks/docx_edit/README.md) and
its accepted-text checks. The focused UNO suite adds only missing compound-engine
and application-outcome coverage. No live models or full sweeps belong in ordinary
CI. Pin the tested engine/runtime in deployments and record actual versions.

[LibreOffice UNO](https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1text_1_1TextDocument.html)
is the chosen independent rich runtime. The existing LibreOffice PDF path remains
separate from editing. SuperDoc adoption is not proceeding: its V2 engine's
separate proprietary terms blocked the proposed evaluation. WordUp/native Word
is not a customer-runtime fallback. No Aspose/UNO/SuperDoc engine-routing system.

[DocOps](https://github.com/icip-cas/DocOps) and
[llm-docx-editing](https://github.com/nberk/llm-docx-editing) remain external task/
interface references, not dependencies or substitutes for actual artifact checks.
Optional Word interoperability tests may reveal differences, but no supported
cloud operation may depend on a licensed Word process.

Keep four lanes separate:

| Lane | Required proof |
| --- | --- |
| A: document mechanics | Compound notes/fields/hyperlinks/bookmarks/revisions/comments/controls/tables/drawings/custom-XML/unknown parts. Exact postconditions, source conservation, relationships/schema, export/reopen and layout-sensitive renders. Current UNO witnesses are conservative and incomplete, not a full schema/layout oracle. |
| B: agent/application contract | Scope, Direct/review policy, cancellation, stale rejection, exact candidate publication and retries. Real database/browser gates remain distinct from injected-store tests. Measure successful-task tokens including help and retries, not just prompt size. |
| C: optional live Word host | Retain its existing independent capability/session/smoke gates. No Word-host dependency for the new headless path and no claim that Linux results prove Windows/macOS execution. |
| D: accepted legal gold | Exact occurrence/style/core/short-form/pinpoint/kind spans; canonical identity/resolver snapshot; hyperlink spans/destinations; quotation/source match; proposition/support; unresolved/ambiguous/no-quote/no-support cases. Profiles on/off, within/outside pinpoint, editorial/repeated matches, actual source fragments, fallbacks and paired rescue outcomes. |

Provisional DOCX/ToA rows are not a denominator. Annotate exact identities/spans/
version receipts; double-review semantic gold and adjudicate disagreements.
Keep occurrence/link/quote/support scores separate. No missing or failed cases
may vanish from evaluation. Repeated loss of important content is an engine
rejection signal, not permission to grow an XML repair layer. Passing a small
fixture slate is not comprehensive Word fidelity or a release certificate.

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

1. Gate the implemented UNO slice in complete local/cloud checkouts: repository
   build, real persistence and artifact/browser flows, installed image and isolation.
2. Expand the compound corpus for concrete needed properties and Word structures;
   reject destructive round trips rather than copying XML parts back after export.
3. Extend compact object inspection and exact selection without affecting existing
   evidence coordinates; retain semantic composition and deterministic text tools.
4. Add broader programmed operations only with an established execution sandbox,
   clear native review semantics and outcome-based tests. No home-grown script sandbox.
5. Preserve citation/linking/quotation gates above independently of engine progress.
   Remove generic implementations only when an actual tested replacement covers them.
6. Qualify Windows/macOS packaging and process ownership, then measure warm/cold
   latency and successful-task token cost. Add warm workers only for measured need.

No feature SDK/registry/permissions DSL, universal runtime, extra UI/office suite
or transition machinery. Reuse component/operation/job/source/mutation primitives;
extract shared code only when live semantically identical consumers need it.
