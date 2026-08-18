# Grounded drafting copy-gate boundary

Run date: 2026-08-17 (America/Edmonton)

## Result

The proposed 25-character seed followed by an eight-lexical-token and
40-normalized-character rejection boundary is **not shippable**. Freeze
**8 lexical tokens and 51 normalized characters** as its replacement for the
mandatory gate.

It detected every eligible exact-copy boundary sample and rejected none of the
below-boundary controls. But it also rejected 3 of 31 historical Beaver claim
payloads for conventional constitutional language. A 9.7% claim-level false
rejection rate is too high for a mandatory drafting gate. The 8/51 replacement
catches the factual-vacuum witness, produces zero false rejections among the
nine reviewed matches, and retains five of the six reviewed true positives.

## Local sample

The run used only existing local data:

- 40 case passages sampled from the local A2AJ case database;
- 120 journal passages sampled from the local journal database;
- 33 case/legislation passages exposed in persisted Beaver traces; and
- 31 claims from four persisted `submit_grounded_answer` payloads across 78
  trace files.

This produced 193 real-prose source passages. Of those, 192 contained an
eligible, unmarked eight-token window of at least 40 normalized characters.

## Boundary controls

| Check | Samples | Rejected | Expected |
| --- | ---: | ---: | ---: |
| Exact eight-or-more-token/40-character copy | 192 | 192 | 192 |
| Seven-token copy | 192 | 0 | 0 |
| Eight-token copy shorter than 40 characters | 192 | 0 | 0 |

Explicit quotation, source-title, citation-marker, and URL windows were
excluded before drawing positive samples because production intentionally
excludes them.

## Historical Beaver outputs

The gate flagged 9 of 31 historical claims. Manual review classified six as
true positives and three as false rejections.

True positives repeated distinctive source language without quotation marks,
including:

- `federalism, democracy, constitutionalism and the rule of law, and respect
  for minorities` (several claims); and
- `as obligatory by the officials to whom it applies`.

False rejections were conventional or fixed constitutional language:

- `the Canadian Charter of Rights and Freedoms and` (8 tokens, 47 normalized
  characters);
- `resolutions of the Senate and House of Commons` (8 tokens, 46 characters);
  and
- `resolutions of the Senate and House of Commons and` (9 tokens, 50
  characters).

These are not isolated tokenizer mistakes: they clear the proposed boundary
exactly as designed.

## Replacement sweep

Each candidate was evaluated against the same nine manually reviewed matched
spans, not by reclassifying its entire containing claim. This matters because
two claims containing a conventional phrase also contain a separate,
distinctive copied span. The factual-vacuum witness is 13 tokens and 69
normalized characters.

| Boundary (tokens/chars) | Factual vacuum caught | True positives retained | False rejections |
| --- | ---: | ---: | ---: |
| 8/40 (original) | yes | 6/6 | 3 |
| 8/50 | yes | 5/6 | 1 |
| **8/51** | **yes** | **5/6** | **0** |
| 9/50 | yes | 5/6 | 1 |
| 9/51 | yes | 5/6 | 0 |
| 10/40 | yes | 5/6 | 0 |
| 10/51 | yes | 5/6 | 0 |

The five retained true-positive matches are:

- `include federalism, democracy, constitutionalism and the rule of law, and
  respect for minorities` (13 tokens, 93 characters);
- `federalism, democracy, constitutionalism and the rule of law, and respect
  for minorities` (12 tokens, 85 characters; three reviewed occurrences); and
- `of federalism, democracy, constitutionalism and the rule of law, and`
  (10 tokens, 65 characters).

The lost true positive is `as obligatory by the officials to whom it applies`
(9 tokens, 49 characters). No tested simple boundary can retain it while
excluding the 9-token/50-character false rejection: both use inclusive minimum
thresholds.

There are two Pareto-minimal passing choices in this sweep: 8/51 and 10/40.
They have identical results on the frozen reviewed sample. Choose 8/51 because
it retains the lower token floor and can still detect long eight- or nine-token
copying; 9/51 is strictly dominated by it. The 8/50 and 9/50 controls show that
51 characters is the smallest passing character floor at eight or nine tokens.

## Factual-vacuum witness

The persisted traces contain the real case-source sentence `Charter decisions
should not and must not be made in a factual vacuum.` Replaying that sentence
as unmarked prose is rejected by the production gate. No persisted submitted
claim in this local trace set contains the unmarked factual-vacuum wording, so
the original observed bad output itself could not be replayed.

## Reproduction

```powershell
backend\node_modules\.bin\tsx.cmd experiments\grounded_drafting_copy_gate\run.ts
```

The script reports progress, checkpoints after trace/source batches, and
writes detailed samples to ignored `raw/latest.json`. It imports the production
gate directly and performs no network or provider calls.

## Limits and next decision

The historical output sample is small and concentrated on Canadian
constitutional history. The case/journal boundary controls test lexical
behavior across broader real prose, but they are constructed exact-copy and
below-boundary controls, not human-authored paraphrases.

The 8/51 boundary meets the plan's stated frozen-sample acceptance rule, so it
is the recommended single replacement rather than disabling the mandatory
gate. Keep this dataset frozen and add broader real grounded Beaver outputs as
they become available. Do not add a phrase stop-list, classifier, fuzzy match,
or exception path.
