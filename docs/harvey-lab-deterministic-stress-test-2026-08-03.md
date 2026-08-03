# Deterministic stress test — grounded-cache LAB corpus (2026-08-03)

Date: 2026-08-03 · Scope: every grounded-cache run with a .docx deliverable.
Method: **zero model calls** — the three deterministic omission organs (H1 `derivedValueScan`, H2 `deadlineOmissionScan`, H3 `undefinedTermScan`) plus the full SLA repair-prompt reconstruction (`auditSlaDraft`) ran as pure functions over cached drafts and source documents already on disk. Scores are the fixed-Sol criterion-judge labels, not human gold.

- Runs examined: **43** (of 81 grounded-cache run dirs; the rest lack a config task mapping or a .docx deliverable).
- Task families covered: **8** — antitrust-competition, banking-finance, capital-markets, corporate-ma, healthcare-life-sciences, tax, trusts-estates-private-client, white-collar-defense-investigations.
- Scored runs: 43; passed: 0; failed: 43. **Every scored run here FAILED** — these grounded-cache cells are below the pass threshold, so the pass/fail cross-reference in section 2 has no passed runs to work from.
- Organs fired at least once on: derived **20** runs, deadline **22** runs, undefined **43** runs.

## 1. Per-organ, per-family firing table

Rows = task families with at least one scored run; `dv`/`dl`/`uf` = total findings the organ fired across all runs in the family, of which the parenthetical is how many fired on a run the model PASSED (false-positive candidates). Pass/Fail = scored runs in the family by verdict.

| Family | Runs | Pass | Fail | dv (fires@pass) | dl (fires@pass) | uf (fires@pass) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| antitrust-competition | 9 | 0 | 9 | 15 | 0 | 93 |
| banking-finance | 3 | 0 | 3 | 0 | 0 | 36 |
| capital-markets | 11 | 0 | 11 | 0 | 40 | 109 |
| corporate-ma | 9 | 0 | 9 | 35 | 25 | 91 |
| healthcare-life-sciences | 3 | 0 | 3 | 0 | 0 | 35 |
| tax | 2 | 0 | 2 | 6 | 8 | 24 |
| trusts-estates-private-client | 3 | 0 | 3 | 0 | 3 | 29 |
| white-collar-defense-investigations | 3 | 0 | 3 | 0 | 7 | 31 |

### Per-run detail

`dv`/`dl` = raw organ findings, with the workflow-gated count in parens (derived/deadline are suppressed on operative-drafting work types; the gated count is what a repair prompt would carry). `dl (res/eng/ref)` = source deadline relationships resolved / engaged / refused. `cand/quoted` = H3 candidate phrases / quoted-only mentions.

| Run (arm · version) | Family/task | WT | src | Draft k | dv | dl | uf | dl res/eng/ref | cand/quoted | prompt k | Verdict |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gs · v1 | antitrust-competition/analyze-antitrust-hsr-strategy | analyze | 5 | 37.1 | 2 | 0 | 5 | 0/0/12 | 80/29 | 2.5 | FAIL 45/50 |
| ms · v1 | antitrust-competition/analyze-antitrust-hsr-strategy | analyze | 5 | 43.3 | 2 | 0 | 12 | 0/0/12 | 92/19 | 3.0 | FAIL 45/50 |
| ut · v1 | antitrust-competition/analyze-antitrust-hsr-strategy | analyze | 5 | 41.8 | 2 | 0 | 12 | 0/0/12 | 85/0 | 3.9 | FAIL 44/50 |
| gs · v1 | capital-markets/compare-closing-documents-against-closing-checklist | review | 7 | 17.7 | 0 | 0 | 7 | 0/0/9 | 61/29 | 1.7 | FAIL 29/32 |
| ms · v1 | capital-markets/compare-closing-documents-against-closing-checklist | review | 7 | 17.1 | 0 | 0 | 10 | 0/0/9 | 48/4 | 1.8 | FAIL 27/32 |
| ut · v1 | capital-markets/compare-closing-documents-against-closing-checklist | review | 7 | 15.2 | 0 | 0 | 5 | 0/0/9 | 41/1 | 1.3 | FAIL 28/32 |
| gs · v1 | capital-markets/draft-indenture-for-senior-secured-notes-offering | draft | 11 | 90.2 | 0 | 8(0) | 12 | 10/8/136 | 417/107 | 4.2 | FAIL 71/83 |
| ms · v1 | capital-markets/draft-indenture-for-senior-secured-notes-offering | draft | 11 | 107.0 | 0 | 9(0) | 8 | 10/9/136 | 444/188 | 4.5 | FAIL 70/83 |
| ut · v1 | capital-markets/draft-indenture-for-senior-secured-notes-offering | draft | 11 | 83.3 | 0 | 8(0) | 12 | 10/9/136 | 407/85 | 4.8 | FAIL 71/83 |
| gs · v1 | corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts | analyze | 19 | 40.4 | 4 | 3 | 8 | 4/3/235 | 89/20 | 3.2 | FAIL 42/57 |
| ms · v1 | corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts | analyze | 19 | 52.6 | 6 | 4 | 12 | 4/4/235 | 101/24 | 4.0 | FAIL 32/57 |
| ut · v1 | corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts | analyze | 19 | 49.4 | 2 | 3 | 12 | 4/3/235 | 106/0 | 3.6 | FAIL 5/57 |
| gs · v3 | antitrust-competition/analyze-antitrust-hsr-strategy | analyze | 5 | 30.1 | 2 | 0 | 4 | 0/0/12 | 77/55 | 1.6 | FAIL 40/50 |
| ms · v3 | antitrust-competition/analyze-antitrust-hsr-strategy | analyze | 5 | 48.5 | 3 | 0 | 12 | 0/0/12 | 76/5 | 3.8 | FAIL 45/50 |
| ut · v3 | antitrust-competition/analyze-antitrust-hsr-strategy | analyze | 5 | 54.7 | 1 | 0 | 12 | 0/0/12 | 118/32 | 2.6 | FAIL 44/50 |
| gs · v3 | antitrust-competition/prepare-antitrust-risk-assessment | analyze | 10 | 96.0 | 1 | 0 | 12 | 0/0/19 | 135/0 | 3.9 | FAIL 64/95 |
| ms · v3 | antitrust-competition/prepare-antitrust-risk-assessment | analyze | 10 | 77.4 | 1 | 0 | 12 | 0/0/19 | 105/10 | 3.2 | FAIL 66/95 |
| ut · v3 | antitrust-competition/prepare-antitrust-risk-assessment | analyze | 10 | 73.0 | 1 | 0 | 12 | 0/0/19 | 141/8 | 3.5 | FAIL 68/95 |
| gs · v3 | banking-finance/extract-credit-agreement-covenants | analyze | 2 | 56.2 | 0 | 0 | 12 | 0/0/18 | 168/79 | 2.6 | FAIL 56/65 |
| ms · v3 | banking-finance/extract-credit-agreement-covenants | analyze | 2 | 55.0 | 0 | 0 | 12 | 0/0/18 | 144/60 | 2.3 | FAIL 56/65 |
| ut · v3 | banking-finance/extract-credit-agreement-covenants | analyze | 2 | 55.7 | 0 | 0 | 12 | 0/0/18 | 152/2 | 1.9 | FAIL 53/65 |
| gs · v3 | capital-markets/compare-closing-documents-against-closing-checklist | review | 7 | 19.5 | 0 | 0 | 8 | 0/0/9 | 50/4 | 2.3 | FAIL 28/32 |
| ms · v3 | capital-markets/compare-closing-documents-against-closing-checklist | review | 7 | 17.4 | 0 | 0 | 12 | 0/0/9 | 74/31 | 2.3 | FAIL 27/32 |
| ut · v3 | capital-markets/compare-closing-documents-against-closing-checklist | review | 7 | 30.7 | 0 | 0 | 12 | 0/0/9 | 86/4 | 2.3 | FAIL 28/32 |
| gs · v3 | capital-markets/draft-indenture-for-senior-secured-notes-offering | draft | 11 | 70.2 | 0 | 8(0) | 11 | 10/8/136 | 300/128 | 4.8 | FAIL 69/83 |
| ms · v3 | capital-markets/draft-indenture-for-senior-secured-notes-offering | draft | 11 | 83.3 | 0 | 7(0) | 12 | 10/8/136 | 389/219 | 4.5 | FAIL 74/83 |
| gs · v3 | corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts | analyze | 19 | 47.9 | 3 | 3 | 10 | 4/4/235 | 117/0 | 3.8 | FAIL 41/57 |
| ms · v3 | corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts | analyze | 19 | 47.1 | 3 | 3 | 10 | 4/3/235 | 86/31 | 3.0 | FAIL 36/57 |
| ut · v3 | corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts | analyze | 19 | 5.1 | 2 | 1 | 3 | 4/1/235 | 20/0 | 1.6 | FAIL 4/57 |
| gs · v3 | corporate-ma/draft-acquisition-due-diligence | draft | 26 | 79.3 | 5 | 3 | 12 | 4/4/127 | 217/1 | 4.5 | FAIL 52/64 |
| ms · v3 | corporate-ma/draft-acquisition-due-diligence | draft | 26 | 57.9 | 5 | 3 | 12 | 4/3/127 | 159/70 | 3.4 | FAIL 51/64 |
| ut · v3 | corporate-ma/draft-acquisition-due-diligence | draft | 26 | 56.5 | 5 | 2 | 12 | 4/3/127 | 218/0 | 3.2 | FAIL 50/64 |
| gs · v3 | healthcare-life-sciences/analyze-counterparty-markup-of-clinical-trial-agreement | analyze | 3 | 41.7 | 0 | 0 | 12 | 0/0/36 | 90/28 | 2.3 | FAIL 65/70 |
| ms · v3 | healthcare-life-sciences/analyze-counterparty-markup-of-clinical-trial-agreement | analyze | 3 | 45.1 | 0 | 0 | 11 | 0/0/36 | 97/50 | 3.1 | FAIL 67/70 |
| ut · v3 | healthcare-life-sciences/analyze-counterparty-markup-of-clinical-trial-agreement | analyze | 3 | 51.6 | 0 | 0 | 12 | 0/0/36 | 105/38 | 3.4 | FAIL 65/70 |
| ms · v3 | tax/draft-transfer-pricing-documentation | draft | 25 | 57.5 | 4 | 4 | 12 | 7/4/60 | 92/6 | 3.9 | FAIL 41/77 |
| ut · v3 | tax/draft-transfer-pricing-documentation | draft | 25 | 48.0 | 2 | 4 | 12 | 7/4/60 | 111/2 | 3.2 | FAIL 43/77 |
| gs · v3 | trusts-estates-private-client/extract-client-intake-facts/scenario-01 | analyze | 2 | 28.4 | 0 | 1 | 12 | 1/1/2 | 68/14 | 2.1 | FAIL 47/56 |
| ms · v3 | trusts-estates-private-client/extract-client-intake-facts/scenario-01 | analyze | 2 | 24.1 | 0 | 1 | 7 | 1/1/2 | 68/19 | 1.9 | FAIL 46/56 |
| ut · v3 | trusts-estates-private-client/extract-client-intake-facts/scenario-01 | analyze | 2 | 22.0 | 0 | 1 | 10 | 1/1/2 | 58/10 | 2.5 | FAIL 45/56 |
| gs · v3 | white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement | analyze | 5 | 58.6 | 0 | 3 | 11 | 3/3/62 | 61/15 | 3.6 | FAIL 44/58 |
| ms · v3 | white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement | analyze | 5 | 67.0 | 0 | 3 | 12 | 3/3/62 | 76/11 | 3.9 | FAIL 49/58 |
| ut · v3 | white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement | analyze | 5 | 59.8 | 0 | 1 | 8 | 3/1/62 | 69/18 | 2.5 | FAIL 49/58 |

## 2. False-positive analysis

An organ firing on a run the model PASSED means the draft was judged fine on gold yet the organ claimed an omission — the candidate set of noisy findings. 0 run(s) qualify.

**Caveat: 43 of 43 scored runs here FAILED (0 passed), so this section is empty by construction — there is no passed draft to cross-reference.** A false-positive read needs passed runs, or a per-criterion gold read of fired findings on these failed runs (section 4 samples are dominated by H3 proper-noun noise, which is the closest thing to a noisy-on-good-draft signal here).

None — every firing landed on a failed run.
## 3. Miss analysis

A run the model FAILED where every organ stayed silent means the deterministic organs did not catch whatever defect the gold rubric penalized. 0 run(s) qualify.

**Caveat: because H3 floods 12 findings onto 26 of 43 runs, "every organ stayed silent" is a high bar — the organs almost always fire *something*, but mostly H3 proper-noun noise. "No misses" therefore does NOT mean the organs caught the failed gold criteria.** The real miss test is criterion-level: for each failed criterion, does any organ's finding point at it? That correlation is not computed here (section 6 gaps).

None — every failed run had at least one organ firing.

## 4. Information-density audit

The repair prompt's lines are built from each finding's `detail` string only — the structured refs/excerpts are carried in the machine receipt, not the prompt. This section measures how self-contained those detail strings are.

| Organ | findings | detail chars min/med/p90/max | names source doc? | self-contained? |
| --- | ---: | ---: | --- | --- |
| derived (H1) | 56 | 124/142/171/187 | yes — each `detail` ends with the source doc in parens, e.g. `…but never the 34% share (crescent-ic-memo.docx)` | high — the arithmetic, the omitted half, and the source doc all sit in the prompt line |
| deadline (H2) | 83 | 158/191/209/213 | yes — each `detail` appends `(source.docx)` after the resolved arithmetic | high — anchor −/+ duration = resolved date, the engaged subject, and the source doc |
| undefined (H3) | 448 | 151/163/177/235 | no — the term is draft-local by construction; the detail names the term and the source count, but not which documents were searched | partial — a reader knows the term and that nothing in the stack defines it; the occurrence excerpt is carried on the finding but not in the prompt |

### Sample findings

**derived — antitrust-competition/analyze-antitrust-hsr-strategy (grounded_structure_v1)**:
- `$93.16 million = 34% of 274,000,000 revenue — the deliverable states the amount $93.16 million but never the 34% share (crescent-ic-memo.docx)`
- `$21.25 million = 5% of 425,000,000 value — the deliverable states the amount $21.25 million but never the 5% share (crescent-ic-memo.docx)`

**undefined — antitrust-competition/analyze-antitrust-hsr-strategy (grounded_structure_v1)**:
- `"AI Legal Assistant Date" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…l Partners, LP; TGD Acquisition Corp.; Ashford, Kendrick & Hale LLP From: Mike, AI Legal Assistant Date: April 2025 Re: Proposed acquisition of Triton Industrial Gas Distribution, Inc…”
- `"Source and Limitations" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…GD Acquisition Corp. It is based solely on the deal materials identified in the Source and Limitations section. It is not a substitute for advice from antitrust counsel, a final HSR…”

**derived — antitrust-competition/analyze-antitrust-hsr-strategy (mike_structure_paths_v1)**:
- `$21.25 million = 5% of 425,000,000 value — the deliverable states the amount $21.25 million but never the 5% share (crescent-ic-memo.docx)`
- `$38 million = 14% of 274,000,000 revenue — the deliverable states the amount $38 million but never the 14% share (triton-medical-gas-summary.docx)`

**undefined — antitrust-competition/analyze-antitrust-hsr-strategy (mike_structure_paths_v1)**:
- `"Pinnacle Competitive Overlap Analysis" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…y concentrated after closing and all five show HHI increases above 200 points. (Pinnacle Competitive Overlap Analysis, §§ VII.B–VII.D; see also Synergy Presentation, slides 5 and 15.) • Product-mar…”
- `"Investment Committee Memorandum" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…tion, cGMP compliance, and state pharmacy licensing limit the competitive set. (Investment Committee Memorandum, §§ II.B, VI.B–VI.C; Medical Gas Operations Summary, §§ 2–5.) • Customer eviden…”

**derived — antitrust-competition/analyze-antitrust-hsr-strategy (upstream_terminal_v1)**:
- `$93.16 million = 34% of 274,000,000 revenue — the deliverable states the amount $93.16 million but never the 34% share (crescent-ic-memo.docx)`
- `$21.25 million = 5% of 425,000,000 value — the deliverable states the amount $21.25 million but never the 5% share (crescent-ic-memo.docx)`

**undefined — antitrust-competition/analyze-antitrust-hsr-strategy (upstream_terminal_v1)**:
- `"HIGH to VERY HIGH" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…solved before any HSR submission. Executive conclusion Overall risk rating: HIGH to VERY HIGH; Second Request risk: HIGH; remedy risk: HIGH; closing-timing risk: HIGH. The…”
- `"Baton Rouge and New Orleans" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…of 3,989 and 3,760, respectively, with HHI increases of 1,848 and 1,280 points; Baton Rouge and New Orleans also cross the reported structural-presumption thresholds. [Pinnacle, §§ VII.B–…”

**undefined — capital-markets/compare-closing-documents-against-closing-checklist (grounded_structure_v1)**:
- `"Master Closing Checklist" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…ure the discrepancies described below. Scope and Method The review used the Master Closing Checklist, the Closing Document Index, the Delivery Status and Open Items tabs in that in…”
- `"Closing Document Index" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…d below. Scope and Method The review used the Master Closing Checklist, the Closing Document Index, the Delivery Status and Open Items tabs in that index, and the following avail…”

**undefined — capital-markets/compare-closing-documents-against-closing-checklist (mike_structure_paths_v1)**:
- `"Delivery Status and Open Items" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…ent for this report. The review also considered the closing-document index, its Delivery Status and Open Items sheets, and the substantive documents supplied in the project folder. Where the…”
- `"Delivery Status" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…irements summarized below. | closing-document-index.xlsx | All Documents, Delivery Status, and Open Items sheets provide the delivery status, issue flags, document dates…”

**undefined — capital-markets/compare-closing-documents-against-closing-checklist (upstream_terminal_v1)**:
- `"Master Closing Checklist" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…ing-discrepancy-report Scope and Executive Summary This report compares the Master Closing Checklist (dated March 14, 2025 and updated as of closing) against the closing-document i…”
- `"Certificate of Authentication" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…Guarantors to include only CFT and PES, omitting GBCC; (iv) the Trustee&apos;s Certificate of Authentication is not listed; (v) the issuer&apos;s counsel 10b-5 letter is addressed only to…”

**deadline — capital-markets/draft-indenture-for-senior-secured-notes-offering (grounded_structure_v1)**:
- `deadline 2029-03-15 + 91 days = 2029-06-14 (existing-credit-agreement.docx) — the deliverable engages the deadline measured from 2029-03-15 but never states the resolved deadline 2029-06-14`
- `deadline 2028-02-15 + 3 years = 2031-02-15 (offering-memorandum-excerpts.docx) — the deliverable engages the deadline measured from 2028-02-15 but never states the resolved deadline 2031-02-15`

**undefined — capital-markets/draft-indenture-for-senior-secured-notes-offering (grounded_structure_v1)**:
- `"Issuer Order" is used as a defined term in the draft but is not defined in the draft or any of the 11 source document(s); the reader cannot know what it means` — excerpt: “…e shall authenticate and deliver Notes in the principal amount specified in the Issuer Order. Section 2.03. Registrar and Paying Agent. The Issuer shall maintain office…”
- `"Redemption Price" is used as a defined term in the draft but is not defined in the draft or any of the 11 source document(s); the reader cannot know what it means` — excerpt: “…icate stating the applicable provision, Redemption Date, amount to be redeemed, Redemption Price and identifiers. Section 3.02. Selection of Notes to Be Redeemed. If less t…”

**deadline — capital-markets/draft-indenture-for-senior-secured-notes-offering (mike_structure_paths_v1)**:
- `deadline 2029-03-15 + 91 days = 2029-06-14 (existing-credit-agreement.docx) — the deliverable engages the deadline measured from 2029-03-15 but never states the resolved deadline 2029-06-14`
- `deadline 2028-02-15 + 3 years = 2031-02-15 (offering-memorandum-excerpts.docx) — the deliverable engages the deadline measured from 2028-02-15 but never states the resolved deadline 2031-02-15`

**undefined — capital-markets/draft-indenture-for-senior-secured-notes-offering (mike_structure_paths_v1)**:
- `"Offer Period" is used as a defined term in the draft but is not defined in the draft or any of the 11 source document(s); the reader cannot know what it means` — excerpt: “…Charge Coverage Ratio," 1.01; "Legal Defeasance," 8.02; "Offer Amount," 3.09; "Offer Period," 3.09; "Payment Default," 6.01; "Purchase Date," 3.09; "Successor Issuer," 5.0…”
- `"DRAFTING POINT" is used as a defined term in the draft but is not defined in the draft or any of the 11 source document(s); the reader cannot know what it means` — excerpt: “…icted Subsidiaries, in each case subject to a cumulative cap of $75,000,000. [DRAFTING POINT — confirm whether the builder basket begins with the first full fiscal quarter…”

**deadline — capital-markets/draft-indenture-for-senior-secured-notes-offering (upstream_terminal_v1)**:
- `deadline 2029-03-15 + 91 days = 2029-06-14 (existing-credit-agreement.docx) — the deliverable engages the deadline measured from 2029-03-15 but never states the resolved deadline 2029-06-14`
- `deadline 2028-02-15 + 3 years = 2031-02-15 (offering-memorandum-excerpts.docx) — the deliverable engages the deadline measured from 2028-02-15 but never states the resolved deadline 2031-02-15`

**undefined — capital-markets/draft-indenture-for-senior-secured-notes-offering (upstream_terminal_v1)**:
- `"General Intangibles" is used as a defined term in the draft but is not defined in the draft or any of the 11 source document(s); the reader cannot know what it means` — excerpt: “…Paper, Instruments, Documents, Letter-of-Credit Rights, Supporting Obligations, General Intangibles, books and records and Proceeds, in each case to the extent relating to the for…”
- `"Real Property" is used as a defined term in the draft but is not defined in the draft or any of the 11 source document(s); the reader cannot know what it means` — excerpt: “…ateral other than ABL Priority Collateral, including PP&E, Equipment, Fixtures, Real Property, Intellectual Property, Equity Interests, Investment Property other than Securi…”

**derived — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (grounded_structure_v1)**:
- `87,300,000 revenue × 25.3% = 22,086,900 — the deliverable states 25.3% of revenue but never the amount (deal-overview-memo.docx)`
- `$23,900,000 = 27.4% of 87,300,000 revenue — the deliverable states the amount $23,900,000 but never the 27.4% share (deal-overview-memo.docx)`

**deadline — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (grounded_structure_v1)**:
- `written notice of non-renewal due 2026-01-14 − 180 days = 2025-07-18 (apex-msa.docx) — the deliverable engages the written notice of non-renewal but never states the resolved deadline 2025-07-18`
- `deadline 2024-06-30 + 12 months = 2025-06-30 (great-lakes-credit-agreement.docx) — the deliverable engages the deadline measured from 2024-06-30 but never states the resolved deadline 2025-06-30`

**undefined — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (grounded_structure_v1)**:
- `"Solara Health" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…ware Solutions, Inc. and a proposed 100% stock acquisition. The second concerns Solara Health & Wellness LLC and a proposed 100% membership-interest acquisition. The contrac…”
- `"Great Lakes" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…NovaBridge partnership. Highest-priority risks in the Solara package are: (i) Great Lakes' change-of-control event of default and acceleration of approximately $42.7 mil…”

**derived — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (mike_structure_paths_v1)**:
- `$22.1 million = 25.3% of 87,300,000 revenue — the deliverable states the amount $22.1 million but never the 25.3% share (deal-overview-memo.docx)`
- `$23,900,000 = 27.4% of 87,300,000 revenue — the deliverable states the amount $23,900,000 but never the 27.4% share (deal-overview-memo.docx)`

**deadline — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (mike_structure_paths_v1)**:
- `written notice of non-renewal due 2026-01-14 − 180 days = 2025-07-18 (apex-msa.docx) — the deliverable engages the written notice of non-renewal but never states the resolved deadline 2025-07-18`
- `deadline 2024-06-30 + 12 months = 2025-06-30 (great-lakes-credit-agreement.docx) — the deliverable engages the deadline measured from 2024-06-30 but never states the resolved deadline 2025-06-30`

**undefined — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (mike_structure_paths_v1)**:
- `"Project Summit" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…Aldersgate Software Solutions, Inc. by Ridgeline Capital Partners LLC; and (2) Project Summit, the proposed acquisition of Solara Health & Wellness LLC by Ridgeline Consumer…”
- `"Solara Health" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…eline Capital Partners LLC; and (2) Project Summit, the proposed acquisition of Solara Health & Wellness LLC by Ridgeline Consumer Products Inc. The report keeps the two tra…”

**derived — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (upstream_terminal_v1)**:
- `$23,900,000 = 27.4% of 87,300,000 revenue — the deliverable states the amount $23,900,000 but never the 27.4% share (deal-overview-memo.docx)`
- `187,300,000 revenue × 41% = 76,793,000 — the deliverable states 41% of revenue but never the amount (deal-summary-memo.docx)`

**deadline — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (upstream_terminal_v1)**:
- `written notice of non-renewal due 2026-01-14 − 180 days = 2025-07-18 (apex-msa.docx) — the deliverable engages the written notice of non-renewal but never states the resolved deadline 2025-07-18`
- `deadline 2024-06-30 + 12 months = 2025-06-30 (great-lakes-credit-agreement.docx) — the deliverable engages the deadline measured from 2024-06-30 but never states the resolved deadline 2025-06-30`

**undefined — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (upstream_terminal_v1)**:
- `"Solara Health" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…Consumer Products Inc. deal team in connection with the proposed acquisition of Solara Health & Wellness LLC (Project Summit). This report analyzes change of control, assign…”
- `"Project Summit" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…am in connection with the proposed acquisition of Solara Health & Wellness LLC (Project Summit). This report analyzes change of control, assignment, consent, deemed-assignmen…”

**derived — antitrust-competition/analyze-antitrust-hsr-strategy (grounded_structure_v1)**:
- `$93.16 million = 34% of 274,000,000 revenue — the deliverable states the amount $93.16 million but never the 34% share (crescent-ic-memo.docx)`
- `$21.25 million = 5% of 425,000,000 value — the deliverable states the amount $21.25 million but never the 5% share (crescent-ic-memo.docx)`

**undefined — antitrust-competition/analyze-antitrust-hsr-strategy (grounded_structure_v1)**:
- `"VERY HIGH" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…e economic consultant. Executive Assessment Overall risk rating: HIGH, with VERY HIGH risk in Hattiesburg and Gulfport-Biloxi and a substantial probability of a Seco…”
- `"Baton Rouge and New Orleans" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…ort-Biloxi show majority combined shares in the Pinnacle/management case, while Baton Rouge and New Orleans also trigger the reported structural concentration screen. Specialty gases may…”

**derived — antitrust-competition/analyze-antitrust-hsr-strategy (mike_structure_paths_v1)**:
- `$93.16 million = 34% of 274,000,000 revenue — the deliverable states the amount $93.16 million but never the 34% share (crescent-ic-memo.docx)`
- `$21.25 million = 5% of 425,000,000 value — the deliverable states the amount $21.25 million but never the 5% share (crescent-ic-memo.docx)`

**undefined — antitrust-competition/analyze-antitrust-hsr-strategy (mike_structure_paths_v1)**:
- `"Executive Summary" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “[deliverable document: antitrust-risk-memo.docx] antitrust-risk-memo Executive Summary Privileged and Confidential — Prepared for Counsel and Deal Team Matter: Cr…”
- `"Baton Rouge and New Orleans" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…k overall, with very high risk in Hattiesburg and Gulfport-Biloxi, high risk in Baton Rouge and New Orleans, and moderate but non-trivial risk in Mobile. The principal issue is not the na…”

**derived — antitrust-competition/analyze-antitrust-hsr-strategy (upstream_terminal_v1)**:
- `$93.16 million = 34% of 274,000,000 revenue — the deliverable states the amount $93.16 million but never the 34% share (crescent-ic-memo.docx)`

**undefined — antitrust-competition/analyze-antitrust-hsr-strategy (upstream_terminal_v1)**:
- `"Executive Summary" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “[deliverable document: antitrust-risk-memo.docx] antitrust-risk-memo Executive Summary PRIVILEGED AND CONFIDENTIAL — ATTORNEY WORK PRODUCT PREPARED FOR LEGAL AND TR…”
- `"AI Legal Assistant Re" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…artners, LP; TGD Acquisition Corp.; deal team and antitrust counsel From: Mike, AI Legal Assistant Re: Proposed acquisition of Triton Industrial Gas Distribution, Inc. by TGD Acquis…”

**derived — antitrust-competition/prepare-antitrust-risk-assessment (grounded_structure_v1)**:
- `$185 million = 3.9% of 4,690,000,000 revenue — the deliverable states the amount $185 million but never the 3.9% share (synergy-analysis-and-integration-plan-summary.docx)`

**undefined — antitrust-competition/prepare-antitrust-risk-assessment (grounded_structure_v1)**:
- `"Project Lighthouse" is used as a defined term in the draft but is not defined in the draft or any of the 10 source document(s); the reader cannot know what it means` — excerpt: “…15, 2025. Matter: Proposed acquisition of Lakeshore Performance Materials, LLC (Project Lighthouse). This memorandum is based solely on the project documents identified in the so…”
- `"VERY HIGH" is used as a defined term in the draft but is not defined in the draft or any of the 10 source document(s); the reader cannot know what it means` — excerpt: “…and jurisdictional data are verified. Executive Summary Risk rating: HIGH / VERY HIGH in the two narrow product markets most likely to drive agency review. The trans…”

**derived — antitrust-competition/prepare-antitrust-risk-assessment (mike_structure_paths_v1)**:
- `$185 million = 3.9% of 4,690,000,000 revenue — the deliverable states the amount $185 million but never the 3.9% share (synergy-analysis-and-integration-plan-summary.docx)`

**undefined — antitrust-competition/prepare-antitrust-risk-assessment (mike_structure_paths_v1)**:
- `"Second Request" is used as a defined term in the draft but is not defined in the draft or any of the 10 source document(s); the reader cannot know what it means` — excerpt: “…t foregrounds problematic documents before counsel determines its value. If a Second Request issues: negotiate scope and custodians where possible; preserve certification a…”
- `"South Korea" is used as a defined term in the draft but is not defined in the draft or any of the 10 source document(s); the reader cannot know what it means` — excerpt: “…ily identify the EU, Germany or EU one-stop-shop, China, Canada, Brazil, Japan, South Korea, India, and voluntary UK and Australia engagement as potentially relevant. This…”

**derived — antitrust-competition/prepare-antitrust-risk-assessment (upstream_terminal_v1)**:
- `$185 million = 3.9% of 4,690,000,000 revenue — the deliverable states the amount $185 million but never the 3.9% share (synergy-analysis-and-integration-plan-summary.docx)`

**undefined — antitrust-competition/prepare-antitrust-risk-assessment (upstream_terminal_v1)**:
- `"North American" is used as a defined term in the draft but is not defined in the draft or any of the 10 source document(s); the reader cannot know what it means` — excerpt: “…nsaction presents HIGH U.S. antitrust risk, with the most serious issues in (i) North American automotive OEM structural adhesives and (ii) aerospace sealants. The record sup…”
- `"Second Request" is used as a defined term in the draft but is not defined in the draft or any of the 10 source document(s); the reader cannot know what it means` — excerpt: “…structural adhesives and (ii) aerospace sealants. The record supports a likely Second Request and a material risk of an FTC or DOJ challenge. Clearance without a substantial…”

**undefined — banking-finance/extract-credit-agreement-covenants (grounded_structure_v1)**:
- `"Borrowing Base" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…terial drafting and technical-default risk. The agreement contains no operative Borrowing Base definition, no advance rates, and no defined Eligible Accounts Receivable or El…”
- `"Eligible Accounts Receivable or Eligible Inventory" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…ntains no operative Borrowing Base definition, no advance rates, and no defined Eligible Accounts Receivable or Eligible Inventory, while the facility otherwise reads as a committed revolving facility rather th…”

**undefined — banking-finance/extract-credit-agreement-covenants (mike_structure_paths_v1)**:
- `"Total Net Leverage" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…l change effective January 1, 2025: the December 31, 2024 test remains at 4.00x Total Net Leverage and 1.15x Fixed Charge Coverage. The first step-down/step-up applies to the Mar…”
- `"Fixed Charge Coverage" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…2025: the December 31, 2024 test remains at 4.00x Total Net Leverage and 1.15x Fixed Charge Coverage. The first step-down/step-up applies to the March 31, 2025 test, when the limit…”

**undefined — banking-finance/extract-credit-agreement-covenants (upstream_terminal_v1)**:
- `"Credit Agreement&apos" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…Ridgeline acquisition of 100% of Vantage&apos;s voting equity would trigger the Credit Agreement&apos;s Change of Control definition because the acquirer would own more than 35% and…”
- `"Pinecrest Growth Equity" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…olders are: (i) members of the Delacroix family and their Related Parties; (ii) Pinecrest Growth Equity and its Affiliates; and (iii) persons directly or indirectly controlled by, or…”

**undefined — capital-markets/compare-closing-documents-against-closing-checklist (grounded_structure_v1)**:
- `"Delivery Status" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…page from Lakefield Stern & Co. not included in executed set." The index&apos;s Delivery Status sheet and Open Items sheet classify this as a Critical open item. | Obtain an…”
- `"Open Items" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…& Co. not included in executed set." The index&apos;s Delivery Status sheet and Open Items sheet classify this as a Critical open item. | Obtain and insert Lakefield&ap…”

**undefined — capital-markets/compare-closing-documents-against-closing-checklist (mike_structure_paths_v1)**:
- `"Master Closing Checklist" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…egate principal amount; closing date March 14, 2025. This report compares the Master Closing Checklist, the closing document index, and the closing documents provided in the project.…”
- `"Certificate of Authentication" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…field Stern & Co. signature page to the Underwriting Agreement, and the missing Trustee's Certificate of Authentication. The index also identifies one administrative checklist/index inconsi…”

**undefined — capital-markets/compare-closing-documents-against-closing-checklist (upstream_terminal_v1)**:
- `"Certificate of Authentication" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…secretary&apos;s certificate; (iii) the apparent absence of the Trustee&apos;s Certificate of Authentication; (iv) an incorrect CUSIP in the DTC eligibility letter; (v) an incorrect aggreg…”
- `"Master Closing Checklist" is used as a defined term in the draft but is not defined in the draft or any of the 7 source document(s); the reader cannot know what it means` — excerpt: “…ng correction for a reliable final record. | Basis and Severity Framework The Master Closing Checklist is treated as the controlling requirements list. The closing-document index…”

**deadline — capital-markets/draft-indenture-for-senior-secured-notes-offering (grounded_structure_v1)**:
- `deadline 2029-03-15 + 91 days = 2029-06-14 (existing-credit-agreement.docx) — the deliverable engages the deadline measured from 2029-03-15 but never states the resolved deadline 2029-06-14`
- `deadline 2028-02-15 + 3 years = 2031-02-15 (offering-memorandum-excerpts.docx) — the deliverable engages the deadline measured from 2028-02-15 but never states the resolved deadline 2031-02-15`

**undefined — capital-markets/draft-indenture-for-senior-secured-notes-offering (grounded_structure_v1)**:
- `"General Intangibles" is used as a defined term in the draft but is not defined in the draft or any of the 11 source document(s); the reader cannot know what it means` — excerpt: “…Paper, Instruments, Documents, Letter-of-Credit Rights, Supporting Obligations, General Intangibles, books and records and Proceeds, in each case as more particularly described in…”
- `"Designated Non-Cash Consideration" is used as a defined term in the draft but is not defined in the draft or any of the 11 source document(s); the reader cannot know what it means` — excerpt: “…sh Equivalents, subject to customary deemed-cash items and up to $10,000,000 of Designated Non-Cash Consideration. Within 365 days after receipt, Net Proceeds shall be used to repay secured Ind…”

**deadline — capital-markets/draft-indenture-for-senior-secured-notes-offering (mike_structure_paths_v1)**:
- `deadline 2028-02-15 + 3 years = 2031-02-15 (offering-memorandum-excerpts.docx) — the deliverable engages the deadline measured from 2028-02-15 but never states the resolved deadline 2031-02-15`
- `exchange offer registration due 2025-11-15 + 270 days = 2026-08-12 (offering-memorandum-excerpts.docx) — the deliverable engages the exchange offer registration but never states the resolved deadline 2026-08-12`

**undefined — capital-markets/draft-indenture-for-senior-secured-notes-offering (mike_structure_paths_v1)**:
- `"Issuer Order" is used as a defined term in the draft but is not defined in the draft or any of the 11 source document(s); the reader cannot know what it means` — excerpt: “…manual signature of the Trustee or an authenticating agent. Upon receipt of an Issuer Order, an Officers' Certificate, an Opinion of Counsel and such other documents as th…”
- `"TIA Section" is used as a defined term in the draft but is not defined in the draft or any of the 11 source document(s); the reader cannot know what it means` — excerpt: “…he Issuer and its Affiliates as permitted by law. The Trustee shall comply with TIA Section 310(b) and applicable law concerning conflicting interests, including any confl…”

**derived — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (grounded_structure_v1)**:
- `$23,900,000 = 27.4% of 87,300,000 revenue — the deliverable states the amount $23,900,000 but never the 27.4% share (deal-overview-memo.docx)`
- `$14,800,000 = 17% of 87,300,000 revenue — the deliverable states the amount $14,800,000 but never the 17% share (deal-overview-memo.docx)`

**deadline — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (grounded_structure_v1)**:
- `deadline 2024-06-30 + 12 months = 2025-06-30 (great-lakes-credit-agreement.docx) — the deliverable engages the deadline measured from 2024-06-30 but never states the resolved deadline 2025-06-30`
- `deadline 2025-06-01 + 2 years = 2027-06-01 (orion-subscription-renewal.docx) — the deliverable engages the deadline measured from 2025-06-01 but never states the resolved deadline 2027-06-01`

**undefined — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (grounded_structure_v1)**:
- `"Project Summit" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…two distinct acquisition workstreams, which are analyzed separately below: • Project Summit: proposed acquisition of Solara Health & Wellness LLC by Ridgeline Consumer Pro…”
- `"Solara Health" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…hich are analyzed separately below: • Project Summit: proposed acquisition of Solara Health & Wellness LLC by Ridgeline Consumer Products Inc., structured as a purchase of…”

**derived — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (mike_structure_paths_v1)**:
- `$23,900,000 = 27.4% of 87,300,000 revenue — the deliverable states the amount $23,900,000 but never the 27.4% share (deal-overview-memo.docx)`
- `187,300,000 revenue × 41% = 76,793,000 — the deliverable states 41% of revenue but never the amount (deal-summary-memo.docx)`

**deadline — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (mike_structure_paths_v1)**:
- `written notice of non-renewal due 2026-01-14 − 180 days = 2025-07-18 (apex-msa.docx) — the deliverable engages the written notice of non-renewal but never states the resolved deadline 2025-07-18`
- `deadline 2024-06-30 + 12 months = 2025-06-30 (great-lakes-credit-agreement.docx) — the deliverable engages the deadline measured from 2024-06-30 but never states the resolved deadline 2025-06-30`

**undefined — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (mike_structure_paths_v1)**:
- `"Project Summit" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…ers LLC's proposed acquisition of Aldersgate Software Solutions, Inc.; and (ii) Project Summit, involving Ridgeline Consumer Products Inc.'s proposed acquisition of Solara He…”
- `"Great Lakes" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…lude FCB's 2% make-whole where applicable; Solara's approximately $42.7 million Great Lakes payoff; Webb's approximately $35.4 million potential payout; TerraVerde's possi…”

**derived — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (upstream_terminal_v1)**:
- `87,300,000 revenue × 17% = 14,841,000 — the deliverable states 17% of revenue but never the amount (deal-overview-memo.docx)`
- `187,300,000 revenue × 18% = 33,714,000 — the deliverable states 18% of revenue but never the amount (deal-summary-memo.docx)`

**deadline — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (upstream_terminal_v1)**:
- `written notice of non-renewal due 2026-01-14 − 180 days = 2025-07-18 (apex-msa.docx) — the deliverable engages the written notice of non-renewal but never states the resolved deadline 2025-07-18`

**undefined — corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts (upstream_terminal_v1)**:
- `"Project Summit" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…t material contracts identified in the confidential deal summary memorandum for Project Summit, the proposed acquisition of 100% of the membership interests of Solara Health…”
- `"Solara Health" is used as a defined term in the draft but is not defined in the draft or any of the 19 source document(s); the reader cannot know what it means` — excerpt: “…Project Summit, the proposed acquisition of 100% of the membership interests of Solara Health & Wellness LLC by Ridgeline Consumer Products Inc. The transaction is described…”

**derived — corporate-ma/draft-acquisition-due-diligence (grounded_structure_v1)**:
- `$9.3M = 15.1% of 61,400,000 revenue — the deliverable states the amount $9.3M but never the 15.1% share (greenleaf-diligence-memo-template.docx)`
- `61,400,000 revenue × 13.3% = 8,166,200 — the deliverable states 13.3% of revenue but never the amount (greenleaf-diligence-memo-template.docx)`

**deadline — corporate-ma/draft-acquisition-due-diligence (grounded_structure_v1)**:
- `deadline 2024-09-30 + 9 months = 2025-06-30 (board-shareholder-minutes-compilation.docx) — the deliverable engages the deadline measured from 2024-09-30 but never states the resolved deadline 2025-06-30`
- `deadline 2023-02-28 + 19 months = 2024-09-28 (board-shareholder-minutes-compilation.docx) — the deliverable engages the deadline measured from 2023-02-28 but never states the resolved deadline 2024-09-28`

**undefined — corporate-ma/draft-acquisition-due-diligence (grounded_structure_v1)**:
- `"Floor New York" is used as a defined term in the draft but is not defined in the draft or any of the 26 source document(s); the reader cannot know what it means` — excerpt: “…December 2024 Prepared by: HARTWELL & CRANE LLP 610 Lexington Avenue, 28th Floor New York, NY 10022 Lead Partner: Jonathan Ashford Senior Associate: Claire Matsuda F…”
- `"Round Rock" is used as a defined term in the draft but is not defined in the draft or any of the 26 source document(s); the reader cannot know what it means` — excerpt: “…, and retail applications. The Company operates from its Austin headquarters, a Round Rock manufacturing facility through the Manufacturing Subsidiary, and a Boulder, Col…”

**derived — corporate-ma/draft-acquisition-due-diligence (mike_structure_paths_v1)**:
- `$7.8M = 12.7% of 61,400,000 revenue — the deliverable states the amount $7.8M but never the 12.7% share (greenleaf-diligence-memo-template.docx)`
- `$9.3M = 15.1% of 61,400,000 revenue — the deliverable states the amount $9.3M but never the 15.1% share (greenleaf-diligence-memo-template.docx)`

**deadline — corporate-ma/draft-acquisition-due-diligence (mike_structure_paths_v1)**:
- `deadline 2024-09-30 + 9 months = 2025-06-30 (board-shareholder-minutes-compilation.docx) — the deliverable engages the deadline measured from 2024-09-30 but never states the resolved deadline 2025-06-30`
- `deadline 2023-02-28 + 19 months = 2024-09-28 (board-shareholder-minutes-compilation.docx) — the deliverable engages the deadline measured from 2023-02-28 but never states the resolved deadline 2024-09-28`

**undefined — corporate-ma/draft-acquisition-due-diligence (mike_structure_paths_v1)**:
- `"Transaction Diligence Team" is used as a defined term in the draft but is not defined in the draft or any of the 26 source document(s); the reader cannot know what it means` — excerpt: “…for: Cascade Ventures Holdings LLC and its affiliates and advisors Prepared by: Transaction Diligence Team FOR INTERNAL USE ONLY — This memorandum has been prepared solely for the use…”
- `"FOR INTERNAL USE ONLY" is used as a defined term in the draft but is not defined in the draft or any of the 26 source document(s); the reader cannot know what it means` — excerpt: “…s LLC and its affiliates and advisors Prepared by: Transaction Diligence Team FOR INTERNAL USE ONLY — This memorandum has been prepared solely for the use and benefit of the propo…”

**derived — corporate-ma/draft-acquisition-due-diligence (upstream_terminal_v1)**:
- `$9.3M = 15.1% of 61,400,000 revenue — the deliverable states the amount $9.3M but never the 15.1% share (greenleaf-diligence-memo-template.docx)`
- `61,400,000 revenue × 13.3% = 8,166,200 — the deliverable states 13.3% of revenue but never the amount (greenleaf-diligence-memo-template.docx)`

**deadline — corporate-ma/draft-acquisition-due-diligence (upstream_terminal_v1)**:
- `deadline 2023-02-28 + 19 months = 2024-09-28 (board-shareholder-minutes-compilation.docx) — the deliverable engages the deadline measured from 2023-02-28 but never states the resolved deadline 2024-09-28`
- `deadline 2025-03-31 + 3 years = 2028-03-31 (meridian-properties-supply-agreement.docx) — the deliverable engages the deadline measured from 2025-03-31 but never states the resolved deadline 2028-03-31`

**undefined — corporate-ma/draft-acquisition-due-diligence (upstream_terminal_v1)**:
- `"Floor New York" is used as a defined term in the draft but is not defined in the draft or any of the 26 source document(s); the reader cannot know what it means` — excerpt: “…December 2024 Prepared by: HARTWELL & CRANE LLP 610 Lexington Avenue, 28th Floor New York, NY 10022 Lead Partner: Jonathan Ashford Senior Associate: Claire Matsuda F…”
- `"Round Rock" is used as a defined term in the draft but is not defined in the draft or any of the 26 source document(s); the reader cannot know what it means` — excerpt: “…ring subsidiary. The Company reports approximately 310 employees across Austin, Round Rock, and Boulder. (Sources: amended-restated-certificate-of-incorporation.docx, Art…”

**undefined — healthcare-life-sciences/analyze-counterparty-markup-of-clinical-trial-agreement (grounded_structure_v1)**:
- `"General Counsel" is used as a defined term in the draft but is not defined in the draft or any of the 3 source document(s); the reader cannot know what it means` — excerpt: “…— ATTORNEY-CLIENT COMMUNICATION / ATTORNEY WORK PRODUCT To: Rachel Ostrander, General Counsel; Dr. Philip Torrance, VP of Clinical Operations From: Sarah Lindquist, Partner,…”
- `"Lakeshore Regional Medical Center" is used as a defined term in the draft but is not defined in the draft or any of the 3 source document(s); the reader cannot know what it means` — excerpt: “…om: Sarah Lindquist, Partner, Whitfield & Crane LLP Date: November 17, 2025 Re: Lakeshore Regional Medical Center — Protocol VTX-4821-301 CTA Redline Analysis Purpose. This memorandum compare…”

**undefined — healthcare-life-sciences/analyze-counterparty-markup-of-clinical-trial-agreement (mike_structure_paths_v1)**:
- `"General Counsel" is used as a defined term in the draft but is not defined in the draft or any of the 3 source document(s); the reader cannot know what it means` — excerpt: “…n / Attorney Work Product REDLINE ANALYSIS MEMORANDUM To: Rachel Ostrander, General Counsel; Dr. Philip Torrance, Vice President of Clinical Operations From: Whitfield & C…”
- `"Vice President of Clinical Operations From" is used as a defined term in the draft but is not defined in the draft or any of the 3 source document(s); the reader cannot know what it means` — excerpt: “…ALYSIS MEMORANDUM To: Rachel Ostrander, General Counsel; Dr. Philip Torrance, Vice President of Clinical Operations From: Whitfield & Crane LLP — for Vanterra Therapeutics, Inc. Date: November 17, 202…”

**undefined — healthcare-life-sciences/analyze-counterparty-markup-of-clinical-trial-agreement (upstream_terminal_v1)**:
- `"General Counsel" is used as a defined term in the draft but is not defined in the draft or any of the 3 source document(s); the reader cannot know what it means` — excerpt: “…— ATTORNEY-CLIENT COMMUNICATION / ATTORNEY WORK PRODUCT To: Rachel Ostrander, General Counsel; Dr. Philip Torrance, VP of Clinical Operations From: Sarah Lindquist, Partner,…”
- `"Senior Associate Date" is used as a defined term in the draft but is not defined in the draft or any of the 3 source document(s); the reader cannot know what it means` — excerpt: “…erations From: Sarah Lindquist, Partner, Whitfield & Crane LLP; David Nakamura, Senior Associate Date: November 17, 2025 Re: Lakeshore Regional Medical Center — Classified Analysis…”

**derived — tax/draft-transfer-pricing-documentation (mike_structure_paths_v1)**:
- `$315 million = 25% of 1,284,000,000 revenue — the deliverable states the amount $315 million but never the 25% share (draft-master-file.docx)`
- `$1.1 million = 32% of 3,400,000 income — the deliverable states the amount $1.1 million but never the 32% share (draft-master-file.docx)`

**deadline — tax/draft-transfer-pricing-documentation (mike_structure_paths_v1)**:
- `Buy-in payment due 2020-07-01 + 10 years = 2030-07-01 (northbridge-benchmarking-study-services-and-financing.docx) — the deliverable engages the Buy-in payment but never states the resolved deadline 2030-07-01`
- `Payment due 2021-03-01 + 60 days = 2021-04-30 (qualified-cost-sharing-arrangement-qcsa-agreement.docx) — the deliverable engages the Payment but never states the resolved deadline 2021-04-30`

**undefined — tax/draft-transfer-pricing-documentation (mike_structure_paths_v1)**:
- `"Master File" is used as a defined term in the draft but is not defined in the draft or any of the 25 source document(s); the reader cannot know what it means` — excerpt: “…ckage is substantial and contains many useful building blocks: a detailed draft Master File, executed-style intercompany agreements, two Northbridge economic reports, the…”
- `"Local Country Files" is used as a defined term in the draft but is not defined in the draft or any of the 25 source document(s); the reader cannot know what it means` — excerpt: “…date of June 30, 2025. The engagement letter also contemplated seven individual Local Country Files, but the reviewed package does not contain standalone files for all seven non-U…”

**derived — tax/draft-transfer-pricing-documentation (upstream_terminal_v1)**:
- `$42.0 million = 7% of 628,000,000 revenue — the deliverable states the amount $42.0 million but never the 7% share (northbridge-benchmarking-study-tangible-goods-and-royalties.docx)`
- `$42.0 million = 3.3% of 1,284,000,000 revenue — the deliverable states the amount $42.0 million but never the 3.3% share (northbridge-benchmarking-study-tangible-goods-and-royalties.docx)`

**deadline — tax/draft-transfer-pricing-documentation (upstream_terminal_v1)**:
- `Buy-in payment due 2020-07-01 + 10 years = 2030-07-01 (northbridge-benchmarking-study-services-and-financing.docx) — the deliverable engages the Buy-in payment but never states the resolved deadline 2030-07-01`
- `Payment due 2021-03-01 + 60 days = 2021-04-30 (qualified-cost-sharing-arrangement-qcsa-agreement.docx) — the deliverable engages the Payment but never states the resolved deadline 2021-04-30`

**undefined — tax/draft-transfer-pricing-documentation (upstream_terminal_v1)**:
- `"AI Legal Assistant Subject" is used as a defined term in the draft but is not defined in the draft or any of the 25 source document(s); the reader cannot know what it means` — excerpt: “….docx] memo Review Memorandum To: VIT Group Tax and Legal Team From: Mike, AI Legal Assistant Subject: FY2024 Transfer Pricing Documentation Package — Comprehensive Review Review sc…”
- `"FY2024 Transfer Pricing Documentation Package" is used as a defined term in the draft but is not defined in the draft or any of the 25 source document(s); the reader cannot know what it means` — excerpt: “…ndum To: VIT Group Tax and Legal Team From: Mike, AI Legal Assistant Subject: FY2024 Transfer Pricing Documentation Package — Comprehensive Review Review scope: Global FY2024 package, including the draft…”

**deadline — trusts-estates-private-client/extract-client-intake-facts/scenario-01 (grounded_structure_v1)**:
- `deadline 2011-08-18 + 3 weeks = 2011-09-08 (client-intake-questionnaire.docx) — the deliverable engages the deadline measured from 2011-08-18 but never states the resolved deadline 2011-09-08`

**undefined — trusts-estates-private-client/extract-client-intake-facts/scenario-01 (grounded_structure_v1)**:
- `"Case No" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…Whitfield v. Derek James Whitfield Court and case: DuPage County Circuit Court, Case No. 2025-D-000347 Filing date: February 7, 2025 Stated basis: Irreconcilable diffe…”
- `"Illinois Approximate" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…tated basis: Irreconcilable differences Marriage: August 18, 2011, Lake Forest, Illinois Approximate marriage duration at filing: 14 years Current residence: 2918 Ridgeview Terrace…”

**deadline — trusts-estates-private-client/extract-client-intake-facts/scenario-01 (mike_structure_paths_v1)**:
- `deadline 2011-08-18 + 3 weeks = 2011-09-08 (client-intake-questionnaire.docx) — the deliverable engages the deadline measured from 2011-08-18 but never states the resolved deadline 2011-09-08`

**undefined — trusts-estates-private-client/extract-client-intake-facts/scenario-01 (mike_structure_paths_v1)**:
- `"DuPage County" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…to Derek James Whitfield, three minor children, and a dissolution case filed in DuPage County on February 7, 2025. The principal factual and strategic issues identified by t…”
- `"Case No" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…for dissolution was filed February 7, 2025, in the DuPage County Circuit Court, Case No. 2025-D-000347, on irreconcilable-differences grounds. Rachel reports that Dere…”

**deadline — trusts-estates-private-client/extract-client-intake-facts/scenario-01 (upstream_terminal_v1)**:
- `deadline 2011-08-18 + 3 weeks = 2011-09-08 (client-intake-questionnaire.docx) — the deliverable engages the deadline measured from 2011-08-18 but never states the resolved deadline 2011-09-08`

**undefined — trusts-estates-private-client/extract-client-intake-facts/scenario-01 (upstream_terminal_v1)**:
- `"Case No" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…hitfield dissolution of marriage Court and case: DuPage County Circuit Court; Case No. 2025-D-000347. Petition reportedly filed February 7, 2025, on grounds of irrec…”
- `"and Lily's" is used as a defined term in the draft but is not defined in the draft or any of the 2 source document(s); the reader cannot know what it means` — excerpt: “…$40 copay per session. Current informal arrangement: Derek reportedly handles Ethan's and Lily's school drop-off and pickup on Monday, Wednesday, and Friday and attends…”

**deadline — white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement (grounded_structure_v1)**:
- `Voluntary Self- Disclosure due 2022-06-14 + 17 months = 2023-11-14 (negotiation-strategy-memo.docx) — the deliverable engages the Voluntary Self- Disclosure but never states the resolved deadline 2023-11-14`
- `deadline 2022-08-03 + 15 months = 2023-11-03 (negotiation-strategy-memo.docx) — the deliverable engages the deadline measured from 2022-08-03 but never states the resolved deadline 2023-11-03`

**undefined — white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement (grounded_structure_v1)**:
- `"VMH Defense Team Date" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…s-memo Privileged and Confidential — Attorney Work Product Prepared for the VMH Defense Team Date: April 2025 Matter: United States v. Vantage Meridian Holdings, Inc. Subject: C…”
- `"Deferred Prosecution Agreement and VMH's" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…rnment's counter-markup, identifies material changes from the original proposed Deferred Prosecution Agreement and VMH's initial markup, evaluates legal, operational, financial, disclosure, and litiga…”

**deadline — white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement (mike_structure_paths_v1)**:
- `Voluntary Self- Disclosure due 2022-06-14 + 17 months = 2023-11-14 (negotiation-strategy-memo.docx) — the deliverable engages the Voluntary Self- Disclosure but never states the resolved deadline 2023-11-14`
- `deadline 2022-08-03 + 15 months = 2023-11-03 (negotiation-strategy-memo.docx) — the deliverable engages the deadline measured from 2022-08-03 but never states the resolved deadline 2023-11-03`

**undefined — white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement (mike_structure_paths_v1)**:
- `"VMH Defense Team From" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…Executive Summary PRIVILEGED AND CONFIDENTIAL — ATTORNEY WORK PRODUCT To: VMH Defense Team From: Thornfield & Beckett LLP Date: April 2025 Matter: United States v. Vantage Mer…”
- `"Target Letter" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…, despite the documented sequence of a CFTC referral, grand-jury investigation, Target Letter, and only later proffer sessions. This is an absolute red line and should be de…”

**deadline — white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement (upstream_terminal_v1)**:
- `Voluntary Self- Disclosure due 2022-06-14 + 17 months = 2023-11-14 (negotiation-strategy-memo.docx) — the deliverable engages the Voluntary Self- Disclosure but never states the resolved deadline 2023-11-14`

**undefined — white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement (upstream_terminal_v1)**:
- `"Managing Director" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…undefined institutional-knowledge admission or attribution above the desk-level Managing Director chain; (3) express preservation of privilege; (4) a material-breach notice-and-…”
- `"Delete Section" is used as a defined term in the draft but is not defined in the draft or any of the 5 source document(s); the reader cannot know what it means` — excerpt: “…h risk, and economic certainty. Absolute or effectively absolute positions: • Delete Section 16 in its entirety, or replace it with an express statement that VMH provided s…”

## 5. Repair-prompt size distribution

Reconstructed via `auditSlaDraft` with `requestContext` = the task instructions and `artifactNames` = the run's output filenames — the exact audit the harness runs post-synthesis.

- All runs: **43** runs — min **1341**, p50 **3162**, p90 **4486**, p99 **4829**, max **4829** chars
- Runs that produced a repair prompt (non-null): **43** runs — min **1341**, p50 **3162**, p90 **4486**, p99 **4829**, max **4829** chars
- Runs with **no** repair prompt (audit silent): 0
- Runs whose prompt exceeds the **3,000-char** skimming bound: **24** — antitrust-competition/analyze-antitrust-hsr-strategy·mike_structure_paths_v1 (3031); antitrust-competition/analyze-antitrust-hsr-strategy·upstream_terminal_v1 (3899); capital-markets/draft-indenture-for-senior-secured-notes-offering·grounded_structure_v1 (4158); capital-markets/draft-indenture-for-senior-secured-notes-offering·mike_structure_paths_v1 (4486); capital-markets/draft-indenture-for-senior-secured-notes-offering·upstream_terminal_v1 (4809); corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts·grounded_structure_v1 (3162); corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts·mike_structure_paths_v1 (4044); corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts·upstream_terminal_v1 (3640); antitrust-competition/analyze-antitrust-hsr-strategy·mike_structure_paths_v1 (3792); antitrust-competition/prepare-antitrust-risk-assessment·grounded_structure_v1 (3883); antitrust-competition/prepare-antitrust-risk-assessment·mike_structure_paths_v1 (3206); antitrust-competition/prepare-antitrust-risk-assessment·upstream_terminal_v1 (3544); capital-markets/draft-indenture-for-senior-secured-notes-offering·grounded_structure_v1 (4829); capital-markets/draft-indenture-for-senior-secured-notes-offering·mike_structure_paths_v1 (4499); corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts·grounded_structure_v1 (3781); corporate-ma/draft-acquisition-due-diligence·grounded_structure_v1 (4501); corporate-ma/draft-acquisition-due-diligence·mike_structure_paths_v1 (3376); corporate-ma/draft-acquisition-due-diligence·upstream_terminal_v1 (3193); healthcare-life-sciences/analyze-counterparty-markup-of-clinical-trial-agreement·mike_structure_paths_v1 (3064); healthcare-life-sciences/analyze-counterparty-markup-of-clinical-trial-agreement·upstream_terminal_v1 (3353); tax/draft-transfer-pricing-documentation·mike_structure_paths_v1 (3892); tax/draft-transfer-pricing-documentation·upstream_terminal_v1 (3231); white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement·grounded_structure_v1 (3627); white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement·mike_structure_paths_v1 (3872)

Distinct prompt sections (conflict/temporal/drift/derived/deadline/undefined/lint): min 1, med 2, max 4 (of 7).

## 6. Recommendations

Computed from the runs above:

- **H3 (undefined term) fires at its 12-finding cap on 26 of 43 runs** — every one of those drafts has 12+ capitalized phrases with an unquoted occurrence that resolve to no definition. The fired terms on the memo/analytical tasks are dominated by proper nouns the filters do not know: person names, cities/metro areas, company names without a designator word, and statute/form names. A repair pass would spend its budget correcting non-defects.
- **H1 (derived) fired on 20 runs; never at cap (0 at cap).** Where it fires it names the source doc and the arithmetic. Counts are low (1–6), so the findings are dense and cheap to verify.
- **H2 (deadline) fired on 22 runs; never at cap (0 at cap).** Its refusals dominate on source stacks without stated calendar anchors (see `dl res/eng/ref`), which is the typed-refusal behavior the mechanism promises.
- **Work-type gate:** `requestsOperativeDrafting` suppressed deadline on 5 deadline-firing runs (the operative indenture arms — correctly, after `indentures?` joined OPERATIVE_ARTIFACT) and derived on 0 derived-firing runs. The vocabulary still misses `diligence` and `transfer pricing documentation`, so those operative-drafting tasks are still audited as analytical.
- **Repair prompt exceeds the 3,000-char skimming bound on 24/43 runs** (p90 4486, max 4829). The H3 flood is the main driver.

### Calibration cross-check (CoC task, vs the run's own failed gold criteria)

Two organ findings on the change-of-control runs line up with the RUN's OWN failed gold criteria — evidence the organs find real omissions, not just noise:

- **H2 deadline → C-018** (failed on all CoC arms): `Identifies Apex MSA auto-renewal notice deadline of approximately July 18, 2025`. The organ fired `written notice of non-renewal due 2026-01-14 − 180 days = 2025-07-18` on every CoC arm — the resolved date (2025-07-18 = July 18, 2025) is exactly the date the criterion requires.
- **H1 derived → C-008** (failed on all CoC arms): `Quantifies Pinnacle-dependent revenue at risk ($22.1M / 25.3% of total revenue)`. On the arms where the organ fired the `$22.1M / 25.3%` identity, it names the half that criterion penalizes as missing.

(C-009 — rate the Pinnacle exclusivity conversion as Critical — also failed on the upstream CoC arm; it is a severity-rating criterion, not an omission, so no organ addresses it. That is a genuine miss but out of H1/H2/H3 scope.)

### Organ readiness

- **H1 (derived) — ready for live A/B** on the analytical families where it fires (CoC, tax, diligence, antitrust). Low fire counts, dense details, source-naming details, zero cap-floods. Gate it to analytical work types and keep the `"of <base>"` engagement gate.
- **H2 (deadline) — ready for live A/B** where it fires (indenture, CoC, diligence, tax, white-collar). The typed refusal path is behaving (most deadline-ish periods refuse rather than guess). Validate a sample of fired `resolved` dates against gold before enabling repair, since a wrong resolved date is worse than no finding.
- **H3 (undefined term) — not corpus-ready; two distinct problems.** First, an early pass of this stress test caught a live regression: a word-class `.` in `PHRASE_RE` glued sentence-final periods to the next capitalized word (`Business Days. Upon`); that has been reverted and the indenture stack is back to the documented baseline of 1 firing. Second, and still live: on memo/analytical deliverables H3 floods its cap with proper nouns — person names (`Frank Castellano`), cities/metro areas (`Baton Rouge`, `Hattiesburg and Gulfport-Biloxi`), company names without designators (`PetroStar Refining and Gulf Coast Shipbuilders`), and statute/form names (`Hart-Scott-Rodino Act`, `Notification and Report Form`). Recommended: add a person/place/known-name filter (or an NER-shaped gate), or gate H3 to operative-drafting work types where undefined defined terms are the real defect and run it analytically only for the quoting/use boundary.

### Stress-test gaps

- **Sealed tier (997 tasks) is off-machine** — this covers only the vendored LAB tasks with grounded-cache runs (43 runs, 8 families).
- **Scores are fixed-Sol criterion labels, not human gold.** A PASS is the judge's verdict, so "false positive" here means "fired on a judge-PASS run", not "wrong per a lawyer". A manual gold read of the fired findings is the next step.
- **Multiple arms per task** (grounded_structure / mike_structure_paths / upstream_terminal × v1/v2/v3) are pooled per family; some v1/v2 arms have no deliverable and were excluded.
- **Concurrent edits:** the organs were modified during this run (2026-08-03 14:21–14:35 local). The numbers are a snapshot against the module versions loaded at script start; re-run to refresh.
