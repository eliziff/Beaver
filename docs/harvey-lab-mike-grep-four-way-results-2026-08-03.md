# Mike-plus-Grep four-way result (2026-08-03)

Status: **candidate cells structurally valid; upstream comparison excluded**.
Scores are fixed-Sol criterion-judge labels, not human gold.

This experiment tested whether a small retrieval delta from pinned upstream
Mike could preserve its answer quality while reducing provider-reported logical
tokens. The implementation, launcher, tests, tasks, sources, prompts, tools,
models, and decision rule were frozen in commit
`588d2c23a83feeb22ebaf540943ac26043efe897` before any performer call. The
immutable registration contains every run ID and fingerprint:
[four-way preregistration](harvey-lab-mike-grep-four-way-preregistration-2026-08-03.json).

## Validity

- All 12 Luna/high performer runs reported the default provider tier and used
  run stamp `2026-08-03T00-15-00Z-r1`.
- All requested DOCX files existed, passed ZIP/XML inspection, and converted
  through Pandoc. All traces were schema-correct, with zero failed tool calls,
  no worktree or held-out-data access, and matching task/source/tool/prompt/
  model/effort/tier/source fingerprints.
- The isolated coding comparator matched the current task, instruction,
  source-bundle, model, effort, and reported-tier fingerprints.
- A post-result provenance audit found that the three reused
  `comparable-upstream-pinned-default` cells do **not** satisfy the registered
  upstream-origin gate. Their actual `config.json` and
  `beaver-receipts.json` identify commit
  `e89d3230db40193c540a6b38d8f301ae76377a1a` and schema
  `78f2e1dfaa7f2c5a62dcc52531804373e998ee002fe783e7767a10113e7a87fc`;
  their run fingerprint contains no origin/source-blob proof. They predate
  commit `171cd82d`, which restored the true-origin snapshot
  `2266446b0d26f735865b8cd3bb153b28e7d11b17` and corrected tool-loop
  semantics. The preregistration's eligibility assertion was therefore wrong.
  These cells remain labelled legacy diagnostics and cannot establish a win or
  loss against true upstream Mike.
- The valid judge run is
  `.tmp/harvey-sol-judge/2026-08-03T01-10-00Z-sol-fixed-r4`: fixed
  `codex/gpt-5.6-sol`, requested temperature 0, provider-default judge effort,
  criterion parallelism 1, output parallelism 12, and BelowNormal local
  priority. Its rubric, judge-source, and scoring-source SHA-256 values match
  the registration.
- An earlier `r3` judge launch was excluded. Windows environment cleanup had
  removed Pandoc from the child `PATH`, so the evaluator scored placeholder
  read errors rather than the existing DOCX files. Those outputs remain
  explicitly labelled `scores.invalid-evaluator-path-r3.json` and
  `report.invalid-evaluator-path-r3.html`; they are not evidence.

## Fixed-Sol scores

| Arm | Change of control /57 | Transfer pricing /77 | Indenture /83 | Total /217 | Versus upstream |
| --- | ---: | ---: | ---: | ---: | ---: |
| `mike_grep_v1` | 47 | 33 | 63 | **143** | -7 |
| `mike_legal_v1` | 42 | 36 | 63 | **141** | -9 |
| `mike_legal_guided_v1` | 43 | 40 | 70 | **153** | +3 |
| `v5_reconstruction_v1` | 46 | 18 | 63 | **127** | -23 |
| Legacy upstream-shaped comparator (excluded) | 37 | 44 | 69 | **150** | invalid control |
| Frozen isolated coding finalist | 11 | 25 | 59 | **95** | -55 |

The registered winner rule cannot be applied because its upstream control was
ineligible. Against the legacy diagnostic only, `mike_grep_v1` trailed seven
points; the guided arm's three-point gain cost 1.438x tokens; and V5 used
1.698x tokens. Those comparisons explain why the complex arms were retired,
but none is a claim about true upstream Mike. The next experiment reruns the
control on every task.

## Context and cost telemetry

Cache-adjusted token equivalents value cache reads at ten per cent of ordinary
input tokens. Public-price equivalents are diagnostic estimates, not billing
receipts.

| Arm | Logical tokens (% upstream) | Cache read | Cache-adjusted equivalent | Public-price equivalent | Source coverage | Calls | Rounds | Legal scopes | Wall time sum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `mike_grep_v1` | 673,159 (46.9%) | 4,608 | 669,011.8 | $0.938742 | 49/58 | 20 | 12 | 0 | 1,606.80 s |
| `mike_legal_v1` | 1,325,527 (92.3%) | 13,312 | 1,313,546.2 | $1.567901 | 57/58 | 37 | 14 | 0 | 1,573.96 s |
| `mike_legal_guided_v1` | 2,065,539 (143.8%) | 430,592 | 1,678,006.2 | $1.951376 | 52/58 | 63 | 19 | 0 | 1,659.31 s |
| `v5_reconstruction_v1` | 2,439,211 (169.8%) | 340,992 | 2,132,318.2 | $2.460963 | 49/58 | 143 | 41 | 24 section | 1,920.91 s |
| Legacy upstream-shaped comparator (excluded) | 1,436,478 | 1,536 | 1,435,095.6 | $1.698766 | 58/58 | 10 | 12 | 0 | 1,129.25 s |
| Frozen isolated coding finalist | 1,611,907 | 26,624 | 1,587,945.4 | $1.828095 | 40/58 | 89 | 38 | 0 | 1,094.95 s |

`mike_grep_v1` used 162,844, 285,946, and 224,369 logical tokens on the three
tasks. Upstream used 406,836, 559,453, and 470,189. The guided arm's transfer-
pricing run alone used 1,438,758 tokens; V5's used 1,412,720.

## Trace findings

The simple Grep arm is the candidate efficiency frontier, but its margin over
true upstream is not yet known. Its change-of-control run scored ten points
higher than the legacy diagnostic after two selective
searches and selected whole-document reads, covering 12 of 19 sources. On
transfer pricing it exposed all 25 documents and all 1,166,898 exact source
characters with no tool error, yet omitted requested numbers, jurisdictional
details, and matrix fields. The primary failure there was evidence salience and
draft completeness, not evidence availability. Indenture misses were likewise
mostly drafting qualifiers after the relevant sources had been accessed;
selective retrieval plausibly hid only a small number of items.

The optional legal scopes did no useful work. Both plain and guided legal arms
made zero section/page-scope calls. The guided arm's modest score gain came
from more ordinary reading/search and a longer answer, while its transfer-
pricing trace churned through 30 calls and 10 rounds. V5 did use 24 legal
scopes, but 143 calls, 41 rounds, costly compaction, and a fresh drafting
handoff produced the worst aggregate answer among the candidates. This rejects
the current optional-coordinate schema and the checkpoint/handoff stack, not
the possibility that host-resolved structure can help behind ordinary coding
tool semantics.

Terminal generation remains a promising isolated mechanical hypothesis. The
legacy comparator and `mike_grep_v1` both exposed every transfer-pricing
document, but the terminal arm completed in three rounds and 285,946 tokens
versus four rounds and 559,453. Because the comparator lineage is invalid, the
next experiment tests that delta directly on the corrected upstream surface.

The frozen coding finalist is not a clean stock-Codex/Pi control: it performed
three, seven, and one research refreshes and handed off roughly 114--118k
characters per task. It is retained as historical evidence, not proof about a
standard continuous coding-agent loop.

## Decision and next experiment

Retire `mike_legal_v1`, `mike_legal_guided_v1`, and the reconstructed V5 stack
from the main matrix. Preserve `mike_grep_v1` as the measured efficiency
frontier and pinned upstream Mike as the control.

The next visible-development ablation broadens to nine tasks and adds two
small, independently attributable treatments:

1. An upstream-terminal arm: pinned upstream Mike's prompt, schemas, reading
   behavior, and continuous context, with only successful `generate_docx`
   made terminal. This isolates whether removing the full-context
   post-generation replay preserves Mike's quality while recovering the
   largest observed mechanical token saving.
2. A discovery-first structural arm: the same ordinary Grep/Read surface, with
   verified host-side structure returned as locator metadata and executable
   paths after a match. The model never guesses a section/page coordinate.
   Deterministic diagnostics, if included, must be objective, bounded, and
   measured separately; safe silent fixes require exact version/hash receipts.

The matrix should include corrected pinned upstream, upstream-terminal,
`mike_grep_v1`, and the structural arm. Rerun upstream on all nine tasks; do
not reuse the three mislabelled comparator cells. Existing Mike-plus-Grep cells
may be reused only under an explicit current-source equivalence audit.
Accuracy remains primary. A token increase up to 1.5x upstream is acceptable
only for a broad, decisive quality win; otherwise the smallest accurate arm
wins.
