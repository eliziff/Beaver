# A2AJ decision-roster experiment

## Goal

Derive auditable substantive opinion bodies and judge voting relationships for A2AJ decisions. Use a high-precision deterministic extractor when the source makes the answer explicit, and route only unresolved cases to the richer Luna extractor. Opinion boundaries are exact source-text offsets with verbatim anchors; paragraph ranges are derived metadata, not the extraction contract.

The experiment must remain siloed from the inflight compaction/tool-structure work. It must reuse the existing A2AJ, `SourceDoc`, lookup, locator, evidence, and SQLite machinery. It must not grow a second family of runners, watchers, caches, bridges, or generated artifacts.

## Current v4 architecture

1. The deterministic extractor recognizes explicit opinion ranges, author-bearing reasons headings, paragraph-start authors, BCCA joinders/signatures, and terminal disposition lines. It emits exact `[start, end)` offsets, boundary anchors, opinion alignment, and per-judge vote relationships.
2. A result is `ready` only when every substantive opinion has an author and alignment and every discovered judge has a result side. A sole unopposed opinion is `lead`; all judges who author or join it are majority, even when the source never uses that word.
3. `codex` normally accepts deterministic-ready cases locally and sends only `unresolved` or `unavailable` cases to Luna. `--force` is reserved for controlled cells whose input manifest was already prequalified for Luna.
4. Luna returns strict schema `a2aj_opinion_votes`: opinion authors/alignment and unique verbatim start/end quotes, plus judges with `result_side`, `relationship`, and `opinion_ids`. Validation resolves exact offsets, enforces a substantive-length floor and non-overlap, checks panel coverage, and verifies vote/opinion coherence.
5. Each Luna case gets a distinct ephemeral `codex exec`. Runs use a bounded worker pool, append each completed receipt immediately, preserve partial output, and can resume without repeating completed document IDs.
6. Cold deterministic screening reads IDs from the corpus's covering dataset index and fans independent derivations across up to ten persistent child processes. Workers receive only IDs and small metadata, then batch-read and compile their own source once through the existing bulk primitive; full case text is never serialized from the main process. Screen receipts cache source length and routing, so a resumed manifest can sample the qualified cache without reparsing.
7. The resumable audit uses the same ten-process batch pool. With a frozen full JSON or compact JSONL receipt input it source-hash checks each case and compares model output directly with the deterministic oracle for exact text boundaries, derived paragraph roles, and judge votes.

V4 additionally treats explicit non-participation as exclusion from the deciding
panel, filters institutional tails in tribunal panel descriptions, expands
unique short boundary anchors without moving their offsets, and persists the
raw schema submission for every rejected compact receipt. Historical v3 runs
remain immutable and retain their original prompt/validator behavior.

Seeded samples preserve pseudo-random draw order rather than sorting by document ID. A filtered manifest can prequalify an exact number of deterministic-unresolved cases while excluding an earlier manifest:

```powershell
node experiments/a2aj_decision_roster_qwen/harness.mjs manifest `
  --needs-llm --seed 123 --sample-size 15000 --scope ALL `
  --exclude-case-file experiments/a2aj_decision_roster_qwen/runs/earlier.manifest.json `
  --out experiments/a2aj_decision_roster_qwen/runs/luna-high-needs-llm15k.manifest.json
```

The screen starts with an interleaved sample from every eligible A2AJ dataset, then fills from the global seeded random order. Screening is local, resumable, ten-process by default, and makes no model calls. Use `--workers` to lower its process bound.

## Controlled paired run

Use one reproducible seed and one random case for the first smoke cell.

```text
same seed and same case
├── Luna-low run first
│   └── independent roster prediction
├── Qwen 9B / none / 32k run second
│   └── independent roster prediction; Luna output is not shown
└── comparison
    ├── judge identity and role agreement
    ├── opinion-span agreement
    ├── paragraph-role agreement
    └── runtime and turn count
```

Luna is a comparator/teacher candidate, not a hidden source of Qwen guidance. Its answer must be persisted separately and compared only after Qwen finishes.

## Source and structure truth

1. Read the local A2AJ corpus through the existing read-only provider path.
2. Compile paragraphs through the existing A2AJ `SourceDoc` compiler.
3. Before treating any roster as valid, audit the selected decision read-only at three levels:
   - raw stored A2AJ text;
   - the existing A2AJ structure summary;
   - emitted `SourceDoc` paragraph labels and ranges.
4. Audit the actual emitted paragraph set and reported missing labels. A gap is not itself a regression: the current compiler deliberately suppresses competing quoted-number ladders. Treat a gap as a structure regression only when raw evidence shows a decision paragraph was lost (for example, a heading joined to its own paragraph marker), and fail the experiment closed rather than teaching the model a false index.
5. Do not repair paragraph boundaries inside this experiment. Fix or test the shared structure machinery in its own lane.

## Read-only structure audit (2026-08-02)

- Full current-corpus sweep: 225,017 cases; 202,536 emitted a paragraph spine; zero compiler errors, duplicate labels, or non-monotone labels.
- 47,871 emitted spines (23.64%) have internal gaps. Most cannot be called defective without context because `monotoneScopes(maxGap=8)` intentionally excludes quoted/embedded number ladders.
- There are nevertheless 5,011 high-confidence heading-joined omissions. CITT is decisive: 4,647 omitted labels have a formal heading immediately followed by a dot-numbered paragraph, while recovery only runs for bracket numbering.
- `CITT PR-2023-044` (`Baja Construction Canada Inc.`) emits `par1` through `par15`, then `par17`, `par18`, `par20` through `par25`, then `par27` through `par32`; raw text contains the lost `[16]`, `[19]`, and `[26]` after sentence-style headings.
- `SourceDoc` computes `ranges.paragraph.missing`, but `summarizeA2AJSourceDoc` exposes only counts; no runtime caller consumes the missing-label signal.
- Initial Mike history finding: this is not a recent SourceDoc refactor regression. `c1142333` introduced missing-range computation; `d18580f1` introduced gap-tolerant monotone selection and hid ranges from the A2AJ summary; `622b01ae` added only title-case/bracket heading recovery.
- Independent ALR Quote Verifier lineage is now closed, read-only. Its nested repository is a separate Git root. Its first A2AJ structure commit, `882ce0a` (2026-07-12), introduced both the line-start marker rule and `monotone_scopes(max_gap=8)`; the accompanying test explicitly accepts the emitted sequence `[1, 2, 4, 6, 7, 8]`. Numeric contiguity was therefore never the shipped contract.
- `7e3764f` (2026-07-31) added a narrow improvement: recovery of title-case, bracketed heading-joined paragraphs. It did not change the line-start rule or gap-tolerant spine. It only invokes recovery for bracket style, so CITT's dot-numbered and sentence-style heading forms remain outside the reference implementation. This is a long-standing inherited coverage limitation, not a later Mike-only regression.
- The independent repository's full reachable history contains only those five structure-module commits; `7e3764f` is tagged `v1.02`. The parent of `882ce0a` contains no A2AJ paragraph-parser symbol, so no earlier committed contiguous-label implementation exists to have regressed.

## Deterministic preflight

Run a small deterministic search pass before the model sees the case. Report:

- judge/header candidates found by the existing lightweight header pass;
- searches for `majority`, `minority`, `dissent`, `concurring`, and reasons headings;
- zero-hit results explicitly;
- paragraph labels and short snippets for hits;
- the fact that these are search hints, not role adjudications.

The preflight may narrow the model’s hunt, but it must not silently assign majority or minority status. It should report what was tried and failed, not invent an answer.

## Qwen turn protocol

For every model turn, preserve a bounded audit in the existing progress stream:

- round and elapsed wall time;
- assistant text and thinking, when the provider exposes them;
- exact tool name and arguments;
- requested paragraph/range;
- lookup status, returned labels, and evidence ID;
- validation error and repair instruction.

Guide Qwen to use contiguous exact-range lookups, up to the existing per-call limit, instead of reading one paragraph at a time when a range is appropriate. Invalid locators must receive the valid canonical index and a precise next action.

The model must submit a complete partition of the actual SourceDoc paragraph set. It must not be rewarded for covering a merely numeric interval that contains nonexistent labels.

## Validation and evidence

Keep validation deterministic:

- opinion authors and judge names must occur in the source;
- every discovered panel member must appear in the vote graph;
- a sole substantive opinion must be the lead opinion;
- boundary quotes must be verbatim, unique, ordered, and long enough to anchor safely;
- exact source ranges may not overlap and must clear the substantive-word floor;
- result sides and relationships must agree with referenced opinion alignment;
- paragraph intersections are derived from exact offsets when a spine exists.

Use mechanical references only when explicit source boundaries cover the complete verified paragraph spine. Otherwise mark the reference unresolved. Human references remain a separate annotation path.

## Sidecar and comparison output

Store only derived metadata in the existing ignored sidecar SQLite:

- run configuration and seed;
- decision metadata and source hash;
- model predictions;
- judge-vote rows and exact opinion-text rows;
- evidence IDs;
- reference and metrics JSON.

Do not copy corpus text into the sidecar. Use the existing receipt/progress files under the already ignored `runs/` directory. The comparison command should print its result and write a file only when explicitly requested.

## Luna-high Codex exec screen

The lightweight Codex arm is a first-class command on the existing harness. It
runs each routed case independently through `gpt-5.6-luna` at high effort,
with an ephemeral, read-only, user-config-free Codex session and a strict JSON
output schema. The prompt contains the complete source text, optional paragraph
index, and term-search preflight. It does not contain the deterministic result.

Select explicit A2AJ document IDs on the command line:

```powershell
node experiments/a2aj_decision_roster_qwen/harness.mjs codex `
  --document-ids 123,456,789
```

For a longer arbitrary set, pass a UTF-8 file containing comma/newline-delimited
IDs or a JSON array of IDs:

```powershell
node experiments/a2aj_decision_roster_qwen/harness.mjs codex `
  --case-file experiments/a2aj_decision_roster_qwen/my-case-ids.txt `
  --out experiments/a2aj_decision_roster_qwen/runs/luna-high-check.json
```

Optional controls are `--model`, `--effort`, `--workers`, `--timeout-seconds`,
`--run-id`, and `--sidecar-db`. Defaults are `gpt-5.6-luna`, `high`, eight
workers, and 900 seconds per case. Omitting both explicit selectors retains the seeded `--seed`,
`--sample-size`, and `--scope` path.

The ignored run receipt records selection order, route, Codex CLI version,
model and effort, source/prompt/output hashes, elapsed time, token usage,
normalized prediction, exact source offsets and text hashes, derived paragraph
intersections, deterministic/mechanical comparison, and evidence IDs. The
progress JSONL and sidecar preserve per-case partial results.
The complete source and prompt body are not persisted; existing bounded header
and preflight snippets remain in the receipt for audit.

Each Luna case is a separate `codex exec --ephemeral` process. The runner uses
an asynchronous worker pool with a default of eight and hard maximum of ten workers;
one case is submitted to a worker at a time, and receipts are restored to the
input order after the dispatch completes. `--workers N` may lower concurrency
for a local smoke test but cannot raise it above ten. The `submit_roster`
payload is also the strict `json_schema` object used by GPT Responses-style
structured output (`name: a2aj_opinion_votes`); the same schema is written to
the Codex `--output-schema` file and embedded in the run receipt.

For corpus-scale screens, first create a reproducible manifest:

```powershell
node experiments/a2aj_decision_roster_qwen/harness.mjs manifest `
  --seed 123 --sample-size 30000 --scope ALL `
  --out experiments/a2aj_decision_roster_qwen/runs/luna-low-30k-manifest.json
```

Run that manifest with `--receipt-mode compact`. Completed cases are appended
to the adjacent `.receipts.jsonl` stream immediately after their sidecar row is
saved. If a long run is interrupted, repeat the same command with `--resume`;
the runner skips document IDs already present in that stream. The final JSON
receipt points to the stream rather than duplicating tens of thousands of
large per-case objects.

## Read-only run dashboard

The same append-only streams can be inspected with a small local dashboard;
it does not import the frontend build or modify the runner:

```powershell
node experiments/a2aj_decision_roster_qwen/harness.mjs dashboard `
  --port 8796 --frontend-url http://127.0.0.1:3000
```

Open `http://127.0.0.1:8796/`. The dashboard refreshes only on user request, shows a
progress bar and receipt counts, groups the run library by finished versus
failed/incomplete execution, and sorts finished runs by accepted outcome rate.
The default case scope is `All seeds / runs`; individual current and historical
runs are available from a compact selector in the detail header. Selecting a
run exposes paged, searchable cases sorted accepted → rejected →
structure unavailable → case failure. The case controls can filter to only
decisions with a concurring/dissenting (minority) opinion or sort those cases
first. Each case links to the local legal source viewer and displays the exact
character range, linking to its first derived paragraph when available.
`Receipts` downloads the raw JSONL stream for
later double-checking. Set
`--frontend-url` (or `BEAVER_FRONTEND_URL`) to the address where the Beaver
frontend is running so those source links open in the right app.

## Acceptance gates

- Typecheck and the runner self-test pass.
- Luna and Qwen select the same seeded case.
- Qwen’s prompt contains no Luna result.
- Raw-source and canonical-label audit reports no unexplained paragraph loss; otherwise the run is a structure regression finding, not a model score.
- Turn logs make it possible to tell whether Qwen understood the task, searched sensibly, used invalid locators, or stopped early.
- Paired comparison reports model agreement without pooling Luna and Qwen as one controlled model cell.

## Paragraph spine via competing +1 monotonic sequences

### Problem

`paragraphBlocks` (backend/src/lib/sourceDocA2AJ.ts:1063) scopes candidate
markers with `monotoneScopes(maxGap)` — a gap-tolerance bandaid:

- `maxGap=1` (a2aj mode) rejects real spines whose markers are heading-joined.
  2011 SCC 38 is a clean counterexample: `[1]`..`[111]` all exist, but 11 of
  them sit mid-line behind headings ("II. Facts, Proceedings and Issue
  1. Facts [3]", "III. Analysis [11]", "IV. Disposition [65]"), so the strict
  +1 scope fractures and the compiler emits 0 paragraphs. The reference
  implementation returns 107 (it bridges the residual holes with `maxGap=8`).
- `maxGap=8` (legacy/reference) admits end-of-doc citation lists as
  paragraphs: 1936 SCR 4's trailing `[1]`..`[20]` citation entries and 1936
  SCR 281's `[1]`..`[11]` reference list become a fake "spine" that the
  opinion/partition layer then trusts.

Digital A2AJ text has no missing glyphs: every `[N]` that "should" exist is
present. A marker is either (a) heading-joined (mid-line, recoverable), or
(b) part of a *competing* +1 sequence — an endnote/citation list or a quoted
provision of another case/statute. The mature reference (TFP
`sequence_page_map_detector.py`, PDF engine `footnote_pairing.py`
`select_label_backbone`) scores every candidate label site and selects the
strongest +1 monotonic chain, separating competing chains by scope.

### Plan (all inside sourceDocA2AJ.ts; no invocation from the worker/harness)

1. **Broaden heading-join recovery.** The current `looksLikeJoinedHeading`
   (sourceDocA2AJ.ts:836) rejects roman-numeral headings ("III.", "IV." —
   `^\p{Lu}\.$/` is single-letter-only) and trailing punctuation ("Facts,"
   in "II. Facts, Proceedings and Issue 1. Facts"). Adopt the reference's
   more permissive word grammar while keeping the uniqueness discipline (one
   exactly-matching candidate per missing label, bracketed by line-start
   neighbours). This alone recovers [3], [7], [10], [11], [16], [31], [35],
   [38], [43], [64], [65] in 2011 SCC 38.
2. **Competing-sequence scoring.** Port the reference scored DP
   (footnote_pairing.py `select_label_backbone`): each marker candidate earns
   a zone/substance score; adjacent +1 links earn a bonus; gaps are penalized
   (bounded); the global best increasing chain is the paragraph spine.
   Replaces the `monotoneScopes(maxGap)` split.
3. **Spine vs endnote disambiguation.** A second +1 chain in the tail whose
   blocks are citation-shaped (short bodies, reporter/case shape) is emitted
   as `footnote`-kind blocks (block model already has the kind), not
   paragraphs — recovering both structures instead of choosing one.
4. **Quoted provisions compete in the same scoring.** Keep
   `quotedDotProvisionStarts` as an explicit negative score rather than a
   hard fence, so a statute quote that also forms a +1 chain is excluded from
   the decision spine by score, and inline case pinpoints stay out.
5. **Tests.** Extend `__tests__/sourceDocA2AJ.test.ts`:
   - 2011 SCC 38 fixture -> `par1`..`par111` contiguous, `missing: []`
   - 1936 SCR 4 / SCR 281 fixture -> citation list emitted as footnote blocks,
     not paragraphs
   - quoted-provision + inline-pinpoint fixtures keep their refusal.

### Measurement gates

- SCC spine coverage on the 9000-row seeds: 1903/9000 today -> most of the
  209 modern marker rows (20 genuine failures like 2011 SCC 38) and the
  pre-2000 rows with real decision markers recover a spine.
- End-of-doc citation lists (1936 SCR 4, 281) must NOT become paragraphs;
  they become footnote blocks.
- 2011 SCC 38: `par1`..`par111` contiguous, `ranges.paragraph.missing = []`.
- All 50 sourceDocA2AJ tests + legalOpinionBoundaries tests keep passing;
  no regression on BCSC/FC/ONCA (95-100% spine coverage today).
- Re-capture seeds, `node harness.mjs verify --scope SCC` -> changed=0/9000.

## Verbatim user prompts for this revision

> ok, well we need luna to do its own run, then do the qwen run, then compare the two, yes. And I want you to inspect what qwen is doing within each turn to see if it understand the task and/or if there is some better way to guide it to hunt for majority/minority decisions. having it read whole paragraphs is probably not the fastest way to the solution, and having a deterministic layer either do some of the work, or report in the first model turn what was already tried and failed (e.g. we grepped for majority, minoirty etc and found 0 results), then we can probably make this faster.

> the fact that (1) it wrote the spans as several instead of just one and (2) the spans excluded certain paragraphs means that luna is not being instructred well here.

> a2aj paragraph labels are not non-contiguous. ever. if the structure layer is reporting that, read-only determine how severe taht issue is, because that would be a regression.

> check its work.

> write down ur plan (plus revisions I just asked for) into an .md

> write down my prompts to you verbatim

> plan + prompts
