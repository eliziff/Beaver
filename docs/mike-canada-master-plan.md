# Mike-Canada master plan

Status: canonical implementation plan
Last reconciled: 2026-07-26

This is the single source of truth for unfinished Mike-Canada work. Earlier
planning files remain as design records and technical appendices; their status
lists are not authoritative where they differ from this file.

The plan consolidates the user's requests without turning every experiment into
a permanent subsystem. The default is a small deterministic implementation,
measured against the current Mike baseline, with model calls reserved for
ambiguity that cannot be resolved reliably in code.

## Status key

- **Done**: implemented and verified in the current worktree.
- **Partial**: a useful implementation exists, but the requested end-to-end
  behavior or validation is incomplete.
- **Research**: investigated and documented; runtime behavior is unchanged.
- **Blocked**: implementation exists but an external credential, license, or
  dataset is unavailable.
- **Planned**: not implemented.

## Fixed architecture decisions

These decisions are not open backlog items:

1. Mike-Canada supports an account-free local mode. Cloud/Supabase/R2
   compatibility remains available; local mode is additive, not a fork that
   deletes cloud support.
2. Provider downloads, bulk databases, and shared source caches live under the
   versioned `OpenLegalData` contract, normally
   `%LOCALAPPDATA%\OpenLegalProducts\LegalData`.
3. SQLite is the lookup/runtime format. DuckDB, PyArrow, and Parquet readers
   are optional import-time dependencies.
4. ALR Quote Verifier remains an independent product. Mike does not import its
   private modules or require its checkout. Small algorithms and fixtures may
   be ported into neutral packages with parity tests.
5. `universal-legal-pdf-engine` is the neutral PDF structure package. Mike,
   Table of Authorities Maker, ALR, and future applications consume thin
   adapters.
6. Exact evidence, document versions, source locators, hashes, and tool
   receipts are durable state. A prose session summary is disposable context
   and is never legal authority.
7. Exact lexical/pinpoint lookup hydrates authoritative source text. Dense
   vectors are an optional candidate-generation layer, not a source of truth.
8. Model choice and reasoning effort are capability-driven and dynamically
   enumerated where a provider exposes a catalog. Values such as `max` are not
   hardcoded away.
9. The browser UI is the maintained Table of Authorities UI used both
   standalone and inside Mike. The Tk UI is a compatibility fallback, not a
   second product to redesign.
10. Legal ontology artifacts use renderer-independent JSON. A viewer is a
    replaceable projection, not the data model.
11. Accessibility is a cross-cutting product constraint. New and changed
    browser workflows target WCAG 2.2 Level AA and use native HTML before
    custom ARIA widgets.

## Implemented baseline

The following work is complete enough to build upon and is not repeated as
backlog:

| Area | Current baseline |
| --- | --- |
| Local identity | Anonymous account-free startup, Library storage, and atomic durable chat transcripts under shared AppData |
| Assistant | Local Library tools work without the unavailable `mike_runtime` connector |
| Codex | Local Codex authentication, dynamic model catalog, separate reasoning-effort control, and bounded Mike tool bridge |
| Providers | OpenAI, Claude, Gemini, Codex, DeepSeek, and an OpenRouter/Muse adapter |
| Legal lookup | A2AJ, CourtListener, TNA Find Case Law, GOV.UK ET, GovInfo, and journal article lookup surfaces |
| Pinpoints | Deterministic native anchors/text fragments, including multi-text directives, are appended without asking the model to construct URLs |
| Shared data | `OpenLegalData` SQLite/bulk contract and AppData layout; A2AJ and CourtListener bulk paths |
| Journal data | `public_endpoint.db` page/structure access and a contentless FTS5 sidecar |
| PDF core | Standalone deterministic digital-born parser, footnote/proposition artifacts, optional r=1 Codex repair, cache, diagnostics, and adapters |
| DOCX citations | Bounded deterministic citation splitting and hyperlink insertion with a Codex worker only for unresolved splits |
| Legal Library | Lightweight A2AJ/journal pointers and a structured source viewer |
| Table of Authorities | Shared data path, dependency bootstrap, browser UI, standalone host, and a Mike sibling route |
| UI | Mike-Canada name, maple leaf identity, red accents, flat text-presentation symbols, visible model control, and separate effort control |

The baseline still needs a clean local commit. “Implemented” here describes the
worktree, not release readiness.

## Priority 0 — correctness, reliability, and measured performance

### P0.1 Reliable local lifecycle

Status: **Partial**

Build one small Windows launcher/doctor path that:

- starts the backend, frontend, and optional Table of Authorities service from
  known production builds;
- refuses duplicate listeners and reports exact owning PIDs;
- pins the selected Codex executable without corrupting `PATH`;
- waits for health endpoints, prints actionable failures, and can stop only the
  processes it started;
- checks required runtime versions and optional provider credentials without
  exposing secret values; and
- opens Mike only after the frontend is ready.

Acceptance:

- Five cold start/stop cycles leave no orphan watcher or duplicate listener.
- A missing build, occupied port, missing optional key, and failed backend each
  produce a specific diagnosis.
- `http://127.0.0.1:3000`, backend health, Library upload, model selection,
  effort selection, first assistant message, and Table of Authorities launch
  pass one automated smoke flow.

### P0.2 Frontend responsiveness and build time

Status: **Partial**

The user reported excruciating loading and long builds. Existing cache,
single-flight, streaming, and lazy-start improvements are useful but have not
established a reproducible win.

Work:

- Record cold/warm navigation, first contentful UI, assistant-ready, first
  token, Library listing, model catalog, and legal-source-open timings.
- Profile the production build and client bundles before deleting code.
- Remove dead assets, duplicate dependencies, unreachable routes, redundant
  adapters, and accidental server/client boundary crossings only where the
  profile shows a win.
- Keep useful warmup. Do not trade lower build time for slower first legal
  lookup or first assistant response.
- Split rarely used heavy surfaces at route boundaries, including graph,
  tabular, workflow, and legacy/cloud-only UI where safe.
- Add a fast verification lane for backend-only and static-public changes; keep
  the full production build as a release gate.

Acceptance:

- Publish before/after medians from the same machine and exact build command.
- No regression in first model response, Library open, legal source lookup, or
  warmed Table of Authorities open.
- Remove code/dependencies only when tests and bundle/runtime measurements show
  a strict win.

### P0.3 Account-free local parity

Status: **Partial**

Anonymous local mode currently covers Library and chat but not all project,
tabular, workflow, drafting, and mutation paths.

Work:

- Define which cloud entities have a local equivalent and store them under
  `apps/mike`, versioned and atomically written.
- Add local projects/project chats or explicitly merge the concept into
  Library matters; do not silently return empty project lists.
- Provide local drafting/revision, tabular review, and workflow behavior or
  hide a cloud-only surface with a clear explanation.
- Retain cloud adapters and test that local additions do not break them.

Acceptance:

- No ordinary local navigation ends in a Supabase 503.
- A local user can create a matter, import documents, chat, draft/revise a
  document, restart Mike, and continue with unchanged versions and citations.
- Cloud mode passes its existing authentication/storage tests.

### P0.4 Freeze and commit the current baseline

Status: **Planned**

- Ignore Python bytecode and generated benchmark/runtime artifacts.
- Commit nested neutral repositories first, then record their exact local git
  identities in the root.
- Decide explicitly whether the nested repositories become true submodules or
  remain documented local gitlinks; do not leave ambiguous untracked
  directories.
- Create focused local commits without raw model traces, credentials, AppData,
  downloaded corpora, or temporary PDFs.

Acceptance:

- Root and nested status outputs contain only intentional ignored runtime
  artifacts.
- A fresh local clone/check-out has documented bootstrap steps and does not
  fail randomly for `duckdb`, PyMuPDF, Node, or Codex.

## Priority 0 — legal-safe context management and compaction

### P0.5 Independent research and falsifiable hypothesis

Status: **Research in progress**

Two agents are independently:

- comparing the proposed design with primary long-context/memory research and
  source code from existing systems;
- verifying current legal and long-session benchmarks, including the exact
  identity, access terms, and usefulness of the benchmark described as
  “Semantic Legal Bench by Marty Rudolf”; and
- proposing separate ablation experiments before their conclusions are
  reconciled.

Their reports will be:

- `context-compaction-research-track-a.md`
- `context-compaction-research-track-b.md`
- `context-compaction-research-synthesis.md`

No compaction strategy is promoted merely because a paper or framework reports
general-agent gains.

### P0.6 Server-authoritative legal session state

Status: **Research**

Implement the smallest three-layer projection that survives the benchmark:

1. **Exact state ledger**: matter/document versions, accepted instructions,
   defined terms, factual assertions with status, quotes, pinpoints, evidence
   IDs, tool receipts, pending decisions, and artifact hashes.
2. **Lossy task summary**: current objective, completed work, unresolved
   issues, and a short rationale map. It may be regenerated or discarded.
3. **Recent verbatim tail**: the most recent turns and bounded tool outputs.

The browser submits the current turn and optimistic concurrency version. The
backend reconstructs the canonical provider request from durable state rather
than trusting a browser-supplied full transcript.

Required behavior:

- Preserve the complete raw transcript for audit and recovery.
- Keep matters and clients isolated by default; no cross-matter legal facts or
  instructions enter context without an explicit reference.
- Compact on the estimated final assembled request, not raw transcript length.
- Reserve output/tool budget before compaction.
- Use provider continuation/compaction where available, but keep the
  provider-neutral exact ledger authoritative.
- Capture and resume Codex thread/checkpoint state where it is demonstrably
  safer and cheaper than new ephemeral invocations.
- Bound every tool result and store overflow behind durable handles.
- Rebuild a session from raw transcript + exact ledger when a provider session
  expires or becomes inconsistent.

Acceptance:

- Long-session tests show no material loss in quotes, pinpoints, qualifiers,
  defined terms, document versions, unresolved instructions, or tool state.
- Cross-matter leakage is zero in adversarial fixtures.
- Median input tokens and latency beat full-history baseline at equal or better
  legal fidelity.
- A corrupted summary cannot override exact state or source evidence.

### P0.7 Context observability and prompt/tool diet

Status: **Research**

- Log provider/model/effort, assembled input estimate, actual usage, cache
  hits, compaction reason, retained tail, summary version, exact-state size,
  tool schema size, retrieved evidence size, and continuation IDs.
- Use stable prompt prefixes and cache keys where officially supported.
- Measure the current system/developer/tool-schema overhead.
- Group or defer tools only after tool-recall tests demonstrate no material
  legal regression.
- Replace large tool payloads with result handles and deterministic follow-up
  reads.
- Test prompt injection through retrieved opinions, PDFs, journal articles,
  tool receipts, and summaries.

Acceptance:

- A run can explain why compaction occurred and which exact state survived.
- Token reductions can be attributed to a measured component.
- Tool discovery/selection recall remains within the benchmark tolerance.

## Priority 0 — universal document structure in Mike

### P0.8 Wire the universal PDF engine into Library ingestion

Status: **Partial**

The engine exists but Mike does not consume it.

Work:

- On PDF import, store the source first, then create a durable background parse
  job with `queued`, `parsing`, `ready`, `degraded`, or `failed` state.
- Save versioned page, paragraph, section, footnote, proposition, diagnostics,
  parser configuration, and repair artifacts beside the immutable source.
- Reuse cached artifacts by source hash + parser/prompt/model/config version.
- Keep flat-text access available if structural parsing fails.
- Expose parse state, diagnostics, and a manual retry/escalation control in the
  Library.
- Feed attachments from TNA/GOV.UK ET/GovInfo and other providers through the
  same adapter when native structure is absent.
- Add a concrete optional weak-hardware OCR provider for scanned/image PDFs;
  route only affected pages.

Acceptance:

- Import returns after safe source storage, not after model repair.
- Restarting Mike resumes or reports an interrupted parse deterministically.
- An unchanged PDF does not repeat extraction or model calls.
- A raster-only PDF degrades honestly and can be selectively OCRed.

### P0.9 Exact structure tools

Status: **Planned**

Expose compact tools for:

- one footnote or a bounded footnote range;
- the proposition(s) associated with each note reference;
- page or page range, including `[page n]` markers;
- paragraph or paragraph range;
- section, subsection, paragraph, subparagraph, clause, subclause, schedule,
  article, and provider-specific encoded variants;
- surrounding context by structural neighbor count, not arbitrary characters;
  and
- deterministic source/evidence handles suitable for later citation or
  document mutation.

These tools return only requested units plus stable IDs, version, confidence,
and link metadata. The model does not parse the whole PDF to answer “footnote
62.”

Acceptance:

- Exact lookups are covered by digital-born, degraded-export, restart-numbered
  notes, symbol notes, multi-column, and provider-native structure fixtures.
- Every quoted result can be rehydrated from authoritative source bytes and
  linked without model-authored URL syntax.

### P0.10 Complete the structural benchmark

Status: **Partial**

Completed corpus foundation:

- `scripts/stage_docx_benchmark_corpus.py` builds a private,
  content-addressed corpus, verifies every hash, rejects lockfiles and
  sensitive/credential-like names, excludes downstream chief/galley/camera/
  final derivatives by default, and keeps all source documents and manifests
  out of git.
- The current canonical local set contains 24 byte-unique, least-edited
  upstream DOCX files (10.76 MiB), with one source per work and no selected
  chief, galley, camera, annotated, ToA/BoA, returned, revised, or final copy.
- The corpus runner parsed 24/24 files in 2.42 seconds, extracting 2,009
  footnotes (1,860 unique) and 1,090 citation signals. The conservative gate
  covered 143 notes (7.12%); recall-first covered all notes; both had zero
  substantive character-conservation failures.
- An 80-row, document-diverse 40-easy/40-hard review queue exists locally, but
  every row remains `provisional`. Coverage and character conservation are
  not boundary accuracy.
- The independently maintained 405-row accepted ALR split gold was rerun:
  conservative produced 144 exact partitions and recall-first 324, with zero
  character loss. See [DOCX benchmark design](docx-benchmark-design.md).

Use the ALR Quote Verifier `.docx` suite as ground truth for corresponding PDF
exports. Do not assume rich exports:

- native tagged/accessible;
- ordinary print/export;
- flattened or font-damaged;
- missing tags/bookmarks;
- rasterized and mixed scanned/digital;
- difficult multi-column/page-marker cases.

Run:

- the frozen 80-page and full 661-page Text-Fidelity corpora;
- the available ALR DOCX/PDF equivalents, not only the existing 19-page smoke
  case;
- deterministic-only, cheap repair, and stronger repair arms;
- warm-cache replay and weak-hardware resource measurements; and
- a diverse, licensed US/Canadian/UK public legal-PDF corpus collected with a
  manifest, checksum, source URL, jurisdiction, document type, and failure
  taxonomy.

Score exact text fidelity, reading order, page boundaries, section hierarchy,
footnote reference/body pairing, proposition pairing, citation recall, runtime,
memory, tokens, and cost.

Acceptance:

- Frozen manifests and scorer versions make every reported number
  reproducible.
- Model repair must improve a named structural metric without losing text,
  IDs, or source order.
- Complexity increases only for recurring failure classes with held-out wins.

## Priority 1 — provider-neutral legal retrieval and durable sources

### P1.1 Normalize all provider structure

Status: **Partial**

- Prefer provider-supplied sections, subsections, paragraphs, subparagraphs,
  pages, neutral citations, and anchors.
- Build stable structure where the provider omits it, using the proven
  A2AJ/ALR heuristics and universal PDF artifacts.
- Preserve distinct locator kinds even where a provider encodes them in one
  string.
- Test SCC/Ontario `#par`/`#sec`, A2AJ, CourtListener, TNA, GOV.UK ET,
  GovInfo, legislation, and journal article variants using a cross-provider
  fixture matrix.
- Record whether each locator is native, hybrid, heuristic, or model-repaired.

Acceptance:

- The model can request a section/paragraph/page by normalized locator without
  provider-specific URL logic.
- A wrong inferred locator fails closed or is labeled approximate.

### P1.2 Durable provider cache and bulk paths

Status: **Partial**

- Add shared read-through caches with schema version, source checksum/ETag,
  fetch time, license/provenance, retry metadata, and atomic replacement.
- Keep provider databases independent immutable snapshots.
- Retain and test A2AJ/CourtListener bulk import/update.
- Survey official bulk/download options for every integrated provider; add
  only lawful, maintainable paths that improve reliability.
- Let Library entries point to a stable provider/cache record instead of
  copying large bodies.

Acceptance:

- A source already in bulk/cache opens without a network call.
- A provider outage does not invalidate previously verified local evidence.
- Cache corruption is detected and recoverable.

### P1.3 Seamless deterministic pinpoint links

Status: **Partial**

- Replace verbose model-authored citation JSON with short evidence handles.
- Hydrate and verify exact quote spans on the server.
- Prefer native provider anchors; otherwise produce verified text fragments.
- Support multiple text directives for disjoint spans in one page/paragraph/
  section.
- Produce local galley-viewer links when an external URL cannot express the
  exact unit.
- Attach links automatically to chat output and generated/revised DOCX
  citations.
- Benchmark latency and cache behavior so references appear with no perceptible
  second pass.

Acceptance:

- The model can effectively ask for “this evidence handle,” “section 7.3,” or
  “the sentence just retrieved”; it never hand-builds `#par`, `#sec`, or
  `:~:text=`.
- Link correctness, quote verification, and source version are deterministic.

### P1.4 Retrieval: lexical first, vectors only if earned

Status: **Research**

- Build a held-out exact-passage retrieval suite over bulk provider data and
  `public_endpoint.db`.
- Compare FTS/BM25, TurboVec or another small dense index, and hybrid/reranked
  retrieval at the same candidate and latency budgets.
- Measure Recall@k/nDCG, exact pinpoint hydration, wrong-source rate, index
  time/size, update cost, and weak-hardware latency.
- Keep vector outputs as candidates; authoritative source lookup supplies text
  and links.

Acceptance:

- Add the vector dependency only if it produces a meaningful held-out win that
  lexical retrieval cannot match with simpler query expansion/reranking.

## Priority 1 — deterministic document and spreadsheet work

### P1.5 Compact evidence handles and citation-linking route

Status: **Partial**

For “link the citations in this document”:

1. deterministically inspect footnote layout and citation boundaries;
2. route directly to the bounded ALR-style splitter + ultra-economy linker
   unless a measured routing classifier saves tokens at equal accuracy;
3. use a dynamically available strong Codex model demonstrated equivalent on
   the benchmark; and
4. write only verified links into a new immutable document version.

Complete the still-pending real ALR DOCX multi-arm benchmark now that real model
calls were authorized. Do not use unsupported `gpt-5.2`; compare current
eligible models and efforts with constants pinned.

The least-edited upstream Ampleman source has 70 exact accepted-gold matches
and a frozen 12-case sample. Luna, Terra, and Sol capability probes pass, but
the six legal-data arms remain unrun because transmitting the selected private
footnotes and propositions to OpenAI through Codex requires a separate,
informed approval. The offline router estimates only 212 tokens saved by
forced hybrid, below its 512-token threshold, so `direct` remains the automatic
route. See [DOCX live-model benchmark](docx-live-model-benchmark-2026-07-27.md).

Acceptance:

- Zero silent character loss, citation under-splitting, or uncertain OOXML
  mutation.
- Every link has a source/evidence receipt and document-version binding.

### P1.6 Token-efficient DOCX operations

Status: **Partial**

| Research artifact | Status |
| --- | --- |
| [Deterministic Word actions catalog](deterministic-word-actions-catalog.md) | **Complete** — classifies direct, bounded, preview-only, and judgment-dependent Word actions; runtime gaps below remain planned. |

Implemented:

- A conservative `library_fix_docx_supras` operation finds visible
  `supra note N` across Word run boundaries, adds native bookmark/`NOTEREF`
  fields, preserves run properties and unrelated OOXML, creates a new Library
  version only on change, and abstains on restarted numbering, invalid targets,
  tracked changes, hyperlinks, or unsafe field boundaries.
- A Library HTTP action and assistant tool expose the same operation; the
  citation-linker and Table/Book of Authorities workflow are exposed beside it.
- **Document actions** is a non-modal floating side panel, not a focus-stealing
  dialog. It docks left/right, minimizes to a launcher, and leaves the Library
  interactive. A component test verifies background interaction, docking,
  minimize, and restore.

- Build version-bound find handles so repeated changes do not resend whole
  documents or ambiguous before/after context.
- Add deterministic scoped replace, batch replace, tracked-change insertion,
  bookmark/REF/PAGEREF/SEQ maintenance, and editorial lint primitives.
- Support Word content controls where they reduce repeated model-authored
  structure: stable IDs/tags, bound fields, linked definitions/citations, and
  repeatable sections.
- Preserve unsupported OOXML and reject unsafe run-boundary mutations.
- Port only general-purpose features from the ALR macro audit; leave
  law-review-specific UI/macros behind.

Acceptance:

- Each mutation declares source version, target handles, preconditions, and a
  new version.
- A simple find/replace uses a bounded deterministic operation, not a model
  rewrite.

### P1.7 Token-efficient spreadsheet operations

Status: **Research**

- Add bounded A1/range reads, table metadata, formula inspection, targeted cell
  patches, row/column insertion, and batch operations.
- Preserve formulas, types, styles, comments, validation, and unsupported
  workbook features, or fail closed.
- Never serialize an entire workbook to Markdown when a range answers the
  question.

Acceptance:

- Every edit is version-bound, range-scoped, previewable, and testable on
  formula/style fixtures.

## Priority 1 — Library viewers and durable legal work products

### P1.8 Universal legal galley viewer

Status: **Partial**

The current `LegalSourceViewer` is a useful start, not the requested
Text-Fidelity galley-viewer port.

- Define one renderer contract for cases, legislation, journal articles, and
  uploaded PDFs.
- Reuse the Text-Fidelity viewer's proven navigation/layout behavior and
  Table of Authorities' source rendering without runtime coupling to those
  applications.
- Render pages, sections, nested provisions, paragraphs, footnotes,
  propositions, highlights, native/external/local pinpoints, and provenance.
- Library entries remain lightweight pointers to shared bulk/cache/artifacts.
- Open sources in existing or separate tabs without duplicating durable blobs.

Acceptance:

- The same normalized source record renders across providers and uploaded PDFs.
- Opening a pinpoint is fast, stable after restart, and highlights the exact
  quoted unit.

### P1.9 Legal ontology graph artifacts

Status: **Research**

Use the decision in `legal-ontology-graph-repo-evaluation.md`:

- renderer-independent versioned JSON for tests, factors, subfactors,
  interpretations, applications, commentary, exact passages, citations,
  proposals, review state, and saved views;
- deterministic schema validation, quote/link hydration, IDs, hashes, visible
  projection, layout seed, and memo generation;
- model-generated proposals stay separate until accepted;
- lazy `@xyflow/react` + `@dagrejs/dagre` viewer with filters for doctrine,
  interpretation, application examples, and journal commentary; and
- immutable Library revisions plus linked Markdown/DOCX research memos.

Acceptance:

- A user can expand from a legal test to factor/subfactor, then to exact case
  or article passages and further treatment.
- Large graphs meet an explicit node/edge interaction budget.
- The artifact remains usable without React Flow.

### P1.10 Table of Authorities integration and packaging

Status: **Partial**

- **Done:** the local assistant has bounded submit/status tools for owned
  Library DOCX versions. It reuses the standalone localhost job API, exposes no
  arbitrary path/command parameter, and returns a job-specific Mike route.
- **Done:** detection can explicitly use the neutral universal engine's cached
  splitter for incomplete citation units only; deterministic-only remains the
  standalone default and review JSON records fallback telemetry.
- Finish browser/Tk parity gaps using the browser UI as canonical.
- Make jobs durable/resumable and use the universal PDF adapter.
- Remove anonymous-development-only embedding restrictions where deployment
  security permits.
- Package the same localhost host/static UI as a standalone desktop executable.
- Add dependency/version doctor checks; normal startup must not import optional
  DuckDB/PyArrow.
- Preserve standalone CLI and legacy Tk fallback.

Acceptance:

- Standalone browser host and Mike tab execute the same job/UI code.
- A clean supported machine can bootstrap or run the packaged build without
  random missing-module failures.

### P1.11 Curated capability examples

Status: **Planned**

Create a small, redistributable demo Library:

- one Canadian decision, one statute/regulation, one US or UK decision, one
  journal article, one structured digital-born PDF, one degraded PDF, and one
  DOCX citation-linking example;
- prompts demonstrating exact paragraph/section/footnote lookup, automatic
  links, drafting, Table of Authorities, and ontology graph output; and
- expected results plus provenance/license records.

Acceptance:

- A new local user can exercise Mike's main capabilities without providing
  private documents or external accounts.

## Priority 1 — provider breadth and multimodality

### P1.12 Provider capability registry

Status: **Partial**

- Expose each provider's text/image/tool/stream/reasoning/effort/context/session
  capabilities from one registry.
- Populate model/effort controls dynamically when possible and keep curated
  fallbacks versioned.
- Avoid duplicate display entries across Luna/Codex/provider aliases.
- Distinguish API-key providers from local Codex-auth models without duplicate
  “Codex local” choices.
- Add safe credential diagnostics and provider-specific error messages.

Acceptance:

- The UI does not advertise unsupported effort/image/tool behavior.
- Adding a model normally changes registry data and adapter tests, not several
  hardcoded UI lists.

### P1.13 Muse Spark live validation

Status: **Blocked**

The OpenRouter adapter exists, but the configured credential returns
`401 User not found`. Replace/fix the credential, then run harmless text,
reasoning, tool, streaming, and image tests through Mike. Treat OpenRouter's
current US-only hosted-preview label as a distribution policy to verify, not an
inherent geographic property of the model. Evaluate a direct Meta endpoint
only if an official credential and terms are available.

### P1.14 Real multimodal legal-image tests

Status: **Partial**

- Run actual provider calls on scanned pages, exhibits, tables, stamps,
  signatures, diagrams, and mixed text/image PDFs.
- Compare full-page vision against deterministic crop/OCR/structure routing.
- Store image provenance and avoid sending unrelated pages.
- Measure tokens, latency, extraction fidelity, and hallucinated visual facts.

Acceptance:

- Vision is invoked only for images/pages that require it.
- Quoted visual text is grounded in an OCR/region artifact with page and box.

### P1.15 Role-aware onboarding and settings

Status: **Deferred**

Do not build this until Mike has enough genuinely distinct litigator and
solicitor capabilities for a preset to change the product meaningfully.

- On first use, offer an optional account-free Mike profile that asks what kind
  of legal work the user does and explains what the answer changes.
- Provide editable presets rather than permanent roles. A litigator preset can
  foreground Table of Authorities and case-research workflows; later solicitor
  presets should be based on implemented transactional workflows, not guesses.
- Add a normal Settings area where the same choices, defaults, providers,
  privacy controls, and local/cloud behavior can be reviewed or changed.
- Store local profiles under the shared AppData contract and keep cloud profile
  compatibility without requiring an account.
- Allow skipping onboarding and changing or resetting the profile at any time.

Acceptance:

- Onboarding is introduced only after at least two evidence-backed role presets
  produce materially different useful navigation or defaults.
- Presets never hide capabilities, hardcode a professional identity, or make
  account creation mandatory.

## Priority 2 — legal benchmarks and deployment gates

### P2.1 Benchmark inventory and licensing

Status: **Research**

Verify exact versions, licenses, access rules, leakage risk, jurisdictions, and
task fit for:

- the user-identified “Semantic Legal Bench by Marty Rudolf”;
- COLIEE;
- LegalBench and LegalBench-RAG;
- Canadian benchmarks such as 2CANLegalRAGBench if available under usable
  terms;
- US citation/retrieval/drafting benchmarks;
- Harvey's public Legal Agent Benchmark materials; and
- internal Mike fixtures for exact evidence retention, document mutation, and
  long-running matters.

Do not claim comparison with Harvey's product unless the exact same hidden
system and evaluation conditions are available. Public LAB reproduction can
compare published methods, not private product performance.

### P2.2 Full-history vs compact-memory factorial

Status: **Planned**

Minimum controlled arms:

| Arm | Context | Directive |
| --- | --- | --- |
| A | Full history | Current Mike prompt |
| B | Full history | Legal-safe concise/Caveman-lite |
| C | Exact ledger + summary + recent tail | Current Mike prompt |
| D | Exact ledger + summary + recent tail | Legal-safe concise/Caveman-lite |

Add ablations from the independent research synthesis:

- no exact ledger;
- no recent verbatim tail;
- summary-only;
- provider-native continuation only;
- different compaction thresholds/reserve budgets;
- no durable tool receipts; and
- lexical versus optional semantic retrieval of prior evidence.

Hold model, effort, provider, tools, source corpus, prompt version, output
budget, and judge rubric constant.

Hard legal gates:

- exact quote and pinpoint fidelity;
- qualifiers, negation, exceptions, dates, defined terms, and party identity;
- conflicting authorities/evidence;
- accepted versus proposed edits;
- document/source version;
- pending user instruction;
- deterministic tool result and citation provenance;
- cross-matter isolation; and
- recovery after restart/provider-session loss.

Secondary metrics:

- task quality and human/blind legal score;
- input/output/cached tokens and dollar cost;
- latency and compaction frequency;
- tool-call count, wrong-tool rate, and source rehydration count; and
- summary drift over 40–80+ turns.

### P2.3 Caveman directive as an independent treatment

Status: **Research**

Do not enable an upstream “Caveman” prompt globally. First pin the exact
repository/version/license and test:

- upstream directive unchanged;
- a legal-safe variant that removes pleasantries/repetition but preserves
  qualifiers, quotes, citations, defined terms, uncertainty, and audit
  explanation; and
- no concise directive.

Adopt only the smallest phrasing that reduces output tokens without damaging
legal gates.

## Priority 2 — release and safety work

### P2.4 Prompt injection and untrusted-document boundaries

Status: **Planned**

- Treat retrieved PDFs, opinions, legislation, journal articles, DOCX fields,
  OCR, metadata, and summaries as untrusted data.
- Mark source boundaries in model input.
- Prevent source text from authorizing tools, changing system instructions, or
  crossing matter boundaries.
- Add adversarial fixtures and verify that compaction does not promote an
  injected instruction into the durable exact ledger.

### P2.5 Cloud/local parity matrix

Status: **Partial**

Maintain a checked matrix for authentication, Library, projects, chats,
provider keys, document versions, legal sources, Table of Authorities, graph
artifacts, and downloads across anonymous local and cloud modes. Migrations
must be forward-safe and local files must never become cloud credentials.

### P2.6 Release evidence

Status: **Planned**

For each release record:

- exact commits for root and neutral subrepos;
- Node/Python/Codex/provider versions;
- clean install/bootstrap result;
- unit/integration/build/lint results;
- startup and browser smoke results;
- benchmark versions and medians;
- known blocked credentials/datasets; and
- migration/rollback notes.

### P2.7 Accessibility and assistive-technology gates

Status: **Planned**

Apply the current W3C WCAG 2.2 Level AA criteria throughout Mike, the embedded
Table of Authorities workflow, Library viewers, document/action panels, and
durable graph artifacts:

- preserve semantic landmarks, headings, labels, names, descriptions, status
  announcements, and logical reading order;
- make every workflow operable by keyboard with visible, unobscured focus and
  predictable focus return from dialogs and dockable panels;
- meet contrast, target-size, zoom, 320-CSS-pixel reflow, text-spacing,
  reduced-motion, high-contrast, and non-colour-only communication needs;
- expose accessible alternatives for charts, legal ontology graphs, PDF/DOCX
  page viewers, citation highlights, progress, errors, and drag/reorder actions;
- keep account-free onboarding and authentication free of cognitive tests or
  redundant re-entry barriers; and
- run fast automated checks in normal development, then manually test critical
  paths with keyboard-only use, browser zoom/reflow, Windows high contrast,
  and at least NVDA plus one other screen-reader/browser combination.

Acceptance:

- Automated accessibility checks have no serious or critical violations on
  each primary route, with documented exceptions rather than ignored rules.
- A human can complete Library import/retrieval, assistant use, provider and
  effort selection, Table of Authorities import/review/build/download, and
  Settings using keyboard and a screen reader.
- Accessibility claims are not based on automation alone; W3C notes that tools
  cannot evaluate every accessibility requirement.

## Explicit non-goals

- No runtime dependency on ALR Quote Verifier and no obligation to fork it.
- No graph database for the first ontology implementation.
- No vector database until a held-out retrieval win justifies it.
- No lossy summary as a legal source or replacement for raw history.
- No global Caveman directive before independent testing.
- No removal of Supabase/R2/cloud compatibility.
- No reduction of useful warmup merely to make a build metric look better.
- No full-document model parsing when a deterministic exact lookup can answer.
- No second maintained Table of Authorities UI.
- No durable copied case/article blob where a versioned pointer to bulk/cache
  data is sufficient.

## Execution sequence

1. **Preserve the baseline**: ignores, nested repo commits, root local commits,
   launcher/doctor, and one end-to-end local smoke flow.
2. **Finish the evidence layer**: Mike PDF ingestion, exact structure tools,
   provider caches/locators, and compact evidence handles.
3. **Benchmark before changing memory**: independent synthesis, instrumentation,
   full-history baseline, compaction prototype, legal hard gates, and
   Caveman-separated factorial.
4. **Deploy context management behind a flag**: server-authoritative state,
   provider continuation, recovery, and isolation tests.
5. **Make document work deterministic**: DOCX linking benchmark, version-bound
   mutation primitives, content controls, and bounded spreadsheet operations.
6. **Complete durable legal work products**: universal viewer, ontology graph,
   Table of Authorities parity/packaging, and curated examples.
7. **Optimize measured bottlenecks**: frontend/runtime/build profiles and
   vector retrieval only where benchmarks justify them.
8. **Validate provider breadth/cloud parity and accessibility**: Muse
   credential, real multimodal calls, provider registry, migrations, WCAG
   gates, and release evidence.

## Requirement traceability

The consolidated backlog deliberately retains these user priorities:

- no accounts for local use, local storage first, cloud compatibility retained;
- dynamic Codex models and full reasoning-effort range with a separate UI
  control and local Codex authentication;
- DeepSeek and Muse Spark provider support;
- sessions/caching/compaction comparable to Codex/OpenCode and official OpenAI
  guidance, evaluated rather than assumed;
- legal-specific auto-compaction that preserves exact evidence and reduces
  token use;
- Canadian/American legal benchmarks, Harvey-public-method comparison, and an
  independent Caveman treatment;
- deterministic work wherever a model is currently hand-rolling URLs,
  citations, document edits, spreadsheet reads, or repetitive structure;
- exact footnote/proposition/page/section/subsection/paragraph/subparagraph
  lookup and automatic native/text-fragment links;
- native provider structure first, reconstructed structure where absent, and
  lawful bulk data paths;
- `public_endpoint.db`, journal pinpoint links, optional vector retrieval, and
  A2AJ/CourtListener/TNA/GOV.UK/GovInfo support;
- a neutral weak-hardware legal PDF engine, selective Codex repair, degraded
  PDF exports, ALR DOCX ground truth, real model calls, and diverse legal-PDF
  testing;
- ALR independence with selective tested ports, not brittle coupling;
- one shared legal-data contract and reliable runtime dependencies;
- Table of Authorities as both a Mike category and standalone GUI/CLI with one
  maintained browser UI;
- a performant universal galley viewer using pointers to shared artifacts;
- multimodal image processing;
- durable legal-test/factor/application/commentary graphs and linked research
  memos;
- Mike-Canada branding, maple leaf/red visual identity, visible assistant,
  non-duplicated models, and usable icons;
- optional role-aware onboarding plus an editable Settings area, deferred until
  litigator and solicitor presets can reflect real implemented capabilities;
- WCAG 2.2 AA as a cross-cutting release gate, including keyboard, reflow,
  contrast, reduced-motion, and manual screen-reader testing;
- reliable startup, working Library import, responsive UI, and dramatically
  shorter measured builds without harmful warmup cuts;
- curated example documents; and
- local git commits and reproducible release evidence.

## Detailed appendices

- [Mike document intelligence](mike-document-intelligence-plan.md)
- [Universal legal PDF engine](universal-legal-pdf-engine-plan.md)
- [Shared legal data and tool UI](shared-legal-data-and-tool-ui-plan.md)
- [ALR independence decision](alr-independence-and-shared-data-plan.md)
- [Session compaction/context efficiency](session-compaction-and-context-efficiency.md)
- [Pinpoint retrieval and vectors](pinpoint-retrieval-and-vector-embeddings.md)
- [Deterministic/durable work audit](deterministic-durable-work-audit.md)
- [Document mutation and content controls](document-mutation-token-efficiency-and-content-controls.md)
- [ALR macro portability audit](alr-macro-portability-audit.md)
- [Legal ontology graph evaluation](legal-ontology-graph-repo-evaluation.md)
- [Muse provider status](meta-muse-spark-provider.md)
