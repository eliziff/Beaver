# Gold authoring standard

Gold is authored afresh from newly selected primary decisions. Earlier issue-
based annotations are not converted or used as drafting shortcuts.

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
3. Account for every detector occurrence exactly once. Correct false positives
   with `not_decision_reference`; add detector misses with a null occurrence ID.
   Preserve the words by which this decision identifies the cited decision.
4. For every opinion, identify each proposition it attributes to a cited
   decision and any substantive operation the opinion performs on that
   proposition. Use no treatment record for a bare mention.
5. State the proposition as this containing opinion presents it. Then state
   succinctly and completely what the opinion does with it and the material
   factual or legal scope. Attach the smallest complete exact evidence spans.
6. Record exact reproduced passages that matter to the account, including
   interrupted or visibly edited quotations. Do not attribute counsel's words,
   another court's words, or a quoted source to the current opinion unless it
   adopts them.
7. Record an earlier or appealed decision from the same litigation under
   procedural history. Reversal or affirmance of that decision is not
   precedential overruling or approval.
8. Validate the record against its source hash and compiler before moving on.

The annotation contains legal-semantic truth, not just structurally valid JSON.
Local identifiers have meaning only within one containing decision. Citation
alias resolution and acquisition of the cited decision are later work.

## Two adversarial passes

After the initial set is complete, read every source again twice.

The first pass looks for omissions and false attribution: missed citation
occurrences, missed opinions, treatments assigned to counsel or quoted sources,
missing same-proceeding history, and propositions split or merged at the wrong
legal unit.

The second pass tries to disprove each affirmative annotation: writer and
joinder claims, result positions, treatment signals, proposition wording,
scope, exact evidence, quotation attribution, and majority support. It also
checks that neutral references were not promoted into treatment and that true
treatment was not discarded merely because the court used no citator keyword.

Both passes edit the gold directly. A separate change ledger is not part of the
benchmark artifact.

## Admission gate

A case enters the benchmark only when:

- its source hash matches;
- every compiler and grounding check passes;
- conservative substantive coverage passes where asserted;
- every detector occurrence is accounted for;
- every treatment is attached to an existing opinion and decision reference;
- quoted language in analyst prose is exact and substantial unmarked copying is
  either quoted or genuinely paraphrased; and
- both adversarial readings find no remaining legal-semantic error.
