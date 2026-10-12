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

## Wide quotation correction gold

The wide gold corrects saved source-backed quotation checks, separately for each
quotation/source pair. It records the exact or closest wording and its correct
pinpoint from the app's source evidence. Sources without printed locators use
their exact source offsets; this runner does not acquire additional publisher data.
This is textual comparison, not semantic similarity.
Judicial quotations are located in the correct opinion's reasons, rather than a
headnote or editorial summary, unless the manuscript expressly quotes that material.
Acquisition failures are outside this gold. Existing manuscript records link to
`quotes/wide/<id>.json`; the older 27-item gold remains separate and unchanged.

Prepare the manuscript inventory once, then correct the saved checks through the
existing subscription-backed `codex exec` adapter:

    python benchmarks/alr-verifier/build_quote_gold.py --wide-manifest benchmarks/local-data/alr-verifier/quote-corrections/wide-manifest.json
    node --experimental-strip-types --no-warnings benchmarks/alr-verifier/quoteGoldReview.ts --concurrency 0 --remote <ssh-alias> --remote-codex-home <desktop-codex-home> --remote-concurrency 24

This task sends private quotation contexts, their original reference chains and
requested canonical-source excerpts to OpenAI through the existing Codex login.
Use it only with authorization for that payload. `--only article-000 --limit 1`
narrows a pilot. The default `sol-low` arm uses `gpt-6.1-sol` at low reasoning
effort; select an account-supported arm with `--arm`. Inherited API-key environment
variables are excluded from Codex worker processes. SSH uses the configured host
alias and an already trusted host key; `--remote-codex-home` selects an existing
desktop login. Both machines need a current Codex CLI that supports the selected model.
The coordinator reads canonical A2AJ/journal sources and transfers a scoped source
sidecar to the trusted desktop. In one Codex session per batch, the reviewer sees
the saved answers and initial excerpts, and can selectively search or read only the
source attached to each check. Tool reads return bounded excerpts with absolute
UTF16 offsets; complete source documents are not inserted into the model prompt.
Remote turn files are removed in `finally`. All inputs, answers, read receipts and
gold stay in ignored private benchmark storage. Local workers default to zero;
omit `--remote` and set `--concurrency` explicitly for a local run.
Completed gold jobs are skipped; turns replay from the content-addressed
cache, including source and reader hashes. `--fresh` reapplies selected jobs from
their saved outputs. It does not invalidate identical cached model answers.

Structured output requires every check ID and only a verdict plus source offsets,
or an absent/nonquotation verdict. The model does not copy quotations, write
pinpoints or render corrections. Selected offsets must be boundaries actually
provided to that check. Local code extracts the original source text and derives
printed paragraph/section anchors through the existing Rust structure engine;
journals use their canonical page markers. Complete literal verdicts require
whole-word evidence. Each source retains its own outcome and pinpoint. Incomplete
answers fail the job before any gold is accepted. A usage limit stops new dispatches.

`compose.ts` saves individual checks in `.quotes.json` beside the delivered workbook,
including manuscript/runtime/native hashes. Compare a saved run immediately:

    python benchmarks/alr-verifier/score.py --quote-gold benchmarks/local-data/alr-verifier/quotes/wide/manifest.json --quote-run benchmarks/local-data/alr-verifier/quotes/wide/run

The diff reads JSON only, without extraction, a build, native matching or model calls.
It overwrites `quotes/wide/latest-diff.json`, reporting differences and pending
reviews separately. Exit 1 means a discrepancy or missing document output; exit 2
means incomplete gold; exit 0 requires complete reviewed coverage without differences.
Ambiguous occurrence bindings are reported, rather than choosing the most favorable
quotation or pooling answers from different sources.
