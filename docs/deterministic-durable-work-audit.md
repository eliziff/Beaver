# Deterministic and durable work audit

Status: audit complete against the dirty workspace on 2026-07-26. No
production code was changed.

## Scope and decision rule

This audit covers the Beaver frontend/backend, `OpenLegalData`,
`universal-legal-pdf-engine`, and `TableOfAuthoritiesMaker`. A **strict win**
preserves the supported result while removing a model round trip, reducing
model-visible text, making verified state survive a restart, or deleting a
duplicate implementation. A **conditional win** needs a held-out benchmark
because it can change recall or output quality.

Two parallel audits own adjacent details:

- [Document mutation, token efficiency, and content controls](document-mutation-token-efficiency-and-content-controls.md)
  covers DOCX/XLSX read-edit-reread flows, bounded mutation tools, document
  generation, and Office content controls. Its portability appendix is
  [ALR macro portability](alr-macro-portability-audit.md).
- [Session compaction and context efficiency](session-compaction-and-context-efficiency.md)
  covers provider session continuation, prompt-prefix caching, system/tool
  schema budgets, tool-result caps, history pruning, and compaction.

This report mentions those areas only where deterministic evidence state must
cross their boundary.

## Ranked result

| Rank | Verdict | Smallest useful change |
| ---: | --- | --- |
| 1 | Strict win | Route Library PDF/DOCX reads and lookups through one content-addressed structural artifact instead of repeatedly flattening the file. |
| 2 | Strict win | Replace model-authored citation metadata and URLs with opaque evidence handles; number, verify, and render citations on the server. |
| 3 | Strict win with an equivalence gate | Persist provider locator offsets/labels beside each bulk snapshot so structure is not rebuilt into `WeakMap`s on every process. |
| 4 | Strict durability win | Persist anonymous/local chats under the shared AppData root; retain Supabase as the cloud adapter. |
| 5 | Strict for exact citations; conditional otherwise | Deterministically route recognized citations and locators, and make the model carry a source handle rather than provider-specific identity fields. |
| 6 | Strict extraction win; conditional retrieval win | Parse each tabular document version once, verify evidence on the server, and benchmark bounded hydration before replacing full-document context. |
| 7 | Strict durability/parity win | Make the bounded DOCX-linking job idempotent and expose the same job through a cloud-storage adapter. |
| 8 | Strict when validators are available | Add a small read-through cache for unchanged TNA/GOV.UK/GovInfo/CourtListener representations; do not build another provider framework. |
| 9 | Conditional reliability win | Constrain remaining semantic result schemas at the adapter boundary; stop asking the model to emit UI markup. |
| 10 | Safe simplification | Use deterministic chat titles by default and retire the Tk-only DuckDB corpus path after migration. |

## 1. Library documents need one durable structural artifact

**Current behaviour.** Local Library reads keep only 16 flattened strings in a
process `Map`, keyed by document/version timestamps
(`backend/src/lib/chat/localAssistantTools.ts:130-173`). PDF and DOCX content is
re-extracted at `localAssistantTools.ts:152-167`, and a read may expose up to
300,000 characters (`localAssistantTools.ts:251`). The cloud path downloads and
parses the active file on each `read_document`
(`backend/src/lib/chat/tools/documentOps.ts:1404-1578`); `find_in_document`
calls that path again at `documentOps.ts:1666-1717`.

The DOCX body extractor opens only `word/document.xml`
(`backend/src/lib/docxTrackedChanges.ts:719-750`), so it cannot answer a
footnote lookup. The existing deterministic implementations already cover the
missing work:

- `TableOfAuthoritiesMaker/toa_maker.py:912-969` reads body footnote
  references and `word/footnotes.xml`.
- `universal-legal-pdf-engine/src/legalpdf/core.py:2127-2176` hashes the source,
  parser code, schema, and options and reopens a completed manifest on a cache
  hit.
- `universal-legal-pdf-engine/src/legalpdf/core.py:2247-2307` performs bounded
  footnote lookup.

The only Beaver integration with the universal engine is currently the bounded
DOCX citation-linking subprocess
(`backend/src/lib/docxCitationLinking.ts:477-519`); normal Library reads do not
use the parser.

**Cost.** A targeted question can currently cause another download, parse, and
as much as 300,000 characters of model context. The rough four-characters-per-
token heuristic makes that an upper bound near 75,000 tokens before the
answer. Restarting Beaver discards the parsed local result. DOCX footnote content
is not merely slow; it is absent.

**Smallest replacement.** Add one Library operation:

`library_lookup(document_id, version_id, locator_kind, locator, context_blocks)`

For PDFs it opens the universal engine manifest. For DOCX it uses the same
neutral OOXML unit reader already proven in Table of Authorities/DOCX linking.
`library_read` may still return flat text when explicitly needed, but both
local and cloud storage adapters must resolve the same artifact contract.
Do not create a document-intelligence daemon or a second parser.

**Persistence and invalidation.** Store application artifacts under
`OPEN_LEGAL_DATA_HOME/apps/mike/document-index/`, keyed by:

`content_sha256 + parser/schema version + parser-code identity + options hash`

Never key correctness to filename or `created_at`. Write collections first and
the manifest last, as the universal engine already does. A changed byte or
parser contract is a cache miss; old immutable artifacts can be pruned later.

**Risk and equivalence gate.** Low-confidence/ambiguous structure must be
visible in diagnostics and may fall back to the flat read. Tests must prove:

1. cold and warm results are byte-equivalent;
2. warm lookup makes no parser/model call;
3. a one-byte source change invalidates the artifact;
4. PDF pages/sections/paragraphs/footnotes and DOCX body/footnotes resolve;
5. local bytes and Supabase/R2 bytes produce the same manifest for the same
   SHA-256.

## 2. The model should cite evidence, not serialize citation records

**Current behaviour.** The main prompt asks the model to number `[N]` markers
and repeat full citation JSON (`backend/src/lib/chat/prompts.ts:14-39`), with
separate A2AJ instructions at `prompts.ts:80-83`. Public legal tools repeat the
same contract (`backend/src/lib/chat/tools/publicLegalSourceTools.ts:101-108`).
Beaver then tolerantly reparses partial or malformed JSON
(`backend/src/lib/chat/citations.ts:71-197` and `:284-386`).

The trusted work is already deterministic after parsing:

- `backend/src/lib/chat/citations.ts:401-465` resolves the citation against
  server-held source state.
- `backend/src/lib/legalSourceLinks.ts:389-447` verifies one or more quote
  spans and creates native/text-fragment links.
- `legalSourceLinks.ts:520-577` and `:671-721` match A2AJ and CourtListener
  evidence before constructing a link.

Journal search now returns `hit_id`
(`backend/src/lib/chat/publicLegalSourceState.ts:164-173`), but follow-up tool
schemas still require the model to repeat `provider` and `identifier`
(`backend/src/lib/chat/tools/publicLegalSourceTools.ts:42-95`). Citation state
is recreated for each response
(`backend/src/lib/chat/streaming.ts:227-232`), so it cannot be referenced
durably on the next turn.

**Cost.** Every citation duplicates provider identity, citation/name/dataset
fields, and an exact quote in model output. It also creates a failure mode in
which a correct answer loses its source because the trailing JSON is truncated
or malformed. URLs themselves are already zero-reasoning deterministic work;
the remaining model-authored envelope has no legal value.

**Smallest replacement.** Every authoritative fetch/lookup returns a short
opaque `evidence_id`. The model emits only an evidence marker such as
`[cite:e7]` (or a tiny `cite(evidence_id, spans)` call). The server:

1. verifies that the handle was returned to this chat/turn;
2. orders and numbers displayed references;
3. resolves the exact block and allowed quote span;
4. creates `#par`, `#sec`, `page=`, or verified multi-text directives;
5. stores the final citation object with the message.

Keep the existing `<CITATIONS>` parser temporarily as a legacy fallback, then
delete it after stored-message and provider equivalence tests pass.

**Persistence and invalidation.** A durable evidence record needs:

`provider + stable_source_id + source_revision/content_sha256 + block_id +
normalized_span_hash + locator/link-resolver version`

The short turn handle maps to that record and may expire; the stored message
must not depend on an in-memory `Map`. If a live provider changes, retain the
original snapshot reference or mark the citation stale rather than silently
repointing it.

**Risk and equivalence gate.** UI and stored-message migration are the main
risks. Run the existing A2AJ, CourtListener, public-source, journal, and
multi-text fixtures through both transports and require identical displayed
source identity, quotes, and final URL. Reject a handle from another
chat/user/version.

## 3. Provider structure should be an offset sidecar, not a process object

**Current behaviour.**

- A2AJ structure and lookup text live in `WeakMap`s
  (`backend/src/lib/a2aj.ts:112-114`) and are rebuilt at `a2aj.ts:402-423`.
- Local A2AJ bulk rows also build structure and attach it to a `WeakMap`
  (`backend/src/lib/a2ajLocalBulk.ts:12` and `:97-126`).
- CourtListener opinion text/structure uses two `WeakMap`s
  (`backend/src/lib/courtlistener.ts:27-28`).
- Journal article structure is reconstructed on first fetch and retained only
  in a process map (`backend/src/lib/journalArticles.ts:61`, `:345-424`, and
  `:446-479`).
- The A2AJ bulk schema stores documents and citation lookup but no durable
  locator rows (`OpenLegalData/src/open_legal_data/bulk.py:15-34`); its FTS
  indexes whole document bodies (`bulk.py:198-214`). CourtListener similarly
  builds cluster/opinion FTS over whole records
  (`OpenLegalData/src/open_legal_data/courtlistener_bulk.py:251-283`).

A2AJ's persistent HTTP response cache
(`backend/src/lib/a2aj.ts:265-376`) and the contentless journal FTS sidecar are
good and should remain. They cache source/candidate data, not authoritative
locator identity. During integration, the journal FTS connection, main
read-only database connection, and parsed-document cache were all changed to
recheck the configured source path/size/mtime and discard warm state when the
snapshot changes (`backend/src/lib/journalArticles.ts`). Focused tests cover
both source-path replacement and in-place snapshot changes.

**Smallest replacement.** At import time, or in one atomic sidecar build,
write only provider-neutral block metadata:

`source_id, kind, label, parent_id, start, end, native_anchor, aliases`

Offsets point into the existing provider text; do not duplicate the raw body.
Keep candidate FTS/vector data in a separate optional sidecar. `OpenLegalData`
should own the sidecar schema so Beaver and Table of Authorities do not fork the
same indexer.

**Persistence and invalidation.** Key a sidecar by provider snapshot
revision/content hash, language, structure-parser version, and normalization
version. Build beside the live file and atomically replace only after counts
and foreign-key checks pass. Beaver may cache opened read-only connections, but
the snapshot signature remains authoritative. Include that signature in the
journal document-cache key and close/clear cached source objects when it
changes.

**Risk and equivalence gate.** Native provider structure must win over
reconstructed structure. Compare every current lookup fixture against the
sidecar and require identical status, selected text, neighbouring blocks, and
anchor. Add ambiguity fixtures for section/subsection/subparagraph aliases.

## 4. Account-free chats are durable; model sessions are not yet compacted

**Implemented 2026-07-26.** Anonymous/local chats now use the local document
store's atomic JSON pattern: one validated, versioned chat record per chat under
`OPEN_LEGAL_DATA_HOME/apps/mike/chats/`. The module-level `Map` is a cache, not
the source of truth. No database dependency was added, and Supabase/cloud
tables, authentication, and storage behavior remain intact.

This closes the restart/data-loss defect, but it does not make provider context
persistent or compact: the browser still sends the full visible history on
each turn. Provider continuation and the exact legal-state capsule described in
the session-compaction report remain separate benchmark-gated work.

**Equivalence evidence.** Regression tests cover restart recovery, message
ordering/linkage, ownership isolation, delete isolation, corrupt records, and
interrupted temporary files. Supabase integration behavior remains unchanged.

## 5. Exact citation and locator routing should not consume reasoning

**Current behaviour.** General chat exposes provider-specific tool families and
requires the model to select a provider and carry its identity fields. The new
bounded DOCX path demonstrates the simpler boundary: public provider patterns
are selected at `backend/src/lib/docxCitationLinking.ts:258-352`, and the Table
of Authorities parser already recognizes primary authority and pinpoint
variants (`TableOfAuthoritiesMaker/toa_maker.py:263-507`).

**Smallest replacement.** Put a thin deterministic pre-router in front of the
existing provider functions:

- exact Canadian neutral citations/statute citations -> A2AJ;
- exact US reporter citations -> CourtListener;
- exact TNA, Employment Tribunal, and GovInfo identifiers -> their provider;
- a returned search result -> its opaque source handle.

Delete provider/name fields from follow-up tool schemas when a handle already
contains them. Do not build an LLM routing agent. Ambiguous names and
proposition searches may fan out to permitted candidate indexes or remain
model-directed.

**Persistence and invalidation.** Version the pattern table and store only
successful stable-source resolution, keyed by normalized input plus provider
snapshot/catalog revision. Do not durably cache an arbitrary model routing
choice.

**Risk and equivalence gate.** Regex false positives are controlled by
abstention: zero or multiple exact matches return candidates, not a guessed
source. Run the Table of Authorities/ALR citation fixtures plus Canadian,
American, and UK negatives and require no incorrect forced route.

## 6. Tabular review should reuse parsed evidence and stop encoding UI syntax

**Current behaviour.** Initial tabular generation correctly batches all
columns into one call per document (`backend/src/routes/tabular.ts:889` and
`:1656-1734`), but it downloads/extracts each document again
(`tabular.ts:820-855`) and sends up to 120,000 characters
(`tabular.ts:1686`). Cell regeneration repeats download/extraction
(`tabular.ts:660-712`) and again sends 120,000 characters
(`tabular.ts:1522-1525`).

The model is also asked to manufacture frontend control syntax:

- `[[Yes]]`, `[[No]]`, and `[[tag]]` at `tabular.ts:59-64`;
- `[[page:N||quote:...]]` markers at `tabular.ts:1513-1518` and `:1674-1683`;
- minified JSONL, with malformed rows silently skipped at
  `tabular.ts:1695-1714`.

The frontend then reverses that syntax into UI objects
(`frontend/src/app/components/tabular/citation-utils.ts:13-54` and
`TabularCell.tsx:45-174`).

**Smallest replacement.**

1. Reuse the document-version artifact from finding 1.
2. Let the model return semantic `value`, `flag`, `reasoning`, and evidence
   handles; validate `yes_no` and `tag` against the column definition.
3. Let the server/UI decide whether a value is a pill and render citations from
   stored evidence. Markdown prose may remain model-authored.
4. Keep the existing one-call-per-document batching.

Bounded structural/lexical hydration is a **conditional** win: benchmark it
against the current 120,000-character baseline before replacing full context.
Use high-recall candidates and fall back to the full artifact when confidence
or coverage is low.

**Persistence and invalidation.** Cache extraction by document content hash.
If semantic cell results are cached, use:

`document_sha256 + column_prompt_hash + format/tags + model + effort +
result-contract version`

and make reuse visible; user edits to a prompt, model, or source invalidate the
result. Evidence handles must point to the immutable document version.

**Risk and equivalence gate.** Measure value agreement, evidence recall, exact
quote verification, page/section accuracy, malformed-result rate, input
tokens, and latency. Citation/link correctness may not regress to gain speed.

## 7. The bounded DOCX linker is the right pattern; finish durability and parity

The new path is mostly a strict win and should not be generalized:

- the main assistant gets one bounded `library_link_docx_citations` tool
  (`backend/src/lib/chat/localAssistantTools.ts:106-113`);
- the instruction routes directly to it without reading/splitting footnotes
  (`backend/src/routes/chat.ts:187`);
- deterministic splitting is attempted first
  (`universal-legal-pdf-engine/src/legalpdf/docx_linking.py:119-148`);
- the model schema rejects URLs and character-changing partitions
  (`docx_linking.py:154-319`);
- calls are content-addressed by prompt/input/model/effort
  (`docx_linking.py:425-475`);
- provider resolution and URL generation are deterministic
  (`backend/src/lib/docxCitationLinking.ts:107-376`).

Two gaps remain:

1. Provider lookups are deduplicated only within one request
   (`docxCitationLinking.ts:396-439`).
2. Every successful replay creates another local version
   (`docxCitationLinking.ts:536-565`), and the bounded tool is local-only.

**Smallest replacement.** Record job provenance on the derived version and
return an existing identical result for:

`input_version_sha256 + link-plan hash + resolved-link-map hash + applier version`

Add a cloud adapter that supplies input bytes and persists output bytes through
the existing Supabase/R2 version path; do not fork the Python worker or link
resolver. Cache verified provider resolution only against the provider source
revision and resolver version.

**Risk and equivalence gate.** A provider link may legitimately improve, so a
manual `refresh=true` must bypass job reuse. Require unchanged footnote text,
relationships-only OOXML changes, identical local/cloud output hash for the
same input and link map, and no duplicate version on exact replay. Detailed
Office mutation controls remain in the document-mutation report.

## 8. Provider GET retries/caching belong below the model

**Current behaviour.** A2AJ has a persistent response cache, but TNA/GOV.UK/
GovInfo fetch helpers call the network directly
(`backend/src/lib/publicLegalSources.ts:150-165`, `:187-285`, `:297-424`, and
`:434-540`). CourtListener opinion structure is process-only. CourtListener's
prompt correctly tells the model to stop on a 429
(`backend/src/lib/chat/tools/courtlistenerTools.ts:100`); the model should not
invent its own retry loop.

**Smallest replacement.** Reuse the A2AJ cache's simple file/metadata pattern
for idempotent GET representations. Honor `ETag`, `Last-Modified`,
`Retry-After`, and a short bounded transport retry for transient failures. Do
not add a general cache service. Search results get short TTLs; exact historical
documents can use validators and longer TTLs.

**Persistence and invalidation.** Key normalized URL/request representation
plus parser version. Store status, fetch time, ETag/Last-Modified, and content
hash. Never persist authentication headers. A validator mismatch replaces the
entry atomically.

**Risk and equivalence gate.** Staleness is the risk. Test 200/304, changed
ETag, 429 with `Retry-After`, corrupt cache, and offline warm-cache behaviour.
Do not retry non-idempotent mutations or multiply model calls.

## 9. Constrain semantic schemas; do not add self-repair agents

Citation JSON should disappear under finding 2. Tabular results still rely on
prompted JSON and permissive fallback (`backend/src/routes/tabular.ts:1513-1564`)
or skipped JSONL (`:1674-1714`). Where every configured provider supports an
equivalent constrained response, use a versioned structured-output/tool schema
and validate it once in the adapter.

This is conditional because provider implementations differ and tool calls may
delay streaming. Benchmark schema-valid rate, time to first completed column,
and total tokens against JSONL. Do not add a second model call merely to repair
serialization.

The universal parser is the positive example: structural repair has a strict
IDs-only schema, at most three bounded attempts, and a validated positive cache
(`universal-legal-pdf-engine/src/legalpdf/codex_repair.py:391-506`). The DOCX
linker is also schema-bound and content-addressed. Keep those local contracts.
A short-lived failure cooldown is only justified if telemetry shows repeated
identical failures; never permanently negative-cache network errors.

## 10. Delete two avoidable paths

### Model-generated titles

Anonymous mode already derives the title deterministically
(`backend/src/routes/chat.ts:664-670`), while cloud chat makes a separate model
call (`chat.ts:677-692`) and tabular chat makes another
(`backend/src/routes/tabular.ts:1567-1593`). Default all modes to the existing
normalizer. If richer titles are valued, make enhancement asynchronous and
optional. This removes one model round trip per new chat at the minor UX cost
of a less polished title.

### Duplicate DuckDB A2AJ corpus

Core Table of Authorities already reads the shared `OpenLegalData` corpus
through `SharedA2AJCorpus`
(`TableOfAuthoritiesMaker/shared_legal_data.py:99-134` and
`toa_maker.py:41,1026`). The Tk GUI still imports and advertises the old
DuckDB installer (`TableOfAuthoritiesMaker/toa_gui.py:17,952-1046`) backed by
`local_a2aj.py:33-46,304-361`. After one explicit legacy-data migration/export
check, remove that GUI path and its optional dependency. Do not maintain two
bulk formats or teach a model which one to use.

## Pinpoints versus embeddings: strict boundary

The detailed implementation and measured journal baseline live in
[Pinpoint retrieval and vector embeddings](pinpoint-retrieval-and-vector-embeddings.md).
The non-negotiable boundary is:

1. **Candidate discovery** may use exact citation routing, provider search,
   SQLite FTS5/BM25, or a future vector index.
2. **Authoritative hydration** resolves the candidate's stable source/block ID
   through the versioned locator table and returns exact text plus small
   neighbours.
3. **Citation and link construction** uses only that authoritative block,
   native anchor, and verified spans.

Vectors may say “look here.” They may never say “this is paragraph 62,” supply
the quoted passage, or construct a URL. Embeddings are keyed independently by
`embedding model + dimensions/quantization + chunk content hash`; locator
indexes are keyed by source/parser revision. Adding TurboVec remains
speculative until it improves held-out Recall@5/10 without regressing exact
locator/link accuracy, weak-hardware latency, or storage.

## State that must survive compaction

The compaction layer needs stable references, not copied source text:

- document ID, immutable version ID, and content SHA-256;
- provider, stable source ID, source revision, and block/evidence ID;
- generated artifact/job provenance;
- accepted/rejected edit state and unresolved user questions.

How those references are carried across provider sessions belongs to the
session-compaction report. The authoritative state belongs in the local/cloud
stores described here, never solely in a provider conversation ID.

## Acceptance dashboard

Before deleting legacy paths, compare old and new on one frozen corpus and
record:

| Measure | Required result |
| --- | --- |
| Exact locator text/status | Identical for every existing provider fixture |
| Final citation URL | Identical or more specific; zero unverified links |
| DOCX citation text | Byte-equivalent text after relationship insertion |
| Warm parser/model calls | Zero for an unchanged cached artifact/job |
| Restart behaviour | Local chats, artifacts, evidence, and jobs reopen |
| Source mutation | One-byte/source-revision change causes a cache miss |
| Isolation | No evidence handle crosses user/chat/document ACL boundaries |
| Cloud compatibility | Existing Supabase/R2 integration tests remain green |
| Retrieval benchmark | No regression in evidence Recall@k or locator accuracy |
| Token/latency reporting | Cold/warm input tokens and p50/p95 wall time recorded |

## Do not build yet

- No universal cache daemon.
- No second legal-source parser in Beaver.
- No model-based provider router for exact citations.
- No vector index before the lexical/hybrid benchmark passes.
- No model call to repair citation JSON, UI markup, or deterministic titles.
- No runtime dependency on ALR Quote Verifier; copy/port neutral components and
  test equivalence.
