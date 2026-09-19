# Jev attribution experiment plan

## Goal

Find out whether a System One decision model can be adapted to the repository's
opinion-boundary and quote-attribution work, and where it is actually reliable,
without invoking Codex or reusing the retired semantic judge.

## Tested

1. **Attribution of quoted material.** Frozen passages judged by the main agent
   before any call. Split into atomic questions: whose words, whose
   proposition, verbatim quotation, advanced by a party, endorsed by the court.
   See `attribution-spec.json`.
2. **Separate-opinion relationships.** Whether a passage is a separate opinion,
   whether its author sat on the deciding court, and agreement with the lead
   disposition versus the lead reasoning.
3. **Opinion boundaries**, mechanically scored, across both benchmark
   generations: the superseded multi-opinion cohort and the fresh v2 cohort.
4. **The superseded fine-grained treatment vocabulary** (target identity, legal
   actor, reduced treatment label) on fixed target occurrences. See
   `treatment-spec.json`.

Results are in [RESULTS.md](RESULTS.md).

## Deliberate limits

- Judgments on semantic dimensions are the main agent's own, frozen before
  calls. They are not independent gold and were not cross-reviewed.
- The boundary comparator is exact-match. Residual single-line differences
  between annotation conventions are reported and classified rather than
  smoothed into a tolerance.
- Instruction tuning stopped after two passes. A third pass against these 19
  documents would fit the gold rather than improve the adaptation.

## Next, if this is continued

1. Split the endorsement dimension into "adopts the proposition" versus
   "distinguishes or departs from it" and re-measure; it is the only
   consistently weak attribution question.
2. Re-express treatment as attribution plus a coarse reliance/adversity flag
   instead of the ten-label operation, and check that against the same
   occurrences.
3. Run the boundary adaptation over a larger seeded sample to separate
   convention differences from genuine extraction errors.
4. Compare confidence-gated routing against a plain threshold, since the
   fine-label distributions already carry the useful signal.
