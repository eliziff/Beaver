# Do deterministic math and date tools improve LLM correctness on legal computation?

A minimal paired probe. 24 micro-probes x 2 conditions, n=1 per cell, one model.

- **Date:** 2026-08-05
- **Model:** `claude-sonnet-4-6` via `claude -p` (flat-rate subscription CLI; provider `firstParty` asserted on every run)
- **Conditions:** `bare` (no tools at all) vs `tools` (a two-tool MCP stdio server: `calc`, `date_math`)
- **Prompts:** byte-identical across conditions. Only the system prompt differs, by the two sentences that announce the tools; it explicitly does *not* instruct the model to use them.

## Headline

| | bare | tools | delta |
|---|---|---|---|
| **overall accuracy** | 24/24 (100.0%) | 24/24 (100.0%) | +0.0 pp |
| A — date computation | 8/8 (100%) | 8/8 (100%) | +0 pp |
| B — arithmetic | 8/8 (100%) | 8/8 (100%) | +0 pp |
| C — extraction + compute | 8/8 (100%) | 8/8 (100%) | +0 pp |

**Paired outcomes (McNemar layout).** both correct 24 · tools-only correct 0 · bare-only correct 0 · neither 0.
Discordant pairs: 0. Two-sided exact binomial p = 1.0000 (not significant).

## Verdict

**No accuracy effect, because there was no headroom.** Both conditions answered all 24 probes correctly. Zero discordant pairs, so the paired test has nothing to test.

That null needs stating carefully. **A null measured at ceiling is not evidence that tools do not help** — it is evidence that these probes were too easy to discriminate. `claude-sonnet-4-6` does 45-day offsets and five-term sums reliably unaided, so no instrument built from computations this small can detect a correctness benefit. The design's real failure is that it did not bracket the difficulty at which the bare model starts to break. To measure accuracy, the probes would have to be hard enough for the bare arm to fail some of them.

What the run does show, unambiguously, is a **cost effect, and its sign depends on the family.** Overall the tools condition spent 69% of the bare condition's output tokens (15793 vs 22882), but that average hides two opposite behaviours.

Per family:

- **A — date computation.** bare 8/8, tools 8/8 (no accuracy difference). Uptake 8/8. Output tokens 14128 -> 8058 (**57%**).
- **B — arithmetic.** bare 8/8, tools 8/8 (no accuracy difference). Uptake 8/8. Output tokens 3117 -> 3462 (**111%**).
- **C — extraction + compute.** bare 8/8, tools 8/8 (no accuracy difference). Uptake 8/8. Output tokens 5637 -> 4273 (**76%**).

Family A carries one outlier: A7, the defective clear-days probe, is the single most expensive run in the whole sweep (4968 output tokens with tools against 3185 without) because getting it right required reasoning *around* the tool's built-in convention rather than deferring to it. Excluding A7, family A's date probes cost **10943 bare against 3090 with tools — 28%, a 3.5x saving.**

So the shape of the answer is:

- **Date arithmetic is where a deterministic tool pays.** Unaided, the model enumerates the calendar — A5 spent 2503 output tokens walking 540 days forward, A2 spent 2897 counting a 657-day interval — and one `date_math` call replaces all of it (260 and 378 tokens respectively). Same answer, a fraction of the reasoning.
- **Plain arithmetic is where it does not.** Family B *rose* to 111% of baseline. A five-term sum or a percentage is something the model does in one line; wrapping it in a tool call adds the call, the result, and a sentence interpreting the result. The tool is pure overhead at this size.
- **Extraction-plus-compute sits in between** (76%), which fits: the extraction half is unaffected by tools, and only the compute half can be offloaded.

**Uptake was total — 24/24 probes, 45 calls — on a prompt that merely said the tools existed and were optional.** The model reached for them everywhere, including the family-B cases where doing so cost more than it saved. That is worth knowing on its own: offering a tool is close to instructing its use, so the decision about *when* a tool is worth calling cannot be delegated to the model by phrasing alone.

## Caveats — how far this generalises

This is a valence probe, not a measurement of production behaviour.

- **The accuracy arm is uninformative, and that is a design failure, not a finding.** With both conditions at 24/24 there are zero discordant pairs, so the McNemar test has no data and the 4.2 pp resolution of a single probe is moot. Do not read "no difference" as "tools do not help correctness"; read it as "these probes could not tell." The one probe that produced any signal at all, A7, turned out to be measuring the gold rather than the model.
- **n = 24 probes, one run per cell.** No repeats, so per-probe sampling noise is entirely unmodelled. A single flipped coin moves overall accuracy by 4.2 pp.
- **One model, one harness.** `claude-sonnet-4-6` through `claude -p`. Nothing here transfers to smaller models, where the arithmetic floor is much lower and tools would plausibly matter far more.
- **Toy contexts.** Every probe is under 2,000 characters with the operative numbers already isolated and every counting convention spelled out in the prompt. Real documents hide the numbers, contradict themselves, and leave conventions implicit. The extraction half of family C is a shadow of the real difficulty.
- **The computations are small.** Sums of five terms, 45-day offsets, one-step percentages. A frontier model does these reliably in its head; that is exactly what the ceiling in this data shows. The interesting regime — long chains, many operands, unusual day-count conventions — is not sampled here.
- **Uptake is prompt-sensitive.** The system prompt announced the tools neutrally and did not require them. Uptake was still 24/24, so this design cannot separate "the model judged the tool useful" from "the model uses an offered tool by default." Measuring genuine tool *judgement* needs probes where calling the tool is clearly the wrong move.
- **The tools encode conventions, and deference propagates them.** `date_math`'s `add_business_days` implements one business-day rule. A7 needed a different one, and the correct answer required working around the tool rather than trusting it. A deterministic tool removes arithmetic error but introduces convention error, and the second failure mode is quieter than the first because the output looks authoritative.

### What would make this measurable

The instrument needs headroom before it can measure accuracy. Three changes, in order of expected value:

1. **Raise difficulty until the bare arm fails.** Longer chains (six or eight sequenced periods, not three), real day-count conventions (30/360, actual/360, month-end roll), holiday calendars, compounding rather than simple interest, and figures that must be reconciled across contradictory sources. Calibrate by running the bare arm alone first and keeping the items it gets wrong 20-50% of the time.
2. **Repeat each cell.** n=1 cannot separate a real flip from sampling noise. Five runs per cell at the calibrated difficulty would give per-probe rates rather than binary outcomes.
3. **Add a third arm where the tool is wrong to call**, so uptake measures judgement instead of compliance.

## Design

**The probes.** 24 items, 8 in each of three families, every one under 2,000 characters and written as realistic drafting — a credit agreement covenant, an indemnity cap, a fee application, a merger termination clause — with exactly one machine-checkable answer emitted as a final `ANSWER:` line.

- **A, date computation.** Cure deadlines, day counts between two dates, "ten (10) Business Days after", multi-period sequencing, a weekend-roll convention. Every counting convention (business day = Mon-Fri, holidays disregarded, day of the triggering event not counted) is stated *in the prompt*, so the probe tests calendar arithmetic and not legal knowledge.
- **B, arithmetic.** Sums over a distribution table, a percentage-of-EBITDA basket test, simple interest on a day-count fraction, a pro-rata split, a deductible-and-cap waterfall, a working-capital adjustment.
- **C, extraction + compute.** Figures scattered through prose and then combined: a cap minus three carve-outs, the earliest of three relatively-defined dates, tiered royalties, two interlocking notice periods.

**Gold answers.** Computed three independent ways and required to agree before any run: (1) the Node generator that emitted the prose, (2) a Python recomputation from each probe's machine-readable spec using `datetime`/`Decimal`, (3) a hand-written Python derivation keyed to the prose facts rather than the spec. The verifier additionally checks that every weekday word asserted in the prose is true, and that no gold value appears verbatim in its own prompt. No gold was computed mentally. That triple check was still not sufficient — one gold (A7) was wrong anyway, for a reason the check was structurally blind to; see the defect section.

**The tools.** A hand-rolled MCP stdio server, no SDK, exposing exactly two:

- `calc` — an arithmetic expression evaluator with **no `eval`**: a tokeniser and recursive-descent parser over exact BigInt rationals, so `0.1 + 0.2` is `0.3` and money never drifts. Accepts `+ - * / ^ ( )`, a postfix `%` meaning divide-by-100, and ignores `,` `_` `$` inside numerals. Any other character is a typed refusal, not a guess.
- `date_math` — civil-calendar arithmetic on Hinnant's days-from-civil algorithm: `add_days`, `subtract_days`, `add_business_days` (Mon-Fri, no holidays, start date not counted), `diff_days`, `business_days_between`, `weekday`. Unparseable or invalid dates raise rather than coerce.

**The two conditions.** The user prompt is byte-identical. The system prompt differs only by two sentences naming the tools and saying "You may use them if you find them helpful. You are not required to use them." — deliberately permissive, because uptake is one of the things being measured. The bare arm gets no `--mcp-config` at all; both arms run `--tools ""` so no built-in tool is ever available.

**Scoring.** Exact match after light normalisation — dates accepted in ISO, "April 17, 2026", or `4/17/2026` form and compared as ISO; money stripped of `$`, commas and whitespace and compared in integer cents. A missing or unparseable `ANSWER:` line scores wrong.

## One probe defect, found and corrected

**A7's original gold was wrong, and both models were right.** This is disclosed in full because the correction was made after seeing model output, which is exactly the sort of move that can launder a result.

A7 asks for the latest date on which notice of a January 20, 2027 meeting may be given, under a clause requiring notice "not less than fifteen (15) Business Days before" the meeting and adding: *"Neither the date of the meeting nor the date of the notice is counted when determining whether fifteen Business Days have intervened."*

That is a **clear-days rule** — fifteen business days must fall *strictly between* the two dates. The generator computed the gold as a plain `add_business_days(2027-01-20, -15)`, which excludes only the meeting date and counts the notice date itself as day fifteen. Those differ by one:

| candidate notice date | business days strictly between it and Jan 20 | satisfies "fifteen ... have intervened"? |
|---|---|---|
| 2026-12-30 (original gold) | 14 | no |
| 2026-12-29 (corrected gold) | 15 | yes |

Both conditions answered `2026-12-29`. The tools arm got there deliberately — it anchored on January 19 (the day before the meeting, since the meeting date is uncounted), stepped back fifteen business days, then called `business_days_between` to check its own work. So the correction flips A7 from *both wrong* to *both correct*: it moves the two arms identically and **cannot** change the discordant-pair count or the direction of the verdict. It raises both accuracies by the same one probe.

The reason the original verifier missed this is worth stating plainly: it checked three independent *derivations* of the gold, but all three encoded the same convention assumption. Agreement among implementations is not agreement with the document. The prose-versus-convention reading was the unchecked step, and it is the step that failed.

After the correction, all 24 golds re-verify across three derivations, with A7's hand-derivation rewritten to search for the latest qualifying date rather than apply an offset. A full manual audit of the prose-versus-gold convention for all 24 probes found no other defect. Scoring in this report is recomputed from `probes.json` at analysis time (2 run records rescored), so no model call needed re-running.

## Tool uptake

| | value |
|---|---|
| probes where at least one tool was called | 24/24 (100%) |
| total tool calls | 45 |
| uptake, family A | 8/8 (100%) |
| uptake, family B | 8/8 (100%) |
| uptake, family C | 8/8 (100%) |
| tools invoked | `date_math` on 11 probes; `calc` on 13 probes |

**Tools called but answer still wrong:** 0.
**Tools available but not called:** 0 probes — 0 correct, 0 wrong.

## Cost of the tools condition

| | bare | tools | ratio |
|---|---|---|---|
| output tokens (total) | 22882 | 15793 | 0.69x |
| uncached input tokens (total) | 7785 | 110 | 0.01x |
| cache read tokens (total) | 0 | 57023 | - |
| cache creation tokens (total) | 0 | 44017 | - |
| **all input tokens (uncached + cache)** | 7785 | 101150 | 12.99x |
| wall time, seconds (total) | 352 | 358 | 1.02x |
| notional cost, USD (total) | $0.3666 | $0.5184 | 1.41x |

The input-side split matters: the tools arm pays for the two tool schemas on every call, but they land in the prompt cache, so its *uncached* input is near zero while its cached input is large. The output side is the honest comparison, and it is where the two conditions actually diverge.

Median output tokens: bare 524, tools 490.
Median wall time: bare 10.8s, tools 12.7s.

> The USD figures are the CLI's own notional accounting. Every call ran on the flat-rate subscription; no per-token spend was incurred. They are reported only as a relative cost signal.

## Per-probe results

`ok` = exact match against a gold answer computed three independent ways. A7's gold is the corrected one; see the defect section above.

| probe | family | gold | bare | bare answer | tools | tool calls | tools answer |
|---|---|---|---|---|---|---|---|
| A1 | A | `2026-04-17` | ok | `2026-04-17` | ok | 1 | `2026-04-17` |
| A2 | A | `657` | ok | `657` | ok | 1 | `657` |
| A3 | A | `2026-07-09` | ok | `2026-07-09` | ok | 1 | `2026-07-09` |
| A4 | A | `2026-05-26` | ok | `2026-05-26` | ok | 3 | `2026-05-26` |
| A5 | A | `2027-05-24` | ok | `2027-05-24` | ok | 1 | `2027-05-24` |
| A6 | A | `2024-10-12` | ok | `2024-10-12` | ok | 1 | `2024-10-12` |
| A7 | A | `2026-12-29` | ok | `2026-12-29` | ok | 2 | `2026-12-29` |
| A8 | A | `2026-06-08` | ok | `2026-06-08` | ok | 2 | `2026-06-08` |
| B1 | B | `75000000.00` | ok | `75000000.00` | ok | 1 | `75000000.00` |
| B2 | B | `10338000.00` | ok | `10338000.00` | ok | 1 | `10338000.00` |
| B3 | B | `825000.00` | ok | `825000.00` | ok | 2 | `825000.00` |
| B4 | B | `69600.00` | ok | `69600.00` | ok | 1 | `69600.00` |
| B5 | B | `2250000.00` | ok | `2250000.00` | ok | 2 | `2250000.00` |
| B6 | B | `4375000.00` | ok | `4375000.00` | ok | 3 | `4375000.00` |
| B7 | B | `2750000.00` | ok | `2750000.00` | ok | 2 | `2750000.00` |
| B8 | B | `94285750.00` | ok | `94285750.00` | ok | 2 | `94285750.00` |
| C1 | C | `19500000.00` | ok | `19500000.00` | ok | 2 | `19500000.00` |
| C2 | C | `2026-08-01` | ok | `2026-08-01` | ok | 3 | `2026-08-01` |
| C3 | C | `806400.00` | ok | `806400.00` | ok | 2 | `806400.00` |
| C4 | C | `58250000.00` | ok | `58250000.00` | ok | 3 | `58250000.00` |
| C5 | C | `2026-09-07` | ok | `2026-09-07` | ok | 3 | `2026-09-07` |
| C6 | C | `1620000.00` | ok | `1620000.00` | ok | 3 | `1620000.00` |
| C7 | C | `2026-11-20` | ok | `2026-11-20` | ok | 2 | `2026-11-20` |
| C8 | C | `4775000.00` | ok | `4775000.00` | ok | 1 | `4775000.00` |

## Discordant pairs in detail

None. Every probe landed the same way in both conditions.

## Every wrong answer

None — every run in both conditions matched gold.

## Transport audit

- runs recorded: 48
- runs not served by `claude-sonnet-4-6`: **0**
- runs whose provider was not `firstParty`: **0**
- runs that errored or exited non-zero: **0**
- every child process ran with all `ANTHROPIC_*` environment variables deleted, so the deepseek proxy could not intercept a call.

## Reproducing

Working files (scratchpad, outside the repo):

```
toy-tools/
  gen-probes.mjs       generates probes.json; each probe carries a machine-readable spec for its gold
  probes.json          24 probes, 8 per family, each <2000 chars, gold + spec
  verify-gold.py       independent Python recomputation of every gold, three ways
  toy-mcp-server.mjs   the MCP stdio server (calc, date_math); `--selftest` runs its own checks
  mcp-config.json      server registration passed to --mcp-config
  run-probes.mjs       the driver; resumable, aborts on any model/provider mismatch
  results.json         one record per run
  toollogs/*.jsonl     every tool call, argument and result, logged server-side
  analyze.mjs          this report
```

The exact invocation, per run:

```
claude -p --model claude-sonnet-4-6 --output-format json \
  --strict-mcp-config --tools "" --no-session-persistence \
  --system-prompt "<condition-specific>" \
  [--mcp-config mcp-config.json --allowedTools mcp__toy__calc,mcp__toy__date_math]   # tools arm only
# prompt on stdin
```

Two things that cost time and are worth recording:

1. **The prompt must go in on stdin, not argv.** A multi-line prompt passed as an argv element gets mangled on Windows; the model receives a fragment and replies that the message looks incomplete.
2. **`ANTHROPIC_*` must be stripped from the child environment.** This machine routes `claude` through a deepseek proxy via those variables. Inherited, they silently divert the run to a metered third-party model — wrong model *and* real money. The driver deletes every `ANTHROPIC_*` key before spawning, and asserts on each run that `modelUsage` names exactly `claude-sonnet-4-6` with provider `firstParty`, aborting the sweep otherwise.
