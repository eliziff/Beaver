# Context compaction Track A experiment

This is an isolated, dependency-free ablation fixture for one narrow question:

> Does an active, exact legal-state projection plus a lossy task summary and a
> bounded recent tail give a model the required facts with less stale context
> than the full transcript?

The fixture is synthetic and contains no external benchmark data or copied
implementation code. It uses only the Python standard library.

## What it tests

The fixture includes:

- superseded storage, account, and document-version state;
- an exact quotation receipt with source ID, locator, hash, and URL;
- long disposable tool logs;
- an assistant-authored option list followed by the user saying “the second
  option”; and
- exact-match questions about current state, provenance, and recent deixis.

It builds six contexts:

1. complete raw history;
2. lossy summary plus a recent full tail;
3. every ledger version plus summary and tail;
4. active ledger projection plus summary and tail;
5. active ledger plus a user-role-only tail; and
6. active ledger plus an event-aware tail that retains user instructions,
   decision surfaces, and bounded tool receipts.

The offline report measures only deterministic prerequisites:

- whether every required literal is available;
- whether superseded literals remain exposed; and
- a transparent UTF-8-bytes/4 size estimate.

Those measurements do **not** establish model performance. In particular,
“stale-token exposure” is an ambiguity-risk proxy; a model may correctly obey a
supersession marker.

## Run

```powershell
python experiments/context_compaction_track_a/harness.py self-test
python experiments/context_compaction_track_a/harness.py report
python experiments/context_compaction_track_a/harness.py prompts
```

`prompts` emits one JSON object per variant/probe. A provider-neutral live runner
should submit `instruction`, `context`, and `question` without alteration and
write JSONL records shaped like:

```json
{"case_id":"active_ledger_summary_event_tail::storage","answer":"STORAGE=LOCAL_APPDATA"}
```

Score those records with:

```powershell
python experiments/context_compaction_track_a/harness.py score answers.jsonl
```

## Controlled live ablation

For a valid comparison:

- hold model, model snapshot, reasoning effort, maximum output, tool schemas,
  system prompt, and provider continuation mode constant;
- use fresh independent sessions so one variant cannot contaminate another;
- randomize variant order and run at least five repetitions;
- use provider-reported input, cached-input, output, and reasoning tokens rather
  than the offline estimate;
- record task accuracy, stale-state resurrection, unsupported answers,
  quotation/hash/locator fidelity, latency, and cost per successful probe; and
- repeat at increasing history lengths and increasing numbers of superseded
  ledger entries.

The decisive comparison is not merely full history versus three layers. It is:

- full history;
- summary plus tail without an exact ledger;
- an append-only exact ledger plus summary and tail;
- an active, supersession-resolved ledger projection plus summary and full tail;
  and
- the same active projection with an event-aware tail.

The experiment should be considered a failure if the compact variants reduce
tokens but lose any required quotation, citation locator, document version,
constraint update, pending action, or recent referent.

## Why this is native instead of adapting another repository

LongMemEval is useful for long-term conversational memory, and LegalBench-RAG is
useful for span-level legal retrieval. Neither directly represents the joint
failure being isolated here: exact legal provenance, mutable matter state,
supersession, disposable tool traces, and recent conversational deixis in one
online session. Importing either implementation would add dependencies and
confound retrieval quality with context composition before this smaller
hypothesis is established.

If the synthetic ablation passes with live models, the next experiment should
reuse LongMemEval’s knowledge-update and assistant-side-information splits and
wrap LegalBench-RAG or CanLegalRAGBench evidence inside otherwise identical
multi-turn sessions.
