# Address-backed legal compaction: Qwen toy experiment

Status: isolated toy experiment, 2026-08-01.

This directory is deliberately separate from the in-flight Beaver prompting
and tool-surface work. It freezes the benchmark-only upstream Mike contract as
the prompt/tool baseline and does not import or modify the live backend chat
path.

## Question

Can a local Qwen model with a 32,768-token context complete a multi-turn legal
research task when three case packets fit separately but their combined history
does not fit, if exact quotations are moved out of the prompt and retained as
stable evidence addresses, then submitted through a deterministic quote gate?

The first task uses the relationship between:

- *Bhasin v. Hrynew*, 2014 SCC 71; and
- *Wastech Services Ltd. v. Greater Vancouver Sewerage and Drainage District*,
  2021 SCC 7; and
- *C.M. Callow Inc. v. Zollinger*, 2020 SCC 45.

The pair is useful because *Wastech* expressly applies and develops the
good-faith framework from *Bhasin*. Callow adds the misleading-conduct and
termination-right application. Callow is loaded through the local A2AJ
full-text provider and its document identity, URL, and text hash enter the
receipt.

## Why the address idea is supported

The idea is not a replacement for evidence. It is a small, typed pointer to
evidence that can be deterministically brought back into the context window.
That combines established patterns:

1. **Virtual/external memory.** MemGPT describes moving information between a
   fast model context and slower external memory, making a bounded context act
   like a larger memory system.
2. **Decoupled observations.** CORVUS separates an agent's record of a read from
   repeatedly carrying the same observation forward, then injects current
   contents when relevant.
3. **Fine-grained legal retrieval.** LegalBench-RAG prefers minimal relevant
   snippets and represents evidence with exact source spans rather than only a
   document identifier.
4. **Attribution and reference audit.** Legal RAG work increasingly checks that
   generated references exist, resolve to authoritative fragments, and match
   the cited text.

The literature supports these components separately. I did not find a
demonstration that combines session compaction, immutable legal evidence
handles, versioned document edits, qualifier closure, and fail-closed quote
validation. That combined legal contract remains an empirical hypothesis.

## Stability assumptions for this experiment

The address semantics are deliberately simpler than a general web-memory
system:

- A case artifact is immutable once loaded.
- Legislation is frozen for the lifetime of a session.
- A DOCX remains stable unless the agent edits it.
- An agent DOCX edit creates a new durable version. Old handles remain valid
  only against the old version; they must not silently resolve to changed text.

Therefore a handle does not need a freshness check on every lookup. A hash is
still useful for integrity, debugging, and run receipts. The important
identity fields are source, stable snapshot/version, locator, and exact span.

A legal evidence handle is conceptually:

```text
case-bhasin@session-snapshot#paragraph-63
```

The compact context keeps the handle and short metadata, not the quotation.
The external registry owns the exact text. Before a source-sensitive answer,
the experiment can rehydrate the handle and place the exact paragraph back in
the prompt.

The legal-specific addition is **context closure**. A useful handle may need
the parent paragraph, a limiting qualifier, an exception, a defined term, or a
cross-reference. This toy uses manually chosen paragraph handles so the first
test does not confuse handle discovery with compaction quality.

## Frozen Mike baseline

The baseline is copied from the benchmark-only snapshot in
`backend/src/lib/chat/upstreamMikeBenchmarkSurface.ts`:

- upstream source commit: `e89d3230db40193c540a6b38d8f301ae76377a1a`;
- recorded upstream tool-schema hash:
  `78f2e1dfaa7f2c5a62dcc52531804373e998ee002fe783e7767a10113e7a87fc`;
- retrieval tools, in order: `read_document`, `find_in_document`,
  `list_documents`, `fetch_documents`;
- project tool: `generate_docx`; and
- Mike's retrieval rules: discover documents, read a relevant document once per
  response, batch independent reads, and use targeted lookup after a full read.

The frozen Python copy is `mike_baseline.py`. The experiment's compaction
layer changes the message history only; it does not alter the baseline tool
schemas.

The final comparison additionally exposes an isolated copy of Beaver's
grounded-answer submission shape: claims carry `text`, `evidence_ids`, and a
typed `kind`. The host verifies quotation claims as normalized contiguous
substrings of the cited evidence handle and rejects altered quotes with a
repair excerpt. This is deterministic host validation, not model self-report.

## Task sequence

The model receives four user turns:

1. Read and summarize *Bhasin*. Identify key quotations with SCC paragraph
   numbers. Do not analyze *Wastech* yet.
2. Read and summarize *Wastech*. Identify key quotations with SCC paragraph
   numbers. Do not compare the cases yet.
3. Read and summarize *Callow*. Identify key quotations with SCC paragraph
   numbers. Do not compare the cases yet.
4. Compare all three cases. The final answer must be submitted through the
   grounded-answer tool, which vets every quotation against its evidence
   handle.

Each case turn asks for three key quotations and caps targeted lookups at three
per case. This keeps Mike's ten-round retrieval budget meaningful; the first
live Qwen attempt otherwise spent all ten rounds making one lookup per
candidate phrase before answering.

The task asks for an inline answer rather than a DOCX artifact so the final
answer is easy to inspect. The baseline `generate_docx` tool remains present
and is recorded if the model calls it.

The runner builds bounded English paragraph packets from the local bilingual
extractions. It keeps paragraph boundaries and source metadata, rather than
cutting through a quote. The default packet cap is 72,000 characters per case;
the self-test verifies that each packet's transparent token estimate fits the
configured context reserve while the two packets plus the conversation
reserve exceed it. The packets are test inputs, not complete opinions; the
run receipt records the exact source and packet hashes.

## Arms

| Arm | After the first two turns | Final turn |
|---|---|---|
| `full_history` | Keep all prior messages and tool results | Send the combined history; expected to approach or exceed 32k |
| `address_only` | Keep compact summaries and evidence handles | Do not page exact text back in; negative control |
| `address_rehydrate` | Keep compact summaries and evidence handles | Deterministically page in curated exact paragraphs for all three cases |

`address_rehydrate` is intentionally conservative: it tests whether stable
addresses can preserve exact source grounding after aggressive compaction. The
compaction layer suppresses redundant full-packet reads; the final structured
submission must cite the rehydrated handles and pass deterministic quote
verification. It does not yet test a model discovering handles from an empty
registry or infer closure automatically.

The primary hypothesis is:

> `address_rehydrate` should complete the comparison with materially less
> final input than `full_history`, while retaining real quotations and
> paragraph pinpoints. `address_only` should expose whether a pointer without
> deterministic page-in is unsafe.

## Run

Offline structural check:

```powershell
python experiments/legal_compaction_qwen/harness.py self-test
python experiments/legal_compaction_qwen/harness.py inspect
```

Live run against the configured Ollama endpoint:

```powershell
python experiments/legal_compaction_qwen/harness.py run `
  --model qwen3.5:9b `
  --arm address_rehydrate `
  --num-ctx 32768
```

Run the controls in fresh, independent processes:

```powershell
python experiments/legal_compaction_qwen/harness.py run --model qwen3.5:9b --arm full_history
python experiments/legal_compaction_qwen/harness.py run --model qwen3.5:9b --arm address_only
```

Set `OLLAMA_BASE_URL` if Ollama is on the desktop PC, and set
`OLLAMA_HOST_HEADER=localhost:11434` for the existing reverse-proxy route, or
pass `--base-url` and `--host-header`.
Set `OLLAMA_NUM_CTX=32768` only as a convenience; `--num-ctx` is recorded in
the run receipt. Use the strongest locally available Qwen model explicitly;
the runner does not change the provider catalog.

Each run writes an ignored JSON receipt under `runs/` containing source hashes,
packet sizes, compacted messages, tool calls, provider usage, final text, and
overflow status. The raw model answer is the material for human inspection.

The second fixture is recorded in [`four_case_fixture.json`](four_case_fixture.json)
and is regenerated by `prepare_four_case_fixture.py`. It uses four 2026 SCC
decisions from the local A2AJ corpus. Each bounded packet is below the 32K
context budget, while the four packets together are 234,690 characters and
therefore materially exceed it. The fixture records source and packet hashes,
stable local IDs, and official SCC URLs; it does not copy the corpus into the
experiment directory.

## What to inspect

The human review should check:

- whether every quotation is verbatim in the source packet or rehydrated
  paragraph;
- whether each quote has the right SCC paragraph number;
- whether the final comparison states the relationship accurately;
- whether a qualifier, exception, or majority/dissent distinction was lost;
- whether `address_only` guesses text that it was never shown; and
- whether `address_rehydrate` actually stays within the model context while
  preserving exact evidence; and
- whether the grounded-answer submission passes only verbatim quotations with
  valid handles.

Token counts are diagnostic, not a correctness score. The deterministic quote
gate is a grounding check, not a contextual legal-quality judgment; legal
grading remains human review.

## Sources

Online literature and implementation precedents:

- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)
- [CORVUS: Context Management for Coding Agents](https://arxiv.org/abs/2607.22711)
- [LegalBench-RAG](https://arxiv.org/abs/2408.10343) and its
  [span-addressed repository](https://github.com/zeroentropy-ai/legalbenchrag)
- [Grounded in Law: A Multi-Stage Anti-Hallucination Pipeline for Legal RAG Systems](https://aclanthology.org/2026.propor-2.9/)
- [Pi compaction documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [Pi compaction implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts)

Local research and source records:

- [`docs/context-compaction-research-synthesis.md`](../../docs/context-compaction-research-synthesis.md)
- [`docs/context-compaction-research-track-a.md`](../../docs/context-compaction-research-track-a.md)
- [`docs/context-compaction-research-track-b.md`](../../docs/context-compaction-research-track-b.md)
- [`benchmarks/legal-generalization-corpus/README.md`](../../benchmarks/legal-generalization-corpus/README.md)
- [`benchmarks/legal-generalization-corpus/manifest.jsonl`](../../benchmarks/legal-generalization-corpus/manifest.jsonl)
- [Bhasin source text](../../benchmarks/legal-generalization-corpus/text/ca-case-2014-scc-bhasin-v-hrynew.txt)
- [Wastech source text](../../benchmarks/legal-generalization-corpus/text/ca-case-2021-scc-wastech-services.txt)

The local corpus manifest records the official Supreme Court source URLs,
retrieval hashes, and its stated court-record reproduction basis. The text is
an unofficial local extraction; authoritative verification remains with the
Supreme Court source.
