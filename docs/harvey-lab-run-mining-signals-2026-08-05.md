# Harvey-LAB corpus signals and run-trace mining — grounding a selective deployment policy

Date: 2026-08-05
Scope: `benchmarks/harvey-labs/tasks` (open tier, 14 tasks) and the landed
`beaver-mike_markdown_e2e_*-claude-p-claude-sonnet-4-6` grid (21 scored runs, 6 tasks × 4 arms).
Read-only mining; no runs were launched and nothing under `backend/` was touched.

**Hypothesis under test:** the correct trigger for an index / cross-reference / definition
wing is that the structure *actually exists in the selected documents above a threshold*.

**Verdict: supported, with a sharper form.** The trigger that separates the matrix is not
"structure exists" in general — it is *which family* of structure exists. Definitional-sentence
density (`"Term" means`) predicts where a definition wing pays; in-text cross-reference density
predicts where scoped reading is safe at all. Parenthetical definitions — the most common
convention by raw count — predict nothing and would be a false-positive generator.

---

## 0. Method and labelled approximations

Extraction: `python-docx` (paragraphs + tables in document order), `openpyxl`, `pdfplumber`,
`python-pptx`, stdlib `email`. Verified by eye on `credit-agreement.docx`
(141,731 chars, preamble → schedules, table rows pipe-joined).
Tracked changes read from raw `word/*.xml` (`<w:ins`, `<w:del`).

**Served-text reconstruction (approximation — used throughout Part 2).** Run receipts store
only a 2,000-char preview per tool result (1,600 head + `…` + ~400 tail) plus `content_chars`.
Served spans were recovered by anchoring the preview head and tail back into the extracted
source text; `head:`/`tail:` reads map to document start/end; `find_in_document` spans are
reconstructed from match ordering (the tool returns the first `returned` occurrences of the
query with ±`context_chars`). Spans are accurate to a few hundred chars at each edge. One
call out of ~230 failed to anchor (`employment/idx+flr toolu_009`, doc-2 offset 32202) and is
excluded, so that run's coverage is a slight under-count.

**Two parse traps worth recording** (both produced badly wrong intermediate numbers before
being caught):
- `json.loads` on `content_preview` fails for any result over 2,000 chars. Parsing that as
  "0 hits" made `find_in_document` look 53% broken. Regexing `"total_matches":(\d+)` out of
  the preview head gives the truth: **0 tool misses in 36 calls**.
- Matching judge reasoning by *literal* money string misses `$210M` vs `$210 million`.
  Value-normalised matching is required.

Scripts and raw outputs live in the session scratchpad under `run-mining/`
(`signals.py`, `defs.py`, `served.py`, `toolsig.py`, `figcheck.py`, `xrefdef.py`,
`attrib.py`, `dates.py`, `econ2.py` and their `*.json` / `*-detail.txt`).

---

## 1. Corpus signal table (deterministic, per task)

All densities are per 10,000 characters of extracted text. `*` marks the two grid tasks where
a definition wing was later measured to pay.

| task | grid | docs | kchar | struct/10k | docs ≥5 struct | xref/10k | in-text xref/10k | distinct anchors | xdoc edge dens. | $/10k | %/10k | numeric/10k | date/10k | rel-deadline/10k | tracked docs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closing | Y | 8 | 113 | 4.06 | 4/8 | 6.35 | 6.00 | 35 | 0.18 | 4.15 | 5.03 | 13.06 | 22.33 | 0.53 | 0 |
| banking* | Y | 3 | 168 | 8.29 | 3/3 | 15.69 | 9.71 | 192 | 0.50 | 15.69 | 4.44 | 31.43 | 4.26 | 1.72 | 0 |
| employment* | Y | 5 | 178 | 6.62 | 4/5 | 15.88 | 10.89 | 134 | 0.45 | 4.99 | 6.40 | 12.80 | 1.57 | 1.40 | 1 |
| dpa | Y | 6 | 299 | 13.23 | 4/6 | 8.55 | 4.84 | 140 | 0.10 | 6.98 | 1.40 | 11.76 | 3.04 | 1.44 | 2 |
| insurance | Y | 7 | 275 | 5.23 | 6/7 | 2.25 | 1.13 | 46 | 0.14 | 7.52 | 1.24 | 14.21 | 7.88 | 0.47 | 0 |
| hsr | Y | 9 | 315 | 2.22 | 6/9 | 3.77 | 2.72 | 81 | 0.12 | 18.25 | 28.00 | 51.29 | 1.71 | 0.57 | 0 |
| subpoena | | 14 | 514 | 1.50 | 8/14 | 1.92 | 1.54 | 58 | 0.14 | 2.20 | 0.91 | 6.92 | 17.53 | 0.19 | 0 |
| cond-prec | | 13 | 184 | 3.91 | 5/13 | 12.05 | 10.15 | 104 | 0.09 | 10.26 | 2.77 | 25.08 | 8.85 | 1.79 | 0 |
| bankruptcy | | 7 | 299 | 5.31 | 4/7 | 11.59 | 7.21 | 247 | 0.40 | 38.78 | 11.62 | 67.77 | 9.72 | 2.27 | 0 |
| timeline | | 15 | 357 | 8.59 | 8/15 | 7.75 | 5.34 | 119 | 0.11 | 11.95 | 2.49 | 18.24 | 11.33 | 1.15 | 0 |
| diligence | | 31 | 906 | 12.15 | 26/31 | 15.37 | 6.78 | 442 | 0.07 | 10.01 | 3.14 | 21.01 | 7.79 | 1.33 | 0 |
| coc-matrix | | 19 | 922 | 12.45 | 18/19 | 18.76 | 9.96 | 476 | 0.07 | 5.16 | 2.99 | 11.46 | 3.44 | 2.29 | 0 |
| indenture | | 14 | 987 | 5.22 | 10/14 | 10.70 | 6.83 | 467 | 0.16 | 6.33 | 4.12 | 16.78 | 3.14 | 2.01 | 1 |
| transfer-px | | 25 | 1182 | 5.35 | 25/25 | 5.69 | 4.58 | 326 | 0.10 | 10.66 | 17.64 | 33.07 | 4.07 | 0.87 | 0 |

`struct/10k` = lines matching `^\s*(ARTICLE|Section|§)\s` or `^\s*\d+(\.\d+)*[.)]\s`.
`in-text xref` excludes matches at line start (those are headings, not references).
`xdoc edge dens.` = fraction of ordered document pairs where A's text mentions B by filename phrase.

**(g) Tracked changes.** Only 3 of 14 task corpora carry any revision marks:
`counterparty-redline-employment-agreement.docx` (248 `w:ins` / 198 `w:del`),
`govt-counter-markup.docx` (19/28) + `vmh-initial-markup.docx` (35/23),
`precedent-indenture-markup.docx` (10/9). The two "analyze-counterparty-markup" tasks
therefore express most of their markup as *prose annotations*, not as real DOCX revisions —
consistent with the wild-DOCX-realism note that this corpus is synthetic.

### 1(h) Defined terms, first-class

| task | h1 paren-defs | h1 def-sentences | def-sent /10k | docs w/ Definitions heading | h2 remote frac | h2 cross-doc frac | h3 imports |
|---|---|---|---|---|---|---|---|
| banking* | 26 | 74 | **4.38** | 1 | 0.855 | 0.056 | 3 |
| coc-matrix | 267 | 288 | 3.12 | 14 | 0.976 | 0.501 | 26 |
| indenture | 235 | 299 | 3.03 | 4 | 0.989 | 0.880 | 23 |
| cond-prec | 38 | 46 | 2.50 | 1 | 0.837 | 0.487 | 11 |
| diligence | 245 | 213 | 2.35 | 12 | 0.966 | 0.657 | 14 |
| bankruptcy | 74 | 68 | 2.27 | 1 | 0.961 | 0.694 | 3 |
| employment* | 52 | 40 | **2.24** | 2 | 0.878 | 0.537 | 4 |
| transfer-px | 263 | 220 | 1.86 | 13 | 0.958 | 0.750 | 8 |
| hsr | 29 | 21 | 0.67 | 1 | 0.881 | 0.084 | 1 |
| timeline | 55 | 15 | 0.42 | 1 | 0.839 | 0.193 | 1 |
| closing | 59 | 3 | 0.26 | 0 | 0.949 | 0.789 | 6 |
| insurance | 7 | 6 | 0.22 | 0 | 0.707 | 0.034 | 2 |
| subpoena | 52 | 9 | 0.17 | 1 | 0.985 | 0.871 | 0 |
| dpa | 86 | 0 | **0.00** | 0 | n/a | n/a | 0 |

- **(h1) convention families.** Parenthetical inline (`(the "Term")`, `("Term")`,
  `(each a "Term")`, `(collectively, the "Terms")`, straight and curly quotes) vs definitional
  sentence (`"Term" means | shall mean | has the meaning`) vs dedicated section heading
  (Definitions / Defined Terms / Interpretation). **The two families are nearly independent.**
  `closing` has 59 parenthetical definitions and 3 definitional sentences; `dpa` has 86
  parentheticals and *zero* definitional sentences and zero definition sections.
- **(h2) usage-site pressure.** For the ~10 most-used `means`-defined terms per corpus:
  the remote fraction (usages outside the defining section) is ≥0.70 everywhere and ≥0.95 in
  6 of 13 measurable corpora. Definitions are essentially never used where they are stated.
  Caveat: `closing`'s 0.949 rests on ≤3 sampled terms and is not load-bearing.
- **(h3) cross-document imports.** Genuine agreement-to-agreement imports:
  `cond-prec` — `borrowing-request.docx`, `compliance-certificate.docx`,
  `guarantor-secretary-certificate.docx` all take meanings from *Credit Agreement*;
  `closing` — `issuer-counsel-10b5-letter.docx` and `officers-certificate.docx` import from
  *Underwriting Agreement*, `tax-opinion.docx` from *Indenture*;
  `indenture` — `existing-credit-agreement.docx` ↔ *Credit Agreement*,
  `acquisition-agreement-excerpts.docx` → *Notes Indenture*;
  `bankruptcy` — *Bankruptcy Code*. Approximation: the `as defined in <X>` pattern also fires
  on intra-document targets (`as defined in Section 7`), which inflates the raw h3 counts for
  `diligence`, `coc-matrix` and `transfer-px`; only the named-agreement subset is a true import.

---

## 2. Proposed triggers and thresholds

These are read off the 14-task matrix and validated against the measured run outcomes in
Part 3. Each is a corpus-side gate; all of them are additionally conditioned on the harness
actually scoping (a wing that resolves remote structure is worth nothing when the run
whole-reads the corpus, which is why all whole-read arms score identically on these measures).

| wing | fire when | why it separates |
|---|---|---|
| **Definition resolver** | `def-sentences/10k ≥ 1.5` **and** ≥1 document carries a Definitions/Defined-Terms/Interpretation heading | Clean gap in the matrix between employment (2.24, wing pays) and hsr (0.67, wing does not). Fires on banking, coc-matrix, indenture, cond-prec, diligence, bankruptcy, employment, transfer-px. Does not fire on hsr, timeline, closing, insurance, subpoena, dpa. |
| **do NOT use parenthetical density as a trigger** | — | Parenthetical defs are *local* — the term is defined at first use, in place. `closing` (5.21 paren/10k, 0 def-sentences) and `dpa` (2.87 paren/10k, 0 def-sentences) both scored **zero** definition-attributable misses. A parenthetical-density trigger would fire on the two corpora where it is provably useless. |
| **Cross-doc definition import resolver** | ≥3 `capitalized terms … not defined herein` / `meanings ascribed in <named agreement>` sites naming a *different* document in the selected set | Fires on cond-prec (11), closing (6), indenture (23); silent on dpa (0), subpoena (0), hsr (1). |
| **Scoped/index navigation is SAFE** | `in-text xref/10k ≥ 6` | Damage from scoping is monotone in this signal (Part 3.6): below 5 the cost is 1.7–2.1 criteria per 10 pp of unserved corpus; at ≥9.7 it is 0.16–0.68 or a net gain. |
| **Whole-read floor** | `in-text xref/10k < 6` **or** `def-sentences/10k < 1.5` with `docs ≥ 6` | Evidence bundles (emails, adjuster notes, spreadsheets, board decks) carry no internal routing; the only way to find a fact is to read the document. |

A single composite that reproduces the observed matrix:

```
navigate_scoped   := in_text_xref_per10k >= 6.0
definition_wing   := def_sentence_per10k >= 1.5 AND definitions_heading_docs >= 1
                     AND navigate_scoped          # only pays when reading is scoped
import_wing       := named_cross_doc_imports >= 3
otherwise         := whole-read
```

Applied to the 6 grid tasks: `definition_wing` fires on **banking** and **employment** only —
exactly the two tasks whose scoped arms lost criteria to unserved definitions, and no others.

---

## 3. Run-trace behavioural mining

### 3.0 Inventory and served coverage

21 scored runs. Three `mike_markdown_e2e_index_v1` cells never ran (employment, insurance,
hsr — empty arm directories). The `e2e` and `floor` arms almost always issue a single
`fetch_documents` for every document (100% served); the `index` and `index_floor` arms navigate
a SECT-INDEX and read scoped windows.

| task | arm | score | rounds | calls | fetch | read | find | served % | docs touched | in tok | out tok | wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closing | e2e | 29/32 | 2 | 2 | 1 | 0 | 0 | 100% | 8/8 | 81,230 | 53,334 | 919 |
| closing | floor | 28/32 | 2 | 2 | 1 | 0 | 0 | 100% | 8/8 | 42,672 | 27,544 | 483 |
| closing | index | 29/32 | 3 | 4 | 3 | 0 | 0 | 100% | 8/8 | 235,916 | 84,255 | 1416 |
| closing | idx+flr | 29/32 | 4 | 8 | 3 | 2 | 2 | 100% | 8/8 | 103,246 | 21,963 | 404 |
| banking | e2e | 56/65 | 2 | 2 | 1 | 0 | 0 | 100% | 3/3 | 199,767 | 75,415 | 1481 |
| banking | floor | 58/65 | 2 | 2 | 1 | 0 | 0 | 100% | 3/3 | 113,422 | 52,934 | 1020 |
| banking | index | 54/65 | 5 | 15 | 2 | 6 | 6 | **42%** | 3/3 | 148,091 | 39,919 | 802 |
| banking | idx+flr | 57/65 | 7 | 30 | 1 | 20 | 8 | **36%** | 3/3 | 326,797 | 82,835 | 1678 |
| employment | e2e | 48/59 | 2 | 2 | 1 | 0 | 0 | 100% | 5/5 | 199,538 | 74,903 | 1486 |
| employment | floor | 51/59 | 2 | 2 | 1 | 0 | 0 | 100% | 5/5 | 199,696 | 75,961 | 1477 |
| employment | idx+flr | 53/59 | 3 | 11 | 1 | 9 | 0 | 63% | 4/5 | 120,364 | 52,367 | 1028 |
| dpa | e2e | 42/58 | 2 | 2 | 1 | 0 | 0 | 100% | 6/6 | 84,742 | 20,610 | 485 |
| dpa | floor | 36/58 | 2 | 2 | 1 | 0 | 0 | **65%** | 3/6 | 58,938 | 30,320 | 684 |
| dpa | index | 28/58 | 7 | 30 | 1 | 8 | 20 | **19%** | 5/6 | 194,490 | 40,562 | 896 |
| dpa | idx+flr | 41/58 | 5 | 12 | 1 | 10 | 0 | 55% | 5/6 | 164,361 | 18,410 | 421 |
| insurance | e2e | 56/57 | 2 | 2 | 1 | 0 | 0 | 100% | 7/7 | 162,568 | 63,731 | 1292 |
| insurance | floor | 56/57 | 2 | 2 | 1 | 0 | 0 | 100% | 7/7 | 194,540 | 48,384 | 999 |
| insurance | idx+flr | 50/57 | 6 | 13 | 2 | 10 | 0 | 71% | 7/7 | 262,029 | 25,804 | 551 |
| hsr | e2e | 48/50 | 2 | 2 | 1 | 0 | 0 | 100% | 9/9 | 797,286 | 183,872 | 3768 |
| hsr | floor | 47/50 | 2 | 2 | 1 | 0 | 0 | 100% | 9/9 | 201,829 | 45,879 | 960 |
| hsr | idx+flr | 42/50 | 3 | 8 | 2 | 5 | 0 | 65% | 9/9 | 137,640 | 52,350 | 1074 |

**Documents never served at all**: `dpa/floor` skipped `cftc-settlement-order.docx`,
`negotiation-strategy-memo.docx` and `usao-transmittal-email.eml` (3 of 6, 105,812 chars);
`dpa/index` and `dpa/idx+flr` skipped `cftc-settlement-order.docx`;
`employment/idx+flr` skipped `comparable-terms-summary.xlsx`.

### 3.1 Quote-vs-derive audit (headline)

803 distinct monetary values across the 21 scored deliverables, of which 185 (23.0%) are
derived. Classification is formatting-tolerant (`$110M` ≡ `$110 million` ≡ `$110,000,000`).

| task | arm | score | derived | reconstructable | unreconstructed | required figs named by criteria | missing from deliverable | …source WAS served | …on a FAILED criterion |
|---|---|---|---|---|---|---|---|---|---|
| closing | e2e / floor / index / idx+flr | — | 1 each | 1 | 0 | 6 | 0 | 0 | 0 |
| banking | e2e | 56/65 | 18 | 18 | 0 | 29 | 1 | 1 | 0 |
| banking | floor | 58/65 | 16 | 15 | 1 | 29 | 0 | 0 | 0 |
| banking | index | 54/65 | 12 | 11 | 1 | 29 | 0 | 0 | 0 |
| banking | idx+flr | 57/65 | 6 | 6 | 0 | 29 | 0 | 0 | 0 |
| employment | e2e | 48/59 | 7 | 7 | 0 | 19 | 3 | 3 | **2** (C-004, C-052) |
| employment | floor | 51/59 | 21 | 21 | 0 | 19 | 1 | 1 | 0 |
| employment | idx+flr | 53/59 | 14 | 14 | 0 | 19 | 5 | 2 | **1** (C-004) |
| dpa | e2e | 42/58 | 2 | 1 | 1 | 24 | 1 | 1 | **1** (C-025) |
| dpa | floor | 36/58 | 8 | 8 | 0 | 24 | 8 | 7 | **6** (C-028, C-031, C-035) |
| dpa | index | 28/58 | 8 | 8 | 0 | 24 | 2 | 1 | **1** (C-035) |
| dpa | idx+flr | 41/58 | 6 | 6 | 0 | 24 | 5 | 5 | **4** (C-028, C-031) |
| insurance | e2e | 56/57 | 9 | 9 | 0 | 37 | 3 | 3 | 0 |
| insurance | floor | 56/57 | 6 | 6 | 0 | 37 | 0 | 0 | 0 |
| insurance | idx+flr | 50/57 | 0 | 0 | 0 | 37 | 7 | 1 | 0 |
| hsr | e2e | 48/50 | 26 | 25 | 1 | 34 | 2 | 2 | 0 |
| hsr | floor | 47/50 | 12 | 12 | 0 | 34 | 0 | 0 | 0 |
| hsr | idx+flr | 42/50 | 10 | 10 | 0 | 34 | 4 | 4 | **4** (C-031, C-032) |

**Derived-figure error rate: effectively 0%.** 181 of 185 derived figures (97.8%) reconstruct
exactly from source values by a single operation (`a+b`, `a−b`, `a×p%`, `a÷p`, `a÷n`) at 0.5%
tolerance. The 4 residuals are regex artifacts of range expressions
(`$3.2–$4.8 million` parses a bare `$3.2`), not figures. Spot-verifying banking/e2e by hand:
`$251,200,000 ÷ 3.25 = $77,292,308` ✓; `$77,292,308 − $68,300,000 ≈ $9,000,000` ✓;
`15% × $68,300,000 = $10,245,000` ✓; syndicate table `$218,750,000 × 35% = $76,562,500` ✓;
Required Lenders `> $159,375,000` = 50% of `$318,750,000` ✓;
FCCR breach headroom `$47,000,000 − (1.20 × $37,900,000) = $1,520,000` ✓.
The predecessor's independent pass over explicitly-asserted arithmetic
(`X / Y = Z` in prose) found 20 assertions across the grid and **0 wrong**.

**The real failure mode is the opposite of derivation: verbatim omission.**
31 required figures sat verbatim in a document the run *had served* and never reached the
deliverable; **19 of those sit on criteria the judge failed.**

**The named example, corrected.** `dpa/floor` (36/58, deliverable
`DPA Counter-Markup Analysis Memorandum.docx`) reports the payment tranches as
"70% net ($210,000,000) within 15 calendar days; 30% net ($90,000,000) within 9 months."
`$210,000,000` and `$90,000,000` are **not** derived — they are verbatim in
`govt-counter-markup.docx`, which was served whole. The same paragraph, two sentences earlier,
states `$274,750,000` and `$117,750,000`; those also appear in `usao-transmittal-email.eml`,
which this run never served. C-028 and C-031 demand the gross pair
(70% of $392.5M and 30% of $392.5M). Judge on C-028: *"The memo applied percentages to the net
figure, not the gross."* So the defect is **incomplete quotation from an already-served
passage**, not an arithmetic error — a figure-reconciliation problem, not a calculator problem.
`dpa/idx+flr` repeats it (C-028, C-031). `dpa/e2e` and `dpa/index` both state $274.75M.

Other verbatim-omission failures: `hsr/idx+flr` C-031/C-032 (the $7.2M branch-consolidation
synergy and the $5.0M/$5.8M split, all four verbatim in served `crescent-ic-memo.docx`,
`pinnacle-overlap-analysis.docx`, `praxion-synergy-presentation.pptx` and
`triton-board-presentation.pptx`); `employment/e2e` C-004 ($468,750 in served
`company-draft-employment-agreement.docx`) and C-052 ($1,200,000 in served
`sponsor-negotiation-guidance.eml`).

### 3.2 Date handling

236 distinct dates across all deliverables. **90.3% quoted verbatim from a source document;
9.7% (23) computed.** Of the 23 computed, 18 reconstruct as a source date plus a
source-stated relative offset (`within 15 days`, `within nine (9) months`, …). The remaining
5 are all the memo's own `DATE:` header (2026-08-05 / 2025-08-05) — the model's today, not a
legal computation. **Zero computed-date errors detected.**

Quote rate is 100% on `closing` (22.33 dates/10k, the most date-dense corpus) and lowest on
`hsr/idx+flr` (73%). Relative-deadline language is dense in `bankruptcy` (2.27/10k),
`coc-matrix` (2.29) and `indenture` (2.01) — none of which have landed grid runs, so the
date-computation wing is currently **unmotivated by measurement**: no observed error to fix.

### 3.3 Tool-behaviour signatures

Counts in the table at 3.0. Behavioural separation between best and worst runs *within* a task:

- **dpa** (worst spread, 28/58 → 42/58). The worst run (`index`) issued 30 tool calls over 7
  rounds and still served only 19% of the corpus; the best (`e2e`) issued 2 calls over 2 rounds
  and served 100%. Call count is *anti*-correlated with score here: effort spent navigating was
  effort not spent reading.
- **banking** (56–58/65 tight). 30 calls/7 rounds (`idx+flr`, 57) and 2 calls/2 rounds
  (`floor`, 58) land within one criterion of each other. Navigation is nearly free here.
- `hsr/e2e` is the outlier on cost: 797,286 input tokens and 3,768 s for 48/50, versus
  `floor` at 201,829 tokens / 960 s for 47/50 — 4× the tokens for one criterion.

**`find_in_document` hit rates.** 36 calls across the grid; **0 tool misses** (every query that
exists in the queried document returned it, with `total_matches` equal to the true count).
9 calls returned zero:

- **7 of 9 are `<Term> means` probes and all 7 failed** — `Consolidated EBITDA means`,
  `Change of Control means` ×2, `Available Amount means` ×2, `Permitted Holders means`,
  `Senior Secured Net Leverage Ratio means`. They fail because legal drafting writes
  `"Consolidated EBITDA" means` — the quotation marks break a literal substring search.
  **The model's natural way to look up a definition fails 100% of the time**, and it then
  burns a retry on the bare term (`Consolidated EBITDA` → 14 hits;
  `Senior Secured Net Leverage Ratio` → 6 hits).
- 1 paraphrase miss (`monitor selection pool`, absent everywhere).
- 1 mis-routed doc (`General Counsel and Secretary` queried against
  `officers-certificate.docx`; the phrase is in a sibling document).

This is the single cleanest mechanical argument for a definition wing: the *grammar* of the
definition site is known and deterministic, and the model does not encode it.

### 3.4 Unresolved cross-references

A reference is *unresolved* when the deliverable (or served text) cites `Section N` /
`Exhibit X` and the heading that defines that anchor was never served in that run.
Sub-clause references resolve against the parent heading (`Section 2.05(b)(i)` → `Section 2.05`).

| task | arm | refs in served text | unresolved from served | refs in deliverable | **unresolved asserted** | failed criteria naming one |
|---|---|---|---|---|---|---|
| banking | index | 135 | 9 | 86 | **11** | 1 (C-011) |
| banking | idx+flr | 110 | 20 | 53 | **11** | 0 |
| employment | idx+flr | 132 | 1 | 114 | **6** | 0 |
| insurance | idx+flr | 46 | 2 | 4 | **1** | 0 |
| all whole-read arms | | 55–323 | **0** | 8–85 | **0** | 0 |

**Total unresolved asserted: 29, all in scoped arms; zero in every whole-read arm.**

**The suspected banking case is confirmed verbatim.** `banking/index` (54/65,
`Covenant Extraction Memorandum  Vantage Industrial Solutions Inc.docx`) writes:

> "Cross-Reference Note: The 365-day reinvestment period in Section 7.05(d) is consistent with
> the asset sale mandatory prepayment provisions in Section 2.05(b). **No inconsistency
> identified** between the two provisions, contrary to what sometimes occurs in template credit
> agreements."

`Section 2.05` was **never served** in that run (nor was `Section 1.01`). The ground truth
(C-011) is that §7.05 states 365 days and §2.05(b) states 180 — a real conflict. The other
three arms all flag it correctly. Cost: **C-011 and C-012, 2 criteria.** This is the
highest-value pattern in the whole mining exercise: the model did not decline, it asserted a
*negative* about a document region it had never seen.

### 3.5 Usage without definition exposure

A term counts when its definition site (`"Term" means|shall mean|has the meaning`, or a
parenthetical definition) exists in the corpus, the term is used in the deliverable, and
**no** served span covers any of its definition sites.

| task | arm | corpus defined terms | used in deliverable | **used w/o definition served** | usages |
|---|---|---|---|---|---|
| banking | index | 88 | 37 | **25** | 106 |
| banking | idx+flr | 88 | 39 | **33** | 136 |
| employment | idx+flr | 55 | 15 | **5** | 21 |
| hsr | idx+flr | 40 | 9 | **5** | 16 |
| dpa | index | 50 | 10 | 1 | 2 |
| dpa | idx+flr | 50 | 9 | 1 | 1 |
| insurance | idx+flr | 11 | 4 | 1 | 1 |
| **all whole-read arms** | | | | **0** | **0** |

**Total: 71 terms, 283 usages — 100% confined to scoped arms.**

Banking is the concentration, and the terms are exactly the covenant-critical ones:
`Event of Default` ×20, `Change of Control` ×16, `Consolidated EBITDA` ×13,
`Required Lenders` ×11, `Available Amount` ×6, `Total Net Leverage Ratio` ×3,
`Senior Secured Net Leverage Ratio` ×3, `Fixed Charge Coverage Ratio`, `Funded Debt`,
`Net Cash Proceeds`, `Permitted Holders`. In both banking scoped runs, **Article I
(Definitions, `Section 1.01`) was never served**, yet the memo drafts a full covenant analysis
on top of those definitions.

### 3.6 Miss attribution and the economics of scoping

A *unique miss* is a criterion that failed in a scoped arm and passed in **every** whole-read
arm of the same task. Each is attributed to the structure it needed.

| task | arm | served % | score | unique misses | DEF | XREF | DOC | COVERAGE | unattributed |
|---|---|---|---|---|---|---|---|---|---|
| banking | index | 42% | 54/65 | 6 | **5** | 0 | 0 | 0 | 1 |
| banking | idx+flr | 36% | 57/65 | 3 | **3** | 0 | 0 | 0 | 0 |
| employment | idx+flr | 63% | 53/59 | 2 | **2** | 0 | 0 | 0 | 0 |
| dpa | floor | 65% | 36/58 | 8 | 0 | 0 | 1 | 2 | 5 |
| dpa | index | 19% | 28/58 | 15 | 1 | 3 | 0 | 3 | 8 |
| dpa | idx+flr | 55% | 41/58 | 5 | 0 | 0 | 0 | 0 | 5 |
| insurance | idx+flr | 71% | 50/57 | 6 | 0 | 0 | 0 | 4 | 2 |
| hsr | idx+flr | 65% | 42/50 | 5 | 0 | 0 | 0 | 0 | 5 |
| **total** | | | | **50** | **11** | **3** | 1 | 9 | 26 |

**Every DEF-attributable miss (11 of 11) falls in banking or employment — the only two grid
tasks above the 1.5 def-sentences/10k threshold.** Zero DEF misses in insurance (0.22),
closing (0.26), hsr (0.67); the one dpa DEF miss (C-010, `Statement of Facts`) occurs in the
19%-served run where almost nothing was exposed. Named misses:

- `banking/index`: C-004 (`Total Net Leverage Ratio` netting cap), C-005
  (`Senior Secured Net Leverage Ratio` netting cap), C-042 (FCCR definition components),
  C-011/C-048 (`Net Cash Proceeds`) — all in the unserved `Section 1.01`.
- `banking/idx+flr`: C-017 (`Consolidated EBITDA` cost-savings cap), C-022
  (`Fixed Charge Coverage Ratio` headroom), C-048 (`Net Cash Proceeds`).
- `employment/idx+flr`: C-030 (`Whitmore Capital` playbook fallback), C-049 (`Fund IV`
  comparables — the run never served `comparable-terms-summary.xlsx`).

**Damage per unit of unserved corpus**, measured against the *best* whole-read arm of the
same task, is monotone in in-text cross-reference density:

| in-text xref/10k | task | arm | served % | Δ criteria vs best whole-read | criteria lost per 10 pp unserved |
|---|---|---|---|---|---|
| 1.13 | insurance | idx+flr | 71% | −6 | **2.08** |
| 2.72 | hsr | idx+flr | 65% | −6 | **1.73** |
| 4.84 | dpa | index | 19% | −14 | 1.73 |
| 4.84 | dpa | floor | 65% | −6 | 1.70 |
| 4.84 | dpa | idx+flr | 55% | −1 | 0.22 |
| 9.71 | banking | index | 42% | −4 | **0.68** |
| 9.71 | banking | idx+flr | 36% | −1 | **0.16** |
| 10.89 | employment | idx+flr | 63% | **+2** | **−0.54** |

Reading: `insurance` gave up 6 criteria to leave 29 pp of its corpus unread; `banking` gave up
1 criterion to leave 64 pp unread. High-cross-reference corpora carry their own routing —
the text tells the reader where to go next — so partial reading is cheap. Low-cross-reference
corpora (insurance adjuster notes, HSR board decks, forensic reports, emails, spreadsheets)
have no internal routing at all; the only way to find a fact is to read the document.

---

## 4. Findings

1. **The hypothesis holds, but the discriminating signal is the definitional-sentence family,
   not "structure" in general.** Definitional sentences per 10k chars separates the matrix with
   a clean gap (employment 2.24 fires / hsr 0.67 does not), and every one of the 11
   definition-attributable criterion misses lands on the fired side. Parenthetical definition
   density — the larger family by raw count (1,488 parentheticals vs 1,302 definitional
   sentences corpus-wide; 1.8:1 across the grid six) — is anti-predictive: the two corpora
   richest in parentheticals *relative to* definitional sentences (`closing` 59:3, `dpa` 86:0)
   recorded **zero** definition-attributable misses.

2. **The measured cost of a missing definition resolver is 11 criteria and 71 unresolved terms,
   all inside scoped arms.** Whole-read arms score exactly zero on every remote-structure
   measure in this report (0 unresolved cross-references, 0 usages-without-definition). The
   wing is worthless as long as the corpus is whole-read; it becomes the dominant failure mode
   the moment reading is scoped, in exactly the corpora the threshold identifies.

3. **`find_in_document` is sound; the model's query grammar is not.** All 7 `<Term> means`
   probes returned 0 because contracts write `"Term" means`. This is a deterministic,
   fixable grammar gap and it is the mechanism by which the banking index arm ended up drafting
   a covenant memo without ever serving Article I.

4. **Arithmetic is not the problem; quotation discipline is.** 97.8% of derived figures
   reconstruct exactly, 90.3% of dates are quoted verbatim, and there are no computed-date
   errors. But 31 required figures that sat verbatim in *served* text never reached the
   deliverable, 19 of them on failed criteria. A verification wing should check that the
   figures the deliverable *does* state are reconciled against every occurrence in the served
   set — not recompute arithmetic that is already right.

5. **Asserted negatives about unserved regions are the sharpest observable defect.**
   `banking/index` wrote "No inconsistency identified" about a §7.05 ↔ §2.05(b) conflict while
   §2.05 had never been served. 29 cross-references were asserted in deliverables whose targets
   were never served — all in scoped arms, none in whole-read arms. A cheap deterministic guard
   (refuse or flag any negative finding whose cited anchor is outside the served set) targets
   this directly.

6. **Scoped navigation should itself be gated.** It is a net win only above roughly
   6 in-text cross-references per 10k chars (banking, employment); below that it costs
   1.7–2.1 criteria per 10 pp of unread corpus (insurance, hsr, dpa). This is the same
   signal, used as a precondition rather than as the wing trigger.
