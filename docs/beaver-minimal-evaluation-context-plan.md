# Beaver: minimal evaluation, context, compaction, and caching plan

Status: adopted 2026-07-27 with the scoping decisions below. This is the
measurement-first plan: instrument before building, one variable per
comparison, and no benchmark for machinery Beaver does not have. A longer
companion brief exists outside the repo; its four-arm benchmark portfolio,
hidden holdouts, and Beaver-CAN-12 task suite are **rejected** as
infrastructure-in-the-dark. Only this document is authoritative.

## Scoping decisions against the existing codebase

The plan below was written repo-blind. Beaver already owns several of the
pieces it asks for, so the steps are re-scoped:

| Plan step | Decision | Why |
| --- | --- | --- |
| Step 1 — common eval trace | **Adopt first.** Extend `backend/src/lib/llm/contextManifest.ts`, which already records per-component sizes, token estimates, latency, and provider/model per call. Add suite/item identity, config hash, commit sha, provider cached-token counts, score, and output path; wrap the existing harnesses (`backend/scripts/prompt-live-harness.ts`, `benchmarks/docx_corpus`) in one thin runner that emits `eval_run.json` per item plus `comparison.md`. | The 2026-07-27 prompt-diet work already ran old-vs-new arms and a cache-token check by hand; the runner makes that the default shape of every future change. |
| Step 2.1 — LegalBench-RAG-mini | **Defer indefinitely.** | It measures chunking/embedding/reranking. Beaver has no chunk-embedding RAG pipeline, and the master plan (P1.4) commits to lexical-first with vectors only if earned. A benchmark for machinery that does not exist is dark infrastructure. Revisit only if P1.4 ever earns vectors. |
| Step 2.2 — CanLegalRAGBench | **Adopt second, retrieval stage only.** Score whether `a2aj_search` surfaces the annotated Canadian cases. | This measures a surface Beaver actually ships. The end-to-end answer stage waits for the Step 1 runner. |
| Step 2.3 — LongMemEval | **Adopt when a second context strategy exists**, as the instrument for the master plan's P2.2 factorial. | Comparing context strategies needs two strategies; today there is one. |
| Step 3 — log / matter state / assembler | **Partially exists; extend, do not rebuild.** Append-only transcript and server-authoritative session state are master-plan P0.6; matters live in `legalKnowledgeGraphStore`; evidence handles already carry provenance. The missing piece is the explicit prompt-component manifest per turn (Step 1 covers it). | The plan's "never preserve only in prose" list matches the evidence-handle doctrine already shipped. |
| Step 4 — strategy switch | **Adopt the two-strategy version** (`full_history`, `legal_state_retrieval_tail`) behind a flag, after Step 1. | Matches P0.6/P2.2. The other three strategies wait for measurements. |
| Step 5 — compaction gates | **Adopt as written.** The five mechanical invariants become deterministic integration tests. | Cheap, and exactly the repo's abstention/receipt doctrine. |
| Step 6 — Beaver-owned caches | **Mostly exists** (provider cache P1.2, artifact keying doctrine, parsed-PDF caches). Add trace fields for hits/misses/time-saved instead of new caches. | Measure the caches that exist before building more. |
| Step 7 — provider prompt caching | **OpenAI already measured** (2,304-token stable prefix reuse verified with provider counters, including across the conditional spreadsheet splice — see `backend/scripts/prompt-cache-check.ts`). Add Anthropic/Gemini only when real keys and real usage exist. | One provider proven beats three providers assumed. |
| Step 8 — product trials | **Defer.** | Not until the runner is boring. |

**Order of work: Step 1 runner → CanLegalRAGBench retrieval adapter →
strategy flag + invariants → LongMemEval.** Nothing else until those produce
traces that have influenced at least one engineering decision.

## Rules for every experiment

1. **Change one material variable at a time.** Do not change the model,
   retriever, prompt, chunking, context policy, and cache policy in the same
   comparison.
2. **Use the same model and settings for baseline and candidate.**
3. **Pin everything.** Record the Beaver commit, dataset version, model
   identifier, provider settings, prompt/config hash, and lockfile.
4. **Keep every raw output.** Never retain only aggregate scores.
5. **Separate development from reporting.** Iterate on a small deterministic
   subset; run the full benchmark for release checks; never call a result
   "unseen" if the benchmark was used during development.
6. **A cheaper wrong answer is not an improvement.** Compare cost and latency
   only after quality is acceptable.

## Step 1 — one common evaluation trace

Each benchmark item emits an `eval_run.json`:

```json
{
  "suite": "prompt-live",
  "suite_version": "pinned-commit-or-release",
  "item_id": "item-001",
  "beaver_commit": "full-git-sha",
  "configuration_hash": "sha256",
  "provider": "provider",
  "model": "exact-model-id",
  "context_strategy": "full_history",
  "cache_strategy": "none",
  "retrieved_source_ids": [],
  "input_tokens": 0,
  "output_tokens": 0,
  "cached_input_tokens": 0,
  "cache_write_tokens": 0,
  "latency_ms": 0,
  "estimated_cost": 0.0,
  "score": {},
  "output_path": "ignored/local/path"
}
```

Also retain: ordered retrieved-passage IDs, hashes of prompt components and
source documents, the assembled-context manifest, output/artifact hashes,
and errors/retries. Never log secrets or client contents by default.

**Done when** one command runs a benchmark configuration and produces raw
outputs, per-item traces, aggregate `results.json`, and a human-readable
`comparison.md`.

## Step 2 — CanLegalRAGBench, retrieval stage first

1. **Retrieval only:** did `a2aj_search` retrieve the annotated relevant
   Canadian cases? Report Recall@5/10, nDCG@10, MRR, retrieved tokens, and
   latency.
2. **End-to-end answer** (later, on the Step 1 runner): supported, responsive
   claims from the retrieved material, with failures separated into
   retrieval / grounding / unsupported claim / citation / over-answering.

The benchmark's own authors note automatic scoring can penalize genuinely
relevant authorities missing from the gold set — preserve retrieved cases
for manual review; never silently count out-of-gold cases either way.

## Step 3 — context strategies behind one switch

Two strategies first: `full_history` (current behaviour, default) and
`legal_state_retrieval_tail`. Initial test defaults (not truths):

```yaml
working_context_tokens: 32000
compact_at_ratio: 0.78
recent_tail_tokens: 8000
retrieved_evidence_tokens: 16000
narrative_summary_tokens: 2000
```

`legal_state_retrieval_tail` per turn: append events to the durable log;
propose and validate a matter-state patch (schema-validated, versioned,
linked to the originating turn, reversible, explicit about supersession);
retrieve evidence for the current request; keep a bounded recent tail;
summarize only older narrative; assemble within budget; record what was
included, excluded, or compressed.

Never preserve **only** in a prose summary: citations and authorities, exact
quotations, pinpoints, jurisdiction and law-as-of date, deadlines, active and
superseded instructions, document versions, accepted edits, disputed facts,
privilege flags. (This is the evidence-handle doctrine, restated.)

Provider-native compaction (e.g. OpenAI's opaque compaction item) is a
transport optimization only — always paired with Beaver-owned state.

## Step 4 — compaction ship gate

The five mechanical invariants, as deterministic integration tests:

1. a newer instruction supersedes an older instruction;
2. the current document version wins over a superseded version;
3. an exact citation, quotation, and locator survive;
4. a disputed fact is not treated as established;
5. a jurisdiction and law-as-of date stated early in the matter survive.

Do not adopt a compacted strategy unless it shows: no new failed invariants,
no material LongMemEval reduction, no material legal-benchmark reduction,
≥25% lower input tokens, and no unacceptable latency or review-cost
regression. Run stochastic configurations at least three times for close
calls. Never hide weak categories inside an average.

## Steps 5–6 — caches

Beaver-owned caches are keyed so that a content or implementation change
naturally causes a miss (file hash + parser version, chunk hash + config
version, citation/locator + source hash + validator version, …), are
deletable and inspectable, and record hits/misses/avoided-work in traces.
No Redis or cache service unless local storage measurably fails.

Provider prompt caching: keep the stable prefix stable (tools, system
instructions, stable examples), dynamic matter below the boundary. OpenAI is
measured; re-read provider docs immediately before adding another — caching
rules change. Caching does not shorten context; compaction and caching stay
separate features.

## References

- [LegalBench-RAG](https://github.com/zeroentropy-cc/legalbenchrag)
- [CanLegalRAGBench](https://github.com/NLP-UBC/CanLegalRAGBench)
- [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
