# Results

## 2026-08-22 fresh proposition-first harness

The new experiment is isolated from the superseded issue-based gold and runner.
It now has one gold contract for one-stage and two-stage inference, complete
decision context, open-ended reference recall, proposition-level treatments,
separate procedural history, exact line-local anchors, Beaver evidence
receipts, bounded drafting-time correction, mechanical scoring, and a semantic-
only judge surface.

The first local audit corrected two material harness defects before new gold or
live inference:

- substantive-coverage validation had treated too much front matter as judicial
  reasons; it now asserts coverage only for paragraphs inside high-confidence
  deterministic opinion bodies; and
- benchmark aggregation had silently omitted rejected, failed, or interrupted
  cases; it now reports every case requested by the run manifest.

The compiler also enforces the existing 40-word substantive-opinion floor,
grounds each named participant/writer/joinder in source text, retains detector
keys for later citation resolution, and handles a sole collectively authored
opinion without automatically counting a judge who expressly agrees only in
the result.

No new model inference has been launched under this contract yet. Fresh gold
selection and authoring must pass the process in `GOLD.md` before a comparative
run.

The tracked fresh draw contains 30 court decisions across all 14 configured
court datasets and overlaps none of the 427 containing decisions recovered
from earlier experiment gold. Replacing a full 11 GB text-table scan with an
indexed ID pool plus primary-key eligibility probes reduced seeded selection
from about 20 seconds to 1.05 seconds on this workstation. Thirty complete
authoring packets then compiled in 6.4 seconds with eight workers.

Ox Alpha routing is implemented for OpenRouter, anonymous OpenCode Zen,
subscription OpenCode Go, Nous through the official local Hermes OAuth proxy,
and anonymous or keyed Kilo. A single run may shard cases round-robin across
those ingress routes while retaining route-local limits, preflights, raw
output, and receipts. No Ox inference call has been made.

## 2026-08-22 Luna High canary

The 15-record gold file validates cleanly. Across the five completed Luna High
cases, gold-aware mechanical grading accepted all five opinion structures and
all 40 structure categories; mean boundary overlap was 99.6%. One boundary was
accepted because Luna omitted only a duplicated order block. Another included
a trailing judicial signature; compilation removed it deterministically while
retaining the raw model output and an adjustment receipt. These were simple
single-opinion cases, so multi-opinion majority/minority performance remains
unproven.

Semantic judgment graded 14 treatments pass, one minor, and four major
(76.3%), with no invented treatment. The major errors were omissions.
Procedural-history accuracy was weaker (56.3%; 70.4% combined). A later
authority-cluster experiment was abandoned: repeating the full case for each
authority fractured connected propositions and made grading invalid. Treatment
inference now remains one case-wide call.
