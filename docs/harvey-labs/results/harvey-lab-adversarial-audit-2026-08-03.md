# Harvey LAB landed batch — adversarial audit

2026-08-03 · Pure adversarial review — no praise, no hedging. Every finding
names a concrete defect with a concrete failure scenario.

## CRITICAL

### C1 — Repair-prompt detail strings omit source document names

**Files:** `backend/src/lib/chat/slaWorkflow.ts:548-550,563-565,592-593`,
`backend/src/lib/legalDerivedValueScan.ts:211-213`,
`backend/src/lib/legalDeadlineOmissionScan.ts` (detail construction),
`backend/src/lib/legalUndefinedTermScan.ts:531`

**Defect:** Every organ's `detail` string goes verbatim into the repair prompt,
but NONE names the source document. The model sees:

> 87,300,000 revenue × 25.3% = 22,116,000 — the deliverable states 25.3% of
> revenue but never the amount

and must Grep the entire source stack to verify it. A lawyer reading this
would ask "which document? which paragraph?" — the finding is not self-contained.

**Scenario:** 11-source indenture task. H1 fires on a percent-without-amount
finding. The repair prompt doesn't say WHICH of the 11 sources the identity is
in. The model spends a full Grep→Read hop (thousands of tokens) re-discovering
what the organ already computed.

**Fix:** Append the source document name to each detail string: `…but never the
amount ($22.1M in overview-memo.docx)`.

### C2 — H1 only closes identities within a single source document

**File:** `backend/src/lib/legalDerivedValueScan.ts:268-275`

**Defect:** The whole amount must be in the SAME source as the
part+percent. `whole` is found by scanning `money` anchors in the same
`source.text` and checking if the label contains `base`. But a real legal
workflow commonly splits this: the deal memo says "$22.1M = 25.3% of total
revenue" and a separate financial exhibit says "total revenue = $87.3M." The
organ stays silent because `$87.3M` isn't in the same source text.

**Scenario:** Due-diligence task with 18 sources. The term sheet states the
purchase price as "15% of enterprise value" and the valuation report states
"enterprise value = $420M." H1 finds no identity because the two numbers are in
different documents — the draft states "15% of enterprise value" without the
$63M amount, and the organ never flags it.

**Fix:** Build a cross-document `whole` index: after the single-document pass,
for identities where `part` and `percent` close but `whole` is absent, scan
OTHER sources for a money anchor whose surrounding text includes the `base`
noun and whose value satisfies `part / whole ≈ percent`.

### C3 — H3's caption detector has a false-negative on numbered/abbreviated captions

**File:** `backend/src/lib/legalUndefinedTermScan.ts:290-307`

**Defect:** `isHeadingLine` classifies a line as a caption only when every word
either starts with an uppercase letter or is a `CAPTION_CONNECTORS` word. A
caption like "2026 Tax Year." starts with a digit (passes the `startsWith
lowercase` check vacuously) but the word "Tax" starts with uppercase and "Year"
starts with uppercase — the period doesn't matter since we split on
whitespace. Wait — actually the defect is subtler. The line "2026 Tax Year."
splits to `["2026", "Tax", "Year."]` — "2026" starts with a digit (not
lowercase), "Tax" is uppercase, "Year." starts with uppercase. This line IS
classified as a caption. That's correct.

The real defect: a line like "in the United States Bankruptcy Court for the
District of Delaware" is ALL lowercase function words — it would NOT be
classified as a caption (every word starts lowercase and "in"/"the"/"for" are
connectors but "Bankruptcy", "Court", "District", "Delaware" also start with
uppercase caps and would prevent the caption classification... wait no, the
check is: "if a word starts with lowercase AND is not a connector → NOT a
caption." "Bankruptcy" starts uppercase, so it doesn't trigger the rejection.
This line has NO lowercase-starting non-connector words. So it IS classified as
a caption. That's actually correct.

Let me re-examine. The defect is about words that START with a digit: "3rd
Amendment" → "3rd" starts with a digit, not a lowercase letter, so it doesn't
trigger the prose rejection. This is treated as a caption. Is that correct? A
caption like "3rd Amendment to Credit Agreement" — yes, that's a caption, and
it's correctly classified. A prose line that happens to start with a number:
"2026 deliveries shall be made" — "2026" starts with a digit, "deliveries"
starts lowercase and isn't a connector → NOT a caption → correctly classified
as prose.

OK, the caption detector actually holds up better than I expected. Let me
rethink this finding...

The real caption-detector gap is: **abbreviated names in captions are rejected
as prose**. A caption like "Re: Asset Sale and Leaseback Transactions" → "Re:"
starts with "R" (uppercase), fine. But "In re Smith Corp." → "In" is a
connector, "re" starts lowercase and is NOT in the connector set → the line is
rejected as a caption and treated as prose. Now the phrase "Smith Corp." in the
caption becomes an undefined-term candidate. The fix is adding "re", "vs",
"ex" to CAPTION_CONNECTORS.

**Scenario:** A draft restates the caption "In re Smith Corp. Bankruptcy
Proceedings" as a section title. "Smith Corp." is fired as an undefined term
because the caption wasn't recognized as a caption (the word "re" is not in
CAPTION_CONNECTORS).

**Fix:** Add `"re", "vs", "ex", "per", "sub", "non"` to `CAPTION_CONNECTORS`.

## HIGH

### H1 — Tier 0's "drafting share" metric conflates ingestion and drafting in single-shot arms

**File:** `backend/scripts/drafting-efficiency-tier0.ts:14-20,282-291`

**Defect:** The drafting boundary is "first round whose tool-call batch contains
an authoring call." In `upstream_terminal_v1`, the single `generate_docx` call
is in round 1 — so the ENTIRE run is "drafting," including the 1 MB
fetch_documents result. The report section §1 acknowledges this but still
presents the aggregate table ranking arms by "drafting cache-adj in" without a
prominent caveat that the upstream arm's number is not comparable.

**Scenario:** A reader skims the aggregate table, sees upstream_terminal_v1 at
121,694 "drafting" tokens vs grounded_structure_v1 at 105,554, and concludes
upstream is 15% less efficient. In reality the numbers measure different things:
grounded_structure did research then drafted; upstream did everything in one
call.

**Fix:** The aggregate table should split runs by trajectory shape (single-shot
vs multi-turn) rather than reporting them as comparable rows. Or add a
"trajectory shape" column that makes the conflation visible.

### H2 — The replay runner only works for checkpoint_paged_v1 arms

**File:** `backend/scripts/drafting-efficiency-replay.ts`,
`docs/harvey-labs/design/harvey-lab-replay-runner-design-2026-08-03.md`

**Defect:** Every grounded-cache arm (`grounded_structure_v1`,
`mike_structure_paths_v1`, `upstream_terminal_v1`) has
`draft_handoff_mode: none`. No checkpoint is emitted. The replay runner cannot
fork ANY of the 44 sliceable Tier 0 runs. The only fork-seedable runs are the
separate `checkpoint_paged_v1` batch — a different set of tasks, a different
model configuration.

**Scenario:** Someone reads O5 ("first test: drafting-efficiency
sub-benchmark") and tries to run the replay against the grounded-cache runs
Tier 0 sliced. It fails silently or produces an empty fork matrix. The Tier 1
A/B requires NEW runs with `draft_handoff_mode: paged` on the SAME tasks the
grounded-cache batch covers — doubling the run cost.

**Fix:** The replay-runner design note should explicitly enumerate which tasks
are fork-ready today and which need new checkpoint_paged_v1 runs. The O5 doc
should reflect this constraint.

### H3 — Outline injection constants are calibrated on one task

**File:** `backend/src/lib/chat/labOutlineInjection.ts:28-40`

**Defect:** Every constant (`PER_DOC_MAX_CHARS=2000`, `TOTAL_MAX_CHARS=6000`,
`TOP_K=8`, `BODY_MAX_CHARS=1200`, `MAX_DEFINED_TERMS=8`,
`MAX_UNRESOLVED_TARGETS=6`) was set from a single indenture dry-run (3580
chars total, per the summary). An antitrust HSR task with a 200-page merger
agreement has a fundamentally different outline shape than a 30-page indenture.
A tax transfer-pricing task may have zero numbered sections. The constants are
not per-task-kind adaptive.

**Scenario:** A 200-page merger agreement produces a 2000-char outline that
hits the per-doc cap and truncates mid-section, dropping the very provisions
the model needs to see. The model drafts from a partial outline and misses
structural context. The arm looks worse than the no-outline arm, and the
conclusion "outlines don't help" is a calibration failure, not a signal.

**Fix:** Make the per-doc cap proportional to document length (e.g. min(2000,
document_chars / 50)) rather than a flat 2000. Or measure the outline-size
distribution across all task families before locking constants.

### H4 — The `[repeated X; use library_find]` rewrite is a string match on another module's output format

**File:** `backend/src/lib/chat/labOutlineInjection.ts:92`

**Defect:** The line `.replace(/\[repeated ([^\]]+); use library_find\]/gu,
"[repeated $1]")` assumes `renderAgreementOutline` emits EXACTLY the string `;
use library_find`. If `legalTextSkeleton.ts` changes its repetition format —
adds a tool name, changes the semicolon to a dash, adds more detail — this
regex silently stops matching. The LAB surface leaks a tool reference into the
model's context, and the model may attempt to call a tool that doesn't exist.

**Scenario:** Someone refactors `renderAgreementOutline` to emit `[repeated
Schedule 3.04 — use library_find]` with an em-dash. The regex no longer
matches. The model sees `[repeated Schedule 3.04 — use library_find]` and may
hallucinate a `library_find` tool call that fails.

**Fix:** `renderAgreementOutline` should accept a `toolLabel?: string` option
and omit the tool reference when it's empty, rather than relying on the caller
to regex-strip it.

### H5 — H1's part-amount pairing is nearest-neighbor without structural awareness

**File:** `backend/src/lib/legalDerivedValueScan.ts:255-265`

**Defect:** The part amount is "nearest money to the percent." In a dense
table cell with three dollar amounts at indices 100, 150, and 380 and a percent
at index 340, the nearest money is at 380 (gap = 40) but the semantically
correct part is at 100 (the revenue, not the adjacent fee). Nearest-neighbor is
a proximity heuristic, not a structural pairing.

**Scenario:** Financial table: "Revenue: $87.3M. Cost: $62.1M. Profit: $25.2M
(28.9% of revenue, 40.6% of cost)." The percent "28.9%" at index X has
"$25.2M" 20 chars before it and "$62.1M" 60 chars before it and "$87.3M" 110
chars before it. Nearest-neighbor picks $25.2M. The identity is $25.2M / $87.3M
= 28.9% — the part IS $25.2M (correct), but the WHOLE must be $87.3M (labeled
"revenue"). If $87.3M is 110 chars away vs $62.1M at 60 chars, and $62.1M
happens to also be near a "cost" label, the whole-search might bind the wrong
pair: $25.2M / $62.1M = 40.6%, not 28.9%. The PCT_TOL check would then reject
this (28.9% ≠ 40.6%), so the identity is correctly NOT found. But it's also NOT
found for the correct pairing ($87.3M might be out of PART_REACH). The organ
stays silent on a real identity.

**Fix:** None needed if the PART_REACH is wide enough in practice (measured at
220 chars — that covers most table rows). But add a note that proximity-to-
percent is a heuristic whose failure mode is silence (miss), not noise
(false positive), consistent with strictness bias.

### H6 — The SLA repair prompt has no severity ordering

**File:** `backend/src/lib/chat/slaWorkflow.ts:607-630`

**Defect:** O2(c) proposed "determinable severity order (arithmetic > resolved
dates > defined terms > structural scaffold)" but it was never implemented. The
repair prompt concatenates findings in a fixed order (conflict → temporal →
drift → derived → deadline → undefined → lint) regardless of severity. An
arithmetic error ($1M ≠ $1.2M) gets the same visual weight as an undefined
term.

**Scenario:** 4 organs fire: conflict (arithmetic error), derived (missing
amount), deadline (unresolved date), undefined (coined term). The model's
one-pass repair spends tokens fixing the undefined term (least impactful) and
misses the arithmetic error (most impactful) because the prompt buried it at
the bottom.

**Fix:** Prefix severity in each finding line: `[arithmetic]`, `[omission]`,
`[definition]`. Or sort findings within the prompt so arithmetic conflicts
always come first.

### H7 — No feedback loop: the repair pass result is never re-audited

**File:** `backend/src/lib/chat/slaWorkflow.ts` (the repair prompt is
emitted, the model responds, and that's it)

**Defect:** After the model's repair pass, the SLA workflow does not re-run the
deterministic organs against the revised draft. If the model's fix introduced a
NEW defect (e.g. fixed the amount but broke the percent), the second audit never
happens. This is one repair pass, not an audit→repair→audit loop.

**Scenario:** H1 fires: "the deliverable states 25.3% but never the amount."
The model adds "$22.1 million" but also changes "25.3%" to "25%" (rounding).
The repair "succeeds" — the amount is now present — but a new conflict
(22.1/87.3 ≠ 25%) is silently committed.

**Fix:** Run `auditSlaDraft` again after the repair turn. If new findings
appear, log them in the receipt (don't trigger another repair — one pass only,
but report the drift).

## MEDIUM

### M1 — H3 never fires on single-word defined terms

**File:** `backend/src/lib/legalUndefinedTermScan.ts:94-95`

**Defect:** `PHRASE_RE` requires two or more Title-Case words. "Borrower",
"Notes", "Issuer", "Indenture" — all legitimate defined terms — are never
candidates. If a draft uses "Obligor" (undefined, not a party name) as a term,
H3 stays silent. The strictness rationale is sound (single-word false positives
would dominate), but the class of single-word undefined terms is a real gap.

**Scenario:** A draft says "the Obligor must maintain the ratio." No source
defines "Obligor." It's a single word, so H3 ignores it. A reader doesn't know
who the Obligor is.

**Fix:** Document this as a known limitation in the organ's JSDoc. Single-word
term detection is a separate, harder problem (requires part-of-speech and
context) — not for the deterministic stack.

### M2 — The eight-finding cap per organ has no per-task-kind calibration

**Files:** `backend/src/lib/chat/slaWorkflow.ts:49-51` (MAX_DERIVED_FINDINGS=8,
MAX_DEADLINE_FINDINGS=8, MAX_UNDEFINED_FINDINGS=8)

**Defect:** 8 findings is a global cap. An indenture with 200 defined terms
might have 20+ undefined candidates, but the model only sees 8. A 2-page lease
might have 0. The cap is a blunt instrument — on a deadline-dense task the
model misses real defects; on a short task the cap is irrelevant.

**Scenario:** Transfer-pricing documentation with 15+ date±duration
relationships. The deadline organ finds 12 omissions. The repair prompt shows
8. The model fixes 8. The remaining 4 are silent omissions the next reader
still can't resolve.

**Fix:** Order findings by some measure of reader impact (e.g. monetary amount
magnitude for H1, deadline proximity for H2, occurrence count for H3) so the
8 most important ones survive the cap, not the first 8 the scan encounters.

### M3 — `BASE_RE` in H1 misses real financial base nouns

**File:** `backend/src/lib/legalDerivedValueScan.ts:91-92`

**Defect:** The base noun regex recognizes "revenue, sales, income, earnings,
ebitda, value, net worth, assets, capital, equity, interest, shares, fees,
cost, price, expenses, revenue share." Missing: "turnover" (UK for revenue),
"profit", "consideration" (M&A), "market cap", "enterprise value", "AUM"
(assets under management), "premium", "principal", "notional", "commitment."

**Scenario:** A UK-source deal memo says "£50M represents 12% of annual
turnover." The percent "12%" has base "turnover," which BASE_RE does not
match. `ofBase` returns null. The identity is never found. The draft states
"12% of turnover" without the £50M amount, and H1 stays silent.

**Fix:** Add "turnover", "profit", "consideration", "premium", "principal" to
BASE_RE.

### M4 — `ENTITY_WORDS` and `JURISDICTION_NAMES` are fixed sets that rot

**File:** `backend/src/lib/legalUndefinedTermScan.ts:113-140`

**Defect:** Entity designators and jurisdiction names are hardcoded sets.
"GmbH", "Sàrl", "KK", "Pty Ltd", "Limited" (standalone — currently "limited"
is in the set but only matches the word "limited", not "Pty Limited"),
"Unlimited", "plc", "AG", "SE", "SARL", "BV", "NV" — none are suppressed.
"British Columbia", "Northern Territory", "Cayman Islands", "Isle of Man",
"Channel Islands", "Puerto Rico" — none are jurisdiction names.

**Scenario:** An indenture governed by "the laws of the Province of British
Columbia" — "British Columbia" is a two-word Title-Case phrase, not a
jurisdiction in the set, and contains no entity word. H3 fires: "British
Columbia" is flagged as an undefined term.

**Fix:** Add the missing entity types and jurisdictions. More importantly,
add a comment noting that the sets are best-effort (strictness bias: false
positive on "British Columbia" is annoying but the model can see it's a
jurisdiction; false negative on a real undefined term is worse).

### M5 — The repair prompt can exceed 3000 chars with no cap

**File:** `backend/src/lib/chat/slaWorkflow.ts:607-630`

**Defect:** Every organ's findings are concatenated unbounded (up to each
organ's per-organ cap × number of organs). With 8 conflict + 8 temporal + 8
drift + 8 derived + 8 deadline + 8 undefined + 12 lint lines, the repair
prompt could reach 2000+ chars of findings plus the fixed instructional text
(~300 chars) — bounded by the per-organ caps, but still a wall of text.

**Scenario:** A complex task fires all 7 organs. The repair prompt is 2500
chars of dense findings. The model's one repair pass skims and misses half.

**Fix:** Add a `MAX_REPAIR_PROMPT_CHARS` (e.g. 2000) that truncates with
`…and N more findings (see receipt)` rather than silently overwhelming the
model.

### M6 — Conformance suite has no real-world corruption fixtures

**File:** `backend/src/lib/__tests__/docxCapabilityConformance.test.ts`

**Defect:** All fixtures are synthetically built via `generate.ts`. The suite
tests against clean, programmatically-generated .docx files. Real legal .docx
files have: embedded Excel tables, corrupted style IDs, Tracked Changes that
span paragraphs asymmetrically, nested content controls, custom XML parts,
VBA macros, embedded fonts, OLE objects. The suite tests the happy path.

**Scenario:** A real M&A docx has a table where half the cells have `w:vMerge`
and the other half don't (a common Word corruption). The ingestion path either
crashes with an opaque JSZip error or produces garbled text. The model drafts
from garbled context. The deterministic fix (flattening) was never tested
against real corruption.

**Fix:** Add 2–3 real-world pathology .docx files to
`benchmarks/docx_edit/fixtures/real/` and test that ingestion gracefully
degrades (warning + best-effort extraction) rather than crashing.

### M7 — `worthARevision` gates on ANY finding, even a probable false positive

**File:** `backend/src/lib/chat/slaWorkflow.ts:611-618`

**Defect:** If H3 fires on "British Columbia" (see M4), `worthARevision` flips
to true and the model spends a full turn "fixing" a non-defect. One noisy
finding triggers a token-expensive repair pass.

**Scenario:** A 14-source real-estate task. H3 fires once on "British
Columbia." No other organ fires. `worthARevision` is true. The model gets a
repair prompt asking it to "revise every material error." It either (a) adds a
fake definition of "British Columbia" (hallucination), or (b) correctly ignores
it (wasted turn). Both cost tokens for zero quality gain.

**Fix:** A repair pass should require either (a) ≥2 organs firing, or (b) an
organ whose findings have historically high precision on the task kind. A
simpler heuristic: skip the repair if only H3 fires with exactly 1 finding.

## LOW

### L1 — French regex alternatives in H2 are dead code in the vendored corpus

**File:** `backend/src/lib/legalDeadlineOmissionScan.ts:109-117`

**Defect:** AFTER_RE, BEFORE_RE, WITHIN_RE, EXACT_MARKER_RE, BOUND_MARKER_RE
all include French equivalents (`après`, `suivant`, `à compter de`, `avant`,
`précédant`, `dans les`, `au plus tard`, `soit`, `c.-à-d.`). The vendored
corpus is English-only. These alternatives make the regexes slower (more
alternation branches) for zero benefit. In the worst case, a French word like
"soit" could partially match English text ("so it" → no, `\bsoit\b` requires
word boundaries).

**Scenario:** Negligible. Purely a maintenance burden — someone reading this
code assumes French support exists and writes tests for it.

**Fix:** Remove French alternatives or gate them behind a locale flag. If
French support is a real requirement, add French test fixtures.

### L2 — H1 `PART_REACH=220` rationale is undocumented

**File:** `backend/src/lib/legalDerivedValueScan.ts:86`

**Defect:** 220 chars is the max distance between a percent and its part money
anchor. Why 220? Was it measured as the 99th percentile across the corpus? Or
is it a round-ish number? The JSDoc doesn't say.

**Fix:** Add a one-line comment: "Measured: 99th percentile percent-to-part
distance across the vendored corpus is X chars."

### L3 — `quoteMask` treats ASCII apostrophe as a quote delimiter outside word contexts

**File:** `backend/src/lib/legalUndefinedTermScan.ts:251-268`

**Defect:** The single-quote heuristic (`isWordChar(prev) && isWordChar(next)`
→ apostrophe; else → quote delimiter) handles "Issuer's" correctly but fails on
leading apostrophes: "'Cause of Action" in a colloquial brief or "Rock 'n'
Roll" where the apostrophes mark elisions, not quotations. In "Rock 'n' Roll",
the first `'` has space before it ("Rock ") → treated as an OPENING QUOTE. The
second `'` has space after it (" Roll") → treated as a CLOSING QUOTE. The word
"Roll" is now quoted. If "Roll" is a defined term candidate, it's masked as
quoted and never fires — which is correct (it's not operatively used). But if
ANY text between the two apostrophes is quoted, "n" is inside quotes, which is
harmless. The real failure: if "Rock 'n' Roll Transfer" is a coined defined
term, the quoting mask splits it incorrectly, and the one unquoted occurrence
("Transfer") is treated as a single-word remnant.

**Scenario:** A music-industry contract uses "Rock 'n' Roll Transfer" as a
defined term. The quoting mask marks "n" inside single quotes. The full phrase
"Rock 'n' Roll Transfer" is segmented oddly. The organ either misses it (if the
quoting creates spurious boundaries) or fires on a fragment. Low likelihood in
the vendored corpus (corporate/finance, not entertainment).

**Fix:** None needed at this priority. Document the limitation.

### L4 — Tier 0 aggregate table buries the "v2 batch entirely empty" finding

**File:** `backend/scripts/drafting-efficiency-tier0.ts:655-656`

**Defect:** The report's §2 (Run-directory gaps) lists 37 v2 runs as
"no_artifacts" but the report never says WHY v2 is empty (run-state.json only).
Was it a config error? A harness crash? The slicer dutifully reports the gap
but doesn't investigate.

**Fix:** Add a one-line hypothesis in the report ("v2 batch appears to be an
aborted run — only run-state.json present in every task directory; likely a
harness timeout or config error").

---

## Cross-cutting theme: the deterministic organs tell the model WHAT is wrong but not WHERE to look

Every organ's detail string describes the defect. None point the model at the
source evidence. The model's repair turn must re-search the source stack to (a)
verify the finding isn't a false positive, and (b) find the right number/date/
definition to fix the draft with. This re-search cost is the organ's token
overhead — it's not zero, and it scales with source count.

The fix is uniform and small: each detail string should carry a
`(<source>.docx)` citation. The organ already knows the source (it's in the
`DerivedValueRef.document`, `DeadlineRef.document`, and
`UndefinedTermFinding` has the draft's own text); surfacing it costs ~30 chars
per finding and saves a Grep→Read round trip.

## Cross-cutting theme: strictness bias is measured on one stack each

H1: measured on CoC (5 real, 0 false). H2: probed on CoC (239 relationships, 4
resolved). H3: measured on indenture (1 real, 0 false on "Permitted Tax
Distributions"). The strictness bias is calibrated to these stacks. A tax
transfer-pricing task or a healthcare clinical-trial markup might have
different percent idioms, different deadline conventions, different term
definition patterns. The corpus-wide stress test (running now) will reveal
this — but until then, every organ's "measured: N false positives" claim is
single-stack evidence, not corpus-wide proof.
