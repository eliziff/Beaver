# Handoff: retrieval layer, tool-surface A/B, editing benchmark

Written 2026-07-31. Branch `docs/legal-skills-ecosystem-comparison`, not pushed.

This describes three connected pieces of work, what is verified, what is not,
and where every artifact lives. Read the "Not verified" and "Known wrong"
lines before trusting any number.

Standing constraints that apply to all of it:

- Pathspec-only git staging. Never `git add -A` — concurrent sessions share
  this working tree.
- Model calls go through flat-rate surfaces only: the codex CLI route
  (`codex:gpt-5.6-*`) or headless `claude -p`. The Anthropic key in
  `backend/.env` is a stub. No per-token API spend.
- Receipts are written to
  `%LOCALAPPDATA%\OpenLegalData\experiments\legal-grounding\2026-07-30\`
  and are never committed.
- Licensing questions are settled by Eli, who is a lawyer. Do not perform
  licensing analysis and do not exclude material on licensing grounds.

---

## Part 1 — Retrieval layer

### The bed and why it is weak

`benchmarks/legalbench_rag/` holds LegalBench-RAG mini: 69 documents, 776
tests over contractnli, cuad, maud, privacy_qa, plus a hold-out split of 55
documents. The adapter is `backend/src/lib/legalbenchRag.ts`.

Four things about it are established and limit what it can prove:

1. A CRLF/LF mismatch silently corrupted every maud number for five stages.
   17 maud corpus files are CRLF; upstream gold coordinates are LF. Any run
   must assert `text[start:end] == answer` on the scorer's own bytes, 100%,
   per source, before the first model call.
2. The queries contain the document name. Stripping it moves document recall
   from 1.00 to 0.71 and pool R@48 from 0.8915 to 0.3680. Retrieval numbers
   from this bed are substantially a query-format artifact.
3. Gold marks *where the answer text is*, not *what must be read to
   understand it*. Following a cross-reference to a definition is scored as a
   precision loss by construction.
4. 0 of 124 corpus files carry `[page N]` markers, so page addressing cannot
   be exercised here at all.

The bed has no case law, no citations and no courts, so the citation-web and
court-hierarchy work cannot be tested on it in principle.

### What was measured

**Stage 20 (`fc820b65`, verdict `f0f675ee`).** The program's founding premise
— "the harness carries grounding decisions, not the model family" — is false.
289 banked compositions re-judged, 1,156 checker calls, no composer call.
Same model judging twice disagrees with itself 6.3% of the time [3.8, 10.3];
a different model family disagrees 35.8% [31.5, 40.4]. Paired difference
+29.5 pp [23.2, 36.0]. Aggregate accept rates match within 3 pp, which is how
an 8-cell table read as family-invariant. Consequence: every per-cell verdict
and false-accept count in Stages 6–13 is single-family evidence.

**Stage 21, navigation A/B.** Harness `backend/scripts/nav-shape-rag.ts`.
Result: no demonstrated quality difference between the tool surfaces in
either direction, on two frozen pairings that disagree with each other; the
early positive did not survive the arm's own revision. One robust behavioural
difference: the address arm reads about 75% less document (3,361 vs 13,134
characters) for statistically identical answers.

Three of the four affordances the arm was built for were never used across
2,941 tool calls: `library_links` 0 calls, `follow` 0 graph walks in 597
searches, page addressing 0. That is partly a property of the bed (see 3 and
4 above), not only of the tools.

**This run was corrupted partway and recovered.** A concurrent session (mine)
edited `backend/src/lib/chat/localAssistantTools.ts` while it was running, so
arm A drifted across four schema revisions. The harness now records a schema
hash on every row and `--expect-hash` aborts on drift. Any future run must
pin both arms and nobody may edit the surface files while it runs.

**C4 / H7 re-analysis (`1d09f681`), zero model calls.** Findings that still
need acting on:

- `attested_trigram_share` is an exact affine complement of
  `unattested_trigram_share` — they sum to 1 on every row. Both have shipped
  as separate lint receipts since Stage 7. One should be deleted.
- `novel_absolutes` is wired backwards: registered as "higher = more
  overreach", measured at AUC 0.445, and removing it *raises* the ensemble by
  +0.012 [+0.007, +0.017].
- Marginal value inverts by source class. `entity_count` helps on case cells
  (+0.017 [+0.007, +0.026]) and hurts on legislation (−0.032 [−0.041,
  −0.024]); `prompt_only_share` does the reverse. Both clear their bands.
- Raw claim length separates the classes about as strongly as corpus
  alienness does (|AUC−0.5| 0.178 vs 0.186, opposite direction). Alienness is
  a ratio over that same trigram count, and no run has ever included a length
  control. Until one does, no alienness number is interpretable.
- H7 was retired on half its own gate. The registered gate was disjunctive
  (checker-call reduction OR decision-quality gain) and only the economic
  half was tested.

### Known wrong, not yet fixed

**The citator join is broken by pinpoint suffixes.** In
`backend/scripts/c4-build-matrix.ts` the citation key is built from
`claim.evidence_ids`, which carry paragraph pinpoints. `rvtak2005bcca293para4`
joins nothing; the same case as `2005bcca293` joins and returns a citer. The
conclusion recorded in that study — that citator witnesses are "unjoinable on
this bed" and every citator ΔAUC is exactly 0.000 — is a defect in our key
normalisation, not a fact about the data. 103 of 4,730 rows do join today, 84
at rich tier. Strip pinpoints via `citationLookupKey`
(`backend/src/lib/caselawCitator.ts`) and re-measure before believing any
citator verdict.

### Local data (query these; do not re-derive or re-download)

- Canadian case law, full text:
  `%LOCALAPPDATA%\OpenLegalProducts\LegalData\providers\a2aj\a2aj-cases-fulltext.sqlite`
  — 225,017 decisions, 224,132 with text (99.6%), 113,461 with at least one
  citing case, FTS index present, 11.7 GB. Built 2026-07-31. The older
  `a2aj.sqlite` beside it is metadata-only and has text for nothing.
- Canadian legislation:
  `%LOCALAPPDATA%\ALR Quote Verifier\a2aj_corpus\laws\` — parquet by
  jurisdiction, 23,531 English statutes, 587 MB of text.
- Citator graph: `%LOCALAPPDATA%\ALR Quote Verifier\citator\noteup.sqlite` —
  224,970 decisions, 2,541,822 citation edges, 540,948 distinct cited
  decisions.
- US case law: CourtListener bulk sqlite under
  `%LOCALAPPDATA%\OpenLegalProducts\LegalData\providers\courtlistener\`,
  55,504 opinions with text.
- There is **no** local US statute corpus. Only the live `govinfo` API
  surface in `backend/src/lib/publicLegalSources.ts`.

The A2AJ MCP server's `coverage` tool reports what the corpus contains. Use
it rather than inspecting the files.

### What to build next in this layer

The case-law bed, because the thesis cannot be tested on contracts. Two beds
were designed and neither is built:

- **Bed A, `canlaw-pinpoint`**: the quote located in the cited case is the
  gold; the judge's own pinpoint is an independent check (measured agreement
  0.891).
- **Bed B, `canlaw-attested`**: roughly 1,200 single-citation journal
  footnotes with author and editor as gold.

Freeze the gates before building, and apply the document-name-strip test to
our own bed so we do not repeat defect 2 above.

---

## Part 2 — Tool-surface A/B

### What the two arms are

Selected by the environment variable `MIKE_NAV_SHAPE`, read in
`backend/src/lib/chat/localAssistantTools.ts` as `NAV_TOOL_SHAPE`.

**Arm A, `legacy`** — the surface that shipped before 2026-07-31. 43 resident
tools. `library_read(document_id, mode, section, offset, max_chars)`,
unscoped `library_find`, no `library_links`, no page addressing, edit scopes
are `whole_document` / `find_text` / `range`.

**Arm B, `address`** — 11 resident tools, 34 deferred. Contains all of:

1. One address grammar on `library_read`, `library_find`, `library_links` and
   the edit scopes. Bare is structural (`8.01`, `Article VIII`); `pdf:52` and
   `printed:47` are the two page schemes; `off:12000` is a raw window.
2. `from: "start" | "end"` — head and tail of any addressed span.
3. `follow` / `depth` — widen an address along the document's own resolved
   cross-references, on read, find and edit scopes.
4. `library_links` — the reference map: ancestors, siblings, children, what a
   provision cites and what cites it, plus a document-level census and hubs.
5. Capability on contact — the opening read reports what *that* document
   affords (sections, page schemes present, resolved cross-references,
   contents outline, or a note that there is no numbering).
6. Progressive tool disclosure — `describe_tools({domains})`. Research is a
   tree (`research` → `research.cases` / `research.legislation` /
   `research.commentary`); every other domain is one level. Opening a parent
   returns its children.
7. Prose travels with its domain — the research instructions are no longer in
   the base prompt; they arrive in the `describe_tools` reply.
8. `library_revise_docx` takes `at`, so the server derives the surrounding
   context from the document instead of the model retyping it.
9. Structure served from pre-baked sidecars (see Part 3).

Neither arm accepts the other's parameter names, and neither describes the
other's vocabulary. There is a check for this; **it is not yet a test** and
should become one, because this leak recurred three times.

### Measured cost

| | arm A | arm B |
|---|---|---|
| resident tool schemas | 10,130 tokens | 4,004 tokens |
| system prose | 1,970 tokens | 1,077 tokens |
| base context per turn | 12,100 tokens | 5,081 tokens |

Tokenised with `o200k_base`.

### The result that matters, and it inverts an earlier claim

From the editing benchmark, three surfaces, 162 runs:

| | legacy | address, no disclosure | address + disclosure |
|---|---|---|---|
| total tokens per run | 69,281 | 79,425 | 56,149 |
| schema bytes, first request | 25,809 | 28,802 | 13,282 |
| retyped document characters | 276 | 327 | 126 |
| runs containing a misquote | 15/54 | 14/54 | 9/54 |

**The address grammar on its own costs 14.6% more than the surface it
replaces.** It adds a tool and parameters, and every request carries them.
Progressive disclosure is what pays for it (−29.3% within the same grammar).
An earlier report of "the address arm is 23% cheaper" came from a partial run
and bundled three changes; it is wrong and should not be repeated.

Correctness was undecided on all three surfaces: 81% / 79% / 79% excluding
floor tasks, inside the replicate floor.

The second-order effect is larger than the token saving. Deferring
`library_revise_docx` behind a domain cut retyped characters from 327 to 126
and misquote-bearing runs with them. When the retyping tool is visible the
model reaches for it; when it is behind a domain the model uses the addressed
tool instead.

### Open items

- **Stage 22 is registered but stale.** It tests the disclosure half and was
  written against an older arm B. Re-register against the current definition
  before running. Harness `backend/scripts/nav-shape-rag.ts`.
- **The editing campaign predates `library_revise_docx at=`** (`b53c1353`).
  Its numbers are pre-change and need a re-run.
- `library_find.at` was passed as an empty string on all 61 calls in one
  campaign — the scoped search was never actually scoped. Undiagnosed; likely
  a parameter-description problem.
- The `amendment` domain was opened 5 times and called from 0. Its blurb
  attracts renumbering tasks it cannot perform.
- Citation verification is spread across three domains
  (`courtlistener_verify_citations` in `research.commentary`,
  `library_link_docx_citations` and `library_fix_docx_supras` in `review`,
  the two `toa_*` tools in `authorities`). It is one job and should be one
  top-level `citations` domain.
- **A renumbering tool does not exist and should.** When a clause is inserted
  or deleted, downstream siblings renumber and every reference to them must
  move. Today the model reads the whole document and issues N retyped edits,
  which is where the misquotes come from. The pieces exist: the skeleton
  gives sibling order, `backend/src/lib/legalCrossReference.ts` gives every
  resolved reference with its source span and target label, and
  `backend/src/lib/legalAmendOps.ts` already splices text. The tool should
  refuse on unresolved and external references rather than guessing.

### Provider seam

`backend/src/lib/llm/types.ts` gained `resolveTools?: () => OpenAIToolSchema[]`
and `backend/src/lib/llm/openai.ts` re-reads it at the top of every tool-loop
iteration. Without this the tool list was snapshotted before the loop and a
tool revealed by `describe_tools` could never be called. Codex routes through
the same function. Absent the parameter, behaviour is unchanged.

---

## Part 3 — Structure compilation and caching

### In-process memo

`backend/src/lib/legalTextSkeleton.ts` memoizes `compileAgreementSkeleton` on
`(sha256(text), id, recoverExtraction)`; `backend/src/lib/legalCrossReference.ts`
memoizes graphs in a `WeakMap` keyed by the skeleton. Cap 8 entries.

`recoverExtraction` is load-bearing: 45 of 23,531 A2AJ statutes compile a
different node inventory with it on than off (Criminal Code 10,861 vs
10,979). A cache key that ignored it would serve the wrong artifact.

Verified: the whole statute corpus re-derived under both constructions with
the cache active reproduces both known digests exactly — `b31fdc04…` with
`recoverExtraction: false`, `6a5be600…` with the default. 47,062 compiles.

Measured on 12 hold-out contracts, median 37,796 characters: a turn's
structural work drops from 130.9 ms to 8.1 ms. This is the explanation for
Stage 21's +1,464 ms latency penalty on arm B, which does more structural
compilation per turn.

### Durable sidecars

`backend/src/lib/legalStructureSidecar.ts`, written to
`%LOCALAPPDATA%\OpenLegalProducts\LegalData\apps\mike\library\structure-cache\`.

A `SourceDoc` cannot be serialised — `index` is a `Map` (JSON produces `{}`
and every lookup then answers "not found") and `tokens` is a non-enumerable
lazy accessor that `structuredClone` drops and cannot re-attach. The sidecar
stores the JSON-safe inventory and rebuilds the document through
`createSourceDoc`, which is O(blocks) and does not tokenize.

Pre-bake with `backend/scripts/prebake-structure.ts`, which takes a JSONL of
`{id, text}` produced by `backend/scripts/dump_a2aj_laws.py`. Eight federal
acts are baked. Income Tax Act: 7,318,921 characters, graph 12,328 ms to
build, 27 MB of sidecars for the set.

**Not verified.** A defect was found and fixed but the fix was not confirmed:
the sidecar key originally included the caller's `id`, so a bake made from an
A2AJ row id could never be served to the tool layer, which passes a Library
document id. Measured before the fix: 76 ms on a hit against 760 ms for the
tool layer's own call — every bake was unreachable. The key now covers text
and the recovery flag only, and the caller's id is stamped at rehydration;
`prebake-structure.ts` now writes both recovery variants. **The verification
run of this fix did not complete. Re-run it before relying on the sidecars,
and confirm node and edge digests still match a cold compile.**

Also unverified: the sidecar read path has not been measured through the tool
layer (`library_read`, `library_links`) end to end, only standalone.

---

## Part 4 — The editing benchmark

`benchmarks/docx_edit/`. This is the durable asset; the A/B was its first
consumer.

v1 is 27 tasks over 11 fixtures, frozen. Tasks are data in `tasks.jsonl`:
id, the verbatim semantic instruction, fixtures, difficulty, categories, a
`why` field, checks, a reference solution and near misses. Fixtures are built
and hashed; identity is the sha256 of extracted body text, because DOCX bytes
are not reproducible. Checkers are a library and the tool surface is
configuration — nothing under `src/` knows what `MIKE_NAV_SHAPE` is.

Validity was established before the first model call: 27/27 tasks have a
verified reference solution, 27/27 reject every wrong result, and guard
sensitivity is proved by a synthetic probe that damages exactly what each
guard protects. The whole-document-rewrite shortcut is blocked by a zero
budget for destroying original lines the reference keeps.

Instructions are phrased semantically and never name a tool. That is the
design: what the model reaches for is the measurement.

### What the failures showed

All five v1 failures reduce to three mechanisms, and all three are retyping:

1. **No address reaches a table cell.** Extraction puts each cell in its own
   paragraph, so a `find_text` scope spanning `"Cure / Correction\n30 days\n30
   jours"` matches nothing. `No revision was saved` is the commonest error in
   the campaign, 25 occurrences. Two tasks fail in both arms for this one
   reason. **The skeleton has no concept of a table cell. This is a real gap
   in the structure layer, not a tool gap, and it should be scoped as its own
   piece of work.**
2. The model passes the text it wants the document to say into a `find_text`
   scope. Unmatchable by construction.
3. Both arms invent whitespace they never saw — arm A joins lines with a
   space where the document has a newline, arm B invents a blank line where
   extraction has one newline.

### v2, in progress

Two findings reshaped it:

- **None of Beaver's 24 shipped workflows produces an edited document.**
  Thirteen produce a Markdown table, eleven a spreadsheet. But nine terminate
  in a "Recommended Change" / "Proposed Change" column — an edit instruction
  against a cited location. Beaver already emits the stimulus half of an
  editing benchmark at scale and has nothing that consumes it. That pair is
  v2's largest family. See `backend/src/lib/systemWorkflows.ts` and
  `docs/legal-skills-ecosystem-comparison.md`.
- A v1 weakness worth fixing: all 27 tasks are solvable with resident tools
  only, so the bed measures the cost of hiding a tool the model *wanted*, not
  one a task *needs*. v2 should add a block where the correct route requires
  opening a domain.

v2 scaffolding is committed: additive task sets with v1 frozen, a `real`
fixture family that packs source lines verbatim rather than through the
markdown renderer, and a Class A–D taxonomy enforced by the loader — a task
must declare its class, and a Class A/B task must be marked a floor task
because a deterministic tool should do it.

---

## Where things are

| What | Where |
|---|---|
| Tool surface, arms, disclosure | `backend/src/lib/chat/localAssistantTools.ts` |
| Tool schemas | `backend/src/lib/chat/tools/toolSchemas.ts` |
| System prompts | `backend/src/lib/chat/prompts.ts`, `backend/src/routes/chat.ts` |
| Document navigation | `backend/src/lib/legalDocumentNavigator.ts` |
| Skeleton compiler | `backend/src/lib/legalTextSkeleton.ts` |
| Cross-reference graph | `backend/src/lib/legalCrossReference.ts` |
| Sidecars and pre-bake | `backend/src/lib/legalStructureSidecar.ts`, `backend/scripts/prebake-structure.ts` |
| Citator | `backend/src/lib/caselawCitator.ts` |
| Retrieval A/B harness | `backend/scripts/nav-shape-rag.ts` |
| Editing benchmark | `benchmarks/docx_edit/` |
| LegalBench-RAG bed | `benchmarks/legalbench_rag/` |
| Experiment log | `docs/legal-grounding-experiments-2026-07-30.md` |
| Research plan | `docs/legal-grounding-restart-plan-2026-07-31.md` |
| Structure-graph design | `docs/legal-structure-graph-round-2026-07-31.md` |
| Receipts (never committed) | `%LOCALAPPDATA%\OpenLegalData\experiments\legal-grounding\2026-07-30\` |
| Baked sidecars | `%LOCALAPPDATA%\OpenLegalProducts\LegalData\apps\mike\library\structure-cache\` |

Scratch files under
`%LOCALAPPDATA%\Temp\claude\C--Users-elias-Desktop-MikeOSS-Fork\…\scratchpad\`
are ephemeral. `statutes.jsonl` there (23,531 rows, 603 MB) is regenerable
with `backend/scripts/dump_a2aj_laws.py`.

## Uncommitted at handoff

`backend/scripts/prebake-structure.ts` and
`backend/src/lib/legalStructureSidecar.ts` carry the sidecar key fix described
above, unverified. `backend/scripts/nav-shape-rag.ts`,
`benchmarks/docx_edit/manifest.jsonl` and `benchmarks/docx_edit/src/fixtures.ts`
carry in-progress benchmark work from a subagent.

## Method notes worth keeping

- A green test that exercises a different construction than production is not
  evidence. This happened three times in one day: a corpus digest that
  measured the recovery-off path while claiming to cover the default, a
  clause-lane test whose oracle compiled with recovery on while production
  used off, and a DOCX fallback that made the read and edit layers disagree
  on character offsets.
- Report the within-arm replicate floor beside every between-arm difference.
  Most results here sit inside it and the honest word is "undecided".
- Do not quote a partial run. Two claims in this document's history were
  reversed by finishing the run.
