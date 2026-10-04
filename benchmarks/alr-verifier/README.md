# ALR verifier eval

Scores the ALR Quote Verifier pipeline (`backend/scripts/alr-verify.ts`) against the
Python ALR-Quote-Verifier on the same private documents. All split, field, link and
supra/ibid numbers come from the Python app's own scorers in
`ALR-Quote-Verifier/dev/benchtools` (imported read-only at eval time). Each metric
group is reported separately, in the order of `dev/benchmarks/README.md`: user-visible
safety, final source outcomes, routing inputs, diagnostics; then quote checking, cost
and speed.

Everything private lives in the ignored `benchmarks/local-data/alr-verifier/`:
`inputs/` (documents + `manifest.json` with source paths and sha256), `arms/<arm>/`
(one latest payload per document), `raw/<arm>/` (workbooks and logs), `llm/<arm>/`
(recorded codex answers and receipts), `quotes/` (quote gold and its review),
`report.json`, `report.md`.

## Run

Python 3.12+ venv with the Python app's requirements, once:

    python -m venv benchmarks/local-data/alr-verifier/.venv
    benchmarks/local-data/alr-verifier/.venv/Scripts/python -m pip install -r "<ALR-Quote-Verifier>/requirements.txt"

Then, with that interpreter (`py` below):

    py benchmarks/alr-verifier/locate_inputs.py      # find each gold document's DOCX by footnote text
    py benchmarks/alr-verifier/build_gold_docx.py    # the 405 split-gold footnotes as one DOCX
    py benchmarks/alr-verifier/run.py baseline       # Python app, Free, splitting and links only
    py benchmarks/alr-verifier/run.py baseline --app # Python app, Free, whole app, local-only sources
    py benchmarks/alr-verifier/build_quote_gold.py   # independent quote gold (see below)
    py benchmarks/alr-verifier/run.py arm free
    py benchmarks/alr-verifier/run.py arm sol-low --mode high_accuracy
    py benchmarks/alr-verifier/run.py arm luna-max --mode high_accuracy
    py benchmarks/alr-verifier/score.py              # report.md, report.json, regressions list

Model arms call `codex exec -m gpt-6-luna -c model_reasoning_effort=max` or
`codex exec -m gpt-6.1-sol -c model_reasoning_effort=low` with `--skip-git-repo-check
--sandbox read-only --ephemeral --output-schema --json` (`codexLlm.ts`), plus flags that
keep codex's own context small (`--ignore-user-config`, an empty working directory, a
one-line instructions file, apps/browser/computer use off). Tokens are read from the
`turn.completed` event; cache-adjusted tokens = uncached input + 0.1 x cached input +
output. Answers are recorded per request and replayed, so a rerun after a pipeline
change only pays for prompts that changed.

## Gold and its limits

- Split, field and supra/ibid gold are the Python benchmark's (`dev/benchmarks`). Some
  gold rows were made from another draft of a document or from a checked workbook;
  `score.py` keeps a row only where the located DOCX has the same footnote text
  (renumbering split rows when the text moved), and reports the counts.
- Quote gold is independent of both apps. For body passages ending in a footnote that
  names exactly one decision or statute held in the local A2AJ store (or a bare ibid
  after one), each quotation of five or more words is compared with the source text
  after typographic normalization: verbatim (every segment between ellipses and
  bracketed insertions appears in order) -> Perfect; altered -> Partial; absent -> No
  match. Every non-verbatim label was then checked by reading the source and recorded
  in `quotes/review.json` (some candidates excluded as not quotations of that source).
- Recorded Python numbers without a re-runnable artifact (High Accuracy, the Luna
  experiment) are listed in `report.json` under `recorded_python_baselines`.
