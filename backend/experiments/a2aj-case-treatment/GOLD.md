# Gold authoring standard

The benchmark unit is one complete containing decision. Its gold record states
the decision's opinion structure once, then records what each opinion says
about other decisions. Gold is authored from the primary containing decision,
not copied from an earlier gold record, a candidate model output, a judge
output, or a citator summary. A conservative compiler may point to an exact
source citation that appears omitted; the author must verify it in the primary
decision and determine its proper role.

The current fresh expansion is selected by `gold/selection-sol61-low-630.json`.
Its 630 decisions are authored with `gpt-6.1-sol` at `low` reasoning effort,
with two complete primary-source audits per case in the persisted author thread.
Exhaustive source annotations and receipts live in ignored
`benchmarks/local-data/a2aj-case-treatment/sol61-low-expansion-630/`.
Earlier gold and candidate outputs must never be consulted while authoring
fresh records. Projection and assembly happen only after admission.

## Product-aligned pared gold

`gold/gold-product-scale-current.jsonl` is the current projection for the
citator task, in `a2aj-product-treatment-gold-v1` format. Its matching selection
is `gold/selection-scaled-current.json`: the existing 70 decisions followed by
the 300-case and 630-case fresh expansions. The exhaustive source annotations
remain separate.
The product projection contains only fields that are scored:

- opinion boundaries, writers, participation, joinders, and result positions;
- what the present decision did to a decision directly under review;
- an opinion's report that another decision was affirmed, reversed, varied,
  quashed, remitted, or received a material leave disposition; and
- proposition-level substantive treatment, its treating opinion, machine
  signal, and concise legal explanation.

| Corpus | Decisions | Opinions | Treatments | Direct outcomes | Reported history | Multi-opinion decisions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original records | 70 | 91 | 1,020 | 50 | 74 | 12 |
| Sol 6.1 low, first expansion | 300 | 401 | 4,572 | 242 | 373 | 55 |
| Sol 6.1 low, latest expansion | 630 | 851 | 9,936 | 535 | 786 | 125 |
| Current corpus | 1,000 | 1,343 | 15,528 | 827 | 1,233 | 192 |

Reported procedural history is not mere chronology. A statement that a cited
trial decision was reversed on appeal is retained even when it is not a
precedential treatment. Background event logs are excluded: for example,
successive supervision orders or terminated proceedings that are recounted
without direct review, evaluation of their reasoning, or a material comparison
of their procedural posture.

A treatment requires the opinion to use or evaluate another adjudicative
decision's holding, rule, reasoning, remedial approach, or a material factual
or procedural analogy. A bare mention, an unadopted quotation, a party's
position, and a decision recounted only as an event are not treatments.

The pared gold does not store citation inventories, identifying blocks,
evidence blocks, copied quotations, span hashes, or other grounding receipts.
Candidate runs still return receipts for deterministic validation, but those
mechanics are neither gold targets nor semantic score categories.

## Opinion structure

Read the complete decision, including every set of reasons and its disposition.
Record each independently reasoned opinion from its first substantive heading
or sentence through its last substantive sentence. Once a judge supplies
independent reasons, include that complete body of reasons, including its
statements adopting other reasons and its disposition. Exclude a bare joinder
only when it stands alone. Also exclude metadata, headnotes, counsel lists,
signatures, and orders copied outside the reasons.

Record the actual writer, every participant and express nonparticipant, each
participant's result position, full joinders, and the exact passage expressing
a qualified agreement. Represent a named writer through the participant's
`wrote` link; reserve `collective_author` for genuinely collective reasons with
no named writer. Panel membership does not prove authorship or joinder.
When the source does not identify a writer or expressly establish collective
authorship, retain both fields as null; do not manufacture an author from the
panel list.
Retain an expressly identified Chief Justice's office label when the source
does not give a personal name. A named C.J. may be identified by that office in
the relationship passage; panel membership alone still does not prove joinder.
If every judge supports the same disposition, that is a supported disposition,
not an unknown one. A qualified-agreement passage records only what the source
expressly says; do not invent its legal scope.

## Other decisions

`decision_mentions` contains one clear source occurrence of every other
adjudicative decision cited, quoted, or described in judicial reasons, the
disposition, or a court-authored procedural account. This includes decisions
mentioned while recounting a party's argument. It excludes legislation,
secondary sources, the present decision, publisher material, headnotes, and
authorities appearing only in counsel or authority lists.

Use a short exact name or citation copied from the identifying block, or a
short exact identifying description when the source gives neither. Merge two
forms only when the containing decision itself establishes that they identify
the same decision. Global citation resolution happens later.

## Same-litigation history

A decision, order, or award from the same litigation belongs in
`procedural_relationships` only when the present court directly reviews it;
other same-litigation events remain citation-inventory entries. State its role
and every action the present court takes on it. Every relationship must contain
at least one action. Distinguish
affirming, reversing, varying, setting aside, restoring, and remitting, and name
the affected part when the action is narrower than the whole decision.
Recounting a decision, leaving it undisturbed, or refusing extra time to start
an appeal is not an action on the underlying decision.

Keep the description limited to what identifies the relationship and the
material result. Include every decision directly under review in a consolidated
matter, but do not turn earlier administrative steps, leave orders,
adjournments, or other procedural events into relationships merely because
they occurred in the same litigation. Procedural reversal is not precedential
overruling.

## Reported appellate history

In `reported_history`, record an opinion's statement that another adjudicative
decision was later affirmed, reversed, varied, quashed, remitted, or received a
material leave disposition. Identify the earlier decision affected, the later
decision when the opinion names it, the action, and any narrower affected part.
Include such a relationship even when it appears inside a chronological account;
omit events that state no such relationship. Do not include the present court's
own disposition here. Gold also records the opinion that made the statement;
candidate runs need only provide source blocks, from which the host derives that
opinion.

## Treatments

Create a `treatments` record whenever a judicial opinion uses or evaluates
another decision for more than identification, including a decision directly
under review. A directly reviewed decision may therefore have both a procedural
relationship and substantive treatments. The material point taken from it may
be a holding, legal rule or test, reasoning, remedial approach, or material
factual or procedural analogy. A bare citation, a party's submission, an
unadopted quotation, or another opinion's reasoning is not the current
opinion's treatment.

The unit is one opinion, one cited decision, and one coherent proposition and
operation. Split materially different propositions, operations, scopes, or
opinions. Do not split a connected legal test merely because it spans several
sentences. When a passage invokes several decisions as authority for the same
proposition, record each decision separately. Do not create duplicate records
for repeated citations that add no new treatment.

`proposition` states the material point the containing opinion takes from the
cited decision. `treatment` states succinctly how the containing opinion uses
or evaluates that point and any material limit on the operation. Include
present-case facts or the ultimate result only when they are needed to explain
the application or limitation. Do not burden every treatment with a recital of
the containing decision's full analysis or disposition.

An opinion's express adoption of another opinion's legal analysis carries the
adopted treatments only when the adoption passage clearly covers them. Record
those treatments under the adopting opinion with both the adoption passage and
the underlying treatment passage as evidence. Do not infer adoption from a
shared disposition or general agreement on an unrelated point.

Choose signals from the operation actually performed. In particular,
`overruled` requires an express precedential displacement by a court capable of
doing so; `not_followed` is not overruling; `distinguished` requires a material
difference; and a supporting string citation is not automatically `applied`.
Use `other` only when no listed signal accurately describes the operation.

## Evidence and quotations

Use the smallest complete source blocks that establish the proposition,
treatment, opinion attribution, procedural relationship, or action. Never use
the whole decision as evidence merely because it contains the answer. Evidence
must show the court's own adoption or evaluation, not merely the cited source's
words or counsel's characterization.

`quoted_passages` contains exact words the containing decision attributes to
the cited decision and that matter to the treatment. Preserve visible edits
and interruptions. Leave it empty when no material words are reproduced.
Ground every boundary, evidence block, and quotation against the immutable
source and retain the source hash.

## Per-record authoring sequence

1. Read the complete primary decision without opening old gold or candidate
   outputs.
2. Author and verify the opinion structure.
3. Inventory every in-scope other decision from the source.
4. Record direct outcomes and reported appellate history independently from substantive treatment.
5. Author proposition-level treatments opinion by opinion.
6. Compile and ground the record; fix mechanical defects from the source.
7. Re-read the source for omissions and false speaker attribution.
8. Try to disprove every affirmative writer, vote, relationship, proposition,
   signal, scope, and quotation claim.

Do not admit a case until both adversarial readings are complete. Edit the gold
directly; a change ledger is not part of the benchmark.

## Admission checks

A record is ready only when:

- its source hash matches and the current compiler accepts it;
- every opinion, writer, participant, result position, and express agreement is
  supported by the source;
- every in-scope decision mention is present exactly once after source-proven
  alias merging;
- a same-litigation decision is treated only where an opinion actually uses or evaluates its reasoning;
- every treatment states a real proposition and operation of the identified
  opinion, with no counsel, quotation, or speaker misattribution;
- every direct or reported procedural action, direction, and affected part is accurate;
- evidence is minimal but sufficient, and every quoted passage is verbatim;
- grouped string citations and clearly adopted cross-opinion analysis have
  been checked deliberately; and
- two full adversarial source readings find no remaining semantic error.

Mechanical validation proves only that a record is well formed. It is never a
substitute for this semantic audit. A later judge's source-supported item that
is absent from gold is recorded as a gold challenge for correction; it does not
invalidate unrelated grades. Gold-reference accuracy is the headline score;
accurate extra discoveries are reported separately and never offset an omitted
gold item.

## Codex authoring route

`author-gold.ts` is the standard batch authoring path. Each case gets its own
Codex app-server thread and sees only the complete primary decision. The host
supplies the output schema, compiles the draft, and returns mechanical failures
as small JSON Patch requests rather than asking the model to repeat the record.

Authoring completes before auditing begins. Two complete audit passes are
required and run by default in the same persisted case thread. Each pass
re-reads the primary decision and returns only corrections; an empty patch
means it found none. Runs stopped with `--audits 0` or `--audits 1`
remain resumable drafts and cannot be assembled as benchmark gold. Raw output,
source hashes, continuation IDs, usage, every patch, and per-case state remain
in the run directory. Restarting the command skips completed stages and never
uses old gold or candidate output as authoring context.

## Sol 6.1 low expansions

Both expansions cover all 14 court datasets. The first 300 comprise 225
dataset-balanced decisions and 75 additional Supreme Court decisions, excluding
569 previously selected IDs. The latest 630 comprise 420 dataset-balanced
decisions and 210 additional Supreme Court decisions, excluding 870 previously
selected or rejected IDs. This gives the latest batch 30 decisions from each
non-SCC dataset and 240 SCC decisions; its sampling seeds are `20261009` and
`20261010`.
Sampling seeds, document IDs, public source URLs, provider-text SHA256 hashes,
and upstream license metadata are retained in `gold/selection-sol61-low-300.json`
and `gold/selection-sol61-low-630.json`. Sources come from the existing
local [A2AJ Canadian case-law dataset](https://huggingface.co/datasets/a2aj/canadian-case-law)
store; no second corpus copy is needed. The recorded upstream case revision is
`54bfeaec1ab9250ef4490e1f11df623d4fd4fad4`.
The first expansion replaced one disposition-only source using seed
`20261008`. The latest expansion replaced three sources without judicial
reasons using seeds `20261011`, `20261012`, and `20261013`; one of their author
calls was interrupted after streaming whitespace. The failed or interrupted
drafts, admission receipts, and original run manifests remain private. Each
expansion and the combined selection record the admission replacements and
every admitted addition's immutable annotation-source hash, separately from
its provider-text hash.

The submission origin is `machine_test`, with run IDs
`sol61-low-expansion-300` and `sol61-low-expansion-630`.
This identifies the automated submission; the decision text is public-source
material, not invented test data. Existing records keep their historical
provenance, and missing historical origin remains unknown. Assembly preserves
the previous 370 product records byte for byte. The additions are model-authored and
model-audited annotations; mechanical acceptance does not establish semantic
accuracy or human review.

From the repository root, the authoring command resumes retained stages. The
remaining commands project the admitted source records and assemble the active
corpus in selection order:

```powershell
.\backend\experiments\a2aj-case-treatment\gold\author-sol61-low.ps1 -Batch 630

.\node_modules\.bin\tsx.cmd backend/experiments/a2aj-case-treatment/gold/build-product-gold.ts `
  --source benchmarks/local-data/a2aj-case-treatment/sol61-low-expansion-630/gold.jsonl `
  --out backend/experiments/a2aj-case-treatment/gold/gold-product-scale-additions-sol61-low-630.jsonl

.\node_modules\.bin\tsx.cmd backend/experiments/a2aj-case-treatment/gold/assemble-product-scale-gold.ts

.\node_modules\.bin\tsx.cmd backend/experiments/a2aj-case-treatment/cli.ts validate-gold `
  --gold benchmarks/local-data/a2aj-case-treatment/sol61-low-expansion-630/gold.jsonl --workers 1 `
  --out benchmarks/local-data/a2aj-case-treatment/sol61-low-expansion-630/source-validation.json

.\node_modules\.bin\tsx.cmd backend/experiments/a2aj-case-treatment/cli.ts validate-product-gold `
  --gold backend/experiments/a2aj-case-treatment/gold/gold-product-scale-current.jsonl --workers 1 `
  --out benchmarks/local-data/a2aj-case-treatment/sol61-low-expansion-630/product-validation.json
```

Use `-Batch 300` and the matching `300` paths to regenerate the earlier batch.
Rich source gold, raw calls, receipts, and provider history stay in the owning
ignored run directory. Product JSONL stays in the ignored owning gold directory;
selection metadata and reproduction commands live beside the authoring scripts
in the repository.

Validation on 2026-10-06 accepted all 630 latest source records and all 1,000
active product records. Assembly preserves the previous 370 records byte for
byte and matches the complete
1,000-case selection order. The latest source report retains 206
`shared_treatment_wording` review flags across 107 decisions; grouped authorities
can legitimately share wording, and these flags do not fail mechanical
validation. Counts, artifact hashes, and validation receipts are retained in
the run's `summary.json`.

The compiler's paragraph coverage check excludes the next opinion's delivery
byline when it is attached to the preceding substantive paragraph. An independently
invented regression verifies that the preceding conclusion is still required.
The focused contract, product-gold, and Codex adapter suites passed 53 tests;
the authoring self-test also passed. The broader backend typecheck failed in
unchanged files: a missing `legal-citations/source-canlii-routes.json` import,
an argument-count mismatch in `documentProjectionService.ts`, and four
`S3Client.send` type errors in `storage.ts`.
