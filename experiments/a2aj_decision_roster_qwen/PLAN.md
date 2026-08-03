# A2AJ decision-roster experiment

## Goal

Test whether a cheap quantized Qwen model can create useful sidecar data for a randomly selected A2AJ decision: the judges, their majority/minority/concurring roles, and the exact paragraph spans belonging to each opinion.

The experiment must remain siloed from the inflight compaction/tool-structure work. It must reuse the existing A2AJ, `SourceDoc`, lookup, locator, evidence, and SQLite machinery. It must not grow a second family of runners, watchers, caches, bridges, or generated artifacts.

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

- judge names must occur in the source;
- roles must be one of majority, minority, concurring, or unknown;
- every actual paragraph must be covered exactly once;
- ranges may not overlap or refer to absent paragraphs;
- accepted ranges are rehydrated through existing A2AJ lookup/evidence machinery.

Use mechanical references only when explicit source boundaries cover the complete verified paragraph spine. Otherwise mark the reference unresolved. Human references remain a separate annotation path.

## Sidecar and comparison output

Store only derived metadata in the existing ignored sidecar SQLite:

- run configuration and seed;
- decision metadata and source hash;
- model predictions;
- judge rows and paragraph-span rows;
- evidence IDs;
- reference and metrics JSON.

Do not copy corpus text into the sidecar. Use the existing receipt/progress files under the already ignored `runs/` directory. The comparison command should print its result and write a file only when explicitly requested.

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
