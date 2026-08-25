# A2AJ case-treatment experiment

This experiment asks one practical question: given a complete court decision,
can a model recover the judicial opinions and accurately describe what each
opinion does with every cited decision?

The unit is one containing decision. Citation detection supplies fallible
search hints, not the universe of references and not an alias-resolution
oracle.

```text
complete containing decision
        |
        +-- deterministic source structure and citation candidates
        |
        +-- stage 1: opinion boundaries, writers, joins, and result positions
        |
        +-- stage 2: every reference occurrence, reproduced passages,
                     proposition-level treatment, and procedural history
        |
        +-- exact-source compiler and receipts
        |
        +-- mechanical comparison + semantic grading against audited gold
```

The same gold record grades both the one-call and two-call paths. The two-call
path passes the complete decision to both stages; stage 2 also receives the
stage-1 structure. Initial calls and correction calls never silently retry at
the transport layer. Every case has its own model session, raw streamed output,
hashes, attempts, validation errors, and final receipt.

`--authority-pass` adds one experimental case-wide reading between structure
and treatment. It supplies a grounded inventory of cited decisions to the
single treatment call. It never splits a case into authority-specific calls,
and treatment remains free to add references that either inventory missed.

## Contract

`structure` records:

- complete substantive opinion boundaries using exact line-local quote anchors;
- named or institutional writers;
- every participant and express nonparticipant;
- full and partial joinders; and
- each opinion's and participant's position on the disposition.

`analysis` records:

- every supplied citation occurrence exactly once, plus references the detector
  missed;
- whose position surrounds each reference, so counsel, quoted decisions,
  decisions under review, metadata, and the current opinion remain distinct;
- exact passages reproduced from cited decisions when they matter;
- one treatment per treating opinion and cited proposition, with a compact
  signal, a complete semantic explanation, and exact evidence; and
- same-proceeding procedural history separately from precedential treatment.

There is no case-issue table or issue identifier. A proposition is the smallest
legally meaningful unit for the relationship being described. It may be a
sentence, several connected propositions, or the components of a legal test.
The model is not asked to resolve a citation to a global case identity. Exact
reference text and detector keys are retained so later alias knowledge can be
applied without rerunning inference.

## Grounding

All model spans are resolved to exact half-open offsets in the immutable source
text. An anchor must occur exactly once on its stated line. Beaver's existing
legal-evidence machinery produces durable receipts for the resolved spans.

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

Matching unmarked language against the *cited decision's* source requires that
source and is intentionally a later enrichment arm. It does not limit reference
recall in the closed-record experiment.

## Deterministic and semantic work

Deterministic code owns source preservation, line/offset resolution, hashes,
citation-candidate accounting, quote integrity, non-overlap, a conservative
opinion-length floor, and conservative coverage checks. Coverage is asserted
only inside opinion bodies the existing detector marks ready; uncertain text is
not converted into a false oracle.

The model owns questions that require reading law: whether text is the court's
own position, what proposition a cited decision supplies, what the current
opinion does with it, the scope of that treatment, and whether a citation is
same-proceeding procedural history. Those fields are graded semantically
against the gold. Opinion boundaries, writers, joins, votes, exact spans, and
detector accounting are compared mechanically.

## CLI

Run from `backend`:

```powershell
node_modules\.bin\tsx.cmd experiments\a2aj-case-treatment\cli.ts select `
  --count 30 --seed 12345 --out experiments\a2aj-case-treatment\gold\selection.json

node_modules\.bin\tsx.cmd experiments\a2aj-case-treatment\cli.ts packets `
  --case-file experiments\a2aj-case-treatment\gold\selection.json `
  --out-dir experiments\a2aj-case-treatment\packets --workers 8

node_modules\.bin\tsx.cmd experiments\a2aj-case-treatment\cli.ts validate-gold `
  --gold experiments\a2aj-case-treatment\gold\gold.jsonl --workers 8

node_modules\.bin\tsx.cmd experiments\a2aj-case-treatment\cli.ts run `
  --case-file experiments\a2aj-case-treatment\gold\selection.json `
  --mode two-stage --provider codex --model gpt-5.6-luna --effort max `
  --workers 10 --call-budget 180 --out-dir experiments\a2aj-case-treatment\runs\luna-max

# Optional comparison arm: add --authority-pass and budget three stages.
```

Ox Alpha can be spread across several gateway routes in the same run. Case
assignment is stable round-robin over the requested document IDs, each route
has its own limiter and preflight, and a failed case never moves silently to a
different route:

```powershell
hermes portal
hermes proxy start

node_modules\.bin\tsx.cmd experiments\a2aj-case-treatment\cli.ts run `
  --case-file experiments\a2aj-case-treatment\gold\selection.json `
  --mode two-stage --provider ox-alpha --effort high `
  --ox-routes openrouter,opencode-zen,nous,kilo `
  --workers 10 --call-budget 180 `
  --out-dir experiments\a2aj-case-treatment\runs\ox-alpha-multi
```

OpenRouter requires `OPENROUTER_API_KEY`; OpenCode Zen is anonymous; OpenCode
Go is an optional subscription route using `OPENCODE_API_KEY`; Nous uses the
official local Hermes OAuth proxy; Kilo is anonymous unless `KILO_API_KEY` is
set. A live model-catalog preflight verifies the route/model and, where the
catalog supplies prices, fails closed unless both token prices remain zero.
Kilo currently flags the free model as eligible for prompt training, so use
that route only for public material.

`show-prompt`, `show-schema`, and `show` expose the exact model surface and
numbered primary text before a run. `benchmark` performs the mechanical
comparison. `judge` sends only valid semantic differences to the configured
judge. `raw-output` recovers a call byte-for-byte by call ID. `export` emits
flat treatment and procedural-history records while retaining exact references,
detector keys, proposition support, and evidence hashes.

Generated packets and run output are ignored. The selected case list, authored
gold, contract, tests, and durable findings are tracked.
