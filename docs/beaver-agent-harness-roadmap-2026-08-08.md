# Beaver agent harness and deterministic legal organs roadmap

Date: 2026-08-08

Status: technical execution appendix; proposed sequencing, not canonical status

## Document contract

[`beaver-master-plan.md`](beaver-master-plan.md) remains the authoritative source
for Beaver priorities, acceptance gates, and implementation status. This file
preserves the conclusions from the August 2026 LAB trace audit and turns them
into independently testable implementation slices. Nothing in this file changes
the master plan until it is adopted there.

The evidence below is a dated development snapshot. DeepSeek and Luna results
are provider-specific, judge-derived side-run evidence, not human gold and not
the canonical same-model Beaver A/B required by the master plan. Historical
experimental arms are evidence about mechanisms, not permanent architecture.

The governing delivery rule is simple:

> Repair demonstrated correctness defects now. Test one efficiency or legal
> mechanism at a time. Build product-scale agent machinery only when a real
> caller and a measured failure justify it.

Every feature in this roadmap must identify:

- the observed failure or product need;
- the smallest useful change;
- what the change deliberately does not do;
- focused deterministic checks;
- any live A/B needed for promotion;
- the acceptance and rollback conditions; and
- which existing implementation it extends instead of duplicating.

## Executive decision

Retain the flat coding-harness treatment. It is already holding its own and is
materially simpler than the context compilers, forced planners, reviewer loops,
and semantic indexes previously tested.

The resident model-facing surface remains:

- `Glob` for workspace discovery;
- `Grep` for locating text;
- `Read` for hydrating selected text;
- `generate_docx(filename, content)` for complete Word work products; and
- `Edit` for bounded revision without re-emitting an entire document.

The model sees one ordinary filesystem/source plane. A Word document has a
stable `.docx` path. Markdown normalization, DOCX rendering, caches, redline
projection, version storage, receipts, telemetry, and benchmark machinery stay
behind that path. Search locates; Read hydrates. Both operate on the same
normalized, versioned text.

There is no model-facing fixed document-count rule. Files explicitly attached
to the current user message are mandatory scope. A larger matter Library is
discoverable and searchable, not automatically injected into context. A Table
of Contents is an optional projection of the same source registry, not a second
source or a visible shadow Markdown file.

Legal judgment remains with the model. Deterministic code may normalize,
calculate, compare, validate, trace provenance, or refuse. It must not silently
choose the governing provision, decide what belongs in a covenant calculation,
select the legally operative transaction, or declare legal effect.

## 1. Evidence and decisions that must not be lost

### 1.1 Overall treatment result

The audited matched set contained 56 transcripts: 14 tasks, two provider lanes,
and upstream/treatment pairs. The provisional judged side-run result was:

- treatment won 24 of 28 provider-task pairs;
- one pair tied;
- three pairs regressed;
- no task regressed under both providers;
- treatment exposed all 117 available documents in each provider lane;
- upstream DeepSeek exposed 117/117 and upstream Luna 114/117; and
- every audited treatment run produced its requested deliverable.

“Exposed” means that a version-bound tool result returned source content. It
does not prove that the model reasoned adequately about every returned document.

The broad conclusion is not that the surface is perfect. It is that the flat
surface is sufficient for the current ordinary 3–31-document tasks, while a
small set of concrete correctness and output-budget defects remain. The three
provider-specific regressions do not justify a semantic retrieval layer, legal
planner, source-family router, or mandatory review pass.

### 1.1.1 Implementation snapshot at the end of 2026-08-08

Commit `57c31bd3` in the isolated treatment worktree contains the near-term
runtime work:

- shared content-addressed normalized projections with cross-process reuse;
- batched local ingest and bounded parallel prewarming/final receipts;
- a version-keyed, per-turn Promise cache and single-flight Grep source loads;
- outcome-based final receipt handling that preserves valid artifacts while
  keeping missing/corrupt deliverables fatal;
- `coding_markdown_final_v5_read_replay_v1`, which changes only exact unchanged
  ordinary Read replay behavior; and
- `coding_markdown_final_v5_grep_line_500_v1`, which changes only rendered
  content-line width.

The base and both variants preflight to the same performer prompt hash, tool
schema hash, and five tool names. The full focused final-arm suite passes 12/12
with a 60-second test timeout; the default 20-second grouped run can time out
under concurrent real DOCX conversions and is not a behavior failure. The live
near-term campaign launched both providers simultaneously at ten workers per
provider and BelowNormal priority, reusing five valid base cells per provider
and running eight new variant cells per provider.

### 1.2 The decisive prompt ambiguity was not a legal-tool failure

The senior-notes indenture task named the target issuer in task metadata/title,
but the model-visible request contained only generic instructions for a senior
secured notes offering. The corpus contained two plausible offerings. This is
also how the actual open-source Harvey LAB performer is invoked: its runner
passes `instructions`, not the metadata title. The title is available to task
administration/evaluation, not automatically to the performing agent.

DeepSeek treatment read all 14 documents, concluded that the two offerings were
distinct, selected the wrong family, and explicitly quarantined the rubric
target documents as “other transaction.” Luna treatment selected the intended
family and improved by 22 criteria. The failure was therefore a prompt-packaging
ambiguity plus stochastic resolution, not evidence for a general deal-identity
classifier.

Decision:

- preserve reference parity by passing the benchmark `instructions` only;
- never inject a metadata title merely to repair one ambiguous trajectory;
- treat missing decisive facts in instructions as a task-fixture limitation,
  and change the fixture only as an explicitly versioned task-set decision
  applied equally to every harness;
- in the product, every material fact a real user actually supplied remains in
  the model-visible request; and
- do not add a deal-identity checkpoint, transaction-family chooser, or
  benchmark-specific identity prompt.

### 1.3 Flat authoring removed a repeated real failure

The upstream nested `generate_docx` contract required a title and nested
`sections[]` objects. DeepSeek emitted 11 invalid empty authoring calls across
the audited upstream runs. In the PSA task, eight empty calls were followed by
a tiny probe document containing only “Test content,” producing 1/75 criteria.
An earlier stochastic upstream PSA run eventually succeeded, which confirms a
model/schema interaction rather than an impossible task.

The flat treatment call accepts only a filename and complete Markdown content.
It did not show this authoring failure class in the landed treatment set.

Decision:

- keep `generate_docx(filename, content)`;
- do not restore nested sections, table objects, grounding payloads, or a
  visible render step;
- after a valid generation or edit, end the turn without an acknowledgement
  round; and
- if input is malformed, return one compact valid call example.

`Edit` remains. Removing it would force models to spend output tokens
re-emitting long documents for small corrections.

### 1.4 Generated artifacts are not yet ordinary files everywhere

The transcript audit found three related defects:

- in 23/28 upstream arms, `generate_docx` returned `doc-0`, colliding with an
  uploaded source already named `doc-0`;
- treatment-generated outputs were not visible to the same `Glob`/`Grep`
  surface used for sources, producing three failed post-generation searches;
  and
- five generated-artifact reads ignored the requested scope and returned
  412,681 characters in total.

These are general harness defects. They explain model confusion without
requiring any legal-specific mechanism.

Decision: extend the existing document manifest/version machinery into one
artifact namespace. A generated `.docx` becomes an ordinary versioned workspace
file immediately and is addressable through `Glob`, `Grep`, `Read`, and `Edit`.
Do not create a second virtual-filesystem framework.

### 1.5 Luna gelled with the surface, but spent heavily on retrieval

Across the exact 14-task treatment audit:

- DeepSeek made 248 tool calls: 166 Read, 36 Grep, and 28 Glob;
- Luna made 452 tool calls: 333 Read, 89 Grep, and 15 Glob;
- DeepSeek Read results carried about 5.34 million characters;
- Luna Read results carried about 7.37 million characters;
- Luna's 89 Greps returned about 2.308 million characters;
- DeepSeek's 36 Greps returned about 106,500 characters; and
- upstream Luna made 1,463 `find_in_document` calls, so the flat surface still
  removed a much worse search-churn pattern.

Luna's Grep calls were generally sensible regex searches, not evidence that it
needed a legal query language. Its Read sizing also showed that a model can
adapt to ordinary line scopes and host caps. Earlier traces where Luna supplied
both line limits and character limits showed why `max_chars` should remain
hidden: it guessed dense legal-line sizes, but also requested values above the
host cap and caused avoidable truncation.

Decision: retain ordinary Read and Grep semantics. Improve host-side bounds and
recovery metadata; do not create legal-specific read sizes or clause-length
arguments.

### 1.6 Exact rereads are measurable waste, but suppression is not settled

Canonical call reconstruction found 27 exact duplicate Luna Read calls across
7/14 tasks, returning about 600,836 repeated characters. Thirteen occurred in
the closing-checklist task. Result-hash replay counts were higher, but those
include different calls that happened to return identical text and must not be
treated as equivalent automatically.

Decision: test exact duplicate suppression as an isolated experiment. A
conventional coding harness permits rereads, and a model may deliberately
restore a passage to attention. Only exact same-tool, same-arguments,
same-version calls are candidates. Overlaps, different ranges, changed
versions, same-file calls generally, and semantic similarity are out of scope.

### 1.7 Grep needs bounded recovery, not a new query language

Luna's 2.308 million Grep characters show a genuine output-budget issue. They
do not establish that legal clauses require a special search primitive.

The conventional design shared by coding harnesses is enough:

- regex or literal matching;
- case control;
- path/glob/type restriction;
- matching content, counts, or files-with-matches;
- optional context lines; and
- a bounded result with explicit truncation.

The first experiment should test a host total around 50 KiB and a per-matching-
line cap around 500 characters. The model should not set `max_chars` and should
not receive raw unrestricted ripgrep argv. Truncated results must say how many
matches were shown, how many exist, and how to narrow the path/pattern or Read
around a hit.

This is a conventional grep subset, not a claim of full ripgrep dialect parity.
If full parity is ever required, invoke the actual tool over normalized files;
do not grow a JavaScript ripgrep emulator one flag at a time.

### 1.8 Redline visibility is a proven common source-plane improvement

The earlier upstream source plane flattened tracked insertions and deletions.
That makes a markup-analysis task unfair because one arm cannot see the thing
being evaluated. The common markup-aware source plane exposes stable markers
such as `{++inserted++}` and `{--deleted--}` through the same coordinates used
by Read, Grep, outlines, and evidence receipts.

The fair redline reruns produced a provisional aggregate treatment gain of 32
criteria across the selected DPA and protective-order cells. This supports
retaining the common source plane; it does not prove that comments, tracked
moves, manual strike ink, or marker collisions are solved for every document.

Decision:

- both upstream and treatment receive the same markup-aware source
  representation for redline tasks;
- upstream remains native in every other material respect;
- harden new tracked-change pathologies only when a fixture demonstrates them;
  and
- do not build a second semantic diff engine.

### 1.9 The strongest legal-specific opportunity is source-bound computation

Repeated misses across covenant compliance, OFAC, plan distributions, FLSA,
PSA, acquisition diligence, arbitration, and DPA involved amounts, ratios,
counts, or competing bases. The covenant-compliance task was especially clear:
both providers and both arms missed the same core values, including:

- unadjusted LTM EBITDA of approximately $61.85 million;
- the $500,000 overstatement;
- FCCR of approximately 1.511x;
- leverage of approximately 2.531x;
- the quarterly EBITDA build;
- $146,562,500 term-loan principal outstanding;
- the settlement-addback question; and
- the expired transaction-cost addback.

The correct response is not a covenant calculator. The model must still choose
the provision, period, amendments, inclusions, exclusions, and legal treatment.
A deterministic layer can perform exact arithmetic and table aggregation over
the source-bound operands the model selects, then return units, steps,
alternative scenarios, source references, and a typed refusal when the inputs
do not close.

The repository already contains useful pieces—`legalDerivedValueScan`,
`legalFigureReconciliation`, `SpreadsheetCellSpan`, legal anchors, and coverage
receipts. Their model-free ceiling must be measured before adding a broader
tool.

### 1.10 Deadline and defined-term organs are narrower follow-ons

Deadline omissions occurred repeatedly, including a 180-day DPA timing point
missed by all arms. The existing `deadlineOmissionScan` and `computeDeadline`
machinery can resolve stated calendar relationships and refuse ambiguous or
calendar-dependent ones. It is suitable for a separate analytical-deliverable
pilot, not an always-on drafting repair loop.

Defined-term and cross-reference checks also have plausible value for missing
attachments, dangling internal references, and genuinely undefined terms.
However, the current broad scan produced 448 findings across 43 runs and was
dominated by proper nouns and headings. It remains report-only and off by
default until a real-instrument precision gate is met.

### 1.11 What the open-source coding harnesses actually suggest

The useful ideas from Pi, Oh My Pi, and Codex are infrastructure patterns, not
large tool catalogs:

| Harness | Worth adapting | Do not copy now |
| --- | --- | --- |
| Pi | queued steering/follow-up; interruptible work; JSONL session tree; minimal resident tools; bounded Read/Grep with actionable recovery | visible TODO/plan ceremony; terminal UI; code-oriented assumptions |
| Oh My Pi | typed bounded subagents; machine-readable output metadata plus artifact recovery; hash/version-anchored edits; one filesystem abstraction with hidden providers; progressive tool exposure | LSP/DAP/browser/memory sprawl; tree-sitter prose summaries; a permanent 30+ tool surface |
| Codex | turn steering and interrupt; resume/fork/compact lifecycle; bounded attempted-call tracing; start/complete/fail events; concurrency only for declared-safe tools | PTY/process plumbing, sandbox retry, or terminal parallelism as legal features |

Pi's 2,000-line/50-KiB Read boundary and 500-character Grep-line truncation are
useful candidate defaults, not legal truths. Oh My Pi's recoverable `OutputMeta`
shape is more transferable than its code-summary machinery. Codex's bounded
attempted-call recorder and explicit trace lifecycle are useful telemetry
patterns; they do not justify parallel tool dispatch where current traces show
no bottleneck.

The larger product additions—steering, resumability, version-anchored edits,
and bounded subagents—belong after the core source plane and runner are correct.
They are not treatment-arm patches for ordinary tasks.

### 1.12 Reference-harness and judge calibration

Three different comparisons must remain separately labelled:

1. **Actual Harvey LAB.** The public `harveyai/harvey-labs` runner uses its own
   system prompt/skills and six coding tools (`bash`, `read`, `write`, `edit`,
   `glob`, `grep`) in a sandbox. It gives the performer task instructions but
   not the task title. Its evaluator uses fuzzy filename matching and supplies
   title, output, and one criterion to the judge.
2. **Artificial Analysis.** Harvey LAB AA is a Stirrup reimplementation, not
   the exact Harvey harness. It uses Stirrup's agent loop/compaction, exact
   filenames, a smaller tool set, no Harvey custom document skills, and Gemini
   3.1 Pro criterion judging. The public leaderboard reports Luna Max at about
   87.90% criterion pass rate (6,073/6,909 inferred from the published total),
   with 5% task all-pass—not an 80% task all-pass rate.
3. **Stock Codex side baseline.** The local `codex_native_v1` run measures a
   clean Codex CLI coding loop. It is useful, but it is neither Harvey's
   reference harness nor Stirrup and must never be labelled as either.

The official audit pinned current Harvey commit
`55510f0e609ffa5cf6f5df17d9a813ce4bb33d0c`. For the selected eight tasks, every
task/source byte matches the local copy. The combined official system prompt
plus all 29 skills has SHA-256 `c1a50b8e34e7f3534c54b16d11ea71b32afaa33dbeb84a6a7e17d37310208d05`;
the six-tool schema is
`e7f9594c80dd92c514b14caac1471d7010a2be02af5d88ba94e931bdb8f1e11b`.
Both match the local reference files, and adapter parity checks pass 32/32.

Harvey's published headline baseline is not exactly reproducible from the
public repository. The post used an undisclosed holdout mirroring the public
distribution and says grading was repeated across model families, but does not
disclose task IDs/files, number of repeats, judge families, or the released
judge prompt. The public code defaults to Claude Sonnet 4.6 criterion judging.
Accordingly, a new run can be called a pinned **public Harvey-harness side run**,
not a direct replication of Harvey's private headline. AA remains a third,
separately labelled 120-private-task Stirrup/Gemini benchmark.

Fair comparison order:

- pin and record the public Harvey and Stirrup revisions;
- adapt transport only, leaving each reference agent loop, prompt, tools,
  filenames, task instructions, and stopping rule unchanged;
- use the same visible-dev source documents and never held-out tasks;
- hold performer model/effort and judge model/prompt equal when comparing
  harnesses; and
- report reference, Beaver base, and any Beaver variant as separate surfaces.

The budgeted judge-taste calibration is deliberately smaller than a full
Gemini rejudge. It selects a deterministic, task/arm/prior-label-balanced
28-criterion pilot, uses the published AA two-message criterion prompt, meters
prompt/candidate/thought tokens, and enforces a US$13.50 hard stop (about C$20).
It then compares flat-rate Luna and Sol at High and Max using balanced accuracy,
Cohen's kappa, false-pass, and false-fail rates on held-out labels. No paid call
may occur without explicit approval to transmit the visible-dev instructions,
criteria, and generated work-product text to Google. Source documents, sealed
tasks, private keys, and client/user data are out of scope.

## 2. Fixed design constraints

These rules apply to every phase:

1. Extend the modular monolith and existing document/version contracts. Do not
   introduce a service, interface layer, or dependency for a single caller.
2. Model-visible paths are the original user-facing files. No `.md` companions,
   shadow filenames, projection terminology, renderer steps, benchmark labels,
   judge labels, cache notices, or telemetry language.
3. Exact evidence, versions, pinpoints, hashes, and receipts remain durable.
   Summaries and model memory never substitute for source evidence.
4. Search and Read remain separate because they do different work: search
   locates candidate spans; Read hydrates a chosen span or whole document.
5. Whole-document reads remain available when they are the best tool. They are
   bounded by the host, not forbidden by prompt rules.
6. Files explicitly attached to the current user message must be considered.
   Matter-Library files are discoverable, not mandatory by default.
7. A “read the entire matter” policy is a future hypothesis, not a default.
8. Do not tell the model to “read the current source version.” Version checks
   belong in result receipts and stale-write rejection.
9. No fixed document count is exposed to the model. Capacity and task needs
   determine how much evidence the model retrieves within bounded results.
10. A recovered tool error is not a failed run.
11. Telemetry is model-invisible and never decides whether otherwise usable
    work is judgeable.
12. One model-visible feature per experiment. Combinations are tested only
    after the individual features earn promotion.

## 3. Roadmap at a glance

| Phase | Status | Objective |
| --- | --- | --- |
| 0 | NOW | Preserve valid current work and repair runner/finalization correctness |
| 1 | NOW | Make the existing flat source and authoring surface internally correct |
| 2 | NOW / NEXT | Run duplicate-Read and Grep-cap experiments now; keep attachment coverage separate |
| 3 | NEXT | Pilot one deterministic legal organ at a time |
| 4 | LATER | Add product-scale coding-harness capabilities for long matters |
| 5 | DEFER/REJECT | Avoid speculative retrieval, semantic, and orchestration machinery |

## 4. Phase 0 — NOW: recover work and repair orchestration

### 4.1 Preserve and judge valid existing artifacts

Observed incident:

- both data-room treatment attempt-1 runs generated
  `red-flags-report.docx`, then failed a final receipt gate after successful
  auto-flush;
- retrying inference would spend provider time without changing the artifact;
  and
- upstream antitrust runs generated all four recognizable deliverables with
  title-case/spaced filenames rather than the required exact hyphenated names.

The data-room runs establish two separate facts:

| Provider | Upstream criteria | Treatment criteria | Upstream adjusted tokens | Treatment adjusted tokens | Upstream wall | Treatment attempt wall | Treatment provider wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DeepSeek | 18/498 | 36/498 | 417,768.88 | 522,674.48 | 326.68s | 2,021.80s | 281.04s |
| Luna | 13/498 | 14/498 | 409,803.80 | 549,113.00 | 395.12s | 2,096.42s | 354.55s |

Both treatment models completed substantive inference and created the exact
required `red-flags-report.docx`. The large end-to-end wall time was mostly
about 29 minutes of eager 2,863-document normalization, not slow model work.
The terminal error was the post-auto-flush receipt mismatch described above.
Therefore the treatment did not fail to finish because of an inherent agent
quality; it finished, then computational preprocessing and bookkeeping made the
run look failed. Recovered same-provider judging ultimately gave DeepSeek +18
criteria and Luna +1, for +19/996 aggregate. That establishes a treatment gain,
but 50/996 aggregate criteria is still poor room-scale recall. Faster ingest
does not solve the attention/coverage architecture by itself.

Smallest action:

1. Validate each existing DOCX container and required non-empty body.
2. Finalize and judge the valid data-room attempt-1 artifacts without another
   inference call.
3. For antitrust, apply a deterministic, one-to-one canonical filename mapping
   only when each intended artifact is unambiguous.
4. Judge the substantive mapped document while preserving the original file
   and failing the exact-filename criterion.
5. Refuse mapping if two outputs could satisfy the same required filename or a
   required output is genuinely absent.

Acceptance:

- valid work is judged once;
- original artifacts and receipts remain immutable;
- no provider call is made solely to repair bookkeeping or spelling/case/
  separator differences; and
- missing, corrupt, empty, or ambiguous deliverables remain real failures.

### 4.2 Outcome-based finalization and retry policy

Hypothesis: the harness can remove unnecessary retries by deciding from the
usable outcome rather than requiring every intermediate receipt to be green.

Minimum terminal states:

1. **Valid deliverable** — finalize and judge.
2. **Provider failed before a valid deliverable** — retry within policy.
3. **Missing, corrupt, empty, or unusable deliverable** — retry or fail.
4. **Bookkeeping/telemetry defect after valid deliverable** — preserve, record,
   and continue to judging.
5. **Recoverable tool error followed by valid deliverable** — finalize and
   judge; retain the error as trace evidence.

Smallest implementation:

- make a successfully committed auto-flush satisfy the final artifact gate;
- validate from the artifact registry rather than from a fragile count of
  authoring events;
- keep failure reasons typed and local to the failed attempt; and
- make launch, resume, and judge selection self-bookkeeping.

Focused checks:

- successful generate + failed closing receipt;
- successful auto-flush + no explicit body event;
- failed first authoring call + successful correction;
- provider timeout before any artifact;
- corrupt DOCX;
- empty DOCX;
- ambiguous multi-output mapping; and
- valid deliverable followed by telemetry parse failure.

Acceptance:

- the data-room auto-flush case finalizes;
- retries decline without lowering valid-deliverable count;
- no corrupt or missing artifact is promoted; and
- no prompt hash, telemetry mismatch, receipt mismatch, or cache annotation
  alone invalidates a run.

Rollback trigger: any invalid or wrong deliverable reaches judging because the
outcome classifier was too permissive.

### 4.3 Stop the hard-failure pending-queue spin

Observed defect: an obsolete final-v4 orchestrator retained pending work after
a hard failure, suppressed new starts, and then busy-spun at Normal priority
without an inference child.

Smallest implementation:

- when a hard failure prevents all future starts, exit with durable partial
  state; or
- if the state is explicitly recoverable, block on a bounded wait rather than
  loop immediately.

Focused check: reproduce `pending > 0`, `active = 0`, and `hard_failure = true`.
Assert that the runner exits or sleeps, writes its final state, and can resume
without duplicating completed work.

Acceptance: zero CPU spin, no orphan inference child, and usable partial state.

This is a real resource/performance defect. Fixing it does not justify
discarding any completed inference.

### 4.4 Preserve reference-conformant request assembly and prevent leakage

Smallest implementation:

- pass the task `instructions` exactly as the public Harvey performer does;
- do not inject the task metadata title into any performer arm;
- if an internal product caller genuinely provides a title, keep that product
  behavior outside the LAB reference adapter;
- apply the same request assembly to both comparison arms; and
- snapshot-test the assembled prompt for forbidden harness terms.

Forbidden leakage includes `benchmark`, `experiment`, `ablation`, `treatment`,
`judge`, `score`, `telemetry`, cache prices, shadow/projection/canonical Markdown
terminology, fixed document-count commentary, and source-version warnings that
the model cannot act on.

Acceptance:

- the LAB performer sees instructions, not task title or rubric metadata;
- no rubric or held-out criterion enters the performer prompt;
- no tool result exposes internal Markdown paths; and
- only cells with a materially changed model-visible request are rerun.

Non-goal: a domain-specific task planner or deal classifier.

## 5. Phase 1 — NOW: make the flat surface correct

### 5.1 One artifact namespace and one source plane

Hypothesis: making generated outputs ordinary workspace files will remove ID
collisions, wrong-file reads, and post-generation search failures without any
new model concept.

Smallest implementation:

- extend the existing workspace manifest/document-version store;
- allocate generated IDs after all source IDs or use collision-proof durable
  IDs;
- assign every generated artifact a stable user-facing path and version at
  commit;
- resolve `Glob`, `Grep`, `Read`, and `Edit` through the same registry;
- keep uploaded sources immutable to the authoring tools; and
- record source/version/hash receipts for every read and write.

The registry is not a generalized virtual filesystem. It is the existing
document manifest made authoritative for both inputs and outputs.

Focused checks:

- uploaded `doc-0` plus generated output cannot collide;
- generate, Glob, Grep, Read, and Edit the same `.docx` in one turn;
- a generated document survives restart with the same path/version;
- an uploaded source cannot be overwritten by an output;
- anonymous local and cloud adapters preserve the same semantics; and
- one assistant edit turn creates one consolidated durable version.

Acceptance:

- no read silently opens a different artifact;
- generated files are immediately discoverable;
- the model sees no projection/render distinction; and
- there is one implementation of artifact identity and versioning.

Rollback trigger: a generated file can shadow a source path, or local/cloud
version semantics diverge.

### 5.2 Enforce bounded reads for every artifact class

Smallest implementation:

- honor `offset` and `limit` on sources and generated artifacts;
- apply the same host character ceiling to both;
- return the exact path, version, first returned line/offset, last returned
  line/offset, completeness, and next readable offset; and
- return a compact corrective response for past-EOF ranges.

Focused fixtures include long DOCX prose, a one-line legal document, a long
table row, a generated DOCX, and a version change between reads.

Acceptance:

- the known 412,681-character over-return is impossible;
- pagination has no gap or overlap;
- no hidden `max_chars` argument exists; and
- an unchanged complete Read is distinguishable from a truncated Read in the
  result envelope.

### 5.3 Lock the flat authoring contract

The production contract remains:

```text
generate_docx(filename, content)
```

The `content` value is complete Markdown interpreted by the host as the body of
the named Word document. To the model, it is simply writing a `.docx`.

Smallest implementation:

- retain the existing single Markdown renderer;
- delete or keep unreachable any alternate nested `sections[]` authoring path;
- end the turn after successful generation or a successful final Edit;
- permit another call only after an actual validation/tool failure; and
- return one short valid example for malformed input.

Focused regression fixtures cover headings, lists, tables, footnotes, fields,
page breaks, bookmarks, verified source links, redline-safe text, and multiple
requested deliverables in one committed batch.

Acceptance:

- one successful call produces a valid, non-empty DOCX;
- no second authoring pass is induced by an opaque success receipt;
- multiple requested outputs have stable distinct paths; and
- no model-facing render/finalize step exists.

### 5.4 Conventional recoverable tool errors

Invalid `file_path`, malformed regex, unsupported Grep argument, missing
required authoring argument, or past-EOF Read should return:

- an explicit `error` status;
- the actual rejected field/value;
- the valid signature or allowed values; and
- one obvious recovery route.

For example, a bad Grep argument should not produce three rounds of guesses,
and a malformed `generate_docx` call should show exactly
`{filename: "name.docx", content: "# Complete document"}` once.

Acceptance:

- Luna's earlier `max_results`, invalid-regex, and past-EOF recoveries complete
  without runner retry;
- DeepSeek's malformed authoring call receives a usable example; and
- recovered tool errors remain visible in the ledger but do not make the run
  unjudgeable.

### 5.5 Preserve the completed core improvements

The following are baseline behaviors to regression-test, not rebuild:

- `files_with_matches` returns filenames rather than body content;
- outlines expose directly callable `offset`/`limit` spans;
- `max_chars` is absent from the model schema;
- DOCX redlines use the common searchable coordinate plane;
- normalized projections are durable and version-keyed;
- large ingest is batched and prewarmed;
- library-scope telemetry extracts text only for exposed documents;
- scoped Glob respects both path and pattern;
- Grep stops at its match limit;
- the run viewer uses one ledger and distinct run tabs;
- actual model output, provider-returned reasoning information, tool arguments,
  paths, ranges, and versions are inspectable; and
- autoscroll is on/off at the top without moving surrounding UI.

“Reasoning” means reasoning data the provider actually returns. The viewer must
not promise inaccessible hidden chain-of-thought.

## 6. Phase 2 — NOW/NEXT: isolated efficiency experiments

The duplicate-Read and Grep-bound experiments are implemented and launched as
separate runtime arms. Their prompts and tool schemas are byte-identical to the
base treatment; only one result behavior changes in each arm. Do not combine or
promote them until each independently earns promotion. The explicit-attachment
gate remains NEXT and is not bundled with either efficiency test.

### 6.1 NOW — Experiment A: exact duplicate Read suppression

Hypothesis: suppressing exact unchanged replays can remove Luna's repeated
context without changing evidence availability.

Treatment behavior:

- for an ordinary transfer content Read, fingerprint document ID, source
  version, normalized offset, effective limit, and starting character;
- within the same turn, intercept only an exact successful repeated range;
- return a short `ALREADY RETURNED` result directing the model to its prior
  result or a changed offset/limit;
- leave outline, working-set, page/section/reference, failed, overlapping,
  changed-range, and changed-version reads untouched; and
- keep the full attempted call in model-invisible telemetry.

Non-goals:

- no overlap suppression;
- no same-file suppression;
- no content-hash/semantic deduplication;
- no cross-turn or cross-matter memory;
- no new `force_reread` argument in the first minimal arm; and
- no prompt telling the model not to reread.

Focused checks:

- implicit defaults versus their explicitly normalized equivalent, changed
  version, and different offset;
- replay response omits the repeated source body; and
- evidence attribution is unchanged.

Live A/B gate:

- isolate this feature; Grep behavior and prompts remain unchanged;
- compare criteria, cache-adjusted tokens, wall clock, Read calls, Read bytes,
  and evidence omissions; and
- include Luna because the observed waste is model-specific, while retaining
  a DeepSeek lane to detect adverse interactions.

Promotion requires a strict token or wall-time win with no material criteria or
evidence loss. If rereads appear to restore useful attention, revert the
feature; do not build an elaborate cache-control protocol to save it.

### 6.2 NOW — Experiment B: bounded, recoverable Grep

Hypothesis: a conventional host cap reduces Luna's large Grep payloads while
preserving all evidence through ordinary narrowing and Read.

Implemented first candidate:

- cap only each rendered transfer `Grep` content preview line at 500 characters;
- center the excerpt on the matching text and retain the path and line number;
- keep the existing host result cap and ordinary Read recovery path;
- do not change match `limit`, row counts, context selection, regex semantics,
  or the tool schema; and
- leave files-with-matches and count modes byte-for-byte unaffected.

The ordinary recovery path is to narrow `path`, `glob`, or `pattern`, or Read a
reported range. Do not invent a “continuation recipe” prompt concept. Machine-
readable next offsets may be present in the result envelope, just as a coding
harness reports truncation metadata.

Focused checks:

- a greater-than-2,000-character single line returns a centered preview no
  wider than 500 characters plus ellipses;
- the preview retains the needle and line number;
- Read recovers the complete source line; and
- files-with-matches and count outputs remain unchanged.

Live A/B gate:

- run separately from duplicate suppression;
- compare criteria, adjusted tokens, Grep bytes, follow-up Reads, and wall time;
  and
- inspect any loss to determine whether a long clause/table row became
  unrecoverable.

The live campaign uses closing, DPA, protective-order, acquisition-diligence,
and indenture base cells; Read replay runs on the first four and the 500-character
Grep preview runs on DPA, protective order, acquisition diligence, and
indenture. DeepSeek and Luna run simultaneously, ten workers per provider.

Promotion requires bounded output, explicit recovery, and no material evidence
loss. Retune or revert rather than adding legal-specific scopes.

### 6.3 NEXT — Experiment C: explicit-attachment exposure gate

This hypothesis is distinct from a whole-matter rule.

For files explicitly attached to the current user message, the first authoring
attempt may return one compact list of attachments with no version-bound content
exposure. “Considered” means some content was exposed; it does not require a
whole-document Read. Matter-Library files that were not attached remain
optional search space.

Non-goals:

- no full-Library mandatory read;
- no fixed document count;
- no auto-injection of attachment bodies; and
- no assumption that every file in a poorly configured matter is relevant.

Acceptance:

- an explicitly attached DPA-style source cannot be silently skipped;
- large matter runs do not read thousands of unrelated files merely to satisfy
  the gate; and
- the authoring correction occurs at most once.

A “read every document in this matter” mode may be tested later as an explicit
user instruction, never inferred as the default.

### 6.4 Telemetry accuracy is not a model experiment

The current telemetry found false `ambiguous_tool_calls` by searching arbitrary
document text for the word “ambiguous,” while exact duplicate metrics reported
zero even when trace reconstruction found duplicates.

Smallest repair:

- give every tool result an explicit status enum;
- fingerprint canonical arguments;
- record start, complete, error, bytes, output hash, path, version, and range;
- cap recorded argument/result previews while keeping artifact handles; and
- never derive statuses from prose content.

This improves analysis and the viewer. It does not change model-visible
behavior, does not require an A/B, and never invalidates a run.

## 7. Phase 3 — NEXT: deterministic legal pilots

### 7.0 Reuse audit before new code

Before exposing a new legal tool or post-draft check, replay the existing
deterministic modules against the recent sources and delivered artifacts:

- `backend/src/lib/legalDerivedValueScan.ts`;
- `backend/src/lib/legalFigureReconciliation.ts`;
- `backend/src/lib/legalDeadlineOmissionScan.ts`;
- `backend/src/lib/legalDeadlines.ts`;
- `backend/src/lib/legalTermDrift.ts`;
- `backend/src/lib/legalUndefinedTermScan.ts`;
- `backend/src/lib/docxStructuralLint.ts`;
- `backend/src/lib/spreadsheet.ts`; and
- the anchors, skeleton, coverage, and `slaWorkflow` audit plumbing.

For each module, map findings to actual missed criteria, count false positives,
and verify source/version/pinpoint integrity. This is model-free and precedes
any live arm. Do not invent `legal_compute` until the existing components'
ceiling and gaps are documented.

### 7.1 Pilot 1: source-bound arithmetic and table reconciliation

Hypothesis: exact computation over model-selected, source-bound operands will
recover repeated amount/ratio/table criteria without moving legal judgment into
code.

Smallest first increment:

- a short operation enum rather than a general expression language;
- exact decimal/rational operations for sum, difference, product, ratio,
  percentage, comparison, and count;
- operands bound to source path, version, cell/span/pinpoint, value, and unit;
- optional grouping over existing `SpreadsheetCellSpan` rows;
- explicit period/entity labels supplied by the model;
- result, formula, normalized units, steps, alternative scenario values, and
  source receipts; and
- typed refusal for missing operands, incompatible units, ambiguous periods,
  non-closing arithmetic, or unsupported formulas.

The model must choose:

- the governing clause or rule;
- the applicable amendment/version;
- the population and period;
- the inclusions and exclusions;
- whether an addback is legally permitted; and
- which computed scenario to use in its analysis.

The organ must not say “compliant,” “in breach,” “liable,” “permitted,” or
“operative” on its own.

Implementation discipline:

1. First see whether `legalDerivedValueScan` and
   `legalFigureReconciliation` already cover the target miss.
2. Reuse existing number normalization and spreadsheet spans.
3. Add the smallest neutral arithmetic core only for an uncovered operation.
4. Do not add a runtime dependency unless it removes more risk/code than it
   adds and has this named caller.
5. Keep covenant-, OFAC-, bankruptcy-, FLSA-, PSA-, and deal-specific logic out
   of the implementation.

Focused fixtures:

- currency with millions/thousands scaling;
- percentages and ratios;
- quarterly-to-LTM sums;
- beginning/end principal roll-forward;
- grouped table counts;
- mismatched units;
- conflicting source versions;
- ambiguous periods;
- negative/parenthesized values; and
- source values that support two legally distinct scenarios.

Live A/B:

- first target repeated arithmetic/table misses, not the entire suite;
- run this organ alone;
- measure criterion gains, wrong-input rate, refusal rate, added tokens, and
  false confidence; and
- inspect whether the model selected the wrong legal inputs even though the
  arithmetic was correct.

Promotion requires attributable gains across more than one legal task family,
exact receipts, and no false legal conclusion. Roll back if bad model-selected
inputs make the deterministic answer more confidently wrong.

### 7.2 Pilot 2: deadline omission audit

Hypothesis: an optional analytical-draft check can recover resolved dates that
the draft engaged but omitted.

Smallest implementation:

- reuse `deadlineOmissionScan` and `computeDeadline`;
- gate to analytical deliverables, not operative drafting;
- report trigger, source anchor, duration, direction, resolved date, trace, and
  refusal reason;
- return a bounded findings list once; and
- let the model decide whether and how the date matters legally.

Required refusals include unstated anchors, ambiguous bases, jurisdiction or
holiday uncertainty, business/clear/trading days without a calendar, and
unresolved conditions precedent.

Non-goals:

- no full SLA workflow;
- no automatic operative-document repair;
- no guessed holiday calendar;
- no second drafting pass when there are no findings; and
- no combined arithmetic/deadline arm.

Promotion requires high retrospective precision and a live gain on deadline
criteria sufficient to pay for the extra output/round. Roll back if it mostly
causes generic repair prose or whole-document re-emission.

### 7.3 Pilot 3: defined-term and cross-reference report

Hypothesis: a high-precision report can catch missing attachments, dangling
internal references, and truly used-but-undefined terms.

Smallest implementation:

- reuse `collectDefinedTerms`, `termDriftReport.importedUses`,
  `undefinedTermScan`, and the existing cross-reference graph;
- preserve exact source/draft offsets and versions;
- suppress quoted-only mentions, imported definitions, proper nouns, parties,
  offices, jurisdictions, headings, and descriptive extensions;
- report only missing attachment targets, unresolved internal references, and
  high-confidence undefined uses; and
- perform no automatic repair.

Promotion gate:

- real-instrument precision is high enough that a lawyer would trust a bounded
  report;
- the 448/43 proper-noun flood is eliminated;
- findings map to relevant recent failure classes; and
- no model-visible pass occurs when the report is empty.

Otherwise defer indefinitely.

### 7.4 Retain, do not rebuild: common markup-aware source plane

The redline plane is already the best example of a useful legal-specific
primitive:

- it solves a representation problem deterministically;
- it exposes stable exact markers and coordinates;
- it benefits ordinary Read/Grep rather than adding a special legal tool; and
- it leaves interpretation to the model.

Future work is fixture-driven only: comments, tracked moves, manual ink,
revision author/time metadata, or literal marker collisions. No semantic diff
summarizer and no second projection stack.

## 8. Phase 4 — LATER: product-scale coding-harness capabilities

These features address long-running Beaver matters, not current ordinary LAB
cells. Build them one at a time after the artifact registry, bounded outputs,
result ledger, and resumability are sound.

### 8.1 Workspace discovery without auto-injection

The Library/matter surface should expose one bounded, incrementally listable
registry containing:

- stable path and file type;
- byte size and version;
- folder/matter membership;
- explicit-current-message attachment status;
- optional structural outline with directly callable Read spans; and
- availability of normalized text.

A DOCX, PDF, XLSX, email, or authority retains one visible identity even if the
host maintains different internal projections. The Table of Contents is a view
of this registry. It is not injected wholesale into every request and it does
not expose `.md` companions.

### 8.2 Interactive steering, follow-up, interrupt, and cancellation

Pi and Codex both support changing course during long work. This matters for a
30-minute data-room analysis much more than another retrieval primitive.

Smallest slice:

- queue one steering message to the active turn;
- interrupt provider execution safely;
- retain the last committed artifact and ledger state;
- make cancellation visible and idempotent; and
- leave fixed benchmark prompts unsteered.

Acceptance: a user can correct scope mid-run without losing durable work or
starting an unrelated duplicate job.

### 8.3 Durable resume and fork

Adopt the useful shape of Pi's JSONL session tree and Codex's resume/fork
lifecycle without copying their UIs.

Smallest slice:

- durable run/thread ID;
- parent pointer for a fork;
- current objective, provider state, committed file versions, and pending
  operations;
- idempotent resume after process restart; and
- no replay of already committed destructive/external actions.

Long-running ingestion/indexing continues to checkpoint per item or small
batch with atomic rename and heartbeats, as required by the root guide.

### 8.4 Evidence-preserving compaction

Follow master-plan P0.6 rather than adding a benchmark-only summary:

1. exact evidence/version/tool ledger;
2. lossy objective/progress/decision summary; and
3. recent verbatim tail.

The compacted state retains path, version, pinpoint, claim, accepted
instruction, pending decision, file operation, and tool receipt references.
The raw transcript remains durable. A summary cannot override source evidence
or cross matter boundaries.

The audited current tasks had no compaction event that explained their results,
so this remains a product feature, not a treatment-arm fix.

### 8.5 Version-anchored atomic DOCX edits

Adapt the useful idea behind hash/version-anchored coding edits:

- the model calls `Edit` on the visible `.docx` path;
- the call carries the base document version and exact anchors/patch;
- the host edits the hidden normalized projection;
- stale versions or ambiguous anchors refuse;
- the renderer creates/updates one consolidated assistant-edit version; and
- accept/reject receipts remain bound to that version.

The model never sees a render step or the projection filename.

### 8.6 Typed, bounded subagents for data-room scale

Use subagents only where the workspace is too large for one serial attention
path. Ordinary 3–31-document tasks already work with the flat surface.

First capability:

- read-only workers by default;
- a fixed bounded semaphore;
- partition by folder, topic, or query, never arbitrary model fan-out;
- schema-validated findings;
- exact source path/version/pinpoint for every claim;
- parent-owned synthesis;
- live worker transcripts and cancellation; and
- no worker-authorized external/destructive action.

Promotion requires a true data-room A/B against the flat harness, measuring
criteria/recall, wall clock, tokens, duplicate coverage, conflicting findings,
and parent merge quality. If fan-out merely multiplies reads, do not ship it.

### 8.7 Progressive tool exposure

Keep the resident core small. Legal organs and advanced mutation tools should
be available through bounded domain discovery only when the task warrants
them. This extends the schema-size reduction already recorded in master-plan
P0.7.

Do not grow a permanent 30-tool schema. Do not hide a tool the model must know
exists to complete an ordinary task. Measure tool-selection recall before
changing exposure.

### 8.8 Safe concurrency discipline

Codex's useful lesson is to run only declared-safe tools concurrently and give
writes exclusive ownership. Beaver should eventually classify:

- pure metadata/search/read operations as bounded concurrent candidates;
- document mutation, artifact commit, external send, and matter-state changes
  as exclusive; and
- unknown tools as exclusive by default.

Current traces do not show model tool-dispatch latency as the ordinary-task
bottleneck, so parallel dispatch is not an immediate feature. It becomes useful
with data-room workers and background indexing.

### 8.9 Durable execution ledger and live viewer

Promote the current LAB viewer pattern into the product only when needed:

- one chronological ledger;
- start/complete/error/cancel events;
- exact tool arguments and scope;
- source/output path, version, range, byte/character count, and hash;
- recovery and truncation metadata;
- provider-returned output and reasoning information;
- one tab per active or completed run; and
- autoscroll toggle without moving the layout.

Telemetry never enters model context. A telemetry defect can degrade diagnosis,
but cannot erase a valid work product.

### 8.10 External-effect approvals

Approval boundaries are needed when future tools send, file, submit, delete, or
publish. Ordinary local discovery and reads should not prompt. Destructive or
external actions must name the target, show the effect, and remain idempotent
or recoverable where possible.

## 9. Large-workspace and data-room architecture

The 2,863-document aerospace task exposed an architecture problem, not merely a
need for more context.

### 9.1 Retained first rung

The current direction is correct:

- batch ingest rather than thousands of whole-index rewrites;
- durable normalized projections keyed by document/version/source hash;
- bounded prewarming after ingest;
- eight-wide reads/scans over normalized text;
- library-scope receipts that preserve exact source/upload hashes for every
  document while extracting expensive text metrics only for exposed documents;
  and
- no attempt to grep Office binaries directly.

The earlier 657 ms measurement was only a warmed raw-byte scan of 141.8 MB. It
was not end-to-end transfer Grep and should not be used as the interaction
claim. End-to-end profiling found 2,863 separate parse-cache JSON reads and two
JSON parses per document:

- first full-corpus no-hit: 3.60s before and 4.43s after the per-turn cache—the
  new cache does not improve the first cold query;
- repeated same-turn full no-hit: 2.26–2.40s before, 0.24–0.38s after;
- rare `files_with_matches`: 3.50s before, 0.24–0.36s after;
- two concurrent cold no-hit Greps: 7.32s before, 3.76s in the traced
  single-flight run; and
- retained full-room process memory: roughly 364–450 MB heap and 596–634 MB
  RSS after trimming cached projection metadata.

Pre/post task processing improved independently:

- batch file ingest core: 75.15s to 3.16s;
- all 2,863 already-normalized projections loaded from the shared cache:
  4.5–7.3s;
- final receipt extraction for 29 exposed documents: 2.525s to 1.924s; and
- first-ever cold normalization at 24 workers: projected about 11.3 minutes
  from the measured 96-DOCX sample, versus about 29 minutes when two provider
  lanes independently contended and recomputed projections.

The win is cross-provider/content-addressed reuse and cheap repeated Grep, not
an acceptable first-cold search. The first query remains I/O/JSON bound and the
first-ever DOCX projection remains process-launch bound.

### 9.2 When to add an index

The next simplest search rung is one packed, versioned normalized-text artifact
plus a compact path/version/offset table, read sequentially or memory-mapped.
That removes thousands of small-file opens and JSON parses without changing
regex semantics or adding a retrieval model. Measure it against the same cold,
warm, concurrent, memory, and result-equivalence probes.

Do not add FTS merely because the matter is large. Add an FTS sidecar only if
the packed exact-text rung still misses the interaction target, particularly if:

- warm normalized-text Grep p95 exceeds the selected interaction target (for
  example, about two seconds); or
- repeated full-corpus Greps dominate measured task wall time.

An FTS index produces candidates; the exact versioned normalized projection
still supplies source text. Vector retrieval remains separately gated by a
held-out retrieval win over lexical search.

### 9.3 Scope semantics

A data room is a Library/matter scope, not 2,863 files explicitly attached to
one user message. Otherwise the explicit-attachment coverage rule would force
the model to expose every document before drafting.

The task may explicitly instruct the model to review the full room, but the
surface still lets it discover, search, partition, and hydrate evidence rather
than auto-injecting 141.8 MB into context.

### 9.4 Scale run as a separate gate

Do not place the data-room task in every quick regression. Maintain:

- focused deterministic/unit checks;
- an ordinary varied task suite; and
- a separate resumable scale gate with heartbeats and partial-state recovery.

When process priority is reduced, apply the same priority to both A/B arms;
otherwise wall-clock comparison is confounded.

## 10. Task-set growth

The suite should vary work type and scale rather than accumulate near-duplicate
contract tasks.

Required coverage:

- small, medium, long, and genuine data-room scale;
- extraction, comparison, drafting, markup review, spreadsheet/table work,
  legal research, diligence, and multi-artifact production;
- accepted-view DOCX, redline DOCX, PDF, XLSX, and email;
- single-document, conflicting-document, and many-document tasks;
- arithmetic/ratio, deadline, defined-term, source-attribution, and exact-
  filename criteria; and
- tasks where all current-message attachments matter plus tasks where a large
  Library contains irrelevant documents.

Task fixtures must be self-contained and expose no held-out rubric. Redline
tasks use the same markup-aware source plane in both arms. The ordinary upstream
arm remains native in every other material respect.

Selection should be based on diversity of failure opportunities and realistic
work size, not a fixed model-facing document count. “Read everything in the
matter” remains a separately labelled hypothesis.

## 11. Experiment, launch, retry, and judging discipline

### 11.1 Isolation

- Change one model-visible mechanism per experimental arm.
- Do not bundle duplicate suppression, Grep caps, attachment coverage,
  arithmetic, deadlines, term audits, or compaction.
- Hold provider, model, effort, task inputs, source plane, tool surface,
  output budget, and judge lane constant within each A/B.
- Use transcripts for causal interpretation, not to retrofit a
  benchmark-specific prompt.

### 11.2 Providers and concurrency

- DeepSeek inference is judged by DeepSeek.
- Luna High inference is judged by Luna High.
- DeepSeek and Luna use different providers and may run simultaneously.
- Up to the authorized ten workers per provider lane may run concurrently.
- No OpenAI per-token API spend.
- Luna/DeepSeek side evidence remains labelled separately from canonical
  Claude/Qwen controlled A/B evidence.

### 11.3 Reuse and rerun policy

Reuse a valid upstream result unless the new comparison materially changed its
model-visible request, source representation, tool surface, provider execution,
or required deliverable. Never repeat a usable upstream cell to satisfy a new
hash, campaign name, telemetry schema, or receipt field.

Stop or retry only for a real defect:

- provider failure before usable output;
- crash;
- missing, corrupt, empty, or ambiguous required deliverable;
- wrong model/provider/effort/source plane/tool surface;
- a model-visible tool defect that materially changed execution; or
- an unavailable/invalid judge result.

Do not stop or invalidate for:

- prompt/tool hashes that are sufficient to identify but not judge a run;
- telemetry bugs;
- receipt bugs after a valid artifact;
- cache annotations;
- campaign naming;
- recoverable intermediate tool errors; or
- human bookkeeping inconvenience.

### 11.4 Automatic bookkeeping

Runs own their state:

- deterministic cell identity;
- durable phase and attempt state;
- inference/judge pairing;
- resumable pending work;
- final artifact validation;
- automatic reuse of valid controls;
- explicit retry reason; and
- appended progress/heartbeat log.

The launcher should not require a human to hand-carry prompt hashes, run IDs,
replicate labels, judge paths, and dozens of tiny parameters for each launch.

## 12. Measurement and reporting contract

### 12.1 Primary table

Report only fully judged A/B pairs in this compact format:

| Provider | Task | Upstream criteria | Treatment criteria | Δ criteria | Upstream adjusted tokens | Treatment adjusted tokens | Δ tokens | Upstream wall | Treatment wall | Δ wall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| … | … | … | … | … | … | … | … | … | … | … |
| **TOTAL** | **N tasks** | **Σ** | **Σ** | **Σ** | **Σ** | **Σ** | **Σ** | **Σ** | **Σ** | **Σ** |

Use “criteria,” not the vague word “score.” Every table includes a numeric sum
row across all A/B columns. If results are collapsed by provider, use the same
columns and one sum row per provider. Any cross-provider total is explicitly
descriptive and not a canonical pooled claim.

### 12.2 Cache-adjusted tokens

Use a pinned provider-specific multiplier:

```text
adjusted tokens = uncached input + (cached input × cache multiplier) + output
```

For DeepSeek, the cache-hit multiplier is `0.02`, not `0.1`. Do not silently
apply that multiplier to a different provider; pin and report the lane's actual
equivalent or keep raw categories separate.

### 12.3 Acceptance metrics

Criteria remain primary. Also report:

- adjusted tokens;
- wall clock;
- retry/failure rate;
- tool calls by type;
- tool-result characters/bytes and truncations;
- exact duplicate calls;
- document exposure;
- deliverable existence, integrity, and filename correctness; and
- provider/judge identity.

Promotion requires:

- no new DNF or catastrophic task collapse;
- equal or better aggregate criteria;
- a strict attributable improvement in the feature's target metric;
- acceptable token, wall-time, and tool-output cost; and
- no evidence/version/provenance regression.

If a feature adds complexity without an attributable win, delete or leave it
off. A null experiment is evidence against rollout, not a reason to combine
three more mechanisms until something moves.

## 13. Ordered implementation queue

Each line is intended to be one focused change/PR unless noted as an operational
recovery action.

1. **IN FLIGHT — operational:** recovered data-room attempt-1 artifacts are in
   same-provider judging; do not rerun inference.
2. **NOW — operational:** canonically map only unambiguous antitrust filenames
   for substantive judging while retaining the filename failure.
3. **DONE — code (`57c31bd3`):** valid committed/auto-flushed artifacts satisfy
   finalization; corrupt/missing deliverables remain fatal.
4. **DONE — code:** hard-failure plus no active worker exits instead of spinning
   with a permanently pending queue.
5. **DONE — harness parity:** performer request remains instructions-only; title,
   rubric, benchmark, cache, projection, and telemetry leakage stay excluded.
6. **NOW — code:** unify source/generated artifact identity in the existing
   manifest/version plane.
7. **NOW — code:** enforce offset/limit/host caps on generated-artifact reads.
8. **NOW — regression:** lock the flat authoring contract and concise tool
   errors.
9. **IN FLIGHT — experiment:** exact duplicate Read suppression, alone.
10. **IN FLIGHT — experiment:** 500-character Grep content-line preview, alone.
11. **NEXT — experiment:** explicit-current-message attachment exposure, alone.
12. **NEXT — model-free:** replay existing arithmetic/deadline/term organs over
    recent artifacts and publish precision/coverage findings.
13. **NEXT — experiment:** source-bound arithmetic/table reconciliation, alone.
14. **NEXT — experiment:** analytical deadline omission audit, alone.
15. **NEXT — precision work:** defined-term/cross-reference report; live arm
    only after the offline precision gate.
16. **LATER — product:** steering/interrupt/cancel.
17. **LATER — product:** durable resume/fork.
18. **LATER — product:** evidence-preserving compaction.
19. **LATER — product:** version-anchored DOCX Edit.
20. **LATER — scale:** typed bounded read-only subagents.
21. **LATER — product:** progressive capability exposure and safe concurrency.
22. **NEXT — performance:** packed normalized-text corpus/offset table for fast
    first full-room exact search.
23. **MEASUREMENT-TRIGGERED:** FTS; then vectors only if separately earned.

Do not start an item merely because the preceding item exists. Each item starts
when its caller, dependency, and acceptance fixture are ready.

## 14. Explicit defer/reject list

Do not build from the present evidence:

- a deal-identity classifier or checkpoint;
- a transaction/source-family chooser;
- a general legal issue extractor;
- a general obligation graph;
- a broad authority recommender;
- semantic free-text slot reconciliation;
- task-specific covenant, OFAC, bankruptcy, FLSA, PSA, or deal calculators;
- legal-specific Read sizes or clause scopes;
- visible shadow Markdown files;
- a second redline/diff engine;
- full-Library auto-injection;
- a fixed model-facing document-count policy;
- an always-on reviewer/advisor model;
- always-on subagents;
- visible plan/TODO/checklist ceremony;
- hidden time-travel or continuation prompt rules;
- cross-matter automatic memory;
- LSP, DAP, AST, or tree-sitter prose summarization;
- broad shell/Python exposure;
- a permanent 30+ tool schema;
- FTS before scan latency earns it;
- vectors before a held-out lexical comparison earns them; or
- another context compiler, evidence union, forced planning turn, fact packet,
  or compulsory repair loop.

The model-derived checklist/plan hypothesis is especially deferred. Pi's core
deliberately avoids TODO machinery because it can confuse models, and the
current Beaver evidence does not show missing visible planning state as the
bottleneck.

## 15. Feature delivery template

Every proposed feature should use this small template before code begins:

### Feature name

- **Status:** NOW / NEXT / LATER / DEFER
- **Observed failure or caller:** exact trace, fixture, or product workflow
- **Hypothesis:** one falsifiable sentence
- **Smallest change:** one implementation slice
- **Reused code/contracts:** existing files and data model
- **Model-visible delta:** exact prompt/tool/result change, or “none”
- **Non-goals:** explicit nearby temptations
- **Focused checks:** deterministic fixtures
- **Live test:** only if model-visible or performance-semantic
- **Acceptance:** criteria plus target cost/correctness metric
- **Rollback:** condition that deletes/disables the feature
- **Rerun scope:** only cells whose model-visible conditions changed

This is a development record, not a model-facing plan tool.

## 16. Implementation map

These are the existing production or LAB seams to extend. Line numbers are
intentionally omitted because this roadmap spans several small changes and the
files are moving. Search for the named behavior before editing.

| Concern | Primary implementation | Focused checks or evidence |
| --- | --- | --- |
| Model-visible schemas and flat authoring | `backend/src/lib/chat/upstreamMikeBenchmarkSurface.ts` | `backend/src/lib/__tests__/localAssistantTools.finalArm.test.ts` |
| Glob/Grep/Read, normalization, generated artifacts, per-turn read state | `backend/src/lib/chat/localAssistantTools.ts` | `localAssistantTools.finalArm.test.ts`, `localAssistantTools.test.ts` |
| Self-contained LAB request | `backend/scripts/lab-beaver-arm.ts` | assembled-prompt snapshot and leakage scan |
| Auto-flush, mutation commit, post-turn receipts | `backend/src/routes/chat.ts` and `backend/scripts/lab-beaver-arm.ts` | valid-artifact/failed-receipt integration fixtures |
| Campaign retry, reuse, pool, and judging | `benchmarks/harvey-labs/scripts/run_coding_markdown_final_v5.mjs` and its successor | synthetic completed, retryable, and bookkeeping-only states |
| Historical hard-failure spin | `benchmarks/harvey-labs/scripts/run_coding_markdown_final_v1.py` | pending + no active + hard-failure regression |
| Viewer and live ledger | `backend/scripts/lab-run-viewer/` and `backend/scripts/lab-sse-live.ts` | run tabs, expanded args/results, output/reasoning, autoscroll |
| Redline source plane | `backend/src/lib/docx/redline.ts`, `docxDraftingSource.ts`, `docxTrackedChanges.ts` | existing DOCX redline/tracked-change fixtures |
| Derived values and competing bases | `backend/src/lib/legalDerivedValueScan.ts`, `legalFigureReconciliation.ts` | corresponding unit tests and model-free artifact replay |
| Spreadsheet/table spans | `backend/src/lib/spreadsheet.ts` | `backend/src/lib/__tests__/spreadsheet.test.ts` |
| Deadline pilot | `backend/src/lib/legalDeadlines.ts`, `legalDeadlineOmissionScan.ts` | corresponding unit tests and `slaWorkflow` integration tests |
| Terms and cross-references | `legalTermDrift.ts`, `legalUndefinedTermScan.ts`, `legalTextSkeleton.ts`, `docxStructuralLint.ts`, `legalCrossReference.ts`, `legalReferenceGrammar.ts` | corresponding focused tests plus real-instrument precision set |
| Durable session/evidence work | `anonymousProviderSessionStore.ts`, `llm/contextManifest.ts`, `chat/evidenceExposure.ts`, `routes/chat.ts` | `localChatEvidenceDurability.test.ts` and master-plan compaction gates |

Do not introduce a new wrapper or interface merely to make this table look
uniform. Extend the existing caller directly until a second real caller proves
a boundary.

## 17. Research and implementation references

Internal:

- [`beaver-master-plan.md`](beaver-master-plan.md)
- [`beaver-lean-runtime-and-context-plan.md`](beaver-lean-runtime-and-context-plan.md)
- [`harvey-lab-harness-features-plan-2026-08-03.md`](harvey-lab-harness-features-plan-2026-08-03.md)
- [`harvey-lab-index-arm-ideas-ledger-2026-08-05.md`](harvey-lab-index-arm-ideas-ledger-2026-08-05.md)
- [`lab-treatment-v2-design-2026-08-06.md`](lab-treatment-v2-design-2026-08-06.md)
- [`lab-composition-checkpoint-design-2026-08-08.md`](lab-composition-checkpoint-design-2026-08-08.md)
- [`harvey-lab-deterministic-wings-inventory-2026-08-05.md`](harvey-lab-deterministic-wings-inventory-2026-08-05.md)
- [`harvey-lab-deterministic-operationalization-2026-08-03.md`](harvey-lab-deterministic-operationalization-2026-08-03.md)
- [`upstream-mike-native-surface-spec-2266446b.md`](upstream-mike-native-surface-spec-2266446b.md)
- [`harvey-lab-replay-runner-design-2026-08-03.md`](harvey-lab-replay-runner-design-2026-08-03.md)
- [`document-mutation-token-efficiency-and-content-controls.md`](document-mutation-token-efficiency-and-content-controls.md)
- [`session-compaction-and-context-efficiency.md`](session-compaction-and-context-efficiency.md)

External implementation references:

- [Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Pi compaction design](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [Pi Grep implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/grep.ts)
- [Oh My Pi repository](https://github.com/can1357/oh-my-pi)
- [Oh My Pi task/subagent documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md)
- [Codex app-server lifecycle](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex repository agent guide](https://github.com/openai/codex/blob/main/AGENTS.md)

These references support conventions and implementation shapes. They do not
override Beaver's exact-evidence, local-first, versioning, privacy, or legal-
refusal requirements.

The older harness-feature and composition-checkpoint files preserve historical
hypotheses. Their earlier build orders, model-judge assumptions, and narrow
checkpoint proposals are not the current queue where they conflict with this
roadmap or the master plan. In particular, do not revive the composition
checkpoint ahead of the reuse audit and general source-bound computation pilot.
