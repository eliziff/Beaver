# TypeScript export contraction audit

## Durable result

On 2026-08-20, the audit scanned 753 TypeScript/TSX files across production,
scripts, tests, and experiments in 4.082 seconds at Windows `BelowNormal`
priority. After the reviewed changes below, it reports zero dead production
exports and zero production exports used only by their declaring module.

- Removed the unused `legalSourceProviderFamily` production export: 5 nonblank
  lines.
- Removed five unused test helper functions and their now-unused support type:
  44 physical lines.
- Reused the canonical readonly-search SQLite lifecycle in the A2AJ Hansard
  provider instead of its
  private connection cache: 10 nonblank production lines net.
- Routed the Hansard, A2AJ bulk, and CourtListener bulk search connections
  through one cache-policy entrypoint: another 4 nonblank production lines net.
- Removed one constant whose apparent second use was only in a comment: 1
  nonblank production line.
- Made 40 internally used declarations module-private, reducing the accidental
  public surface without changing runtime code.
- Routed all six keyset-page response sites through `pageResponse`, leaving
  cursor encoding/decoding private to the pagination boundary: another 6
  nonblank production lines net.
- Routed document, ZIP, spreadsheet, and CSV attachment headers through one
  hardened response contract (`private, no-store`, `nosniff`, MIME, and RFC
  filename encoding): another 6 nonblank production lines net.
- Routed chat and tabular streams through one disconnect-cancellation and SSE
  framing primitive: another 6 nonblank production lines net.
- Deleted the five-line `documentRoute` pass-through and routed all 14 handlers
  directly through the canonical `asyncRoute` primitive.
- Inlined three one-use exact pass-throughs in the already-gated cursor,
  download-filename, and legal quote-span boundaries: another 15 nonblank
  production lines net.
- Reused shared text and legal-provider primitives for duplicate DOCX report
  formatting, regex escaping, and object guards: another 13 nonblank production
  lines net.
- Consolidated exact SQLite provider row, token, and result-bound helpers across
  Hansard, A2AJ, and CourtListener: another 12 nonblank production lines net.
- Reused the canonical application rejection primitive and inlined three
  one-use React lazy loaders: another 6 nonblank production lines net.
- Replaced 14 local JSON-record/type-guard/text coercion helpers across chat,
  legal evidence, drafting style, PDF process, and the structure wire with
  three root boundary primitives: another 22 nonblank production lines net.
- Reused one positive-integer coercion across journal ingestion/structure and
  CourtListener tool projection: another 10 nonblank production lines net.
- Made the structure adapter's UTF-16 range validator the single primitive for
  native-markup repair and materialization: another 3 nonblank production
  lines net.
- Inlined seven one-call key/normalization/hash adapters whose result variables
  retain the domain names at their call sites: another 18 nonblank production
  lines net.
- Inlined five more one-call wrappers at named SourceDoc quote, A2AJ cache-key,
  drafting-type, download-header, and journal-page boundaries: another 23
  nonblank production lines net.
- Routed Codex event and remote-provider records through the root JSON boundary:
  another 6 nonblank production lines net.
- Inlined five stable frontend one-call helpers for account errors, activity
  icons, plain-text selection, DOCX parsing, and restored-message files:
  another 17 nonblank production lines net. A proposed React ref inline was
  rejected because it would change callback identity.
- Reused one frontend unknown-error formatter across connectors, account
  security, and the legal library: another 3 nonblank production lines net.
- Collapsed eight one-call normalization, hashing, package-inspection, heading,
  and segmentation wrappers into their named result variables or sole callers:
  another 26 nonblank production lines net.
- Reused the canonical LLM abort guard for chat turns and the platform
  `AbortSignal.throwIfAborted()` contract in projection and legal-source
  boundaries: another 12 nonblank production lines net.
- Routed both CourtListener surfaces through one whitespace-preserving
  nonempty-string boundary (zero net lines, one duplicate contract removed).
- Reused the shared XML/HTML text escaper and placed five registry-only text
  operations, one DOCX predicate, and API-key decryption at their sole use:
  another 22 nonblank production lines net.
- Finished the platform abort consolidation in document projection and reused
  one root 404 constructor across project/workflow boundaries: another 7
  nonblank production lines net.
- Collapsed ten more one-use serializers, coercers, labels, job keys, paging,
  and preview/display helpers while retaining stateful callbacks and security
  matchers: another 21 nonblank production lines net.
- Collapsed four more sole-use amendment, cross-reference, redline-comment,
  and MFA-session helpers into named local results or event boundaries: another
  13 nonblank production lines net.
- Collapsed four sole-use quote-repair, PDF error, hard-break, and catalog
  preference helpers at their guarded consumers: another 17 nonblank
  production lines net.
- Reused one typed array-equality primitive for PDF receipt identity and
  collapsed sole-use relevant-page, MCP grouping/timestamp, owned-project,
  and export-status helpers: another 18 nonblank production lines net.
- Removed redundant lazy/cache wrappers around the spreadsheet parser, S3
  object store, SQLite relational adapter, and presentation ZIP entries while
  preserving their existing lazy/singleton lifetimes: another 24 nonblank
  production lines net.
- Routed request records and checkpoint/schema records through the shared JSON
  boundary, and removed duplicate PDF error/Authorities payload casts unlocked
  by its type guard: another 7 nonblank production lines net.
- Collapsed five sole-use locale/citation/quote/credential mappings at their
  named result sites: another 16 nonblank production lines net.
- Removed redundant drafting-style, journal-path/cache, provider-job,
  SourceDoc-number, and spreadsheet-cell adapters while retaining the public
  boundaries around them: another 19 nonblank production lines net.
- Reused the shared DOC/DOCX filename classifier in the tabular viewer while
  preserving its file-type fallback: another 9 nonblank production lines net.
- Collapsed sole-use PDF count coercion and Codex command/completion adapters
  into their named consumers: another 12 nonblank production lines net.
- Removed the Claude event adapter's duplicate JSON parse and collapsed its
  sole-use prompt/usage projections: another 15 nonblank production lines net.
- Reused one prompt serializer across Claude and Codex, routed compatible-wire
  tool input through the root JSON guard, and folded the sole checkpoint-row
  predicate into its reverse scan: another 14 nonblank production lines net.
- Placed four one-use React loading/skeleton/deletion-message components at
  their sole render sites without changing their DOM or accessibility roles:
  another 21 nonblank production lines net.
- Placed workflow-prompt and opinion renderers at their sole sites, expressed
  Codex native-agent state/labels as lookup data, and collapsed CourtListener
  request policy plus MFA recency at their consumers: another 37 nonblank
  production lines net.
- Placed four one-use frontend network-error, legal-provider, citation-supra,
  and model-reasoning policies at their guarded consumers: another 14 nonblank
  production lines net. The model fallback now also preserves the selected or
  default effort when a live catalog omits that model.
- Deleted the unwired `case_citation`/`case_opinions` assistant-stream protocol
  from the backend contract, browser validator, session state, and Markdown
  renderer. Live CourtListener citations already use canonical `citation_data`
  and the same case panel: another 166 nonblank production lines net.
- Routed agreement and statute skeleton detection through the shared Rust
  structure engine's `instrument` profile, deleting the duplicate TypeScript
  statute-spine module and most of the agreement detector. This removes 1,062
  tracked TypeScript physical lines across the two files; it is recorded as a
  cross-language consolidation rather than added to the pure-deletion total.
- Removed six zero-consumer experiment facades and superseded response/
  serializer contracts while retaining the three measured research algorithms
  described by their `RESULTS.md` files: 109 physical experiment lines.
- Removed the never-emitted `workflow_applied` assistant event end to end: its
  backend union and audit adapter, frontend decoder and fixture, and impossible
  audit-history filter. Real workflow request/message metadata is unchanged.
  This removes 18 net physical production/test lines.
- Contracted the assistant wire around events the backend can actually emit.
  Removed the dead `doc_replicated`, `thinking`, MCP start/result, workflow-
  activity, document-activity, planner/reviewer, and unused citation-status/
  artifact-resource shapes. Durable evidence, connector, and continuation
  receipts now remain server-private instead of crossing the browser boundary
  only to become no-ops. The same pass removed an extra `debug` field that made
  strict frontend validation reject real reasoning events, and strips private
  reader resume/grounding payloads from SSE while retaining them in storage.
- Removed `allow_other` and `other_label` from the ask-input contract because
  every normalized choice already included the same fixed “Write your own
  answer” option. The visible choice remains unchanged, but the wire no longer
  advertises two configuration states that could never occur.
- Made structured ask responses the one canonical request and storage shape.
  The browser no longer sends duplicate rendered prose, top-level files, and
  attached-document metadata alongside the structured answers; transcript
  projection now derives the same provider prompt and document attachments
  from those answers. Client-echoed question text and duplicate filename lists
  are gone as well: pending server questions and canonical document records are
  authoritative. This also makes persisted responses valid under the existing
  strict browser decoder instead of storing fields it rejects.
- Encoded declined ask items with the already-unambiguous empty answer or empty
  document selection instead of a second `skipped` flag, and removed the
  unwired `response_prefix` tool field. The same pass removed the redundant
  `content_done` SSE event (the stream already terminates with `[DONE]`) and its
  impossible frontend `noop` state.
- Removed internal tracked-change `kind`/`change_id` fields from public edit
  artifact annotations; highlighting and resolution continue to use the
  durable edit/document and Word insertion/deletion IDs. The strict decoder
  now also accepts the backend's declared nullable version number.
- Made one allowlisted reader projection authoritative for live SSE and
  refreshed transcripts. Model, effort, agent, continuation, grounding, and
  raw error details remain private; the browser derives the same verified-
  passage count from its canonical source list. Generic tool events now pass
  through the same projection, closing the live-only connector/evidence
  receipt leak while retaining those receipts in durable server state.
- Removed citation phase labels and the nested `citation_data` tag: citation
  updates are replacement snapshots and `kind` is now their sole required
  discriminator. Removed duplicate automation document/version identifiers;
  the simultaneously emitted document artifact remains authoritative.
- Deleted the unreachable legacy `case` citation/opinion-viewer slice and its
  dedicated CourtListener HTTP route. No backend producer emitted that shape;
  real CourtListener/citator evidence already uses the canonical legal-source
  citation and viewer path. The same pass removed persisted reasoning and
  interrupted-turn wire variants that the backend never exposes, while
  keeping live reasoning deltas and local interruption state unchanged.
- Made the structured current-turn payload the only attachment channel.
  Ordinary messages and ask responses now send document IDs only; the backend
  resolves authorized filenames once for persistence, prompts, images, and
  retries. Displayed documents likewise carry only their ID.
- Made workflow IDs the only workflow request authority. The backend resolves
  the canonical title from its existing local/cloud workflow registry before
  persistence and prompting, and rejects unknown IDs. Removed the unsupported
  per-turn service-tier input while retaining provider-level tier support for
  the dedicated LLM adapter and smoke harness.
- Removed unconsumed service-tier, description, visibility, and always-true
  API-support metadata from the Codex model-catalog response. Model selection,
  labels, reasoning levels, subagent availability, and adapter-level service
  tiers are unchanged.
- Made durable document identity mandatory for message attachments inside both
  server and browser state. Persistence decoders discard filename-only records,
  and ordinary requests continue to send only authorized document IDs.

The resulting production contraction is 993 nonblank lines after the final
request-hardening guardrails. The repository source receipt now reports 77,108
application production lines (78,905 when
the explicitly relocated feature slice is included). Focused Hansard,
CourtListener, legal-data-path, and legal-source registry tests pass (10 tests
for the SQLite slice, including a configured-database freshness outcome).
The A2AJ bulk contract now correctly asserts that flat bulk retrieval leaves
derivation to the shared structure host instead of calling its removed private
compiler. Strict upload-validation fixtures now use minimal real ZIP packages
rather than invalid placeholder bytes. For pagination, 18 affected tests pass.
All 14 focused download/storage tests pass (with one existing skipped case).
Both streaming integration suites pass (10 tests).
All 7 focused document-route tests pass after the facade deletion.
The pass-through collapses pass 27 focused contract tests (one skipped) and the
backend build.
The duplicate-body tranche passes 50 focused tests and the backend build.
The value-boundary tranche passes 50 focused tests and the backend build; the
AST duplicate report no longer contains its four-member or two-member clone
groups.
The integer/range tranche passes the 12-test journal suite (one skipped) and 24
source-structure tests; its duplicate groups are gone.
The one-call normalization tranche passes 62 focused tests and the backend
build.
The second one-call tranche passes 60 focused tests (two skipped) and the
backend build.
The third one-call tranche passes 82 focused contract tests.
The abort-boundary tranche passes 14 focused contract tests.
The registry/security tranche passes 70 focused contract tests.
The final abort/404 tranche passes 12 focused contract tests.
The broader one-call tranche passes 55 backend and 2 frontend focused tests.
The amendment/redline/MFA tranche passes 61 backend and 4 frontend tests.
The quote/PDF/Markdown/catalog tranche passes 51 focused backend tests.
The receipt/MCP/account-data tranche passes 35 focused backend tests.
The lazy-storage/value-boundary tranches pass 46 focused backend tests and the
backend build.
The locale/citation/quote/credential tranche passes 45 focused backend tests.
The drafting/journal/provider/SourceDoc/spreadsheet tranche passes 24 focused
backend tests (one skipped), and the tabular viewer passes its focused test and
the complete frontend build (2,226 modules).
The PDF/Codex tranche passes 14 focused backend tests and the backend build.
The Claude adapter tranche passes 10 focused backend tests and the backend
build.
The shared-prompt/tool-input/checkpoint tranche passes 22 focused backend tests
and the backend build. The inline-render tranche passes 24 focused frontend
tests and the complete frontend build (2,226 modules).
The workflow/opinion/Codex/CourtListener/MFA tranche passes 16 frontend and 16
backend focused tests, plus both production builds.
The frontend policy tranche passes 43 focused tests; its build passes all 2,226
modules.
The dead assistant-protocol tranche passes 51 focused frontend tests, both
production builds, and the TypeScript surface audit.
The structure-engine consolidation passes 10 Rust tests and 74 focused backend
tests. Its exact-output differential compares the pre-refactor and current
compiler over all 69 LegalBench-RAG mini-corpus documents (7.37 MB), both on
the untouched text and on each of the three recovery segmentations. All 276
individual candidate comparisons and the 69-document production recovery
competition are exact across nodes, document blocks/ranges, defined terms,
schedules, cross-references, ladder diagnostics, outline, and refusal state.
The slowest 69-document pass completes in 3.44 seconds at Windows
`BelowNormal` priority.
The experiment-facade cleanup passes the experiment boundary, TypeScript
surface audit, and backend build. The audit's remaining three non-production
dead symbols are the intentionally quarantined assignment-closure, figure-
reconciliation, and DOCX-anchor research algorithms—not shipped product code.
The dead workflow-event cleanup passes its backend audit tests (2), frontend
assistant-protocol tests (39), both production builds, and the TypeScript
surface audit (zero dead or private-only production exports).
The continued event-contract cleanup passes 14 focused backend event,
transcript, and MCP tests; 57 focused frontend workflow/activity tests; both
production builds; and the zero-candidate production surface audit. Against
the first build in this pass, the emitted `assistantSession` chunk fell from
19.53 kB to 18.96 kB and `ChatView` from 87.10 kB to 86.45 kB (uncompressed).
The ask-contract tranches pass 37 focused backend and 70 focused frontend
tests, plus both production builds. The artifact tranche passes 46 focused
backend and 82 focused frontend tests. The final stream-marker tranche passes
32 backend and 69 frontend tests. The latest build places `assistantSession`
at 17.58 kB and `ChatView` at 85.60 kB (uncompressed). The model-catalog cleanup
reduces `ModelToggle` from 9.08 kB to 9.00 kB. The final protocol/
viewer tranche passes 36 focused backend and 73 focused frontend tests, both
production builds, and the zero-candidate production surface audit.
The frontend tranche passes 83 focused tests and the complete frontend build
(2,226 modules), including the shared error formatter.
The final full backend gate passes with the release PDF and structure sidecars
present: 140 files passed, 4 skipped; 984 tests passed, 11 skipped.
The final full frontend gate passes: 83 files and 348 tests, plus all four
live-build and shared-transport boundary checks. The attachment contraction's
focused server and browser transcript suites include explicit malformed-record
coverage (5 and 32 tests respectively), and both production builds pass.

## Guardrail

Run from the repository root:

```powershell
node scripts\check-typescript-surface.mjs
```

The command exits nonzero and prints the candidate when a production export is
declared but its identifier occurs nowhere else in the canvassed repository,
or is used only inside its declaring module.
Use `--verbose` to inspect advisory non-production and private-only candidates.

This is a deliberately conservative syntax-tree candidate finder, not a proof
that an export is safe to delete. It ignores comments but counts exact
identifier-valued strings, because the frontend route loader selects named
exports by string. Default exports are entrypoints and are excluded. A human
must still check dynamic use and run the smallest behavioral test for each
candidate. Including scripts and experiments prevents a source-only scan from
misclassifying their production entrypoints as dead.

The checker is promoted to `scripts/` and runs in `npm test --prefix backend`,
so a newly dead production export now fails the release gate automatically.
