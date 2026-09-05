# A2AJ case-treatment experiment

The product-aligned ten-case benchmark is
`gold/gold-product-10-v1.jsonl`. It keeps only scored opinion structure,
direct-review outcomes, reported appellate history, and proposition-level
treatments. `gold/gold-fresh-10-v2.jsonl` remains the unchanged exhaustive
source annotation used to build and audit that pared projection. See
`GOLD.md` for the inclusion rule.

This experiment asks one practical question: given a complete court decision,
can a model recover the judicial opinions and accurately describe what each
opinion does with every cited decision?

The unit is one containing decision. The model reads the case itself; a
deterministic citation detector is not shown to it and does not define the
universe of cited decisions.

```text
complete containing decision
        |
        +-- stage 1: opinion boundaries, writers, joins, and result positions
        |
        +-- stage 2: one case-wide reading of every cited decision,
                     same-litigation relationships, and opinion-level treatments
        |
        +-- exact-source compilation
        |
        +-- private no-oracle checks + targeted patch correction
        |
        +-- mechanical comparison + semantic grading against audited gold
```

The same gold record grades both the one-call and two-call paths. The two-call
path passes the complete decision to both stages; stage 2 also receives the
stage-1 structure. Initial calls and correction calls never silently retry at
the transport layer. Every case has its own model session, raw streamed output,
hashes, attempts, validation errors, and final receipt.

## Contract

`structure` records:

- complete substantive opinion boundaries using exact line-local quote anchors;
- named or institutional writers;
- every participant and express nonparticipant;
- full joinders and exact passages expressing qualified agreement; and
- each opinion's and participant's position on the disposition.

The normal `simple` analysis has four flat case-wide lists:

- one in-source label for every adjudicative decision cited, quoted, or
  described in the judicial reasons, disposition, or court-authored procedural
  account;
- each same-litigation decision directly under review and every action the
  present court takes on it; and
- each statement that another decision was later affirmed, reversed, varied,
  quashed, remitted, or received a material leave disposition; and
- each opinion's proposition-level treatments of any other decision, including
  a directly reviewed decision whose reasoning is used or evaluated, with a compact
  signal, semantic explanation, source blocks, and any exact words reproduced
  from the cited decision.

The treatment stage has three interchangeable contracts. `simple` asks Luna for
the cited decision, proposition, treatment, signals, and source blocks; the
host derives the treating opinion and separately retains deterministic quote
candidates. `self-check` additionally makes Luna name the treating opinion and
copy short verbatim support and cited-decision quotations. The host aligns
those copies to exact offsets and independently checks the stated opinion. Both
rich contracts compile to the same record and use the same gold and semantic judge.
The `hypersimple` ablation removes the citation inventory, identifying blocks,
copied passages, and model-written opinion IDs. It returns only flat direct
outcomes, reported history, and treatments with one headline signal; the host
derives opinion attribution and exact offsets from source blocks.

There is no case-issue table or issue identifier. A proposition is the smallest
legally meaningful unit for the relationship being described. It may be a
sentence, several connected propositions, or the components of a legal test.
The model is not asked to resolve a citation to a global case identity. It
merges aliases only when the containing decision makes their identity clear;
later alias knowledge can be applied without rerunning treatment inference.

## Grounding

Opinion-structure anchors and treatment block IDs are resolved to exact
half-open offsets in the immutable source text. In the self-check arm, copied
support and quoted passages must occur in the selected blocks; normalized
whitespace and typographic punctuation are accepted, while the receipt retains
the exact source text and whether alignment was exact or normalized. Beaver's
existing legal-evidence machinery produces durable receipts.

The existing quote-integrity primitive also checks quotation marks in analyst
prose and detects substantial unmarked copying. Its built-in length,
distinct-content-word, and stop-word thresholds ignore trivial shared phrases.
Marked quotations in the decision are collected separately as deterministic
candidates only when they contain at least four words and 24 characters.

If compilation fails, the runner may make a bounded correction call containing
the exact validation errors and relevant source receipts. The model returns only
an RFC 6902 JSON Patch; the host applies it to the retained draft and revalidates
the result. Stateless routes also receive the original task and prior draft.
A correction is a recorded new call, never an invisible retry.

After the draft, a conservative no-oracle check looks only at the source,
accepted opinion boundaries, deterministic citation output, footnote links,
and the draft. Repeated occurrences linked to one detected authority count
once. An unmatched citation form is retained as `unresolved`, because it may be
an alias of a decision already listed. It becomes a correction-triggering
omission only when the draft lists no cited decision at all. Gold is never
available to this check or to inference.

Matching unmarked language against the *cited decision's* source requires that
source and is intentionally a later enrichment arm. It does not limit reference
recall in the closed-record experiment.

## Deterministic and semantic work

Deterministic code owns source preservation, line/offset resolution, hashes,
quote integrity, non-overlap, a conservative opinion-length floor, conservative
coverage checks, and the post-draft citation receipt. Coverage is asserted only
inside opinion bodies the existing detector marks ready; uncertain text is not
converted into a false oracle.

The model owns questions that require reading law: whether text is the court's
own position, what proposition a cited decision supplies, what the current
opinion does with it, the scope of that treatment, and what the present court
directly did to a decision under review. Those fields are graded semantically
against the gold. Opinion boundaries, writers, joins, votes, express result-only
agreement, exact spans, and no-oracle receipts are checked mechanically. The
semantic judge receives only treatments, direct outcomes, and reported history,
not the citation roster or mechanical validation work. Gold-reference accuracy
is scored separately from unmatched candidate claims, so accurate extra
discoveries cannot compensate for omitted gold propositions.

Point-level support is deliberately conservative. Writers and full joiners are
confirmed supporters. A qualified agreement is retained as exact source
evidence but is not assigned to individual treatments by the extraction model.
If qualified agreements could change the count, support is `unresolved` until a
later case-wide semantic resolver groups compatible positions and applies those
agreements.

## Gold authoring

Fresh gold is authored through Beaver's Codex app-server transport, not through
the benchmark CLI. From `backend`:

```powershell
node_modules\.bin\tsx.cmd experiments\a2aj-case-treatment\author-gold.ts `
  --case-file experiments\a2aj-case-treatment\gold\selection-smoke-10.json `
  --run-dir experiments\a2aj-case-treatment\runs\fresh-gold-10-v2 `
  --gold experiments\a2aj-case-treatment\gold\gold-fresh-10-v2.jsonl `
  --model gpt-5.6-sol --effort max --workers 10 --audits 2
```

Each case uses a distinct author thread. Compiler feedback is returned as
targeted JSON Patch requests. Per-case drafts, raw streamed output, patches,
usage, and receipts survive interruption; rerun the same command to resume.
Each record then receives two complete primary-source audits in its persisted
case thread. Draft and admitted partial files remain in the run directory, but
the requested gold file is written only after every selected case has completed
both audits.
`--audits 0` or `--audits 1` may be used to stop at a resumable draft stage;
neither can publish benchmark gold. `--dry-run` checks source availability,
prompts, and schemas without making model calls.

## CLI

Run from `backend`:

```powershell
node_modules\.bin\tsx.cmd experiments\a2aj-case-treatment\cli.ts select `
  --count 30 --seed 12345 --out experiments\a2aj-case-treatment\gold\selection.json

node_modules\.bin\tsx.cmd experiments\a2aj-case-treatment\cli.ts packets `
  --case-file experiments\a2aj-case-treatment\gold\selection.json `
  --out-dir experiments\a2aj-case-treatment\packets --workers 8

node_modules\.bin\tsx.cmd experiments\a2aj-case-treatment\cli.ts validate-gold `
  --gold experiments\a2aj-case-treatment\gold\gold-ablation-10-v6.jsonl --workers 8

node_modules\.bin\tsx.cmd experiments\a2aj-case-treatment\cli.ts run `
  --case-file experiments\a2aj-case-treatment\gold\selection.json `
  --mode two-stage --provider codex --model gpt-5.6-luna --effort max `
  --analysis-contract simple --analysis-audits 1 `
  --workers 10 --out-dir experiments\a2aj-case-treatment\runs\luna-max
```

For the normal inference, mechanical benchmark, and semantic-judge sequence,
use the single launcher from the repository root. It starts semantic judging as
each case receipt lands; one slow inference case does not hold the others at a
run-wide barrier. Inference and judging share one Codex app-server process;
the launcher never starts competing transport processes.

```powershell
.\backend\experiments\a2aj-case-treatment\run-benchmark.ps1 `
  -CaseFile backend\experiments\a2aj-case-treatment\gold\selection-smoke-10.json `
  -Gold backend\experiments\a2aj-case-treatment\gold\gold-product-scale-current.jsonl `
  -RunName v6-simple-luna-max -Model gpt-5.6-luna -Effort max -Workers 10 `
  -AnalysisContract simple
```

Run the same command with a different `RunName` and
`-AnalysisContract self-check` for the explicit-verification arm, naming the
first run as the source of the shared opinion pass:

```powershell
.\backend\experiments\a2aj-case-treatment\run-benchmark.ps1 `
  -CaseFile backend\experiments\a2aj-case-treatment\gold\selection-smoke-10.json `
  -Gold backend\experiments\a2aj-case-treatment\gold\gold-product-scale-current.jsonl `
  -RunName v6-self-check-luna-max -Model gpt-5.6-luna -Effort max -Workers 10 `
  -AnalysisContract self-check -StructureRunName v6-simple-luna-max
```

The second run refuses a missing, stale, or invalid structure checkpoint; it
never substitutes a new opinion-stage call. It also requires the source run to
use the same cases, provider, model, effort, structure prompt, examples,
correction policy, limits, and worker count. The launcher allows up to 131,072
output tokens by default so difficult full-case analyses are not truncated.

`-AnalysisContract hypersimple` is the minimal treatment ablation. It reuses a
completed two-stage opinion run and asks only for flat direct-outcome and
treatment rows. The host derives cited-decision inventory, treatment opinion,
source offsets, exact text, hashes, and grouped procedural relationships. It
compiles to the same semantic judge surface as `simple`; fields the model was
never asked to emit are not treated as semantic errors.

Rerunning the same command recompiles preserved stage drafts first, then resumes
only stages and cases that still need model work. Model-call
budgets auto-size to the pending work; `--call-budget` remains available as a
per-invocation ceiling for direct CLI use. Provider failures stop immediately
and can be retried by rerunning the command.

After a valid case-wide analysis, one case-wide audit call returns only JSON
Patch operations for omitted or inaccurate decision mentions, procedural
relationships, or treatments. The patched analysis is recompiled and saved as
its own checkpoint. Set `--analysis-audits 0` only for an ablation.

`show-prompt`, `show-schema`, and `show` expose the exact model surface and
numbered primary text before a run. `benchmark` performs the mechanical
comparison. `judge` sends only semantic differences requiring legal judgment;
exact matches and absent semantic drafts are scored without model calls.
`raw-output` recovers a call byte-for-byte by call ID. `export` emits
flat treatment and procedural-relationship records while retaining exact cited-case
text, conservative opinion-support bounds, reproduced passages, and evidence
hashes.

Generated packets and run output are ignored. The selected case list, authored
gold, contract, tests, and durable findings are tracked.

For mechanically graded opinion structure, `run-structure-consensus.ps1`
runs independent structure-only members and reports single-member and prefix
consensus accuracy, token usage, and measured output diversity. Codex app-server
does not expose temperature or seed, so the default nine-member design crosses
Luna low/medium/high effort with direct, boundary-first, and vote-first reading;
the conservative structure cues are alternated across those combinations. If
the outputs do not differ, the receipt shows that consensus supplied no extra
signal.
