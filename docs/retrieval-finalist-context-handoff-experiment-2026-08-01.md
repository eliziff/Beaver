# Retrieval finalist: exact evidence handoff

Status: implemented and locally verified; live comparisons pending. This is a
candidate, not a production winner.

## Hypothesis

Coding-native navigation is a strong default because models already understand
`Glob`, `Grep`, and `Read`. Legal structure should add value when it narrows an
otherwise expensive read to an exact provision, table row, page, or direct
reference neighbourhood. It should not require the model to maintain a second
abstract “evidence object” workflow.

The high-value intervention is therefore a host-owned context boundary:

1. Research with familiar tools, optionally using Beaver's exact legal scopes.
2. Record the exact union of source spans exposed during the turn. Search
   excerpts remain separately tracked so they never suppress a later read;
   at handoff, exact unread excerpts survive and stronger read spans replace
   overlapping excerpts.
3. After an evidence-bearing research tool batch, continue in a fresh provider
   invocation containing the original request, a compact index of the durable
   exact-evidence union, and only that latest batch's results. Do not replay
   prior reasoning or older raw tool payloads. This is one model workflow with
   host-owned context replacement, not multi-agent orchestration.
4. When the model opens `drafting` or `output_document`, start a fresh provider
   invocation containing the original request and the exact, deduplicated
   evidence union. Do not replay the prior tool transcript.
5. If that union exceeds the configured cap, return a compact manifest and
   require an explicit alias selection. Never silently truncate source text.
6. Keep provider-native compaction as an optional direct-OpenAI transport
   backstop. Exact source spans, hashes, versions, and receipts remain Beaver
   state.

This follows the repository's existing research synthesis: long contexts can
degrade even while fitting nominal limits; exact-prefix caching reduces cost
but is not memory correctness; and provider compaction is opaque state, not a
legal record. See [context-compaction-research-synthesis.md](context-compaction-research-synthesis.md)
and [harvey-tool-context-audit-2026-08-01.md](harvey-tool-context-audit-2026-08-01.md).

## Correctness changes in this candidate

- Tool results carry typed host statuses. Honest `not_found`, `ambiguous`, and
  `past_end` outcomes are measured separately from implementation failures.
- Local reads are keyed by exact document version and source range. Grep
  candidates have a separate union, so a preview never suppresses the later
  evidentiary read.
- A2AJ, citator, CourtListener, public-source, and PDF passages can enter the
  same exact handoff through durable handles and exact hashes.
- A2AJ/citator receipt IDs are deterministic. Normalized passage hashes remain
  for compatibility; exact-byte hashes decide identity.
- Registering a receipt no longer silently enables the experimental structured
  answer rewriter. That workflow remains available only when explicitly
  selected.
- `submit_grounded_answer` and exact-PDF rehydration are no longer resident
  tools. Mechanical text operations and document-link inspection are deferred
  to their domains.
- PDF lookup output omits internal unit IDs, confidence explanations,
  provenance boilerplate, and empty context arrays. It retains the exact text,
  legal locator, pages, actionable low confidence, and durable handle.
- Deterministic draft checks remain automatic and revision-gated. A correction
  pass reuses the unchanged exact-evidence prefix in a fresh context, allowing
  provider prefix caching without replaying research.

The former `working_set` implementation remains behind its existing experiment
flag for ablation. It is not part of either finalist.

## Frozen comparison arms

All arms use the same task, model, effort, service tier, order policy, visible
documents, evaluator, and run isolation.

| Arm | Surface |
| --- | --- |
| A: `upstream` | Pinned Will Chen upstream Mike surface only: list, fetch, whole-document read, find, and generate. No Beaver disclosure, scopes, compiler, handoff, or compaction flags may leak in. |
| B: `coding_finalist` | Pure coding retrieval (`Glob`, `Grep`, line-window `Read`) plus progressive disclosure and the exact context controller. |
| C: `hybrid_finalist` | Arm B plus the already-implemented legal section/page/table/reference scopes and the selectively actionable deterministic SLA audit. No working-set-first instruction. |

Luna-high `/fast` runs are cheap, separately labelled behavioral screens. The
formal harness comparison holds Claude Code/Sonnet constant as required by the
LAB protocol. Codex/Luna results cannot be pooled with Claude product runs.

## Measurements and decision rule

Primary: existing Harvey LAB deliverable score and criterion-level failures.

Secondary:

- provider-reported input, cached input, output, wall time, and time to first
  useful tool call;
- tool calls and context rounds;
- tool schema, argument, and result bytes;
- exact unique and suppressed source characters;
- candidate-to-evidence conversion, duplicate exposure, and read ratio;
- `not_found`, `ambiguous`, `past_end`, and true tool errors separately;
- whether a handoff occurred, its evidence count/size, and any selection loop;
- research-context refresh count, durable-union size, and latest-result size;
- deterministic findings that triggered a revision, were ignored, or were
  false positives.

Do not choose C merely because it reads less. C must match or beat B and A on
deliverable quality, then win materially on context or latency on the same
tasks. Report paired task deltas and within-arm replicate noise. A pocket win
on large or structure-sensitive tasks is useful even if C is not the universal
default; route by task/document properties only after that interaction repeats
on held-out families.

The initial set must include at least one multi-document extraction task, one
cross-document comparison, one markup/redline analysis, and one long drafting
task. LegalBench-RAG remains a separate pinpoint bed, with document names
stripped wherever identity would leak the answer.

## Verification gates before promotion

- Full backend tests and build pass.
- Strict upstream surface hash/isolation gate passes for every A run.
- Repeated reads return `already_exposed`; a Grep preview does not suppress its
  later Read; exact handoff rehydrates the requested historical version.
- Repeated research checkpoints contain one fresh message and omit older full
  source payloads and reasoning transcripts while retaining their compact
  durable-evidence index entries.
- `content_reset` is honored by both UI and harness, so discarded research or
  first drafts cannot enter the scored deliverable.
- Direct OpenAI requests emit the documented
  `context_management:[{type:"compaction",compact_threshold:N}]` shape only
  when configured; Codex subscription requests never receive it.
- No credentials, traces, corpora, downloaded files, or live result artifacts
  are committed.
