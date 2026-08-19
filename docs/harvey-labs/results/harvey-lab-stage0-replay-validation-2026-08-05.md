# Wings study — Stage 0 replay validation (2026-08-05)

Deterministic replay of three candidate wings over the 21 judged Phase C cells.
**Zero model calls, zero network, zero quota.** Nothing existing was edited; the
two production-candidate modules and the three replay drivers are new files.

| wing | verdict | one-line rationale |
|---|---|---|
| **W4** asserted-negative guard | **PASS (scope-limited)** | Fires 2× on the whole grid, both exposure-correct, one of them the C-011/C-012 defect; silent on all 11 whole-read cells — but structurally blind wherever the section spine is unaddressable (8 of 21 cells). |
| **W5** figure reconciliation | **PASS** | 4 findings across 3,052 figures, all 4 true; fires in exactly the two cells that failed C-028/C-031 and is silent in the two that passed. FP = 0. |
| **W7** find-query normalization | **PASS** | 7/7 of the Phase C definition-grammar queries recover at the definition site; census: 45/282 zero-hit → 33/282 after normalization; one regression, and it is a widening. |

---

## 0. Replay substrate — the served plane is byte-exact, not approximate

The run-mining report reconstructed served spans by anchoring 2,000-char result
previews back into extracted text ("accurate to a few hundred chars at each
edge"). That approximation is not needed. `beaver-receipts.json` carries
`tool_results[].evidence_segments` with exact `start`/`end` on the served body
plane, and the plane itself is a pure function of the task documents on disk:

- `.docx` → `extractDocxDraftingSource(bytes).markdown` (what
  `servedDraftingText` serves, SECT-INDEX excluded — offsets are body-relative)
- everything else → the plaintext extractor (`textParserFor` /
  `spreadsheetToLLMStructure`), which is what the harness falls back to

Validation, over every judged `mike_markdown_e2e*` run on disk:

- **131/131 document planes in the 21 sonnet cells reproduce
  `source_receipts[].served_body_chars` exactly** (source bytes checked by
  sha256 against `uploaded_documents[].source_sha256` first). The 98 mismatches
  in the table are deepseek runs whose receipts predate the
  `served_body_chars` field, so there is nothing to compare against.
- **The unioned spans reproduce `metrics.json.unique_source_exposure_ratio` to
  4 decimal places in all 21 cells** (max |Δ| < 0.00005).
- `doc-N` → filename mapping (index into `source_receipts`) verified against
  `evidence_segments[].filename`: **250 agree, 0 disagree.**

So every exposure claim below is exact, not inferred.

**Two corrections to the Stage 0 brief.** (a) The "No inconsistency identified"
deliverable is `banking-finance / mike_markdown_e2e_index_v1`, not
`index_floor` (forensics §4 has it right; the brief mis-cited the arm).
(b) The `$210,000,000 / $90,000,000` base-selection case is
`white-collar-defense-investigations / mike_markdown_e2e_floor_v1` (and
`index_floor`), not banking — run-mining §3.1 names `dpa/floor`. Both cases were
located verbatim before any validator was written.

The grid is 21 sonnet cells, not 18: 6 tasks × {e2e, floor, index_floor} plus
`index_v1` on banking, capital-markets and DPA (the other three `index_v1` arm
directories are empty). All 21 are replayed.

---

## 1. W4 — asserted-negative guard

**Module:** `backend/src/lib/legalNegativeAssertionGuard.ts` (new, consumers-only,
no I/O, typechecks under `--strict`).
**Driver:** `backend/.tmp-stage0-w4.ts`.

### Method

1. Six trigger families over the deliverable: `no_conflict`
   ("no inconsistency/conflict/discrepancy … identified/found/between"),
   `absence_of_provision` ("there is no", "nothing in", "no provision that"),
   `does_not` ("does not address/contain/include/…"), `silent`,
   `no_reference` ("never references", "makes no mention", "fails to define"),
   `consistency` ("is consistent with", "mirrors", "aligns with").
2. **Claim unit.** Citations are taken from the trigger's own sentence; only if
   that sentence carries none does the scan extend backwards, bounded at 400
   chars and never across a blank line. This is required by the sharpest form of
   the defect, where the anchors and the negative are separate sentences.
   Citations are labelled `trigger-sentence` or `claim-unit` so a consumer can
   weight them.
3. **Anchor resolution** reuses the production machinery: `findProvisionReferences`
   (`legalReferenceGrammar`) plus a local `§`-form scanner, resolved against each
   document's section spine derived by `deriveSectionNodes` + `renderStructureIndex`
   — the same `@N` body-plane anchoring the index arm serves. A section's range
   runs to the next **non-descendant** anchor, so "Section 2.02" means the section
   including its subsections, and "ARTICLE VII" runs to ARTICLE VIII.
4. **Typed refusals.** No matching anchor → `unresolvable / no-matching-anchor`.
   No addressable spine anywhere → `unresolvable / no-addressable-structure`.
   Same label in two documents with either side served → `ambiguous`, not
   actionable. Coordinates are never guessed.
5. **Verdict.** `unserved-anchor` (servedFraction exactly 0) is the only
   actionable class.

### Replay results (21 cells)

| task | arm | exposure | findings | **UNSERVED** | partial | served | unresolvable | no-anchor | all deliverable refs: unserved/resolved |
|---|---|---|---|---|---|---|---|---|---|
| antitrust | floor | 1.0000 | 2 | 0 | 0 | 0 | 1 | 1 | 0/10 |
| antitrust | index_floor | 0.5428 | 7 | 0 | 0 | 1 | 1 | 5 | 0/13 |
| antitrust | e2e | 1.0000 | 1 | 0 | 0 | 0 | 0 | 1 | 0/7 |
| banking | floor | 1.0000 | 8 | 0 | 0 | 3 | 0 | 5 | 0/87 |
| banking | index_floor | 0.3509 | 2 | 0 | 0 | 2 | 0 | 0 | 9/114 |
| banking | **index** | 0.3840 | 6 | **2** | 0 | 3 | 0 | 1 | 14/127 |
| banking | e2e | 1.0000 | 2 | 0 | 0 | 1 | 0 | 1 | 0/60 |
| capmkt | floor | 1.0000 | 4 | 0 | 0 | 0 | 0 | 4 | 0/0 |
| capmkt | index_floor | 0.8957 | 4 | 0 | 0 | 0 | 2 | 2 | 0/0 |
| capmkt | index | 1.0000 | 5 | 0 | 0 | 0 | 2 | 3 | 0/0 |
| capmkt | e2e | 1.0000 | 2 | 0 | 0 | 0 | 1 | 1 | 0/0 |
| employment | floor | 1.0000 | 2 | 0 | 0 | 1 | 0 | 1 | 0/51 |
| employment | index_floor | 0.6723 | 5 | 0 | 0 | 2 | 1 | 2 | 13/75 |
| employment | e2e | 1.0000 | 3 | 0 | 0 | 0 | 1 | 2 | 0/15 |
| insurance | floor | 1.0000 | 5 | 0 | 0 | 0 | 0 | 5 | 0/0 |
| insurance | index_floor | 0.7757 | 4 | 0 | 0 | 0 | 0 | 4 | 0/0 |
| insurance | e2e | 1.0000 | 2 | 0 | 0 | 0 | 0 | 2 | 0/0 |
| DPA | floor | 0.6651 | 5 | 0 | 0 | 0 | 1 | 4 | 0/0 |
| DPA | index_floor | 0.5569 | 6 | 0 | 0 | 0 | 1 | 5 | 0/0 |
| DPA | index | 0.1872 | 1 | 0 | 0 | 0 | 1 | 0 | 0/0 |
| DPA | e2e | 1.0000 | 12 | 0 | 0 | 0 | 2 | 10 | 0/0 |
| **total** | | | **88** | **2** | **0** | **13** | **14** | **59** | **36/559** |

### MUST-HIT: pass

`banking-finance / mike_markdown_e2e_index_v1`, trigger `No inconsistency
identified` @24256:

> **Cross-Reference Note:** The 365-day reinvestment period in Section 7.05(d)
> is consistent with the asset sale mandatory prepayment provisions in Section
> 2.05(b). **No inconsistency identified** between the two provisions, contrary
> to what sometimes occurs in template credit agreements.

- `Section 7.05(d)` → `credit-agreement.docx` @82485–83209, servedFraction **1.00**
- `Section 2.05(b)` → `credit-agreement.docx` @36558–37165, servedFraction **0.00**

Verdict `unserved-anchor`. This is criteria C-011 and C-012, −2 on that cell.

### MUST-STAY-SILENT: pass

All 11 cells at exposure 1.0000 fire **zero** `unserved-anchor` findings. This
holds by construction — a whole-read served span covers every anchor range, so
`servedFraction` is 1.00 for every citation — and is confirmed empirically. The
findings those cells do produce are `served-anchor` (13, informational),
`unresolvable-anchor` (references to items/exhibits/other instruments) and
`no-anchor` (claims about market practice, statutes, the world).

### Precision — every firing hand-checked

Two firings on the whole grid; both are in banking/index; both hand-checked
against the served-span map:

1. **C-011/C-012 case above.** Exposure claim correct, and judge-confirmed as a
   real criterion loss.
2. @31393, trigger `there is no`:
   > … Revolving Credit availability is governed by a straight
   > commitment-minus-outstanding formula under **Section 2.02**, with no
   > borrowing base formula tied to eligible accounts receivable, inventory, or
   > other asset pools. Exhibit H exists in the agreement, but **there is no**
   > operative borrowing base mechanism.

   `Section 2.02` → `credit-agreement.docx` @30192–31706, servedFraction
   **0.00**. The run's nearest served window ends at 30109 — 83 characters
   short of the section it is making a negative claim about. Exposure claim
   correct. The judge did not score this criterion against the cell, so it is a
   true positive on the guard's own predicate ("negative asserted over
   never-served text") and *not* a judge-confirmed defect.

**Precision on the exposure predicate: 2/2 = 1.00. False positives: 0.**
Judge-confirmed defect rate among firings: 1/2.

### Selectivity

Across the grid the deliverables assert **559** internal provision references
that resolve to an addressable anchor; **36** of those point at never-served
text (banking index 14, banking index_floor 9, employment index_floor 13; zero
in every whole-read cell — the same qualitative result run-mining got at 29 with
approximate spans). The guard reports **2** of the 36: exactly those inside a
negative assertion. That is the intended narrowing — an unserved citation is a
coverage fact (W8's job); an unserved citation inside a negative is a false
statement.

### Recall limit worth stating plainly

The guard needs an addressable section spine. Measured over the 6 grid corpora
(`deriveSectionNodes` + `renderStructureIndex` anchoring, per document):

| corpus | documents with an anchored spine |
|---|---|
| banking | `credit-agreement.docx` 295/310 |
| employment | `company-draft-employment-agreement.docx` 129/167; redline 8/113 |
| antitrust | `purchase-agreement-excerpts.docx` 70/76 |
| insurance | `linden-forensic-report.docx` 16/17 |
| capital-markets | **none** (8 docs, 0 anchored) |
| DPA | **none in the read documents** (`govt-counter-markup.docx` 0/83) |

On the DPA corpus the failure is sharper than "no anchors": the skeleton
compiles a spine of `Section 2.1 / 4.1 / 4.4(i)` from the Statement-of-Facts
paragraph numbering, while the markdown headings read `**<u>Section 5 —
Criminal Monetary Penalty</u>**`. The derived labels do not exist as headings,
so nothing anchors, and every DPA deliverable citation (`Section 5(c)`,
`Section 14(b)`, `Section 16`, `Section 19.3`) resolves to
`no-matching-anchor`. **8 of 21 cells (capmkt ×4, DPA ×4) are structurally
blind**, and forensics §6.3's other confident-false-negative case — DPA C-001,
treating Attachment C as present — is out of family anyway: it is an asserted
*positive*, which needs a different predicate.

Deployment consequence: gate W4 on the same `indexIsAddressable` predicate the
index arm already uses, and report `unresolvable` (never silence) where it is
false. That is what the module does today.

### Verdict: **PASS, scope-limited**

Precision 1.00 on 2 firings, 0 false positives, must-stay-silent clean. Advances
to a live cell as a post-draft gate, on corpora whose spine is addressable.
Where it is not, the wing has nothing to say and says so — which is the correct
behaviour but means it cannot be the whole answer for the no-fit band.

---

## 2. W5 — figure reconciliation

**Module:** `backend/src/lib/legalFigureReconciliation.ts` (new, clone of the
H1 organ's approach; `legalDerivedValueScan.ts` untouched).
**Driver:** `backend/.tmp-stage0-w5.ts`.

### Method

Provenance per figure, using `extractAnchors` (`legalTextAnchors.ts`,
read-only) so `$2.25 million` and `$2,250,000` share a value key:

- **VERBATIM** — the key occurs in served text (served windows only, not the
  whole document).
- **RECONSTRUCTIBLE** — a single operation over served figures inside one
  1,200-char window: `a+b`, `a−b`, `a×p%`, `a÷p%`, `a×n`, `a÷n` (n ≤ 12), 0.5%
  tolerance. The bases used are named in the finding.
- **UNGROUNDED** — neither.

Then the defect signal, **competing-base ambiguity**.

### The signal, and what it took to make it precise

The naive form in the brief — "a base sits where a different candidate base for
the same operation appears within N chars" — does not survive contact with the
grid. Measured, in order:

| form of the signal | findings on 21 cells | TP | FP |
|---|---|---|---|
| competing product attested anywhere in the corpus | 289 | 4 | 285 |
| + product must be attested near the competing base, and the percentage too | 91 | 4 | 87 |
| + deliverable must not already state the competing product | 27 | 4 | 23 |
| + bases must be the two ends of a source-stated `G − C = N` identity | 10 | 4 | 6 |
| + identity read in prose order, from **contiguous** money mentions | **4** | **4** | **0** |

The final form is a mechanism, not a threshold pair. Three conditions, each
with an independent justification:

1. **Source-stated adjustment identity.** Candidate bases must be the minuend
   and the result of a `minuend − subtrahend = result` identity the source
   states. This is the gross-vs-net-of-an-offset shape — the classic
   base-selection trap in legal drafting — and it is what makes two numbers
   interchangeable when later prose says "the penalty".
2. **The subtrahend is never a base.** In `G − C = N` the two quantities a
   later sentence can both call "the penalty" are `G` and `N`; `C` is the
   credit, and a percentage of the credit answers a different question.
   Admitting it was the largest FP family (the `70% of the $92.5M CFTC Offset`
   collisions).
3. **Prose order + contiguity.** `G − C = N` and `G − N = C` are the same
   arithmetic over the same three numbers but not the same claim, and English
   writes the identity left to right. Requiring the three figures to be
   *consecutive* money mentions in that order is what a stated expression looks
   like; without contiguity a repeated mention of the credit later in the
   paragraph re-forms the swapped assignment.

Both (3) conditions cost recall on identities split by an intervening figure
("$392.5 million, less the $92.5 million CFTC Offset and $8 million of fees, or
$300 million"). That is the intended trade given a near-zero FP budget.

Plus one condition that is about the deliverable rather than the source:
**a competing reading the deliverable already reports is not an ambiguity.**
This single condition removed the entire multi-column-table FP family — a
syndicate allocation row states one percentage against three bases (facility,
revolver, total) and correctly reports all three products, so every column looks
like a competing base for the other two until you ask whether the deliverable
dropped one.

### Replay results (21 cells, 3,052 figures)

| task | arm | figures | money | verbatim | reconstructible | ungrounded | dates verbatim | dates ungrounded | **competing-base** |
|---|---|---|---|---|---|---|---|---|---|
| antitrust | floor | 201 | 117 | 99 | 17 | 1 | 22 | 3 | 0 |
| antitrust | index_floor | 189 | 98 | 87 | 11 | 0 | 28 | 8 | 0 |
| antitrust | e2e | 212 | 126 | 91 | 34 | 1 | 18 | 4 | 0 |
| banking | floor | 252 | 165 | 144 | 20 | 1 | 27 | 0 | 0 |
| banking | index_floor | 182 | 127 | 116 | 11 | 0 | 22 | 1 | 0 |
| banking | index | 173 | 112 | 93 | 18 | 1 | 21 | 0 | 0 |
| banking | e2e | 185 | 119 | 93 | 26 | 0 | 17 | 3 | 0 |
| capmkt | floor | 59 | 15 | 14 | 0 | 1 | 37 | 0 | 0 |
| capmkt | index_floor | 55 | 0 | 0 | 0 | 0 | 50 | 0 | 0 |
| capmkt | index | 33 | 12 | 11 | 0 | 1 | 19 | 0 | 0 |
| capmkt | e2e | 59 | 17 | 16 | 0 | 1 | 37 | 0 | 0 |
| employment | floor | 172 | 107 | 76 | 21 | 10 | 8 | 4 | 0 |
| employment | index_floor | 172 | 93 | 56 | 33 | 4 | 7 | 5 | 0 |
| employment | e2e | 130 | 60 | 51 | 7 | 2 | 11 | 2 | 0 |
| insurance | floor | 191 | 156 | 142 | 11 | 3 | 24 | 1 | 0 |
| insurance | index_floor | 154 | 111 | 108 | 3 | 0 | 35 | 1 | 0 |
| insurance | e2e | 188 | 137 | 104 | 31 | 2 | 33 | 2 | 0 |
| DPA | **floor** | 95 | 56 | 45 | 9 | 2 | 15 | 1 | **2** |
| DPA | **index_floor** | 109 | 59 | 47 | 11 | 1 | 23 | 1 | **2** |
| DPA | index | 131 | 82 | 67 | 14 | 1 | 13 | 3 | 0 |
| DPA | e2e | 110 | 59 | 57 | 1 | 1 | 27 | 1 | 0 |
| **total** | | **3,052** | **1,828** | **1,517** | **278** | **33** | **494** | **40** | **4** |

Money grounding: **98.2%** of the 1,828 money figures are verbatim or
reconstructible from served text — an independent confirmation of run-mining's
"arithmetic is not the problem" finding, on exact spans this time.

### MUST-HIT: pass, with clean discrimination

All 4 findings, and only these 4:

```
DPA / floor @7720   70% -> $210,000,000   chosen $300,000,000 @14298
                                          competing $392,500,000 @14258
    identity: $392,500,000 − $92,500,000 = $300,000,000  (contiguous, 41 chars)
    70% of the competing base = $274,750,000, attested verbatim @14443
DPA / floor @7797   30% -> $90,000,000  -> competing product $117,750,000 @14636
DPA / index_floor @5359   70% -> $210M  -> competing product $274,750,000
DPA / index_floor @5493   30% -> $90M   -> competing product $117,750,000
```

Judge ground truth on the four DPA cells (`scores.json`):

| cell | C-028 | C-031 | W5 findings |
|---|---|---|---|
| DPA floor | **fail** — *"The memo applied percentages to the net figure, not the gross."* | **fail** | **2** |
| DPA index_floor | **fail** — *"applying percentages to the net penalty after CFTC offset"* | **fail** | **2** |
| DPA index | pass | pass | 0 |
| DPA e2e | pass | pass | 0 |

The signal separates the failing cells from the passing cells exactly, and is
silent on the other 17 cells.

### MUST-NOT: pass

**False positives: 0.** Across 3,052 figures and 1,795 correctly-grounded money
figures (278 of them reconstructions), nothing outside the four fires. There is
no false positive to quote.

For the record, the FP families the final mechanism removes, with their
representative excerpts, are the ones tabulated above: cross-document product
collisions (`5% of $425M enterprise value` vs `$1.0M` in a synergy deck),
multi-column allocation tables (`$87,500,000 | $35,000,000 | $122,500,000` at
35%, all three correct and all three stated), alternative-proposal bases (VMH's
$284M markup vs the government's $392.5M), and the subtrahend swap
(`70% of the CFTC Offset of $92,500,000`).

### Verdict: **PASS**

Precision 1.00, recall 2/2 on the judged criterion pairs, FP budget met exactly.
The wing is worth deploying **as a post-draft check on both bands** — note the
firing cells include a whole-read-class arm (`DPA floor` at 0.6651 exposure and
`index_floor`), and the defect is a quotation-discipline failure over *served*
text, which is the fit-band failure class. Deployment caveat: the mechanism only
sees gross/net-of-adjustment ambiguity. It is one witness, not a figure auditor;
ensemble-witness rules apply.

---

## 3. W7 — find-query normalization (probe only)

**Probe:** `backend/.tmp-stage0-find-norm.ts`. Nothing wired; the native arm's
pinned behaviour is untouched. Matcher is `findTextMatches` from
`backend/src/lib/chat/tools/documentOps.ts`, imported read-only.

### Plane discipline

`find_in_document` does not search one plane. Read from
`localAssistantTools.ts`: under `STRUCTURE_INDEX_ENABLED` it searches
`drafting.served.slice(drafting.bodyOffset)` — the markdown body; otherwise it
searches `extractLocalDocument(...).text` — the plaintext plane. The census
follows that split per arm.

**Fidelity: 282/282 `find_in_document` calls across all 12 judged runs that
issued one reproduce the recorded `total_matches` exactly.** The replay is the
tool.

### Census

| | calls | zero-hit |
|---|---|---|
| all judged Beaver runs on disk (12 runs) | 282 | 45 (16.0%) |
| Phase C sonnet grid subset | **36** | **9**, of which **7** are the definition grammar |

The grid subset reproduces run-mining §3.3 exactly (36 calls, 9 zero, 7
`<Term> means`), independently and on exact planes.

### The defect is two defects, not one

Run-mining diagnosed quotation marks. On the plaintext plane that is right:

```
PLAINTEXT   "Consolidated EBITDA" means, for any period, …
```

But the arms that actually issue these queries are the **index** arms, and they
search the markdown plane, where pandoc puts the bold run *inside* the quotes:

```
MARKDOWN    "**Consolidated EBITDA**" means, for any period, …
```

So on the plane the model is searching, both `Consolidated EBITDA means` **and**
`"Consolidated EBITDA" means` return zero. The markdown swap added a second,
independent break in the same query grammar. Every one of the 7 grid failures is
on the markdown plane.

### Recovery — variant enumeration

Variants: term unquoted, then re-wrapped across {none, `"`, `“ ”`, `‘ ’`,
`« »`} × emphasis {none, `**`, `*`, `__`, `_`} × definitional verb {means, shall
mean, has the meaning, have the meanings, shall have the meaning, is defined
as}; bare term last.

**Definition-grammar family: 11 calls in the full census, all 11 returned zero;
11/11 recovered, 8/11 landing on the definition site with the verb retained.**
The 7 Phase C grid queries are all in the 8:

```
banking/index_floor  "Change of Control means"                    -> "**Change of Control**" means            = 1
banking/index_floor  "Permitted Holders means"                    -> "**Permitted Holders**" means            = 1
banking/index_floor  "Available Amount means"                     -> "**Available Amount**" means             = 1
banking/index_floor  "Senior Secured Net Leverage Ratio means"    -> "**Senior Secured…Ratio**" means         = 1
banking/index        "Consolidated EBITDA means"                  -> "**Consolidated EBITDA**" means          = 1
banking/index        "Change of Control means"                    -> "**Change of Control**" means            = 1
banking/index        "Available Amount means"                     -> "**Available Amount**" means             = 1
banking/index (ds)   "Required Lenders means"                     -> "**Required Lenders**" means             = 1
```

**Target 7/7: met**, and each lands on the definition site itself — not on the
bare term the model had to retry by hand (`Consolidated EBITDA` → 14 hits, which
is what it did in the run and why it never reached Article I cleanly).

### The better fix, and the upstream statistic

Variant enumeration is a wrapper. The general form is to fold both sides before
matching — the same shape `findTextMatches` already applies for whitespace and
case, extended to drop markdown decoration (`*`, `_`, `` ` ``, pandoc `\`
escapes) and **drop** quote characters rather than canonicalize them:

| normalization | zero-hit calls recovered (model's ORIGINAL query, no variants) |
|---|---|
| canonicalize quotes + strip decoration | 1 / 45 |
| **drop quotes + strip decoration** | **12 / 45** (11 of them the definition grammar) |

Canonicalizing is not enough: legal drafting wraps every defined term in quotes
at its definition site and the model's query never carries them, so the quotes
have to disappear from both sides. Under the drop-fold, all 11 definition-grammar
queries hit the definition site with **no variant machinery at all**, including
the 3 corporate-ma queries that variant enumeration could only rescue via the
bare term.

**Regression check:** of the 237 calls that already returned hits, exactly **1**
changes count under the drop-fold — `"Change of Control"` (query written with
literal quotes) goes 1 → 8, because it now also matches unquoted usages. That is
a semantic widening, not a corruption, but it is a behaviour change: a query with
explicit quotes arguably means the quoted form. A production version should keep
an index map back to the original text (as `normalizeWithMap` does) so offsets
stay exact, and should consider preserving quote-sensitivity when the query
itself supplies quotes.

### Headline census numbers

- zero-hit rate **before**: 45/282 = **16.0%**
- zero-hit rate **after** (variant enumeration): 33/282 = **11.7%**
- zero-hit rate **after** (drop-fold, original query): 33/282 = **11.7%**

The residual 33 are genuine absences, verified: paraphrase misses
(`monitor selection pool`, absent from the corpus), a mis-routed document
(`General Counsel and Secretary` queried against `officers-certificate.docx`),
and — a separate class worth recording — **vocabulary mismatches** in the codex
`adaptive_mike` and deepseek corporate-ma runs: `pinnacle-ecommerce-agreement.docx`
and `ridgeline-10k-excerpt.docx` contain zero instances of "change of control",
and `solara-deferred-comp-plan.docx` writes "change **in** control" 18 times.
That is a synonym gap, not a punctuation gap, and W7 does not address it.

### Verdict: **PASS**

7/7 target met at the definition site. The drop-fold is the version worth
building and the version worth contributing upstream: upstream's literal search
fails on the single most common defined-term query grammar, on both the
plaintext and the markdown planes. Wire it to Beaver arms only, flag-gated;
never the native arm.

---

## 4. Files

New, production-candidate:

- `backend/src/lib/legalNegativeAssertionGuard.ts` — W4 guard (pure; imports
  `legalReferenceGrammar` only). Also exports `resolveReferences`, which is the
  denominator W8's coverage certificate needs.
- `backend/src/lib/legalFigureReconciliation.ts` — W5 reconciliation (pure;
  imports `legalTextAnchors` only). Also exports `findAdjustmentIdentities`.

New, replay drivers (scratch):

- `backend/.tmp-stage0-recon.ts` — served-plane reconstruction + cell loader
- `backend/.tmp-stage0-verify.ts` — exposure-ratio validation
- `backend/.tmp-stage0-w4.ts`, `backend/.tmp-stage0-w5.ts`,
  `backend/.tmp-stage0-find-norm.ts` — the three validators
- `backend/.tmp-stage0-spine.ts`, `.tmp-stage0-docmap.ts`,
  `.tmp-stage0-defsite.ts`, `.tmp-stage0-dpafig.ts`, `.tmp-stage0-dump.ts` —
  supporting probes
- outputs under `backend/.tmp-stage0-out/`

Nothing tracked was modified. No git operations were run.

## 5. What this changes for the study design

- §6 falsification test ("Stage 0: W4/W5 replay precision below ~1.0 on known
  cases → wing dies") is satisfied for both: W4 2/2, W5 4/4.
- **W4's band assignment holds but its coverage does not.** It is a no-fit-band
  wing as designed, but it needs an addressable spine, which 2 of the 6 grid
  corpora do not have. Before Stage 2 it is worth checking the addressability
  of the five no-fit corpora (CoC, indenture, diligence, tax-TP,
  antitrust-risk) — the design assumes the guard will function there.
- **W5's band assignment should widen.** The design lists W5 as "fit + no-fit";
  the replay shows the defect firing in a scoped arm *and* in a
  whole-read-class arm, over fully served text. It is a quotation-discipline
  check, so it belongs wherever a deliverable restates a percentage of a
  quantity the source nets down.
- **W7 gains a second justification.** It is not only "upstream's literal search
  fails on `"Term" means`"; the markdown swap independently breaks the same
  query with emphasis markers. Any arm on the markdown plane needs the fold.
