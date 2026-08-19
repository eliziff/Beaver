# Harvey LAB Phase C — criteria-level forensics

**Date:** 2026-08-05 · **Scope:** 11 judged runs, 4 tasks, 4 arms
(`mike_markdown_e2e_v1`, `_floor_v1`, `_index_v1`, `_index_floor_v1`), all
`claude-p:claude-sonnet-4-6`, all judged once by `claude-code/claude-sonnet-4-6`.
**Method:** pure document forensics. No model invoked, no re-judging, no network.
Every count below was recomputed from `scores.json` (`n_passed`, `n_criteria`,
per-criterion `verdict`), exposure from `beaver-receipts.json`
(`evidence_segments` + `source_receipts.served_body_chars`), and answer
provenance from the task `documents/` extracted with `python-docx` / `openpyxl`.

---

## 0. Verification of the supplied numbers

All 11 scores in the brief match `scores.json` exactly. One telemetry number does not:

| Cell | brief | `scores.json` / `metrics.json` | agree? |
|---|---|---|---|
| capmkt e2e | 29/32 | 29/32 | yes |
| capmkt floor | 28/32 | 28/32 | yes |
| capmkt index | 29/32 | 29/32 | yes |
| capmkt index_floor | 29/32 | 29/32 | yes |
| bank e2e | 56/65 | 56/65 | yes |
| bank floor | 58/65 | 58/65 | yes |
| bank index | 54/65 | 54/65 | yes |
| emp e2e | 48/59 | 48/59 | yes |
| emp floor | 51/59 | 51/59 | yes |
| DPA index | 28/58, expo 0.1872, 5/6 docs | 28/58, 0.1872, 5/6 | yes |
| DPA index_floor | 41/58, expo 0.5569, 5/6 docs | 41/58, 0.5569, 5/6 | yes |

> **⚠ CORRECTION — banking index token count.** The brief says the banking index
> cell ran "at 228k tokens". `metrics.json` reports **188,010 total tokens**
> (input 148,091 + output 39,919; cache_read 101,513, cache_write 46,563). No
> field in that file reads 228k. All cost statements below use 188,010.

Both DPA runs' `documents_read_list` is confirmed identical and confirmed to
exclude `cftc-settlement-order.docx`:

```
["govt-counter-markup.docx", "negotiation-strategy-memo.docx",
 "original-proposed-dpa.docx", "usao-transmittal-email.eml",
 "vmh-initial-markup.docx"]
```

Stronger than that: **`doc-6` (the CFTC order) appears zero times in either
run's `raw-sse.txt`.** Neither model ever emitted a tool call naming it. The
document was ingested and available (`source_receipts` lists it with
`served_body_chars: 42834`); it was simply never requested.

---

## 1. Summary table — misses by class

Classes: **read-gap** (source document never read) · **exposure-gap** (document
read, but the span carrying the answer was provably or plausibly never served
into context) · **synthesis** (the answering text *was* in context; the
deliverable covers the topic but omits the specific detail) · **depth**
(analysis present but below the criterion's analytical bar) · **judge-strict**
(deliverable arguably satisfies the criterion, or is more accurate than the
rubric).

| Cell | Score | Misses | read-gap | exposure-gap | synthesis | depth | judge-strict | Total tokens | Docs read | Exposure ratio |
|---|---|---|---|---|---|---|---|---|---|---|
| capmkt · e2e | 29/32 | 3 | 0 | 0 | 2 | 1 | 0 | 134,564 | 8/8 | 1.000 |
| capmkt · floor | 28/32 | 4 | 0 | 0 | 2 | 1 | 1 | 70,216 | 8/8 | 1.000 |
| capmkt · index | 29/32 | 3 | 0 | 0 | 0 | 1 | 2 | 320,171 | 8/8 | 1.000 |
| capmkt · index_floor | 29/32 | 3 | 0 | 0 | 1 | 1 | 1 | 125,209 | 8/8 | 0.896 |
| bank · e2e | 56/65 | 9 | 0 | 0 | 4 | 1 | 4 | 275,182 | 3/3 | 1.000 |
| bank · floor | 58/65 | 7 | 0 | 0 | 3 | 1 | 3 | 166,356 | 3/3 | 1.000 |
| bank · index | 54/65 | 11 | 0 | **7** | 3 | 0 | 1 | 188,010 | 3/3 | 0.384 |
| emp · e2e | 48/59 | 11 | 0 | 0 | 6 | 3 | 2 | 274,441 | 5/5 | 1.000 |
| emp · floor | 51/59 | 8 | 0 | 0 | 2 | 4 | 2 | 275,657 | 5/5 | 1.000 |
| DPA · index | 28/58 | 30 | **1** | **20** | 3 | 6 | 0 | 235,052 | 5/6 | 0.187 |
| DPA · index_floor | 41/58 | 17 | **1** | 4 | 4 | 4 | 4 | 182,771 | 5/6 | 0.557 |
| **TOTAL** | | **106** | **2** | **31** | **30** | **23** | **20** | | | |

### Task-hard vs arm-attributable

| Task | Criteria | Arms judged | Missed by ALL arms (task-hard) | Mixed (arm-attributable) |
|---|---|---|---|---|
| capital-markets | 32 | 4 | **1** — C-009 | 5 — C-011, C-013, C-015, C-018, C-028 |
| banking-finance | 65 | 3 | **3** — C-053, C-057, C-058 | 14 |
| employment-labor | 59 | 2 | **4** — C-014, C-028, C-036, C-053 | 11 |
| white-collar (DPA) | 58 | 2 | **13** — C-001…C-005, C-017, C-020, C-021, C-032, C-033, C-045, C-046, C-047 | 21 |

### Verdict on the prior belief

The prior belief was: *whole-read arms' misses are ~all synthesis; the DPA index
cells introduced the first read-gap class.*

**Half confirmed, half refuted.**

- **Confirmed:** every whole-read arm (7 cells at `unique_source_exposure_ratio`
  = 1.000, plus capmkt index_floor at 0.896 — 8 cells) has **zero read-gap and
  zero exposure-gap misses**. Their 48 misses are entirely synthesis (20), depth
  (13) and judge-strict (15). No whole-read arm ever failed a criterion for want
  of text.
- **Refuted, and this is the headline:** the DPA index cells did **not** introduce
  a read-gap class of any consequence. **Exactly 1 of the 30 index misses and 1 of
  the 17 index_floor misses require the unread document.** The new failure class
  the index arms introduced is **exposure-gap** — 20 in DPA index, 7 in bank index,
  4 in DPA index_floor: **31 of the 106 total misses**, and the single largest
  class in the whole study. The unread document is a red herring; the retrieval
  window is the mechanism.

---

## 2. DPA deep-dive (the headline)

### 2.1 How much did the unread CFTC order actually cost? One criterion.

Of the 58 DPA criteria, 5 mention the CFTC at all: C-002, C-016, C-017, C-034,
C-035, C-037. Only **C-017** has a PASS condition whose text exists nowhere but
in `cftc-settlement-order.docx`:

> **C-017** — *PASS if the memo references the CFTC Settlement Order's
> characterization that VMH's cooperation commenced 'following the issuance of
> formal investigative orders,' which contradicts any voluntary self-disclosure
> claim.*

A full-corpus regex for `following the issuance of formal investigative orders`
and for `formal investigative|investigative order` returns hits in
**`cftc-settlement-order.docx` only** (2 and 3 hits respectively; zero in all
five read documents). C-017 is a genuine read-gap in both arms.

Every other CFTC-flavoured criterion is answerable from read documents:

| Criterion | Fact needed | Lives in | Read? | Verdict |
|---|---|---|---|---|
| C-016 cooperation timeline vs VSD | chronology | `negotiation-strategy-memo` | yes | both PASS |
| C-034 CFTC offset tax implications | IRC §162(f) analysis | `negotiation-strategy-memo` @~12,281 | yes | both PASS |
| C-035 restitutionary vs punitive split | `$110M CMP + $75M disgorgement` | `negotiation-strategy-memo` (2×), `govt-counter-markup` (SOF A.6) | yes | index FAIL, floor PASS |
| C-037 offset $92.5M = 50% of $185M | arithmetic | `govt-counter-markup` §5(c) | yes | both PASS |
| C-002 penalty-computation impact | Attachment C reasoning | `govt-counter-markup` §5(a)/(c) | yes | both FAIL |

**So: 1 of 30 (index) and 1 of 17 (index_floor).** Reading the CFTC order
perfectly would have moved DPA index from 28/58 → 29/58 and index_floor from
41/58 → 42/58. The 5/6 coverage number is a real but nearly costless defect.

The relevant CFTC-order passages (for the record — this is the text neither run
ever saw):

> ¶22 · *"Following the Commission's issuance of formal investigative orders and
> subpoenas to Respondents in July 2022, Respondents commenced cooperation with
> the Division of Enforcement's investigation. The Commission acknowledges that
> Respondents' cooperation, **while not constituting voluntary self-reporting to
> the Commission**, was substantial and included the production of over 2.3
> million documents…"*

> ¶54 · *"The Commission notes that Respondents' cooperation, while substantial,
> **commenced following the issuance of formal investigative orders and was not
> initiated voluntarily by Respondents** prior to the Commission's investigation.
> Accordingly, the cooperation credit afforded herein reflects the nature and
> extent of Respondents' post-investigation cooperation, and not the timeliness
> of self-reporting."*

### 2.2 What actually caused the 30 misses: the retrieval window

The two arms differ in tool trajectory, not in document access:

| | DPA index (28/58) | DPA index_floor (41/58) |
|---|---|---|
| tool calls | 30 (23 × `find_in_document`, 6 × `read_document`, 1 × `fetch_documents`) | 12 (10 × `read_document`, 1 × `fetch_documents`) |
| output tokens | 40,562 | 18,410 |
| unique span chars served | 60,093 / 321,068 = **18.7 %** | 178,797 / 321,068 = **55.7 %** |

Per-document exposure (from `evidence_segments`, unioned):

| Document | served body | index exposed | index_floor exposed |
|---|---|---|---|
| `govt-counter-markup.docx` | 91,467 | 25,595 (28.0 %, **11 disjoint blocks**) | 68,000 (74.3 %, `[0, 68000]`) |
| `negotiation-strategy-memo.docx` | 57,655 | 18,161 (31.5 %, 4 blocks) | 56,000 (97.1 %) |
| `original-proposed-dpa.docx` | 65,598 | 5,078 (7.7 %, 5 blocks) | 24,000 (36.6 %) |
| `vmh-initial-markup.docx` | 56,465 | 4,462 (7.9 %, 4 blocks) | 24,000 (42.5 %) |
| `usao-transmittal-email.eml` | 7,049 | 6,797 (96.4 %) | 6,797 (96.4 %) |
| `cftc-settlement-order.docx` | 42,834 | **0** | **0** |

The index arm's `govt-counter-markup.docx` union is:

```
[6246,8646] [11156,14729] [16887,20365] [26878,27700] [32376,33559]
[37888,40146] [40999,42013] [44614,56109]      →  25,595 of 91,467 chars
```

Everything between those blocks is dark. Using the run's own
`find_in_document` hit offsets (`"at"` + `"locator": "chars X-Y"`) as exact
anchors against the extracted document, I mapped each missed provision into the
served plane. The mapping is tight (the anchor ratio is stable at 1.11–1.14 over
the whole back half):

| Provision | ~served offset | Inside an index gap? | Criteria lost |
|---|---|---|---|
| §5(d) Cooperation Credit rejection | ≈15,800 | gap `[14729, 16887]` | C-040 |
| §7(c) Monitor Access | ≈21,555 | gap `[20365, 26878]` | C-005, C-006, C-046, C-056 |
| §9(d) "best efforts" | ≈30,450 | gap `[27700, 32376]` | C-012, C-013, C-014 |
| §12(a) "institutional knowledge" / SOF "aware of and failed to prevent" | ≈35,600–35,900 | gap `[33559, 37888]` | C-008, C-009, C-041 |
| §14(b) public-statement breach | ≈43,370 | gap `[42013, 44614]` | C-010, C-011, C-045 |
| memo: $290M federal contracting revenue | ≈37,088 (strategy memo) | gap in memo exposure | C-025 |
| memo: $110M/$75M tax characterization | ≈13,064 (strategy memo) | gap `[12945, 14000]` | C-035 |
| Attachments A & B (end of doc) | ≈64,300 / ≈78,300 | beyond 56,109 | C-001…C-004 |

**The §7(c) near-miss is the cleanest single illustration of the mechanism.**
The index arm ran `find_in_document(doc-1, "pool of no fewer than three")` and
got Section 7(a) at `chars 17887-19114`; then
`find_in_document(doc-1, "term of this Agreement")` and got Section 7(b) at
`chars 19543-20365`. Its exposure of that region **ends at char 20,365** — a few
hundred characters before Section 7(c) begins. Four criteria (C-005, C-006,
C-046, C-056) turn on 7(c)'s text. The retrieved windows walked right up to the
provision and stopped.

The `find_in_document` result the arm *did* receive:

> `"excerpt":"pool of no fewer than three", "at":18487, "locator":"chars 17887-19114"` —
> *"**Section 7 — Independent Compliance Monitor** / **Section 7(a) — Appointment and
> Selection** [GOVERNMENT MODIFIED] The Office shall appoint an Independent Compliance
> Monitor … The Office shall propose a pool of no fewer than three (3) qualified
> candidates …"*

The judge's rationale for the resulting failure:

> **C-005** — *"The memo addresses monitor access only regarding attorney-client
> privilege protection, noting it was 'confirmed' as a met red line. It never
> identifies Section 7(c)'s overbroad language granting access to 'all
> communications, including internal communications among employees, whether or
> not related to the conduct at issue'…"*

The **C-035 near-miss is 119 characters wide.** The strategy memo's tax section
("The $185 million settlement was structured as two components: $110 million in
civil monetary penalties and $75 million in disgorgement… characterized in the
CFTC Consent Order … as remedial and restitutionary in nature") sits at served
≈13,064. The index arm's `read_document(doc-2, head: 80)` served `[0, 12945]`;
its next read started at 14,000. The paragraph fell in a 1,055-char hole.

### 2.3 The residual index misses that are NOT exposure

Ten of the 30 index misses had their answering text in context:

**Synthesis (3)**

| Criterion | Evidence it was served | Judge |
|---|---|---|
| **C-047** §1349 | Served at `chars 6246-7068` via the `"term of this Agreement"` find, whose context reads: *"[GOVERNMENT COMMENT from Moreau: … The one-count conspiracy charge under **18 U.S.C. § 1349** remains unchanged."]"* | *"The memo references 18 U.S.C. § 3282 (statute of limitations for wire fraud conspiracy) but never identifies the criminal charge as conspiracy to commit wire fraud under 18 U.S.C. § 1349."* — and indeed the deliverable says only *"the natural five-year limitations deadline (under 18 U.S.C. § 3282 for wire fraud conspiracy)"*. The charge number was one line away in the same served window. |
| **C-039** Civil Division reservation | §11 region served inside `[44614, 56109]` | *"identifies the government rejected the civil/administrative bar but only notes it is 'beyond the authority of this Office to grant' … does not identify that the counter-markup added language expressly reserving DOJ Civil Division and other agency rights."* |
| **C-026** transmittal-email comment | `usao-transmittal-email.eml` served 96.4 % | *"mentions that the Compliance Certification form 'will be developed by the Monitor post-appointment' but does not reference the USAO transmittal email's comment that it 'will be in the form prescribed by the Monitor.'"* |

**Depth (6)** — §17 (clawback) and §18 were fully inside the served
`[44614, 56109]` block, and §13/§16 inside `[37888, 42013]`; the arm read them
and under-analysed them: C-019 (fixed-dollar-floor risk), C-020 (180-day
timeline), C-021 (`pursue` vs `recover`), C-022 (needed ≥2 of 5 successor-liability
concerns, produced 1), C-032 (cure period × sole discretion), C-033 (recommend
objective breach criteria).

**Judge-strict: 0** in this cell. Every index miss is a real gap.

### 2.4 index → index_floor: what the extra 13 points bought

17 criteria flipped fail→pass and 4 flipped pass→fail (net +13):

**Gained by index_floor (17):** C-006, C-008, C-009, C-010, C-011, C-012, C-013,
C-014, C-019, C-022, C-025, C-026, C-035, C-039, C-040, C-041, C-056.

**Every single one of those 17 lives inside `govt-counter-markup.docx [0, 68000]`
or inside `negotiation-strategy-memo.docx [0, 56000]`** — i.e. exactly the text
index_floor read contiguously and index sampled with keyword windows. There is
no criterion in the gain set whose answer lies outside what the floor arm read
whole.

**Lost by index_floor (4):** C-024, C-028, C-031, C-054.

- **C-028 / C-031 (payment tranche arithmetic)** — a real regression, and *not*
  an exposure issue. Both arms served `usao-transmittal-email.eml` at 96.4 %,
  and the email states at char ≈2,502: *"The revised payment schedule calls for
  70% of the total penalty (**$274.75 million**) within 15 days of execution and
  the remaining 30% (**$117.75 million**) within 9 months."* The index deliverable
  quotes both gross figures — *"the net first installment is $210,000,000
  ($274.75M gross less $64.75M …), and the net second installment is $90,000,000
  ($117.75M gross less $27.75M)"* — and passes. The floor deliverable reports only
  *"Installment 1: Net $210,000,000 … Installment 2: Net $90,000,000"* and fails
  both. The floor arm re-derived numbers that were sitting verbatim in context.
- **C-054** — the floor memo cites *"negotiation strategy memorandum"* repeatedly
  and even reproduces Thornfield & Beckett letterhead, but the judge required the
  *"March 10, 2025 … Thornfield & Beckett internal strategy memo"* identification.
  Judge-strict.
- **C-024 / C-045 / C-046** — the floor deliverable *does* cover the substance
  (Compliance Certification form uncertainty; Section 14(b) at "Priority 9 —
  Public Statement Carve-Out"; "Priority 6 — Monitor Access Scope") but is
  penalised for framing/priority-rank. Judge-strict.

### 2.5 Is the completeness-floor clause what saved those 13?

**No — the mechanism is read discipline, not the checklist clause.** The evidence:

1. The floor arm's gains are perfectly co-extensive with its extra *exposure*
   (all 17 gained criteria fall inside the contiguous blocks it read and index
   didn't). If the "issues, parties, dates, numbers, exceptions, conflicts"
   clause were doing independent work, we would expect gains on criteria whose
   text both arms had. There are none.
2. Where both arms had the text and only reasoning differed, the floor arm did
   **worse**: C-028/C-031 are precisely a "numbers" check, and the floor arm is
   the one that got the numbers wrong.
3. The floor arm's trajectory changed in a way the clause does not obviously
   predict: 12 tool calls, 10 of them plain `read_document`, **zero
   `find_in_document`**. It abandoned retrieval entirely and paged the documents.
   That is what raised exposure 0.187 → 0.557.
4. The floor arm still stopped short. It read `doc-1 [48000, 68000]` and then
   quit, leaving `[68000, 91467]` (26 % of the counter-markup, containing all of
   Attachment B and the end of the document) unread — which is exactly why
   C-001…C-004 failed in *both* arms. `govt-counter-markup.docx` ends with
   Attachment B; there is no Attachment C in it. Neither arm ever reached the end
   to observe that absence, even though both had the transmittal email's
   *"Please find attached the revised DPA with **Attachments A, B, and C**"* at
   char 699 and the §5(a) comment *"See Attachment C for methodology"* in context.

So the honest reading of the 13-point delta is: **the floor variant made the model
page documents instead of grep them, and paging is worth ~13 criteria on this
task.** The checklist wording may be the proximate trigger for that behaviour
change, but the causal chain runs through exposure, not through a
self-check pass.

---

## 3. Floor mechanism check — employment (48/59 → 51/59)

Both arms read 5/5 documents at exposure 1.000 and cost effectively the same
(274,441 vs 275,657 total tokens; a 0.4 % difference). So every flip is a pure
authoring/attention effect with identical inputs. **11 of 59 criteria flipped —
18.6 % churn for a net +3.**

### Gained by floor (7)

| Criterion | e2e deliverable | floor deliverable | Real content gain? |
|---|---|---|---|
| **C-020** cure period 30→45 days | zero occurrences of "45 days"/"45-day" | *"Cure period extended from 30 to 45 days."* stated as a redline change | **Yes** |
| **C-048** relocation 50→25 miles | zero occurrences of "25 miles"/"50 miles" | *"Relocation threshold reduced from 50 miles to 25 miles."* | **Yes** |
| **C-044** DGCL §145(e) | zero occurrences of "145(e)" | *"This is inconsistent with DGCL §145(e) best practices…"* | **Yes** |
| **C-058** Good Reason × signing-bonus clawback interaction | discusses both separately | *"Under the Redline's expansive Good Reason definition, the clawback is further eroded — the Executive could engineer a Good Reason event and retain the full $500,000 while collecting severance."* | **Yes** |
| **C-004** bonus dollar impact | zero occurrences of "468,750" | financial-impact table: `Year 1 Target Bonus \| $468,750 (75%) \| $700,000 (100%) \| +$231,250` | **Yes** |
| **C-052** total-cash ceiling | zero occurrences of "$1.2M"/"110%" | comparison table incl. `Sponsor Counter (suggested) \| $650,000–$675,000 \| 80% \| $520,000–$540,000 \| $1,170,000–$1,215,000` | Partly — the ceiling is implied by a table, not stated |
| **C-013** non-CIC severance 12→24 months | *"2.0x Base Salary … vs 12 months Base Salary"* — judged as "a multiple, not a duration" | *"Non-CIC Severance: 2.0x/2.0x/24 Months vs. 1.0x/Pro-Rated/12 Months"* | Marginal — both say 2.0x; the heading format flipped the judge |

### Lost by floor (4)

| Criterion | e2e deliverable | floor deliverable |
|---|---|---|
| **C-006** bonus metric-setting → mutual agreement | *"metrics 'mutually agreed' with prior-year metrics as a default if no agreement by **March 31**"* | zero occurrences of "March 31" |
| **C-040** California governing-law implications | *"mandatory expense reimbursement (**Labor Code §2802**), strong wage payment protections … The Delaware internal affairs doctrine governs…"* | zero occurrences of "Labor Code"/"2802"/"unfair competition" |
| **C-035** 280G gross-up market practice | *"Gross-ups have been effectively eliminated from **market practice since Say-on-Pay adoption in 2012**."* | zero occurrences of "market practice"/"Say-on-Pay"/"ISS"/"Glass Lewis" |
| **C-051** Sponsor email equity guidance | neither memo contains the phrase *"double trigger, standard vesting, no put rights"*; e2e passed anyway | same absence, judged a fail |

### Verdict

**Predominantly a real completeness effect, but a redistribution rather than an
addition — and with one leg standing on judge noise.**

- 5 of 7 gains (C-004, C-020, C-044, C-048, C-058) are hard, mechanically
  checkable specifics that are **verbatim absent** from the e2e deliverable and
  **verbatim present** in the floor's. That is not noise.
- But the floor did not simply add. It **traded**: it dropped three equally hard
  specifics (March 31 fallback, Labor Code §2802, the Say-on-Pay/market-practice
  argument) that the e2e memo had. The two deliverables are nearly identical in
  size (37,225 vs 38,287 chars) — the floor bought its mechanical-delta sweep with
  the e2e's discursive legal-context commentary.
- C-051 is unambiguous judge noise: neither memo contains the criterion's phrase;
  one passed and one failed on the same absence.
- The observable behavioural signature is structural, not checklist-like: e2e
  organises as "Tier 1/2/3 → Issue 1…N"; floor organises as "Priority One…N +
  Financial Impact and Section 280G Assessment" with quantified comparison
  tables. The tables are what earn C-004 and C-052.

**Bottom line: the +3 is real but small relative to the ±11 churn it sits inside.
Treat the employment floor gain as directionally real (mechanical-delta recall
improves) but statistically weak at n=1.** The stronger and safer claim from
this cell is not "floor > e2e"; it is "floor changes *what kind* of thing gets
captured — line-item deltas and quantified impact up, doctrinal context down."

---

## 4. Banking index cell (54/65)

**Is index's 11 a superset of e2e's 9? No.**

- index ∩ e2e = **4** (C-053, C-057, C-058, C-065)
- index \ e2e = **7 new** (C-004, C-005, C-006, C-011, C-012, C-042, C-048)
- e2e \ index = **5 fixed** (C-023, C-026, C-037, C-049, C-064)

So index is not strictly worse — it repaired 5 of e2e's misses and introduced 7
new ones, netting −2.

**All 7 extra misses are exposure-gap.** The index arm read `credit-agreement.docx`
at only 38,066 / 145,997 chars (26.1 %), across 10 blocks:

```
[3908,4924] [6368,7584] [8246,9865] [18517,19733] [28109,30109]
[40759,41959] [65005,70005] [75455,88455] [88454,97454] [107050,109850]
```

Calibrating with the run's own read anchors (`Section 1.06` @28,109;
`Section 2.08` @40,759; `Section 6.01` @65,005; `ARTICLE VII` @75,455;
`Section 7.11` @88,454; `Section 10.01` @107,050 — anchor ratio a stable 1.03):

| Criterion | Answer text | ~served offset | Index gap |
|---|---|---|---|
| C-004 | *"Total Net Leverage Ratio" means … (provided that the amount of Unrestricted Cash and Cash Equivalents netted pursuant to this clause (a) **shall not exceed $15,000,000**)* | ≈23,208 | `[19733, 28109]` |
| C-005 | *"Senior Secured Net Leverage Ratio" means … (**shall not exceed $10,000,000**)* | ≈21,155 | `[19733, 28109]` |
| C-006 | cascades from C-004/C-005 | — | — |
| C-042 | *"Fixed Charge Coverage Ratio" means, as of any date of determination, the ratio of (a) Consolidated EBITDA…* | ≈12,958 | `[9865, 18517]` |
| C-011, C-012 | §2.05(b)(i): *"…reinvests (or commits to reinvest) such Net Cash Proceeds … within **one hundred eighty (180) days** following receipt thereof."* | ≈36,975 | `[30109, 40759]` |
| C-048 | §2.05(b) 100 % mandatory prepayment of Net Cash Proceeds | ≈35,318–38,958 | `[30109, 40759]` |

The C-011 failure mode is the one worth flagging to the experiment: the arm did
not merely omit the conflict, it **asserted its absence**. Judge:

> *"The memo explicitly states there is **NO inconsistency** between Section
> 7.05's 365-day reinvestment period and Section 2.05(b), calling them
> 'consistent.' It never identifies a 180-day period in Section 2.05(b) or flags
> any conflict."*

It had read §7.05 (inside `[75455, 88455]`) but never §2.05(b), and then made a
confident negative claim about the relationship between the two. **A retrieval
window that covers one side of a cross-reference produces false negatives, not
just silence.** That is a strictly worse failure mode than an omission and is
directly attributable to the index/find trajectory.

The remaining 4 index misses are shared with the whole-read arms and are not
harness-attributable:

- **C-057 / C-058 (payment-default grace periods)** — task-hard synthesis. §8.01
  sits at ≈92,715 and **was** inside the index arm's `[88454, 97454]` read, and
  all three arms read it. All three omitted *"(b) Payment Default — Interest/Fees.
  The Borrower shall fail to pay any interest … within **five (5) Business Days**
  after the date when the same shall become due"* and the absence of any grace in
  clause (a).
- **C-053 (Total Funded Debt)** — judge-strict, all three arms. All three report
  $257,950,000 (TLA $218.75M + Revolver $35M + capital leases $4.2M); the rubric
  demands $253,750,000 (TLA + Revolver only). The agreement's own *"Funded Debt"*
  definition covers *"all Indebtedness … that matures more than one year from the
  date of its creation"*, which does not exclude capital leases. **The
  deliverables are arguably more defensible than the criterion.**
- **C-065 (Revolver maturity)** — synthesis; the memo says "March 15, 2027" once
  and the judge attributes it to the Term Loan A.

### A rubric defect worth escalating: C-049

All three banking arms fail C-049 for saying the equity-cure contribution is due
*"10 Business Days after the date the applicable Compliance Certificate is
required to be delivered"*. The credit agreement says, verbatim:

> *"(C) The applicable equity contribution must be received by the Borrower within
> ten (10) Business Days after the date on which the applicable Compliance
> Certificate **is required to be delivered** under Section 6.02(a)"*

The criterion demands *"after delivery of the applicable Compliance Certificate"*.
**The rubric is wrong and the deliverables are right.** This is a −1 on every
banking arm and should be excluded from any arm comparison, not just noted.

### Cost note

The banking index cell cost 188,010 tokens for 54/65. The floor cell cost
166,356 for 58/65 — cheaper *and* better. Index's economy story does not hold on
this task.

---

## 5. Capital-markets (all four arms, 28–29/32)

This task is nearly saturated and its residual misses are almost entirely
**severity-label calibration**, not content:

- **C-009** (tax opinion omits guarantor-payment tax treatment) is missed by
  **all four arms** — the only capmkt task-hard criterion. It is a negative-evidence
  audit ("what is *not* in the opinion") and no arm performs it. Depth.
  (Note: index_floor served only 8,000/16,550 chars of `tax-opinion.docx` — 48.3 %
  — so for that cell the miss is over-determined; but the three arms at 100 %
  exposure miss it too, so the primary class is depth.)
- **C-011 / C-018** (Base Indenture executed March 13 vs March 14): the two
  **whole-read** arms never found the discrepancy at all; both **index** arms did.
  This is the one place in the study where the index shape helped — a targeted
  date cross-check.
- **C-013, C-015, C-018** are all "the finding is present but tiered wrong":
  CUSIP graded Significant where Critical was required (index); stale PES
  certificate graded **Critical** where **Significant** was required (floor,
  index_floor) — note the rubric fails an *over*-severe grading; indenture date
  graded Significant where Administrative was required (index). Judge-strict /
  rubric-calibration, and it is nearly the whole capmkt signal.
- **C-028** (index_floor): no concluding completeness assessment. Synthesis
  (a structural element, omitted).

Cost is the interesting capmkt signal: **the index arm burned 320,171 tokens for
the same 29/32 the e2e arm reached at 134,564 and the index_floor arm at
125,209.** capmkt index is the most expensive cell in the study by 45,000 tokens
and buys nothing.

---

## 6. Cross-cutting observations

1. **Exposure ratio, not documents-read, is the predictor.** Across the 11 cells,
   every cell at exposure ≥ 0.896 has 0 exposure-gap misses; the three cells at or
   below 0.557 account for **all 31** exposure-gap misses (bank index 7, DPA index
   20, DPA index_floor 4). `documents_read` is a misleading coverage metric: DPA
   index scored `documents_read: 5` while serving 18.7 % of the corpus.
2. **`find_in_document` produces adjacency failures.** Twice in the DPA run the
   served window stopped within a few hundred characters of the answering text
   (§7(c) at +~1,200 past a window ending at 20,365; the tax-split paragraph 119
   chars past a window ending at 12,945). Keyword-centred windows land *near*
   provisions and truncate them.
3. **Partial coverage manufactures confident false negatives.** bank C-011
   ("No inconsistency identified") and DPA C-001 (treating Attachment C as
   "present and operative") are both cases where the arm read one side of a
   relationship and asserted the other side's state. Negative-evidence criteria
   (missing attachment, undefined term, absent analysis) require full-document
   coverage and are systematically unreachable under sampling.
4. **20 of 106 misses are judge-strict**, and two of them (bank C-049, bank C-053)
   are cases where the deliverable is demonstrably more faithful to the source
   than the rubric. At 19 % of all misses, judge-strictness is a bigger term than
   read-gap by an order of magnitude and needs to be netted out before any arm
   ranking.
5. **The whole-read arms have a clean failure profile.** 48 misses across 8
   cells, zero attributable to text availability. Their ceiling is set by
   authoring completeness and by the rubric, not by the harness.

---

## Appendix A — DPA missed criteria → source document map

`R` = document was read by that arm. Exposure column states whether the
answering span was served.

### A.1 DPA index (28/58) — 30 misses

| # | Criterion | Answer lives in | Read | Span served | Class |
|---|---|---|---|---|---|
| C-001 | Attachment C referenced in §5(a) but absent | `govt-counter-markup` §5(a) + **doc tail** (ends with Attachment B, ≈78,300–91,467) | R | ref yes; tail **no** (exposure ends 56,109) | exposure-gap |
| C-002 | Substantive impact of missing Attachment C | same | R | no | exposure-gap |
| C-003 | Transmittal email refs A, B and C | `usao-transmittal-email.eml` @699 + doc tail | R | email yes, tail no | exposure-gap |
| C-004 | Recommend clarification before execution | same | R | no | exposure-gap |
| C-005 | §7(c) overbroad monitor access | `govt-counter-markup` ≈21,555 | R | **no** — gap `[20365,26878]` | exposure-gap |
| C-006 | Roving-monitor risks | same | R | no | exposure-gap |
| C-008 | §12(a) "institutional knowledge" | `govt-counter-markup` ≈35,900 | R | **no** — gap `[33559,37888]` | exposure-gap |
| C-009 | Liability implications of that term | same | R | no | exposure-gap |
| C-010 | §14(b) public-statement breach trigger | `govt-counter-markup` ≈43,370 | R | **no** — gap `[42013,44614]` | exposure-gap |
| C-011 | Conflict with parallel litigation defence | same | R | no | exposure-gap |
| C-012 | §9(d) "best efforts" | `govt-counter-markup` ≈30,450 | R | **no** — gap `[27700,32376]` | exposure-gap |
| C-013 | Impossibility for former employees | same (+ strategy memo) | R | no | exposure-gap |
| C-014 | Alternative standard / safe harbour | same | R | no | exposure-gap |
| **C-017** | **CFTC Order cooperation characterisation** | **`cftc-settlement-order.docx` ¶22, ¶54 — ONLY** | **NOT READ** | n/a | **read-gap** |
| C-019 | Clawback fixed-dollar-floor risk | `govt-counter-markup` §17 ≈48,319 | R | **yes** (`[44614,56109]`) | depth |
| C-020 | 180-day timeline concern | same | R | yes | depth |
| C-021 | "pursue" vs "recover" ambiguity | same | R | yes | depth |
| C-022 | §18 successor liability, ≥2 concerns | `govt-counter-markup` ≈51,268 | R | yes | depth |
| C-025 | ~$290M federal contracting revenue | `negotiation-strategy-memo` ≈37,088 | R | **no** | exposure-gap |
| C-026 | Transmittal email on Compliance Certification | `usao-transmittal-email.eml` | R | yes (96.4 %) | synthesis |
| C-032 | Cure period × sole discretion | `govt-counter-markup` §13 ≈38,388 | R | yes | depth |
| C-033 | Recommend objective breach criteria | same | R | yes | depth |
| C-035 | $110M CMP vs $75M disgorgement, tax split | `negotiation-strategy-memo` ≈13,064 | R | **no** — gap `[12945,14000]` | exposure-gap |
| C-039 | DOJ Civil Division reservation | `govt-counter-markup` ≈45,586 | R | yes | synthesis |
| C-040 | §5(d) standalone cooperation credit rejected | `govt-counter-markup` ≈15,800 | R | **no** — gap `[14729,16887]` | exposure-gap |
| C-041 | SOF "directed" → "aware of and failed to prevent" | `govt-counter-markup` ≈35,600 | R | **no** | exposure-gap |
| C-045 | §14(b) ranked high priority | cascades from C-010 | R | no | exposure-gap |
| C-046 | §7(c) ranked high priority | cascades from C-005 | R | no | exposure-gap |
| C-047 | 18 U.S.C. § 1349 | `govt-counter-markup` `chars 6246-7068` (also in 3 other read docs) | R | **yes** | synthesis |
| C-056 | Monitor access "reasonably related" business units | `govt-counter-markup` §7(c) region ≈21,550 | R | **no** | exposure-gap |

**Read-gap total: 1 of 30.**

### A.2 DPA index_floor (41/58) — 17 misses

| # | Criterion | Answer lives in | Span served | Class |
|---|---|---|---|---|
| C-001–C-004 | Attachment C absence | `govt-counter-markup` tail ≈78,300–91,467 | **no** — arm read `[0, 68000]` only | exposure-gap ×4 |
| C-005 | §7(c) overbroad access | ≈21,555 | **yes** | synthesis |
| **C-017** | **CFTC cooperation characterisation** | **`cftc-settlement-order.docx` only** | **document not read** | **read-gap** |
| C-020, C-021 | clawback timeline / verb ambiguity | §17, served | yes | depth ×2 |
| C-024 | "Compliance Certification" undefined | §19, served | yes | judge-strict |
| C-028, C-031 | $274.75M / $117.75M tranches | `usao-transmittal-email.eml` @2,502 | **yes (96.4 %)** | synthesis ×2 |
| C-032, C-033 | cure × sole discretion; objective criteria | §13, served | yes | depth ×2 |
| C-045, C-046 | §14(b) / §7(c) priority ranking | served; ranked Priority 9 and 6 of 10 | yes | judge-strict ×2 |
| C-047 | 18 U.S.C. § 1349 | served at ≈6,646 | yes | synthesis |
| C-054 | Strategy memo dated March 10, 2025 | `negotiation-strategy-memo` @410 / @1,163 | **yes (97.1 %)** | judge-strict |

**Read-gap total: 1 of 17.**

### A.3 Key quotes from the never-read document

`cftc-settlement-order.docx` (42,834 served chars, 0 exposed in both arms).
Beyond ¶22 and ¶54 quoted in §2.1, the document also contains the component
breakdown that C-035 asks about — but that same breakdown is duplicated in two
**read** documents, which is why C-035 is classed exposure-gap and not read-gap:

> ¶38–39 · *"Respondents shall jointly and severally pay disgorgement in the
> amount of Seventy-Five Million Dollars ($75,000,000) … The disgorgement ordered
> herein is **remedial and restitutionary in nature**…"*
> ¶43 + table · `Civil Monetary Penalty | Punitive / Deterrent | $110,000,000` ·
> `Disgorgement | Remedial / Restitutionary | $75,000,000` · `Total | | $185,000,000`

Duplicated in `negotiation-strategy-memo.docx` (read, 97.1 % exposed by
index_floor): *"The $185 million settlement was structured as two components:
$110 million in civil monetary penalties and $75 million in disgorgement … the
$75 million disgorgement component was characterized in the CFTC Consent Order
(dated September 8, 2023) as remedial and restitutionary in nature."* — and in
`govt-counter-markup.docx` SOF ¶A.6: *"…for a total of $185,000,000, comprising a
civil monetary penalty of $110,000,000 and disgorgement of $75,000,000."*

---

## Appendix B — provenance of every figure

- Scores / verdicts / judge rationales: `<run>/scores.json` (`criteria_results[].verdict`,
  `.reasoning`), cross-checked against `<run>/report.html`.
- Exposure spans: `<run>/beaver-receipts.json` → `tool_results[].evidence_segments`
  (`start`, `end`, `filename`), unioned per document; denominators from
  `source_receipts[].served_body_chars`. Recomputed totals reproduce
  `metrics.json.unique_source_exposure_ratio` to 4 decimal places in all 11 cells.
- Tool trajectories: `beaver-receipts.json.tool_calls[].input`, cross-checked
  against `raw-sse.txt` `tool_call_start` events.
- Served-plane offsets: calibrated from the runs' own `find_in_document` hit
  offsets (`"at"`, `"locator": "chars X-Y"`) and `read_document` offsets against
  `python-docx` extractions of the task `documents/`. Anchor ratios are reported
  inline; where a mapping is within ~±1 % of a window boundary it is called out
  as such rather than asserted.
- Deliverables: `<run>/output/*.docx`, extracted with `python-docx` (paragraphs +
  table cells).
- Task criteria text: `benchmarks/harvey-labs/tasks/<task>/task.json`
  → `criteria[].match_criteria`.
