# LAB showdown: faithful upstream control vs. best-theory treatment (2026-08-05)

The two-arm reduction Eli directed after the 24-cell grid: control = the
contribution-grade faithful upstream arm; treatment = our best single theory of
what beats it. One run per cell, one judge pass per run, task diversity over
replicates (runner directive). All runs and judging on Claude flat-rate.

## Arms

| | control | treatment |
|---|---|---|
| arm | `mike_upstream_native_v1` | `mike_markdown_e2e_treatment_v1` |
| chassis | upstream mike pinned at 2266446b: native 9-tool array, native envelopes, sections[] DOCX plane (pinned defects served deliberately), maxIterations=10 | markdown e2e: pandoc-markdown read plane + markdown drafting |
| mechanisms | none (that is the point) | + requirements echo (`fetch_requirements` re-serves the verbatim task message + read/unread doc split; authoring tools refuse until called once) + citation contract (GROUNDING prompt block: verbatim ≤25-word quotes with doc name beside source assertions) |
| model | claude-p / claude-sonnet-4-6 | same |
| effort | **high** (pin fidelity: upstream claude.ts:143) | **max** (markdown-family convention) |
| judge | claude-code / claude-sonnet-4-6, one pass | same |

The effort asymmetry is deliberate and documented
(docs/harvey-labs/results/upstream-native-arm-audit-2026-08-05.md): each arm runs at its own
family-faithful setting. It confounds the cost columns in the treatment's
disfavor on thinking-heavy tasks (see employment) and possibly flatters its
quality; per-task quality deltas should be read with that asterisk.

## Results (5 of 6 tasks; HSR treatment DNF, see below)

Score = criteria passed. b = criteria only control passes, c = only treatment
passes (majority verdicts; n=1 so majority = the single run). p = McNemar exact
on discordants. C@2 = uncached + 1.25×cache_write + 0.1×cache_read + 2×output
(corrected cache-write pricing, applied symmetrically).

| task | control | treatment | Δ | b | c | p | C@2 ctrl | C@2 treat | cost ratio | wall ctrl | wall treat |
|---|---|---|---|---|---|---|---|---|---|---|---|
| closing (32c) | 27 | 28 | +1 | 0 | 1 | 1.00 | 172,137 | 102,818 | **0.60×** | 806s | 333s |
| banking (65c) | 59 | 56 | −3 | 5 | 2 | 0.45 | 230,753 | 162,229 | **0.70×** | 1178s | 791s |
| employment (59c) | 55 | 51 | −4 | 6 | 2 | 0.29 | 225,534 | 280,409 | 1.24× | 1206s | 1563s |
| DPA (58c) | 35 | 47 | **+12** | 2 | 14 | **0.0042** | 135,480 | 141,731 | 1.05× | 342s | 398s |
| insurance (57c) | 56 | 56 | 0 | 0 | 0 | 1.00 | 393,856 | 245,492 | **0.62×** | 1618s | 950s |
| **pooled (5)** | **232/271** | **238/271** | **+6** | **13** | **19** | **0.38** | **1,157,760** | **932,679** | **0.81×** | 5,150s | 4,035s |

Pooling caveat: criteria within a task share one trajectory — the pooled p is
descriptive. Per-task sign test: 2 wins, 2 losses, 1 tie — nothing. Verbosity
confound: deliverable_chars vs pass-rate Pearson r=0.123 over 10 runs (weak).

## What the table actually says

1. **Quality: statistical tie overall, one decisive cell.** The only per-task
   result that survives any scrutiny is DPA: b=2 vs c=14, exact p=0.0042. That
   is the task where the control collapses (35/58, its worst by far, on the
   markup task whose counterparty edits hide in the pinned sections[] plane).
   The treatment's 14 unique passes cluster in requirement-coverage criteria —
   the echo's read/unread split plus grounded quoting is the mechanism pair
   aimed at exactly that failure mode, and DPA is where it cashed.
2. **Where control was already strong, the mechanisms bought nothing.** Banking
   (native 59 beats every markdown arm ever run) and employment (native 55,
   same) both regressed to markdown-family level: treatment banking 56 = plain
   e2e's 56; treatment employment 51 = floor's 51. The treatment deltas track
   its *chassis*, not its mechanisms — on these two tasks the markdown plane
   itself is the handicap, and echo/grounding did not recover it.
3. **Cost: treatment cheaper on 4 of 5 (0.60–0.70× C@2), 0.81× pooled.**
   The exception is employment: effort max spent 77,309 output tokens to
   produce a *shorter* deliverable (44k chars vs control's 54k) — thinking
   burn, the effort asymmetry made visible. On the two tasks where quality
   tied or better (closing, insurance, DPA), the treatment is the same price
   or up to 1.7× cheaper and up to 2.4× faster.
4. **Insurance is a perfect tie in the strongest sense**: identical pass sets,
   both arms failing only C-010, with the treatment at 0.62× the cost.

## HSR: treatment DNF (robustness finding, counts against the treatment)

The treatment cell for antitrust/HSR (9 documents, the largest fit-band
corpus) failed twice, both times on claude-p transport silence (240s watchdog
kill mid-conversation; retries unparseable; conformance then correctly refused
the run — echo never fired, no metrics written). Attempt 1: 94 min alongside 4
concurrent cells. Attempt 2 (solo): still running past 70 min at effort max
when this report was cut; final status noted in the addendum below. The
control completed HSR in 8 minutes (48/50). Whatever the transport's share of
blame, the treatment configuration (effort max, grounding contract over 9
documents) sits much closer to the transport's silence threshold. Any
production adoption of the treatment must retest at effort high.

## Verdict against the sacred goal

- The faithful upstream arm at effort high scored **280/321** across all six
  tasks — it ties or beats every markdown-family arm pooled (best: plain e2e
  279). Every earlier "we beat upstream" claim was against a softer proxy.
  Beating true upstream on *fit* tasks is now shown to be hard: our best
  treatment manages a statistical tie at 0.81× cost, not a win.
- The treatment's real value concentrates precisely where whole-read
  *degrades*: DPA (+12, p=0.004). This is the program thesis in miniature —
  lean/grounded context pays when the native strategy is past its comfort
  zone, not before.
- Consequence for Phase D: the decisive experiment is the no-fit band
  (209k–292k tokens), where the control cannot physically run in a 200K
  window (typed context_overflow) and the treatment completes. The fit-band
  showdown says the treatment gives up little-to-nothing on quality (except
  possibly on tasks like banking/employment, bounded at −3/−4) at lower cost;
  the no-fit band is where it can win outright, and HSR says its long-turn
  robustness needs hardening (effort high retest) before that headline run.

## Treatment mechanism receipts (all completed cells)

echo_call_count=1 and documents_unread_at_echo=0 in every completed treatment
cell — the model calls the echo voluntarily, after reading everything, before
drafting; the authoring backstop never had to fire. Closing-cell deliverable
carries 31 verbatim quoted spans + 12 parenthetical doc-name citations
(GROUNDING uptake verified by inspection, XML-entity-decoded).

## Incidents ledger (this run day)

1. **Session-limit cell poisoning** (3 native cells): a claude-p run hitting
   the session limit on its final round exits 0 with metrics present but all
   usage envelopes lost; one poisoned cell was judged before detection. All 3
   quarantined (`results-quarantine/`), rerun clean, queue verdict order fixed
   (limit grep before DONE). Recorded in memory.
2. **Judge sweeps and background stops are not tree-kills on Windows**:
   TaskStop/harness stops leave git-bash trees alive; a "stopped" sweep
   respawned its judges twice (once with stale in-memory settings), and a
   mass lane-kill was survived by judge.py's spawn-retry backoff, which
   quietly finished banking and employment judging *after* the stop. One
   over-eager orphan kill (mine) cost the insurance judge one partial pass;
   the sweep's retry pass re-judged it clean. Correct procedure now in
   memory: kill by root PID with /T, verify by command-line match, and check
   scores.json timestamps before declaring processes wedged.
3. **Cache-write pricing corrected** (fcfcd2c4): lab-compare had dropped the
   1.25× cache-write term, flattering big-prefix arms; all numbers above use
   the corrected formula. The per-run
   `cache_adjusted_input_token_equivalent` in metrics was always correct.

## Addendum: HSR treatment final status

DNF, killed by hand at ~80 min into attempt 2 (Eli called time). Two attempts,
zero completed rounds of drafting output persisted; both attempts spent 70+
minutes without reaching metrics. Control HSR: 48/50 in 8 minutes. The HSR
cell therefore stands as control-only, and the pooled numbers above cover the
5 completed pairs. If the cell is ever rerun, run it at effort high, solo, and
treat transport silence >240s as the expected failure mode to watch.
