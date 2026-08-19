# Beaver session compaction and context-efficiency audit

Audit date: 2026-07-26

Status: report only. This audit does not change runtime behavior.

## Bottom line

Beaver is not yet defensible for long-running legal sessions.

It durably stores cloud chat messages and legal/document artifacts, and its
direct OpenAI adapter correctly reuses a Responses API response ID inside one
tool-calling turn. Those are useful foundations. However:

- every new user turn sends the entire visible conversation back to the
  backend and then to the selected provider;
- there is no cross-turn compaction or authoritative context checkpoint;
- account-free local chats now have a durable raw transcript, but not a durable
  provider session or server-owned compacted context: every turn still trusts
  and projects the full history supplied by the browser;
- Codex is launched as a fresh `--ephemeral` thread for every user turn, so
  Beaver discards Codex's native session, cache, and compaction machinery;
- the default cloud research surface is about 7.6k prompt tokens before chat
  history, document lists, MCP connectors, retrieved text, or the current user
  request; and
- some document and project tools can return unbounded full text.

The safe direction is not “summarize everything.” Beaver should preserve the raw
transcript, store exact legal/document/workflow state separately, use
provider-native continuation and compaction where available, and treat a prose
summary as disposable context rather than a source of truth.

## What Beaver does now

### Conversation and persistence paths

| Path | Durable transcript | What the model receives on a new turn | Compaction/session reuse |
| --- | --- | --- | --- |
| Cloud assistant | Supabase `chats` and `chat_messages` | Full UI-visible history | None across user turns |
| Cloud project assistant | Supabase, plus project/document records | Full history plus project document inventory | None across user turns |
| Anonymous local assistant | Versioned atomic JSON under shared AppData; process `Map` is a cache | Full history sent by the browser | Durable across restart, but no model compaction/checkpoint |
| Direct OpenAI tool loop | Current turn is in memory | Initial full history, then only tool results through `previous_response_id` | Good within one turn; reset on next user turn |
| Codex bridge | Beaver transcript only | One flattened prompt containing the full conversation | Fresh ephemeral Codex thread every turn |
| Claude/Gemini adapters | Beaver transcript only | Full history; the in-turn tool loop appends and resends results | No provider session/checkpoint |

Evidence in the current tree:

- `frontend/src/app/hooks/useAssistantChat.ts:319` builds
  `apiMessagesForTurn`; `:374` maps all of those messages into every request.
- `backend/src/lib/chat/contextBuilders.ts:125` assembles the provider messages;
  `:166` appends every input message without a history budget or checkpoint.
- `backend/src/routes/chat.ts:818` and `:927` persist cloud messages.
- `backend/src/lib/anonymousChatStore.ts` validates and atomically persists one
  versioned JSON record per anonymous chat under `apps/mike/chats`; its
  module-level `Map` is only a read-through cache.
- `backend/src/routes/chat.ts:121-139` loads or creates that durable chat and
  appends the latest user message, but `:187-203` still invokes the model from
  request-supplied `messages`; the stored transcript is not yet the
  authoritative model-context source.
- `backend/src/lib/llm/openai.ts:254` creates a new, initially empty
  `previousResponseId` for each adapter call. It is populated at `:338-340`,
  which saves tokens during the remaining tool iterations of that same call
  only.
- `backend/src/lib/llm/codex.ts:123` flattens the prompt, while `:213-215`
  launches `codex exec --ephemeral --ignore-user-config`.
- The Codex event parser recognizes `turn.started` and `turn.completed` at
  `backend/src/lib/llm/codex.ts:52-53`, but does not capture
  `thread.started`.

`enrichWithPriorEvents` in
`backend/src/lib/chat/contextBuilders.ts:19` does recover a compact description
of the immediately preceding assistant tool activity. That is useful UI/tool
continuity, but it is not long-session compaction: it covers only the latest
assistant row and is not an authoritative session state.

### Prompt and tool budget

These figures measure source characters in the current serialized prompt/tool
definitions. Token counts use the rough `characters / 4` heuristic; provider
tokenizers will differ.

| Surface | Characters | Approx. tokens | Tools |
| --- | ---: | ---: | ---: |
| Cloud system, research disabled | 6,989 | 1,748 | — |
| Cloud system, research enabled | 11,460 | 2,865 | — |
| Core document/content tools | 8,498 | 2,125 | 7 |
| Workflow tools | 692 | 173 | 2 |
| CourtListener tools | 4,690 | 1,173 | 6 |
| A2AJ tools | 3,009 | 753 | 3 |
| Public legal/article tools | 2,189 | 548 | 3 |
| Project-only tools | 1,876 | 469 | 3 |
| Anonymous-local tool surface | 11,646 | 2,912 | 16 |

The normal cloud research path therefore exposes 21 tools and about 30,538
characters, or about 7.6k tokens, before conversation history and retrieved
content. A project turn exposes 24 base tools and about 8.1k tokens before its
project/document inventory. Every enabled user MCP tool is added on top of that,
so the actual ceiling is unbounded.

The tool surface is a larger problem than the core system prompt. The core
prompt is not unusually huge by itself, but the combined surface is not lean.

### Repeated and dynamic context

The following content is repeatedly paid for or invalidates a longer cache
prefix:

1. The “read each document once per response” rule appears in the system
   prompt, the dynamically appended document inventory, and the
   `read_document`/`fetch_documents` tool descriptions
   (`contextBuilders.ts:144-152`,
   `tools/toolSchemas.ts:14-27`, and `:208-210`).
2. The available-document list is appended to the system prompt on every turn.
   Project chat also inserts the whole project document inventory.
3. With research enabled, all CourtListener, A2AJ, and public-source tools are
   exposed even when the turn is unrelated to research
   (`backend/src/lib/chat/streaming.ts:189-196`).
4. Core generation and workflow tools remain exposed on pure question-answer
   turns.
5. `buildUserMcpTools` selects every enabled, non-confirmation MCP tool on every
   cloud turn (`backend/src/lib/mcp/servers.ts:446-486`). It repeats the
   untrusted-content warning in every tool description.

The repeated read rule is currently a safety workaround: without durable model
context, it prevents answers based on stale document content. It should not
simply be deleted. Replace full-document re-reads with content-addressed version
receipts and targeted paragraph/page/section retrieval first, then consolidate
the prompt wording behind an equivalence test.

### Tool-result pressure

There are useful bounded paths:

- account-free local `library_read` caps extracted text at 300,000 characters
  (`backend/src/lib/chat/localAssistantTools.ts:251`);
- MCP output is capped at 60,000 characters and reports truncation
  (`backend/src/lib/mcp/types.ts:127` and
  `backend/src/lib/mcp/servers.ts:526-527`);
- `find_in_document` and the legal pinpoint tools are naturally more compact
  than full-document reads.

The cloud document paths are less safe:

- `readDocumentContent` returns the entire extracted document
  (`backend/src/lib/chat/tools/documentOps.ts:1404`);
- project `fetch_documents` has no `maxItems` constraint
  (`backend/src/lib/chat/tools/toolSchemas.ts:14-27`); and
- its dispatcher concatenates every requested full document without an
  aggregate output budget
  (`backend/src/lib/chat/tools/toolDispatcher.ts:733`).

Long tool outputs cause context pressure much faster than ordinary dialogue.
They also reduce cache reuse because each result changes the prefix seen by the
next tool iteration. The 300,000-character account-free local cap is technically
bounded, but it is not context-safe and can still dominate a model request.

## Comparison with current primary guidance

The open-source comparison below is pinned for reproducibility to Codex commit
[`18f50c9e`](https://github.com/openai/codex/tree/18f50c9e628af083a52d9240de09fc2db24d79ce)
and OpenCode V2 commit
[`7534d235`](https://github.com/anomalyco/opencode/tree/7534d23551f665e65080809975b4ca5c7d63807b),
both reviewed 2026-07-26.

| Concern | Codex | OpenCode V2 |
| --- | --- | --- |
| Durable source | Canonical rollout JSONL plus SQLite query metadata | Ordered session/message records in SQLite |
| Automatic trigger | Context threshold, normally capped at 90%; checked before and during turns and on context-window downshift | Preflight of the final assembled request against context minus the larger of output budget or safety buffer |
| Model projection | Replacement checkpoint plus reconstructed tail; local and remote compaction retain different material | Structured checkpoint plus bounded newest serialized context |
| Stable state | Turn/world-state baseline, provider continuation, session cache key | Separate instruction epoch and session-derived cache key |

The shared lesson is that the raw durable transcript and the lossy model
projection are different objects. Beaver should combine OpenCode's final-request
preflight with Codex's richer persisted checkpoint and world-state discipline.

### OpenAI Responses API

OpenAI now documents two supported compaction paths:

- server-side automatic compaction through `context_management` and a
  `compact_threshold`; and
- the standalone `/responses/compact` endpoint, which returns a canonical
  compacted context window.

The compacted item is opaque and is meant to be carried forward. In stateless
mode, the application appends response output items and can discard content
before the latest compaction item. When chaining with `previous_response_id`,
the application should send only new input rather than manually reconstructing
or pruning the chain. `store=false` is supported for stateless/ZDR-oriented
flows. See the official [OpenAI compaction
guide](https://developers.openai.com/api/docs/guides/compaction).

Beaver uses `previous_response_id` correctly inside a single tool loop, including
resending instructions because response instructions do not automatically
become durable application state. It does not use response continuation or
compaction across user turns, nor does it request automatic compaction.

OpenAI prompt caching is exact-prefix reuse, not conversation memory. Static
instructions and examples should precede dynamic content, and images and tool
definitions must match for the relevant prefix to hit. OpenAI also exposes
`prompt_cache_key`; current GPT-5.6 guidance says to use it for reliable cache
matching and to avoid concentrating excessive traffic on one key. See the
official [prompt caching
guide](https://developers.openai.com/api/docs/guides/prompt-caching).

Beaver does not set `prompt_cache_key` and records no cached/cache-write token
telemetry. Its stable core prompt comes before the document inventory, which is
directionally good, but changing document inventories, research tool sets, and
MCP schemas shorten the reusable prefix.

### Codex

Current Codex treats a thread as the durable multi-turn unit. Its thread store
keeps canonical rollout JSONL plus SQLite metadata
([thread-store
README](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/thread-store/README.md#L3-L30)).
The persistence policy includes messages, reasoning, tool calls/results,
compaction events, turn context, and world state
([policy](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/rollout/src/policy.rs#L85-L181)).
Compaction records a replacement checkpoint, and resume reconstructs from the
newest surviving replacement plus its tail
([checkpoint](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/core/src/session/mod.rs#L3167-L3207),
[reconstruction](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/core/src/session/rollout_reconstruction.rs#L113-L187)).

Codex normally resolves automatic compaction at 90% of the context window,
checks before and during a turn, and can compact when switching to a
smaller-context model
([threshold](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/protocol/src/openai_models.rs#L409-L470),
[turn checks](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/core/src/session/turn.rs#L845-L1004)).
Its current pre-turn check does not yet estimate the pending user/context
payload
([source TODO](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/core/src/session/turn.rs#L151-L171)).

The local and remote compaction paths are materially different. Local
compaction builds a structured checkpoint and retains recent user messages up
to roughly 20k tokens
([local](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/core/src/compact.rs#L240-L390)).
Remote V2 can retain up to 64k tokens of recent user, developer, and system
messages while preserving media outside that text budget
([remote
V2](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/core/src/compact_remote_v2.rs#L439-L571)).
Codex also uses a session-scoped prompt-cache key and supports incremental
provider requests against prior response state
([client](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/core/src/client.rs#L475-L487)).

Beaver's `--ephemeral` invocation bypasses these cross-turn benefits. Codex may
compact during one unusually long Beaver turn, but Beaver closes the bridge and
throws the thread away immediately afterward. The next turn starts over with a
new flattened transcript.

### OpenCode V2

OpenCode V2 is useful as a second implementation, not as an API contract; V2 is
explicitly beta ([documentation](https://opencode.ai/v2/docs)). It retains raw
ordered messages in SQLite
([schema](https://github.com/anomalyco/opencode/blob/7534d23551f665e65080809975b4ca5c7d63807b/packages/core/src/session/sql.ts#L119-L175))
and builds active model history from the latest compaction checkpoint plus
later messages
([history](https://github.com/anomalyco/opencode/blob/7534d23551f665e65080809975b4ca5c7d63807b/packages/core/src/session/history.ts#L13-L52)).

Unlike the older V1 pruning description, current V2 preflights the final
assembled system/messages/tools request. It compacts when estimated input
exceeds the context limit minus the larger of requested output tokens or a
safety buffer, and it permits one compaction/retry after provider overflow
([official compaction
guide](https://opencode.ai/v2/docs/compaction),
[implementation](https://github.com/anomalyco/opencode/blob/7534d23551f665e65080809975b4ca5c7d63807b/packages/core/src/session/compaction.ts#L74-L168),
[overflow
recovery](https://github.com/anomalyco/opencode/blob/7534d23551f665e65080809975b4ca5c7d63807b/packages/core/src/session/runner/llm.ts#L231-L289)).
Current defaults are a 4096-token summary, roughly 8k tokens of newest
serialized context, a 20k reserve, and 2k-character serialized tool outputs.
The accepted `prune` setting currently has no runtime effect
([configuration
source](https://github.com/anomalyco/opencode/blob/7534d23551f665e65080809975b4ca5c7d63807b/packages/core/src/session/compaction.ts#L12-L46)).
Compaction is presented as historical context while canonical instructions use
a separate epoch
([instruction
epoch](https://github.com/anomalyco/opencode/blob/7534d23551f665e65080809975b4ca5c7d63807b/packages/core/src/session/context-epoch.ts#L91-L174)).

The important lesson remains separation of concerns: dereferencing bulky tool
output, retaining recent conversational texture, preserving current
instructions, and storing exact application state are different jobs. One
prose summary cannot safely do all four.

## Recommended architecture

Keep the raw transcript immutable. Build each model request from five explicit
layers:

```text
versioned static instructions + selected stable tool groups
                         |
authoritative state capsule (IDs, versions, locators, decisions)
                         |
provider checkpoint or Beaver narrative summary
                         |
bounded recent-turn tail
                         |
current user input + only the needed excerpts/tools
```

The context assembler may omit old prose from the model request, but it must
never delete the underlying messages or regenerate exact state from a prose
summary.

### Authoritative state capsule

Store these as structured values:

- user decisions and constraints, including which later decision supersedes an
  earlier one;
- document IDs, current version IDs, content hashes, filenames, and version
  lineage;
- generated artifact IDs and accepted/rejected edit state;
- provider/source IDs, canonical citations, quote hashes/text, paragraph,
  section, page, and subparagraph locators, and the deterministic URL/text
  fragment generated for each citation;
- selected workflow/version, current workflow phase, supplied inputs, and
  pending inputs;
- unresolved user questions and blocked actions; and
- the transcript high-water mark from which the capsule was derived.

These fields are not prose-summary material. They should be updated by
deterministic tool/domain events and validated against the authoritative
document, citation, and workflow tables.

Conversational rationale, exploratory branches, repeated status updates, and
large tool payloads may be summarized or dropped from the model projection.
Retain IDs/hashes needed to re-fetch any payload.

### Minimal persistence shape

Do not create a second chat system. Add one provider-neutral context record per
existing chat, backed by the same small repository contract in both modes:

- `loadMessages(chatId)`
- `appendMessage(chatId, message)`
- `loadContextState(chatId)`
- `compareAndSwapContextState(chatId, expectedVersion, nextState)`

For cloud mode, implement it over the existing Supabase chat tables plus one
versioned context-state row. For account-free local mode, implement the same
contract beside the existing versioned atomic-JSON chat records under shared
AppData. The process-local `Map` remains only a read-through cache. A database
is unnecessary at current single-user scale; the repository boundary can
change storage later without changing compaction semantics.

The context-state record needs:

- schema and row versions;
- prompt-contract version and tool-set hash;
- transcript high-water mark;
- authoritative state capsule;
- recent-tail boundary;
- optional narrative summary;
- optional provider continuation data (`previous_response_id`, Codex thread ID,
  or opaque compacted items);
- provider/model/auth identity to prevent cross-session reuse; and
- a checksum and timestamps.

Provider continuation data is an optimization, not the only copy of state. If
it is missing, expired, corrupt, or incompatible, Beaver must rebuild from the raw
transcript plus authoritative capsule.

The next strict API boundary should be current-turn-only submission. The
frontend should send the chat ID, current user message, attachments, and
expected transcript/context version; the backend should load canonical prior
messages and context state itself. A monotonic high-water mark or
compare-and-swap version must prevent duplicate append/replay. This reduces
wire and serialization cost immediately; model-token savings require the
projection and compaction work described below.

The current anonymous store is only schema version 1 and contains `chat`, not a
context checkpoint. Evolve that existing record or place a versioned context
record beside it rather than creating another chat store.

### Session compaction is not cross-session memory

Session compaction preserves enough state to continue one chat. Cross-session
memory selectively recalls information into other chats. Codex implements
Memories as a separate, optional two-phase pipeline that derives structured
rollout memories and later consolidates them
([architecture](https://github.com/openai/codex/blob/18f50c9e628af083a52d9240de09fc2db24d79ce/codex-rs/memories/README.md#L29-L137)).
No built-in equivalent was found in the OpenCode V2 core and documentation
reviewed.

For Beaver, cross-session recall may include user preferences and reusable
workflow habits. Client facts, matter facts, quotations, legal conclusions,
and document state should remain matter-scoped by default, with provenance,
expiry, and deletion controls. They must not leak through a global narrative
memory.

### Provider strategy

**Direct OpenAI**

1. Instrument current full replay first.
2. For environments that permit server-stored response state, persist the
   latest response ID per chat/provider/model and continue with only new input.
3. For local-first or `store=false` use, persist the stateless response items
   locally and enable automatic compaction or call `/responses/compact`.
4. Preserve the returned compacted window as canonical provider context; do not
   edit its opaque compaction item.
5. Use a stable per-chat/provider/auth-session `prompt_cache_key`, guarded by
   model, prompt-contract, and tool-contract compatibility. Do not use one
   cross-chat contract key that groups unrelated legal matters. Keep stable
   instructions/tools first and dynamic matter content later, and record cache
   reads and writes.

**Codex**

1. Remove `--ephemeral` for chat turns.
2. Parse `thread.started`, persist its thread ID against the Beaver chat, and call
   `codex exec resume <thread-id> <new-turn>` on later turns.
3. Keep model, reasoning effort, Codex auth identity, and Beaver prompt/tool
   contract in the session compatibility key.
4. Send the current user turn and deterministic state delta, not another
   flattened copy of the entire transcript.
5. Start a new Codex thread when the compatibility key changes, while keeping
   the Beaver transcript/state intact.
6. Continue to use the bounded Beaver MCP bridge for tool execution. Recreate the
   bridge endpoint per invocation if necessary; the Codex thread ID and bridge
   process lifetime are separate concerns.

This bridge is implementable with current Codex CLI behavior. It needs an
equivalence and crash-recovery test before replacing the current path.

**Claude/Gemini/other providers**

Use the same authoritative capsule and recent-tail projection. If a provider
has a tested native cache/session API, store that as optional provider state.
Otherwise use the Beaver summary/checkpoint fallback. Do not let provider-specific
state become required for chat recovery.

### Tool exposure

Avoid a brittle intent classifier that can hide a necessary legal tool. Use
stable capability groups plus a small discovery escape hatch:

- document lookup;
- document creation/editing;
- workflow;
- Canadian legal research;
- US/UK legal research;
- journal/public article retrieval; and
- external connectors.

Select groups deterministically from the active UI surface, attachments,
project/workflow state, and explicit user configuration. When uncertain, expose
one small `discover_tool_groups` or connector-search tool rather than every
schema. Keep the selected group order and JSON schema stable and include its
hash in prompt/session telemetry.

For MCP, the lowest-bloat target is a stable broker surface such as
`search_connector_tools` plus `call_connector_tool`, while continuing to enforce
the existing confirmation and untrusted-output rules server-side. This must be
security-tested before replacing direct schemas. A simpler first step is to
expose only connectors explicitly pinned for the chat.

### Retrieval output contract

Every potentially large tool should return a bounded envelope:

- content or excerpts;
- authoritative document/source ID and version/hash;
- page/paragraph/section range;
- deterministic citation/link;
- `truncated` flag;
- total size/count when known; and
- cursor or a suggested targeted follow-up call.

Add an item limit and aggregate output budget to `fetch_documents`. For large
documents, prefer deterministic range/locator lookup to silent truncation. Do
not choose a universal character limit until the baseline records actual
document sizes and model context windows.

## Implementation sequence

### 0. Instrument before changing semantics

Record counts and hashes, not raw private content:

- system, tool-schema, message, attachment, and tool-result characters;
- provider-reported input, cached input, cache-write, output, and reasoning
  tokens where available;
- selected tool groups and tool-contract hash;
- response/thread ID presence and whether it was resumed;
- compaction/checkpoint events and pre/post sizes;
- time to first token, full latency, tool latency, and retry count; and
- exact model and reasoning effort.

This is a strict win and makes every later optimization falsifiable.

### 1. Bound the largest outputs

Add explicit envelopes, pagination/ranges, and aggregate limits to cloud
`read_document`/`fetch_documents`. Keep the current full-read behavior available
behind a deliberate request until equivalence fixtures pass.

### 2. Consolidate prompts under tests

Move the read/version safety rule to one canonical system location and shorten
tool descriptions to action-specific details. Move changing inventories after
the stable prefix. Do not remove safety language merely to improve a token
count.

### 3. Make local sessions durable

Completed 2026-07-26. Anonymous chats now use versioned, validated, atomically
replaced JSON records under shared AppData; the `Map` is only a cache.
Supabase/cloud behavior is unchanged. Restart, corruption, ownership, linkage,
and delete isolation have regression tests.

### 4. Make the backend authoritative, then add the state capsule

Change the browser/backend contract to current-turn-only submission. On every
turn, the backend must load the canonical transcript and context state, append
with a version/high-water guard, and assemble the provider request. Add a
restart test in which the browser omits all prior turns and the resumed answer
receives the same relevant state.

Then populate exact state from existing citation, document-version, edit,
workflow, and tool events. Add a narrative summary and bounded recent tail for
providers without native compaction.

### 5. Enable native provider continuation

Implement OpenAI continuation/compaction and Codex thread resume independently,
behind per-provider feature flags. Never share a continuation ID across chats,
users/auth identities, models, or incompatible prompt/tool contracts.

### 6. Defer tools and connectors

Introduce stable capability groups and the discovery fallback only after tool
selection telemetry and regression fixtures exist.

## Equivalence and efficiency test plan

### Fixtures

Create deterministic 40-80 turn sessions covering:

- cloud and account-free local modes;
- backend restart and browser refresh;
- model/effort change and provider change;
- uploaded PDF/DOCX/XLSX documents with multiple versions;
- accepted and rejected edits;
- A2AJ, CourtListener, legislation, and public journal retrieval;
- paragraph/section/page/subparagraph pinpoints and multi-fragment links;
- a long workflow with supplied and still-pending inputs;
- late user corrections that supersede earlier instructions;
- repeated questions that must reuse durable state without stale text; and
- large tool results, images, failed calls, retries, and a connector result
  containing adversarial instructions.

Use real repository benchmark documents where licensing permits, but store
expected IDs, hashes, quotes, and locators as fixture data so the assertions do
not depend on a judge model.

### Variants

For the same provider/model/effort, compare:

1. current full-history replay;
2. Beaver authoritative capsule + summary + recent tail;
3. direct OpenAI native compaction/continuation; and
4. Codex resumed thread with native compaction.

Force compaction at controlled low thresholds in tests so every run exercises
the boundary. Repeat normal benchmarks at production thresholds.

### Hard assertions

These must be 100% equal or valid:

- user constraints and supersession order;
- current document/version/hash and artifact lineage;
- accepted/rejected edit state;
- spreadsheet sheet/range/formula references;
- workflow version, phase, inputs, and pending questions;
- legal provider/source IDs, quote text/hash, locator hierarchy, and generated
  URL/text fragments;
- chat/user isolation; and
- recovery from an invalid or missing provider checkpoint using raw history and
  authoritative state.

Also assert that no compacted session resurrects an obsolete decision, cites a
stale document version, or silently treats truncated output as complete.

### Quality and efficiency measures

Measure:

- blind task correctness against the current full-replay baseline;
- citation/quote/locator precision;
- input, cached, cache-write, output, and reasoning tokens;
- system/tool/history/tool-result share of input;
- time to first token and end-to-end p50/p95 latency;
- provider cost;
- compaction frequency and checkpoint size; and
- tool-selection recall, unnecessary tool exposure, and repeated reads.

Ship only when exact-state assertions pass, blind quality shows no material
regression, and token/latency reductions are repeatable across multiple runs.
Do not approve a compaction strategy merely because a summary “looks right.”

## Strict wins versus risky shortcuts

Strict wins:

- usage/latency/context instrumentation;
- durable account-free local chat storage (completed);
- explicit bounded result envelopes with visible truncation/cursors;
- persisting Codex thread IDs and OpenAI continuation/checkpoint metadata behind
  compatibility guards;
- moving exact state out of prose; and
- consolidating duplicated instructions after an equivalence test.

Not strict wins:

- deleting the per-turn document-read safety rule before targeted retrieval and
  version receipts exist;
- summarizing citations, document versions, or workflow state into prose;
- hiding tools solely through a guessed intent label;
- silently truncating tool output;
- relying on a provider thread as the only durable copy of a legal session; or
- confusing prompt-cache hits with remembered application state.
