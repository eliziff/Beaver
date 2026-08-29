# Gold authoring standard

`gold/gold-ablation-10-v6.jsonl` is the canonical ten-case gold for the v6
contract ablation. It records the audited treating opinion, but omits the
candidate-only copied-support check. Both `simple` and `self-check` candidates
compile into the same comparison record.
`gold/gold.jsonl` is retained as earlier source material. The launcher requires
an explicit gold path instead of silently selecting either file.

## Selection

- Use seeded random selection and retain the seed and draw order.
- Default to the 14 A2AJ court datasets: the nine available provincial or
  territorial courts plus SCC, FCA, FC, TCC, and CMAC.
- Stratify across those datasets for breadth unless a stated experiment calls
  for a corpus-proportional random sample.
- Exclude every decision used to design or debug the earlier contracts.
- Do not select by expected treatment outcome after reading the case.

## Authoring one record

1. Read the complete containing decision, including front matter and every set
   of judicial reasons.
2. Identify the full substantive boundary and actual writer of each opinion.
   Record every participant, express nonparticipant, vote, and joinder supported
   by the text. Do not turn headings, signatures, or bare agreements into
   opinions.
3. In `decision_mentions`, record one clear source block for every adjudicative
   decision cited, quoted, or described. Merge aliases only when the source
   establishes that they identify the same decision. Do not include the current
   case's editorial metadata.
4. In the flat `treatments` list, identify each proposition an opinion
   attributes to a cited decision and any substantive operation the opinion
   performs on it. If a passage treats several decisions together, record one
   treatment for each decision. Use no treatment for a bare mention.
5. State the proposition as this containing opinion presents it. Then state
   succinctly and completely what the opinion does with it and the material
   factual or legal scope. Record the audited treating opinion and the smallest
   complete evidence blocks.
6. Store exact words attributed to the cited decision in `quoted_passages`,
   including interrupted or visibly edited quotations. Do not attribute
   counsel's words, another court's words, or an unadopted quotation to the
   current opinion.
7. Add a flat `procedural_relationships` entry only for a decision from the same
   litigation. Record its role and any action the present court directly takes
   on it. Identify the affected part when the action is narrower than the whole
   decision. A procedural reversal is not precedential overruling; any
   proposition-level treatment remains separate.
8. Validate the record against its source hash and compiler before moving on.

The annotation contains legal-semantic truth, not just structurally valid JSON.
Local identifiers have meaning only within one containing decision. Citation
alias resolution and acquisition of the cited decision are later work.
Every JSONL row declares the current contract version; old gold is rejected
rather than silently reinterpreted by a newer compiler.

Gold is used only by benchmark comparison and semantic judgment. Extraction,
compilation, correction, and production receipts operate without it.

## Two adversarial passes

After the initial set is complete, read every source again twice.

The first pass looks for omissions and false attribution: missed citation
occurrences, missed opinions, treatments assigned to counsel or quoted sources,
missing same-litigation relationships or procedural actions, and propositions
split or merged at the wrong legal unit.

The second pass tries to disprove each affirmative annotation: writer and
joinder claims, result positions, treatment signals, proposition wording,
exact evidence, quotation attribution, and point-level support. It also
checks that neutral references were not promoted into treatment and that true
treatment was not discarded merely because the court used no citator keyword.

Both passes edit the gold directly. A separate change ledger is not part of the
benchmark artifact.

## Model-drafted expansion

Hand authoring is for establishing the benchmark, not the intended expansion
path. A future source-only drafting run will:

1. have one model draft the complete record;
2. compile exact spans, opinion ownership, source hashes, substantive coverage,
   marked quotations, source-exact copied prose, and conservative citation
   omissions without consulting reference answers;
3. return only patch-sized mechanical defects to the drafter;
4. have an independent stronger model audit the compiled draft against the
   complete source for missing or legally wrong opinions, relationships,
   propositions, treatments, and speaker attribution; and
5. send only surviving disagreements to human review.

Source-exact analyst wording and treatment wording shared across cited decisions
are retained as receipts for the independent audit, not silently rewritten.

A model being evaluated on this benchmark must never author or revise its own
reference answer.

## Admission gate

A case enters the benchmark only when:

- its source hash matches;
- every compiler and grounding check passes;
- conservative substantive coverage passes where asserted;
- every actual cited decision is recorded once;
- every treatment is attached to an existing opinion and cited decision;
- marked quotations are exact, unsupported or altered quotations fail, and
  substantial source-exact wording in analyst prose has a source receipt; and
- both adversarial readings find no remaining legal-semantic error.
