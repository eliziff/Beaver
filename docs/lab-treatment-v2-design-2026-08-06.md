# Treatment v2 design revision (2026-08-06)

Post-showdown reconsideration of `mike_markdown_e2e_treatment_v1`, built from
three parallel forensic passes over the completed runs: (A) discordant-criterion
forensics with e2e/floor cross-reference, (B) claude-p transport root-cause on
the HSR DNF, (C) mechanism-uptake measurement (echo payloads, quote fidelity,
output-burn tracing). Raw data: scratchpad `discordant_extract.json`; CLI
session transcripts under `~\.claude\projects\...-backend\`.

## What the evidence overturned

1. **"Echo supersedes floor" is falsified.** Of the treatment's 11
   banking/employment criterion losses vs control, the floor arm passes 7 —
   including 4 that plain e2e also fails (30→45-day cure change, 50→25-mile
   relocation change, the March 15 2027 date, the CEO-benchmark attribution).
   The floor's enumeration checklist (issues, parties, dates, numbers,
   exceptions, conflicts) is a *precision* organ; the echo is a *coverage*
   organ. They are complementary, not redundant. Aggregate shape: treatment
   losses are 7/13 DETAIL; wins are 8/18 SYNTHESIS + the DPA COVERAGE block —
   v1 trades precision for analysis, and the floor is the missing precision
   mechanism.
2. **A reported-vs-recomputed figures defect.** Banking losses C-022/C-037:
   the model recomputed covenant ratios and reported its own arithmetic
   (1.24x; 3.68x-as-operative) instead of the certificate's stated figures
   (1.22x; 3.15x). The same recomputation habit won C-001 (flagging a genuine
   3.68x-vs-3.72x mismatch). The instinct is right; the reporting discipline
   is missing.
3. **DPA's +12 decomposes: ~7 chassis, ~5 mechanism.** 9/14 treatment-only
   wins vs control are also passed by plain e2e (chassis); 5 are passed by no
   other arm (undefined-term flags, unachievability, certification-form
   critique) — real mechanism value, concentrated in
   closeness-to-text synthesis. One grounding *failure* on the same task:
   treatment asserted Attachment C was "restored" when it is missing (C-002).
4. **The 32k per-provider-message output cap silently taxed the whole
   markdown family at effort max.** Employment's drafting round = three
   provider messages: 32k pure-thinking (discarded), 32k draft truncated
   mid-JSON (discarded), 13k rewrite (delivered) — 83% of 77,309 output
   tokens thrown away, and the delivered doc is a hastier third attempt
   (plausible cause of its e2e-relative synthesis losses). Insurance: same
   mode, 72% discarded. One-shot whole-document drafting + max thinking
   collides with the cap; the native arm's small rounds never touch it.
5. **Both HSR DNFs were harness defects, not task/model failures.**
   - Attempt 1's root failure: a fully completed 16-minute, 58.7KB draft was
     discarded by `parseReply`+jsonrepair (TOOL_CALLS content-shaped mode,
     claudeP.ts:420-441), then corrective full-replay retries were killed by
     the watchdog.
   - The 240s inactivity limit (claudeP.ts:84-86, effort-blind) sits inside
     the healthy-pause tail of effort-max generations: sessions provably
     streamed deltas for 1,310s+ (past the 900s grace) and were then killed
     at stochastic ≥240s pauses (summarized-thinking flush seams / internal
     continuation seams). Each kill forfeits the server-side cache and
     restarts a 30-40-min generation from a cold ~350KB replay.
6. **Echo mechanism: verbatim and cooperative, but the doc-split is inert on
   fit-band tasks.** All five cells: byte-identical requirements echoed,
   `documents_unread=[]` always (the chassis batch-reads everything in round
   0), echo positioned immediately before drafting. Pre-echo round cost is
   wildly variable (67–9,143 output tokens for the same no-arg call).
7. **Quote fidelity ~95%, with real residue.** ~6 unmarked in-quote
   alterations (worst: "expressly and affirmatively contradicts" where the
   source says "denies") + ~4 model-authored labels inside quote marks.
   Quote density collapses exactly where sources are heaviest (banking:
   3.7/10k chars, mostly defined-term labels — matching its DETAIL losses).
   The ≤25-word cap was violated 20×, 17 of them genuinely verbatim;
   insurance is the worst violator and the top scorer — the hard cap buys
   nothing. Filename attribution: 4/5 deliverables use prose titles, never
   filenames; the judge never objected.

## Correctness fixes (harness/transport — apply regardless of arm design)

| # | fix | where | evidence |
|---|---|---|---|
| F1 | Effort-scaled watchdog: inactivity limit = 900s (reuse FIRST_MODEL_EVENT_GRACE_MS) when effort=max, 240s otherwise; both stateless (claudeP.ts:182) and session (:288-290) paths | claudeP.ts:84-86, 182, 252-258, 288-290 | B's patch sketch; 5 sibling cells prove 240s fine at ≤high |
| F2 | stderr resets the session-path liveness timer (one line at :328-331); HARD_LIMIT_MS remains the runaway backstop | claudeP.ts:328-331 | CLI backoff chatter is silent on stdout |
| F3 | Raise the per-message output ceiling for claude-p lab runs (spawn env, CLAUDE_CODE_MAX_OUTPUT_TOKENS-class) so thinking + one-shot draft fits; target 64k | claudeP.ts spawn env (:149-167/:260-278) | 83%/72% discarded output; HSR truncate-loop wall-clock |
| F4 | Retry-cause hygiene: the :652-655 throw should carry per-attempt error kinds (parse-failure vs watchdog-kill) | claudeP.ts:534-655 | attempt 1's log was undiagnosable without transcript forensics |
| F5 | Structural (already planned, now root-caused as necessary): move drafting out of TOOL_CALLS JSON strings (args.markdown → renderer grammar) — parse failures on 58.7KB JSON-embedded drafts discard completed generations | e2e schema target per md-swap verdict | HSR attempt 1 |
| F6 | Instrumentation: `drafting_tool_calls` mislabeled (phase stays "research"); `documents_read_directly=0` despite read_document calls | lab-beaver-arm metrics | C's report |

## Arm design v2 (`mike_markdown_e2e_treatment_v2`)

Deltas from v1, one flag/one delta tag each (siloed-experiment rules):

1. **Floor returns**: `MIKE_COMPLETENESS_FLOOR=1` alongside echo + grounding.
   Expected recovery: 7 of the 11 banking/employment losses.
2. **Grounding contract v2** (`citation-contract-v2`), four amendments:
   - *Stated-figures clause*: report a document's stated figure verbatim;
     when recomputation disagrees, present both, labeled (stated vs
     computed). Preserves the C-001-class win, kills the C-022/C-037 mode.
   - *Quote integrity*: never alter wording inside quotation marks; mark
     elisions with ellipses; model-authored labels/summaries stay unquoted.
   - *Attribution*: name the source document (title or filename) — codifies
     actual behavior.
   - Soften the length rule: prefer ≤25 words, hard cap 40. (The hard 25 was
     violated freely by the top scorer with zero judge cost.)
3. **Effort high** for Phase D headline runs. Kills the effort asymmetry
   critique (both arms at high), shrinks the thinking share of the output
   budget (with F3, one-shot drafts fit in one message), and exits the
   max-effort pause tail entirely. Max survives as an ablation arm only.
4. **Echo unchanged.** Receipts are perfect; cost is one round; the
   read/unread split stays because Phase D scoped-reading chassis can make
   it non-trivial (it is inert, not harmful, on fit-band).

## Confirm plan before Phase D (4 cells, effort high, fixes F1-F3 in)

Run v2 on: banking + employment (loss-recovery check: target ≥ floor's
58/51), DPA (win-preservation: hold ≥ mid-40s), HSR (DNF fix validation +
completes the 6th control pair). Judge once each (sonnet-4-6), then
lab-compare v2-vs-control and v2-vs-v1. Success → Phase D with v2; banking
or employment still below floor → the echo (not the floor) becomes the
ablation suspect.

## Honesty notes

- All per-criterion attributions are n=1 vs n=1 under a single judge pass;
  individual flips sit inside the ±2-3 noise band. The load-bearing signals
  are aggregates (floor-recovery 7/11, DETAIL-loss dominance, 83%/72%
  discard rates, transcript-proven kill mechanics), not single criteria.
- The DPA hallucination (C-002) and the contradicts/denies in-quote
  alteration show grounding reduces but does not eliminate fabrication; v2's
  integrity clause is a mitigation, not a guarantee.

## CONFIRM RUN RESULT (2026-08-06 00:28 queue, judged 00:50-01:02)

All four cells completed and all four targets hit. Transport fixes
(d3b1076c) live; effort high both arms — the showdown's effort-asymmetry
caveat is gone.

| task | v2 | control | v1 | target | outcome |
|---|---|---|---|---|---|
| banking | **60/65** | 59 | 56 | ≥58 | beats control; floor+contract-v2 recovered the reported-vs-recomputed losses |
| employment | **53/59** | 55 | 51 | ≥51 | half-recovered; residual −2 (control-only C-004/C-035/C-040) |
| DPA | **45/58** | 35 | 47 | ≥ mid-40s | win preserved, +10 over control (p=0.0063); −2 vs v1 |
| HSR | **48/50** | 48 | DNF ×2 | completes | ties control; 16.6 min where v1 burned 94+80 min DNF |

- Paired control-vs-v2 (4 tasks): pooled b=6 c=15, exact p=0.078 — v2
  ahead, not significant. Only decisive cell: DPA. v1-vs-v2 (3 tasks):
  b=8 c=12, p=0.50.
- Wall times 10.7–18.4 min per cell (v1 band was 30–90): the long tail
  was transport tax (32k truncate-rewrite cycles, max-effort pauses,
  watchdog kill-restarts), not task time.
- Cost at C@2: banking 0.68x control, employment 0.84x, HSR 1.12x, DPA
  1.90x — pooled 1.05x. DPA's overrun is the parse-failure retry (its
  cache_write is 2.1x its siblings): the drafting round's completed 60KB
  generation was discarded over ONE raw interior double quote
  (`Accepted "material" qualifier`), and the corrective retry both
  re-billed the context and drafted ~30% shorter (39,286 vs ~59,155
  chars) — the plausible cause of the −2 vs v1. The structural-salvage
  transport fix (parseReply dominant-string recovery, replay-proven on
  the preserved artifact) removes this entire failure class; note that
  contract v2's verbatim-quote demand RAISES quote density in drafts,
  which is exactly the character class that breaks in-band JSON — the
  two interact, which is why the salvage landed with the confirm.
- Verbosity confound note: deliverable_chars vs pass-rate r=0.726 over
  these 8 runs (descriptive; control's larger employment/HSR drafts).

Verdict: v2 is the Phase D treatment arm. Banking/employment floor
targets met, DPA win held, HSR validates the transport package live.

## v3 candidate assessment (2026-08-06): quote-grounding organ — DON'T-BUILD

Eli asked whether the existing grounding/closest-match systems (ALR
lineage: quoteRepair.ts nearestVerbatimExcerpt/quoteRepairSuggestion,
sourceDoc.ts offset-bearing quote location, the slaWorkflow
audit->repair-prompt->one-revision-pass chassis — all dormant in lab
arms) should be wired into the treatment. An opus design agent graded
every one of v2's 26 confirm-run misses against the judges' reasoning
and ran the real machinery over the four delivered drafts. Verdict:

- 0/26 misses are quote-verbatim-shaped; 3/26 are figure-presence-shaped
  (all DPA: C-028/C-031 dollar figures, C-047 18 U.S.C. § 1349); 23/26
  are synthesis/depth/attribution — the model SAYING LESS than the
  rubric wants, not saying something wrong.
- Direct measurement: 195 quote candidates harvested from the four
  drafts, ~90% verbatim-correct; zero of 232 judged criteria carry any
  accuracy-flavored judge remark. The hard failures are cosmetic
  ("80%–85%" vs "80% to 85%").
- A submission-time gate would fire on 4/4 tasks, mostly on the model
  quoting ITS OWN prose (untagged-quote classifier problem — the
  mike_workbench 120/298 mass-failure reproduced), each revision
  re-emitting the whole 40-52k-char markdown for +0 criteria.
- Five misses LOOK figure-shaped but are attribution errors (the figure
  is in the draft attached to the wrong referent) — structurally
  invisible to presence diffs.

Corrections and finds from the same investigation:

- DPA v2 −2 vs v1 attribution CORRECTED: doc_coverage shows v2 read 5/6
  documents, skipping cftc-settlement-order.docx (v1 read 6/6; control
  4/6). C-017's required phrase exists only in that unread file. The
  transport-level parse-failure discard did happen (59.2k-char first
  draft vs 39.3k kept), but the specific lost criteria trace to the
  skipped document and a thinner clawback section, not to
  retry-compression per se.
- THE REAL v3 CANDIDATE: the harness already told the model — the
  fetch_requirements echo result carried documents_unread:
  ["cftc-settlement-order.docx"] and the model drafted anyway on the
  next event. A typed generate_docx-time error naming unread documents
  ONCE (model free to read them or state why not) is 100%-precision on
  this miss, costs nothing when clean, and is mechanism-only. n=1 task
  so far; needs its own evidence check before building. Hard
  "read-everything" rules stay out: benchmark folders are fully
  relevant, real matter folders are not.
- Hygiene (dormant-path bug): greenfieldReviewRepairPrompt interpolates
  the reviewer model's source_excerpt into the repair prompt as quoted
  source text without verification (slaWorkflow.ts:213). Unreachable
  today (double-gated off). Fix with sourceDocContainsQuote +
  quoteRepair the next time SLA is touched — that is the one spot where
  those tools are unambiguously right, because the excerpt is a
  machine-consumed claim about a source, not model prose.
