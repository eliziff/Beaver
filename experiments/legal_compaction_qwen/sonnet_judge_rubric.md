# Sonnet 4.6 Judge Rubric

Use this rubric to compare two anonymous answers to the same legal research task. Do not infer which system produced an answer. Judge only the answer, the supplied source texts, and the task requirements.

## Task

The answer must summarize and compare:

- *Bhasin v. Hrynew*, 2014 SCC 71;
- *Wastech Services Ltd. v. Greater Vancouver Sewerage and Drainage District*, 2021 SCC 7; and
- *C.M. Callow Inc. v. Zollinger*, 2020 SCC 45.

It should explain the relationship among the cases, including the distinctions between honest performance, contractual discretion, and misleading conduct, and provide useful SCC paragraph quotations.

## Pre-checks

Run deterministic quote verification before substantive scoring. Record, for each quotation:

- whether it is an exact source match after layout-only normalization;
- whether the cited paragraph is correct;
- whether the quotation is attributed to the correct case; and
- whether the answer contains unsupported or fabricated quotation material.

Do not award substantive credit for a quotation that fails these checks merely because it expresses the right idea.

## Scoring

Score each category from 0 to 4, then apply the weight.

| Category | Weight | 4 — Excellent | 2 — Mixed | 0 — Failed |
|---|---:|---|---|---|
| Case coverage | 15 | All three cases receive accurate facts, issue, holding, and reasoning | One case is thin or partly inaccurate | A case is omitted or materially misrepresented |
| Doctrinal accuracy | 25 | Correctly states each doctrine and its limits | General direction is right but important distinctions are blurred | Central holdings or doctrines are wrong |
| Comparative synthesis | 20 | Clearly explains what Wastech confirms/narrows about Bhasin and what Callow applies/clarifies | Some comparison but mostly parallel summaries | No meaningful relationship among the cases |
| Quote fidelity | 20 | Quotations are exact, correctly attributed, and useful | Some exact quotations but errors, truncation, or weak selections | Fabricated, materially altered, or misattributed quotations |
| Pinpoint grounding | 10 | SCC paragraph references consistently support the quoted or stated proposition | Several weak, missing, or mismatched pinpoints | Pinpoints are mostly absent or unreliable |
| Legal research usefulness | 10 | Concise, organized, precise, and useful to a lawyer | Understandable but verbose, incomplete, or uneven | Confusing, generic, or unusable |

Calculate:

```text
weighted score = sum(category score / 4 * category weight)
```

Report a score from 0 to 100, plus the unweighted category scores.

## Hard-failure flags

Report these separately from the numerical score:

- `fabricated_quote`: quotation is not found in the cited source;
- `misattributed_quote`: quotation belongs to another case or paragraph;
- `material_doctrinal_error`: answer reverses or substantially distorts a holding;
- `missing_case`: one of the three cases is not meaningfully addressed;
- `unsupported_comparison`: relationship claim lacks support in the supplied authorities.

A fabricated quotation or material doctrinal error should normally cap the answer at 50, regardless of prose quality. Multiple fabricated quotations or a missing case should normally cap it at 35.

## Judge output

Return JSON with this shape:

```json
{
  "winner": "A|B|tie",
  "scores": {
    "A": {
      "case_coverage": 0,
      "doctrinal_accuracy": 0,
      "comparative_synthesis": 0,
      "quote_fidelity": 0,
      "pinpoint_grounding": 0,
      "legal_research_usefulness": 0,
      "weighted_total": 0,
      "hard_failures": []
    },
    "B": {
      "case_coverage": 0,
      "doctrinal_accuracy": 0,
      "comparative_synthesis": 0,
      "quote_fidelity": 0,
      "pinpoint_grounding": 0,
      "legal_research_usefulness": 0,
      "weighted_total": 0,
      "hard_failures": []
    }
  },
  "reasoning": {
    "A": ["short evidence-based reasons"],
    "B": ["short evidence-based reasons"],
    "decisive_difference": "one concise paragraph"
  }
}
```

Keep the comparison blind. Do not speculate about the model, prompt, context window, or compaction strategy unless the task explicitly asks for that analysis. Prefer source-supported defects over stylistic preferences.
