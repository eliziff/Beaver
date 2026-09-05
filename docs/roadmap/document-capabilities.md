# Document capabilities, legal workflows, and portable features

Status/order/shared gates: [master plan](master-plan.md). One compact operation
language, Library DOCX and live Office.js executors, existing jobs/evidence/stores.
The detailed operation inventory remains [deterministic Word actions](../decisions/document-actions.md).

## Product vocabulary and workflow catalogue

Workflows is the single catalogue of coherent legal jobs, not implementation
types or individual stages. Drafting includes revision/proofreading/citation/
supra repair; Quote Checking combines exact quotation and optional support review;
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
with assistant/tabular variants, authorities, court_records; existing execution
owners, not a universal engine.

Keep direct Authorities/Court Records/Tabular entries and focused workspaces.
Contextual Workflows binds the selected resource to the same definition. Use
existing launch-site progress/Stop/retry/partial results; saved drafts live in
their compact workspace control with direct links, not another recent-work list.
Static feature preferences gate all real launch/tool/application paths without
deleting prior results. Standalone/Beaver share one UI/core through thin local-file/
Library adapters; [work products](legal-work-products.md) owns their detailed contract.

## Word operations and exact targets

Four tools: word_inspect (bounded content/targets/findings/capabilities),
word_preview (exact proposal/version-bound receipt), word_apply (consume receipt,
return version/change IDs), word_review (accept/reject, resolve/reopen comments).
Delete original/replacement/replace_all text-as-locator prototype when handles
land; no fuzzy/occurrence guessing.

Load compact descriptors per requested family, not all Word properties per turn.
Closed validated op/args catalogue; common legal_body/factum_heading/table_header
profiles and typed run/paragraph/list/table/section/field/note/control/drawing/
metadata properties. Unsupported target/QName/property reports an exact reason;
support requires a round-trip fixture. Models never author XML/XPath/UNO/COM/
Office.js objects. Diagnostic raw inspection remains developer-only.

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
- Library uses surgical ZIP/OOXML/relationships; Office.js native ranges/styles/
  controls/comments/fields/review. Honest runtime capability gaps: fail closed,
  reinspect or produce a separate Library version, never replace a live package
  unsafely. No Word-only backend/session/store/model loop or extra office suite.

## Benchmarks and external references

Pin commits/licences/imported task IDs/verifier changes in one manifest.
[DocOps](https://github.com/icip-cas/DocOps) (210 Apache tasks, Word subset,
content/format/structure × L1–L4) is primary external benchmark;
[llm-docx-editing](https://github.com/nberk/llm-docx-editing) contributes MIT
capability/50-test ideas, not mutable numeric target indexes or its stack.
[dealfluence](https://github.com/dealfluence/docx-benchmark) supplies metrics/runner
ideas only: no AGPL copying or treating its small set as gold.

Office.js plus direct OOXML are production executors. [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)
offers progressive inspection/atomic batch/dump-replay ideas, not a .NET workstream.
[SuperDoc](https://github.com/superdoc/docx-editor) offers authoritative OOXML and
one browser/headless API, but AGPL/commercial licensing/editor duplication need
a separate gate. [ZetaOffice](https://github.com/allotropia/zetajs) and
[aiworkdeck](https://github.com/zeweihan/aiworkdeck/tree/master/experiments/zetaoffice-spike)
support native handles/redlines, not a hundreds-of-MB WASM suite, cross-origin/
fonts/IME burden or plugin stack. ONLYOFFICE/Collabora await a deliberate full
collaborative editor decision. Open XML SDK/Aspose may be isolated comparators/
render oracles only for concrete failures; Word remains final interoperability host.

Keep four lanes separate:

| Lane | Required proof |
| --- | --- |
| A: deterministic kernel, offline each affected change | Per-family and compound headers/notes/fields/hyperlinks/bookmarks/revisions/comments/controls/tables/drawings/custom-XML/macros/unknown-part fixtures; exact postconditions, text conservation, touched allowlist, untouched hashes, relationships/schema, idempotence, stale rejection, reopen/save/reopen. Render pagination-sensitive cases in Word, LibreOffice secondary, with explicit tolerances; disagreements are findings. |
| B: agent contract | Cached traces by default, live only authorized. DocOps plus selection/repetition/stale/long-document/technical-formatting/review/notes/sections/tables/fields/controls/comments/assembly adversaries. Compare provisional contract: success, targets, tokens including help, calls/retries/latency, touched parts/preservation/abstention. |
| C: live Word host | Small outcome-based Office.js fake for stale/capability/proxy/error behavior; ChromeDriver task-pane screenshots; opt-in Windows sideload/open/action/save smoke then Lane A checks. Selection, review/direct, comments/fields/controls/large batches/reopen/unsupported API sets; sync/proxy counts, preview/apply latency, paged reads and prompt untracking. |
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

1. Close remaining upstream Word ledger items and baseline benchmarks; no interim
   Authorities gateway work or duplicate catalogue/UI.
2. Implement handle/epoch/preview/manifest/stale kernel and replace prototype;
   establish Lane A/cached B correctness, recovery/idempotence/token baseline.
3. Shared bounded batch replace/insert/delete, run/paragraph/styles/numbering/
   tables/sections/page setup/comments/review; both executors, real Word smoke.
4. Once handles/hyperlink safe, port/gate citations and linking; need not await
   every formatting family. Exact default spans, zero rewrites/outside-pinpoint
   fragments and accepted gold at declared denominator.
5. Deterministic quote/rescue first, optional support agents after accepted gold.
6. Expand headers/footers/notes/fields/cross-references/controls/drawings/a11y/
   advanced numbering/tables/metadata/rare properties only for benchmark failures.
   Promote an external engine only for measured fidelity/coverage gain justifying
   runtime/licence/maintenance, each property with compound round-trip proof.

No feature SDK/registry/permissions DSL, universal runtime, extra UI/office suite
or transition machinery. Reuse component/operation/job/source/mutation primitives;
extract shared code only when live semantically identical consumers need it.
