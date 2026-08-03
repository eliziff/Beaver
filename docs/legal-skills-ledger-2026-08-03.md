# Legal-skills to LAB-task ledger — 2026-08-03

Purpose: map **external legal-work skill `.md` files** (lawve.ai + similar repos) to
**very tightly matching vendored Harvey LAB tasks**, for an A/B test of whether
injecting these skills as scaffolding improves rubric accuracy. Only high-fidelity
correspondences enter the A/B plan. Partial correspondences are catalogued in the
appendix with the named gap. Rejects are listed for honesty.

Machine-readable form: `legal-skills-ledger-2026-08-03.json` (tight rows only).

## Grading rule

A match is **tight** only when all three of (a) deliverable kind, (b) input
document type, and (c) required analysis/entities correspond, **and** the skill's
prescribed workflow maps onto the task's rubric criteria *without forcing*. Partial
rows kept the skill's useful overlap but named a required rubric class the skill does
not prescribe.

## Corpus grounding

Vendored tree: `benchmarks/harvey-labs/tasks/` (489 tasks across 26 practice areas,
dev + validation tiers only). Sealed tier is **off-machine** and was not touched.
Families relevant to this ledger and their task shapes:

- **diligence** (4): giant VDR red-flags reports, 498–879 rubric criteria each, mostly
  consent/assignment/CoC/IP/compliance.
- **corporate-ma** (13): CIM buy-side memo, SPA/escrow/term-sheet markups, disclosure
  schedule gap, environmental DD, QofE/PPA, CoC-across-contracts, comprehensive DD memo.
- **banking-finance** (10): credit-agreement markup / term-sheet / commitment-letter
  deviation reports, covenant extraction, covenant-compliance recalculation, closing-
  documents-vs-CP gap memos.
- **capital-markets** (9): closing-checklist verification, 10-K YoY, S-1 form check,
  S-3 consistency, DEF 14A drafting, 8-K drafting, indenture drafting, underwriting
  markup, charter-offering cross-check.
- **tax** (8): transfer-pricing documentation review, Section 382, IRS markup/stipulation
  analysis, IDR analysis, assessed-vs-filed variance.
- **antitrust-competition** (11): HSR strategy, HHI/market analysis, hot-document review,
  remedies, compliance-program gap, leniency comparison, complaint drafting.
- **healthcare-life-sciences** (8): HIPAA privacy/security gap, CTA/merger-agreement
  markups, FDA protocol gap, payor benchmarking, vendor-cloud procurement gap.
- **contracts** (278): banking-contract first-draft / first-turn-redline /
  playbook-escalation / term-negotiation / counterparty-paper-review.

## Skills catalogued (sources)

| # | Skill | Source repo | Path | Purpose | Prescribed deliverable |
|---|-------|-------------|------|---------|------------------------|
| 1 | `diligence-issue-extraction` | anthropics/claude-for-legal | `corporate-legal/skills/diligence-issue-extraction/SKILL.md` | Extract issues from a VDR per house categories + materiality; standard extraction sets (CoC, assignment, exclusivity, corporate, IP, employment, litigation) | Severity-graded (🔴🟡🟢) house memo; per-finding "Recommendation:" closure; coverage stats |
| 2 | `analyzing-covenant-compliance` | casemark/skills | `skills/finance/analyzing-covenant-compliance/SKILL.md` | Independently recalculate covenant ratios per agreement definitions; compare vs borrower's certificate; verify add-back caps; cures/defaults | Compliance table (covenant/def §/threshold/actual/headroom/status); headroom sensitivity; cure status; risk flags |
| 3 | `analyzing-credit-agreement-terms` | casemark/skills | `skills/capital/analyzing-credit-agreement-terms/SKILL.md` | Evaluate credit agreement provisions; documentation comparison with deviation flags vs benchmark/precedent | Facility overview table; covenant analysis; comparison matrix; flexibility-vs-protection scorecard; risk flags |
| 4 | `conducting-buy-side-due-diligence` | casemark/skills | `skills/capital/conducting-buy-side-due-diligence/SKILL.md` | Structure buy-side DD; reconcile CIM to audited; QoE adjustments; customer concentration; key-person; synthesize DD report | DRL + consolidated DD report + red-flag memo + quantified impact table + go/no-go |
| 5 | `conducting-environmental-remediation-analysis` | casemark/skills | `skills/capital/conducting-environmental-remediation-analysis/SKILL.md` | Contamination classification, remediation cost estimates (low/base/high), insurance adequacy, liability vs transaction value, deal terms | Contamination table; cost estimate; insurance gap; risk-adjusted liability range; indemnity/escrow/holdback terms |
| 6 | `modeling-tax-attribute-preservation` | casemark/skills | `skills/capital/modeling-tax-attribute-preservation/SKILL.md` | §382 ownership-change test (5%+ shareholders, 50-pt threshold), §382 limitation, (l)(5)/(l)(6), NOL utilization | Excel §382 model + ownership-change testing schedule + scenario comparison + assumptions log |
| 7 | `proxy-statement` | casemark/skills | `skills/legal/proxy-statement/SKILL.md` | Draft Regulation 14A / Rule 14a-3 DEF 14A with section checklists (governance/independence, Item 402(b) exec comp, Item 404(a) RPT, Rule 14a-8 proposals, vote-treatment matrix) | Complete DEF 14A in 10-section order; `[TO FILL]` gap flags; cross-referenced CD&A/say-on-pay |
| 8 | `analyzing-anti-trust-risk` | casemark/skills | `skills/capital/analyzing-anti-trust-risk/SKILL.md` | HSR applicability, SSNIP market definition, pre/post/delta HHI vs Merger Guidelines, competitive effects, remedies, risk rating | HSR filing analysis; market-by-market concentration table; remedy matrix; timeline; executive summary with rating |
| 9 | `managing-transfer-pricing-compliance` | casemark/skills | `skills/finance/managing-transfer-pricing-compliance/SKILL.md` | Structure TP documentation: FAR, five OECD methods, benchmarking/IQR, intercompany-agreement substance review, master/local/CbCR assembly | TP compliance report; gap matrix; action list; jurisdiction compliance calendar |
| 10 | `form-10k` | casemark/skills | `skills/legal/form-10k/SKILL.md` | Draft a compliant Form 10-K (Items 1–15) with MD&A YoY, risk factors, financials, internal-consistency rules | Full four-part 10-K; SOX §302/§906; exhibit index; signature blocks |
| 11 | `escrow-agreement` | casemark/skills | `skills/legal/escrow-agreement/SKILL.md` | Draft tripartite escrow agreement: release conditions table, survival checklist, claim distribution, agent duties | Enforceable escrow agreement + release table + issues list |
| 12 | `conducting-quality-of-earnings-analysis` | casemark/skills | `skills/capital/conducting-quality-of-earnings-analysis/SKILL.md` | Normalize earnings to adjusted EBITDA; adjustment categories + confidence tiers; NWC peg | Adjusted-EBITDA summary + adjustment schedule + revenue/NWC sections |
| 13 | `tabular-review` | anthropics/claude-for-legal | `corporate-legal/skills/tabular-review/SKILL.md` | Batch contract review to spreadsheet: one row per doc, one column per data point, verbatim-quoted cells, 3 not-found states | Markdown/CSV/xlsx table + sources CSV; explicitly "leads, not findings" |
| 14 | `closing-checklist` | anthropics/claude-for-legal | `corporate-legal/skills/closing-checklist/SKILL.md` | Maintain closing checklist: init from PA (extract CPs/deliverables), ingest diligence, status, blocking report | Markdown blocking report + checklist YAML |
| 15 | `material-contract-schedule` | anthropics/claude-for-legal | `corporate-legal/skills/material-contract-schedule/SKILL.md` | Build material-contracts disclosure schedule from diligence findings applying the PA's definition | Markdown Schedule 3.X + consent-tracking overlay |
| 16 | `earnout-analysis` | duraninci/openclaw-legal-skills | `skills/earnout-analysis/SKILL.md` | Analyze earnout/contingent-consideration structure, metrics, protections, 1–5 risk scoring | Structured report with 🔴🟡🟢 risk level, metric analysis, recommendations |
| 17 | `contract-review-anthropic` (playbook review) | lawve-ai/awesome-legal-skills | `skills/playbook-reviewer-anthropic/SKILL.md` | Analyze contracts vs organization playbook; GREEN/YELLOW/RED severity; redline suggestions + fallback | Per-clause redlines + Tier 1/2/3 negotiation priority |
| 18 | `contract-review-skill` (CUAD) | evolsb/claude-legal-skill | `skill.md` | Position-aware contract risk review; CUAD categories; M&A checklist; market benchmarks | Markdown report: key terms, red-flags, 🔴🟡🟢 risk analysis, negotiation priorities |
| 19 | `hipaa-compliance` | lawve-ai/awesome-legal-skills | `skills/hipaa-compliance-tanaji-hemant-naik/SKILL.md` | HIPAA advisor: Privacy Rule, Security Rule, BAA, NPP; compliance review mode | Review: issues table (Issue/§/Risk/Recommendation) citing 45 CFR §164 |
| 20 | `vendor-due-diligence` | lawve-ai/awesome-legal-skills | `skills/vendor-due-diligence-patrick-munro/SKILL.md` | Risk-based vendor assessment (financial/legal/security/operational) with weighted scoring | Vendor risk report + comparison matrix + risk register |
| 21 | `preparing-disclosure-statement-analysis` | casemark/skills | `skills/capital/preparing-disclosure-statement-analysis/SKILL.md` | Chapter 11 disclosure-statement adequacy (§1125), liquidation test, feasibility | Bankruptcy disclosure analysis (NOT M&A schedule) |
| 22 | `disclosure-list` | lawve-ai/awesome-legal-skills | `skills/disclosure-list-andrew-bird/SKILL.md` | England & Wales civil-litigation disclosure regime/models + N265/DRD list | UK litigation disclosure list |
| 23 | `analyzing-cross-border-tax-structuring` | casemark/skills | `skills/capital/analyzing-cross-border-tax-structuring/SKILL.md` | Treaty/WHT/PE/substance analysis for cross-border capital flows | Cross-border tax structure report (no TP documentation) |

Sources: [lawve-ai/awesome-legal-skills](https://github.com/lawve-ai/awesome-legal-skills),
[anthropics/claude-for-legal](https://github.com/anthropics/claude-for-legal),
[casemark/skills](https://github.com/casemark/skills),
[duraninci/openclaw-legal-skills](https://github.com/duraninci/openclaw-legal-skills),
[evolsb/claude-legal-skill](https://github.com/evolsb/claude-legal-skill).

---

## TIGHT matches (A/B plan) — 7 skills, 14 task rows

### Family: diligence (VDR red-flags reports)

| Skill | Matched task(s) | Rationale (skill workflow ↔ rubric) |
|-------|-----------------|--------------------------------------|
| `diligence-issue-extraction` | `diligence/gaming-strategic-acquisition` · `diligence/cybersecurity-tuck-in` · `diligence/enterprise-software-diversification` · `diligence/aerospace-vertical-integration` | Skill's Step 1 inventory-VDR + Step 3 extraction sets (material contracts: CoC/assignment/exclusivity/termination/consent; corporate: cap table/board consent; IP: ownership chain/licensed-vs-owned) map onto the 498–879 criteria each — omitted commercial consents, CoC consent/termination notices, license non-sublicensability, FedRAMP/BIS/sanctions compliance gaps. Step 4 severity (🔴🟡🟢) and per-finding "Recommendation:" closure match the `red-flags-report.md` deliverable. Same input kind (VDR), same deliverable kind (severity-graded issue report). |

### Family: corporate-ma

| Skill | Matched task(s) | Rationale |
|-------|-----------------|-----------|
| `diligence-issue-extraction` | `corporate-ma/draft-acquisition-due-diligence` | Rubric issues (missing Certificate of Designation/cap table, board quorum, CoC termination/assignment, IP) are exactly the skill's corporate + material-contracts + IP extraction sets; per-category memo + "Recommendation:" closure matches the identify-and-recommend criteria. |
| `conducting-buy-side-due-diligence` | `corporate-ma/analyze-cim-deal-teaser/scenario-01` · `/scenario-02` | Skill Step 3 ("reconcile CIM to audited statements, identify QoE adjustments, validate revenue and customer concentration, key-person dependencies") + Step 5 ("quantified impact table + go/no-go recommendation") map onto the rubric's EBITDA-bridge scrubbing, add-back recalculation, customer-concentration, key-person, revenue-at-risk, valuation-guardrail, and IOI-recommendation criteria. |
| `conducting-environmental-remediation-analysis` | `corporate-ma/analyze-environmental-liability-exposure-in-targets-operations` | Skill's 5 steps (contamination classification; regulatory framework; low/base/high remediation cost estimates; insurance-coverage adequacy; liability-vs-transaction-value with indemnity/escrow/holdback terms) cover the rubric's understated remediation accrual, expired indemnification, PFAS/AFFF exposure, missing-sampling data gaps, insurance, and price-adjustment criteria. |

### Family: banking-finance

| Skill | Matched task(s) | Rationale |
|-------|-----------------|-----------|
| `analyzing-covenant-compliance` | `banking-finance/compare-compliance-certificate-against-financial-covenants` · `banking-finance/compare-borrower-covenant-compliance-analysis` | Skill prescribes recalculating every ratio independently from financials using the agreement's defined terms, verifying each EBITDA add-back against its cap, and "compare your result to the borrower's reported compliance certificate figure; investigate any variance exceeding 0.05x." That is the task's verbatim operation (LTM EBITDA recalc, add-back cap application, debt-definition trace, default analysis). |
| `analyzing-credit-agreement-terms` | `banking-finance/compare-credit-agreement-against-term-sheet` · `banking-finance/compare-credit-agreement-to-commitment-letter` | Task = agreement-vs-term-sheet/commitment-letter deviation report. Skill Step 6 "Perform documentation comparison — side-by-side matrix with deviation flags," acceptance rule "every material deviation is captured — err on over-inclusion," plus facility-overview pricing table, covenant/basket/equity-cure/asset-sale analysis, map to the SOFR-floor, pricing-grid-tier, CapEx-cap, ECF-sweep, springing-covenant, and RP-basket criteria. |

### Family: tax

| Skill | Matched task(s) | Rationale |
|-------|-----------------|-----------|
| `modeling-tax-attribute-preservation` | `tax/analyze-section-382-analysis` | Skill's ownership-change test (5%+ shareholders, rolling testing period, 50-pt threshold), §382 annual-limitation computation, (l)(5)/(l)(6) exceptions, and NOL-utilization forecast map to the SPAC-merger ownership-change, threshold, limitation, and NOL-utilization criteria. The skill's Excel deliverable (ownership-change testing schedule, §382 limitation model, NOL utilization) matches the task's workbook tabs (shareholder register / ownership-shift calc / §382 limitation / NOL utilization) 1:1. |

### Family: capital-markets

| Skill | Matched task(s) | Rationale |
|-------|-----------------|-----------|
| `proxy-statement` | `capital-markets/draft-proxy-statement-disclosure` | Skill prescribes the Regulation 14A / Rule 14a-3 DEF 14A drafting workflow with section checklists: Board/Governance independence (maps to the NYSE 3-year cooling-off independent-director criteria), Related-Party Transactions per Item 404(a) (maps to the Prism/Okafor $4.3M RPT criteria incl. threshold, interest, approval/recusal), Executive Compensation CD&A per Item 402(b), Shareholder Proposals per Rule 14a-8, say-on-pay cross-references, and a `[TO FILL]` gap-flagging convention matching the task's issues-and-inconsistencies memo. |

---

## Partial matches (appendix — overlap with a named gap; NOT in A/B plan)

| Skill | Candidate task | Named gap |
|-------|----------------|-----------|
| `analyzing-anti-trust-risk` | `antitrust-competition/prepare-antitrust-risk-assessment` | Skill covers HHI calc (13 criteria), market definition/SSNIP, Second-Request timing, remedies, HSR mechanics, risk rating — but NOT the rubric's hot-document smoking-gun identification (C-022–C-031, C-069–C-070), efficiencies defense (C-041–C-044), or merger-agreement terms (C-072–C-075). |
| `analyzing-anti-trust-risk` | `antitrust-competition/analyze-antitrust-hsr-strategy` | Same core HHI/market/HSR/timing coverage; gap = hot documents (C-003–C-006, C-046), branch-consolidation synergies (C-031–C-032), serial-acquisition roll-up (C-026–C-027). |
| `managing-transfer-pricing-compliance` | `tax/draft-transfer-pricing-documentation` | Skill covers FAR/substance, intercompany-agreement consistency, benchmarking/IQR, master/local-file assembly, deadline tracking — but NOT jurisdiction-specific issues in the rubric: maquiladora safe-harbor asset segregation (C-010–C-013), India FTS withholding characterization (C-032–C-034, C-048), QCSA cost-sharing buy-in amortization (C-043–C-045), guarantee-fee benchmarking (C-025–C-027), Singapore thin-cap economics (C-020–C-022). Orientation is documentation construction, not risk-review memo. |
| `form-10k` | `capital-markets/compare-form-10` | Skill drafts a compliant 10-K (incl. MD&A YoY + internal-consistency rules); task *reviews two existing 10-Ks* for cross-year inconsistencies and SEC comment-letter risk. Review/audit stance not prescribed. |
| `escrow-agreement` | `corporate-ma/analyze-escrow-agreement-markup` | Skill drafts escrow agreements (release schedule, survival, claim distribution) but is drafting-oriented, not markup-review; and its own scope note excludes counter-security, which is a rubric criterion (C-009–C-010). |
| `conducting-quality-of-earnings-analysis` | `corporate-ma/analyze-qoe-reconciliation` | Skill builds adjusted-EBITDA + NWC peg; explicitly does NOT cover purchase-price allocation, and the task reconciles *two QoE reports + preliminary PPA* (PPA reconciliation is a required workbook, C-004 etc.). |
| `tabular-review` | `corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts` | Skill extracts CoC/assignment/exclusivity data points to a spreadsheet with verbatim quotes (matches extraction half), but explicitly "every cell is a lead, not a finding" and "not issue spotting" — the rubric requires risk ratings (Critical), quantified revenue-at-risk, and a prose deal-team report. |
| `closing-checklist` | `capital-markets/compare-closing-documents-against-closing-checklist` · `banking-finance/compare-closing-documents-against-conditions-precedent` | Skill initializes/tracks a closing checklist and produces a blocking report; task *verifies a closing set against a checklist/CPs* and grades severity (Critical/Significant/Administrative) with remediation. Document-vs-checklist verification not prescribed. |
| `material-contract-schedule` | `corporate-ma/analyze-disclosure-schedule-markup-against-merger-agreement` | Skill *builds* a material-contracts schedule from diligence applying the PA's definition; task *reviews a seller's supplemental schedule markup* for gaps vs the merger agreement (UMN consent, recall disclosure, qui tam). Construct vs review-markup mismatch. |
| `earnout-analysis` | `corporate-ma/analyze-counterparty-spa-markup` | Skill covers the earnout criteria (structure/metrics/operational covenants) but the task rubric spans NWC collar, reps/indemnity, MAE carve-outs outside earnout scope. |
| `contract-review-anthropic` (playbook) | `contracts/*playbook-escalation` · `contracts/*term-negotiation` | Skill's playbook-deviation + severity + redline + Tier-negotiation analysis matches the out-of-policy/contested-term analysis, but deliverable shape differs: per-clause redline package vs the task's structured escalation memo (Executive Summary, Policy Provisions at Issue with cross-refs, Quantified Risk Impact table). |
| `contract-review-skill` (CUAD/evolsb) | `contracts/*first-turn-redline` · corporate-ma/analyze-counterparty-spa-markup | Position-aware risk review + redline language matches, but the task requires agreement-specific counter-redlining in tracked changes with playbook cross-reference; skill is generic contract risk review, not tracked-changes redlining. |
| `hipaa-compliance` | `healthcare-life-sciences/compare-privacy-policy-against-hipaa-requirements` · `compare-policies-against-regulations` · `analyze-compliance-program-gaps` | Skill is a knowledge/advisory HIPAA reviewer (issues table citing 45 CFR §164). The rubric requires document-vs-rule *element-by-element gap detection* (specific missing NPP elements, stale risk assessment dates) — the checklist operation is not prescribed, only the advisory frame. |
| `vendor-due-diligence` | `healthcare-life-sciences/compare-vendor-cloud-infrastructure-proposal-against-internal-procurement-requirements` | Skill is a vendor risk/onboarding scoring framework (financial/security/operational weights); task is a proposal-vs-internal-procurement *commercial* gap analysis (cap, payment terms, termination fee, SLA). Analysis kind differs. |
| `analyzing-credit-agreement-terms` | `banking-finance/analyze-credit-agreement-markup` | Skill's documentation-comparison covers agreement-vs-benchmark; task compares a *borrower's markup against the original agreement* + commitment letter + credit memo. Markup-vs-original redline comparison not prescribed. |

## Rejects (catalogued, not even partial)

- `preparing-disclosure-statement-analysis` (casemark) → M&A disclosure schedule: it is a **Chapter 11 bankruptcy** disclosure-statement/feasibility skill; unrelated to M&A disclosure schedules.
- `disclosure-list` (lawve-ai) → M&A disclosure schedule: it is **England & Wales civil-litigation** disclosure (CPR/PD 57AD N265 list).
- SEC *retrieval* skills (`clarion-sec-research`, `sec-edgar`, `edgartools`): EDGAR retrieval/search tools; the LAB SEC tasks provide filings as inputs and require document comparison, not retrieval.
- Insurance family (coverage determination under policy exclusions, coverage-gap vs specs, loss reserves): no skill in the surveyed ecosystem matches tightly; casemark's insurance skills (`analyzing-cyber-insurance`, `analyzing-health-insurance-plans`, `analyzing-insurance-financials`) are financial-analytics, not policy-coverage analysis.

---

## How the A/B would run

Per task row, a **paired controlled arm** on the matched vendored task:

- **Controlled arm** — the task's rubric and source documents, injected verbatim into
  the harness prompt (no skill).
- **Skill arm** — the same task, same model, with the skill's `SKILL.md` body injected
  as system-prompt/context **before** the task prompt (the skill is external scaffolding,
  not the benchmark's hidden rubric — a legitimate generalization probe).
- **Model held constant** across both arms per the LAB doctrine (e.g., `claude -p`
  sonnet-4-6; flat-rate surfaces only — no per-token API spend).
- **Scoring**: judge both outputs against the task's rubric (PASS/FAIL per criterion).
  Metric = criterion-level pass rate; effect = skill-arm minus control-arm pass rate on
  the matched task's own criteria. Composed deltas `< ±0.015` are inside composer noise
  (per the coordinate-oracle lesson), so the pre-registration should set the decision
  threshold accordingly.

Practical notes:

- The 4 `diligence/*` tasks are 2,800–3,600 documents; run those with the harness's
  existing sub-agent/token budget for the skill arm and reuse the same budget in the
  control arm.
- For multi-task rows (diligence ×4, covenant ×2, credit ×2, CIM ×2), each task is an
  independent A/B pair; aggregate by family.
- Skill text should be injected verbatim from the pinned repo commit/raw URL so the arm
  is reproducible; record the skill content hash with the run.

## A/B-readiness assessment

- **7 skills / 14 task rows are tight enough to run.** Strongest families:
  **diligence** (1 skill → 4 tasks + 1 corporate-ma memo), **banking-finance**
  (2 skills → 4 tasks), **corporate-ma** (2 skills → 3 tasks), then **tax** and
  **capital-markets** (1 skill each). This is a defensible, non-stretched set.
- **Biggest gaps in the ecosystem vs the vendored corpus:** no tight skill for
  antitrust **hot-document/intent-evidence** review, insurance **coverage-gap /
  policy-exclusion** determination, **transfer-pricing jurisdiction-specific** issues,
  HIPAA **element-diff** gap analysis, or **10-K cross-year review**. These families
  should be excluded from the skill-injection A/B or probed only as partial.
- The `closing-checklist` family (capital-markets + banking-finance) is the highest-value
  near-miss: the concept matches but the verification operation does not; a small
  extension of the skill would make it tight.
- Recommend pre-registering each arm before running, with the model, the skill-content
  hash, and the rubric judge fixed in advance.
