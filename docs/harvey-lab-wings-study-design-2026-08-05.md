# Wings selective-deployment study — design (2026-08-05)

Synthesis of three agent reports plus the completed 18-cell grid:

- `harvey-lab-deterministic-wings-inventory-2026-08-05.md` (what exists, per wing)
- `harvey-lab-run-mining-signals-2026-08-05.md` (task-shape signals, thresholds, defect census)
- `harvey-lab-toy-math-date-tools-2026-08-05.md` (math/date tool valence)
- Grid final, 321 criteria: e2e 279 (86.9%) > floor 276 > index_floor 272.

Goal (Eli): run a few many-document tasks and study what works and the
*correct selective deployment* of the deterministic experiment wings —
produce something genuinely valuable for legal work. Doctrine constraints:
deployment policy keyed to measured task-shape signals, never task identity;
wings tested solo AND in concert (ensemble-witness); no hidden rubric; no
per-token spend; sealed tier untouched.

## 1. The band split the mining data forces

The three reports converge on one structural fact: **the failure classes of
the fit band and the no-fit band are disjoint.**

**Fit band (corpus ≤ ~150k, whole-read possible).** Whole-read e2e leads
pooled. Its misses are output-side: 31 criterion-required figures sat
verbatim in *served* text and never reached the deliverable (19 on failed
criteria); synthesis misses 30/106; judge-strict 20/106. Derived-figure
arithmetic is a non-problem (97.8% exact; zero computed-date errors). The
$210M/$90M banking case is **base selection inside one served paragraph**
(percentages applied to the net figure two sentences after the gross one),
not calculation. Read-side wings have nothing to fix here — every
exposure-gap, unresolved-xref, and usage-without-definition defect in the
census sits in scoped arms; whole-read cells have zero.

**No-fit band (209k–292k, scoping forced).** All scoped pathologies live
here or in scoped fit-band arms: exposure gaps (31 misses), unresolved
cross-refs (29, criterion cost 2), usage-without-definition (71 terms /
283 usages, 100% scoped), and the sharpest failure — asserted negatives
over unserved regions ("No inconsistency identified" about a section never
served, while all whole-read arms caught the 365-vs-180-day conflict).

So: **output wings are the fit-band play; read wings + guards are the
no-fit play.** One study, two sub-experiments, no wing deployed on the band
whose failure class it cannot touch.

## 2. Wings roster

| id | wing | band | status (inventory) | attacks (mining) |
|---|---|---|---|---|
| W1 | requirements-echo (#41) | fit + no-fit | build: small; tool + refusal backstop | verbatim omission 31; synthesis 30/106 |
| W2 | citation/quote contract (#42) | fit + no-fit | prompt block exists in native surface; harvester missing | judge-strict 20/106; base-selection visibility |
| W3 | defined-terms pull (read-time) | no-fit only | 3 of 4 conventions built; dependency listing computed-then-dropped | usage-without-definition 71 terms; Article I never served |
| W4 | asserted-negative guard | no-fit only | new, but small: served-span map already built then discarded | banking C-011 class: negatives citing unserved anchors |
| W5 | figure reconciliation | fit + no-fit | retarget of H1 derived-value organ (built) | base-selection ($210M case); NOT a calculator |
| W6 | date_math tool | signal-gated | built (toy MCP server); production shape TBD | calendar enumeration waste (3.5× output saving); H2 compose |
| W7 | find query normalization | scoped arms | tiny: strip/flex quotes + `"X" means` variants | 7/7 `<Term> means` probes returned 0 hits — the mechanism that let a covenant memo skip Article I |
| W8 | coverage certificate | no-fit only | plumbing: `exposureMetrics` builds per-doc span map, discards it | scoped claims discipline; Phase D headline artifact |

Dropped/held: calculator-as-wing (toy probe: arithmetic tools cost MORE;
mining: derivation errors ≈ 0%); parenthetical-trigger for W3 (mining:
anti-predictive — closing 59:3 and DPA 86:0 parenthetical:sentence ratios
with zero definition misses); salience-ranked index (killed twice);
index-without-floor (dominated).

## 3. Deployment policy (signal-gated, from measured thresholds)

- **W3 fires** iff `def-sentences/10k ≥ 1.5` AND ≥1 Definitions/Defined-Terms
  heading AND the harness is scoping. On the grid this selects exactly
  banking (4.38) and employment (2.24) — the two tasks that lost criteria to
  unserved definitions; HSR (0.67) correctly does not fire.
- **Import sub-wing** fires at ≥3 incorporation-by-reference sites
  (`capitalized terms … not defined herein` / `meanings ascribed in <agreement>`).
- **Scoped navigation at all** is safe only at `in-text xref/10k ≥ 6`;
  below that, whole-read (or widest windows) — scoping damage is monotone
  in xref density: insurance (1.13/10k) lost 2.08 criteria per 10pp unread;
  employment (10.89) gained. High-xref corpora carry their own routing.
- **W6 fires** on date-computation density (relative-deadline mentions),
  not on numeral density (arithmetic tools are net-negative).
- **W1/W2 are unconditional on their band** (self-limiting by their own
  terms; W2's block exempts drafted-instrument deliverables — Eli's caveat).

## 4. Sequencing — cheapest evidence first

**Stage 0 (zero quota, offline, start immediately): replay validators over
the 18 judged transcripts.**
- W4 guard: run the negative-assertion detector over every scoped-arm
  deliverable with the reconstructed served-span maps; report
  precision/recall against the known misses (banking C-011/C-012 must fire;
  whole-read cells must be silent). The mining report already reconstructed
  served text; the inventory says the span map is built-then-discarded.
- W5 reconciliation: run the retargeted organ over all 18 deliverables;
  it must flag the $210M/$90M base-selection case and stay quiet on the
  181 correct derivations (false-positive budget: near zero, or the wing
  dies by ensemble-witness rules).
- W7: replay the 7 failed `"Term" means` queries through the normalized
  matcher; confirm 7/7 now hit. Also an upstream-contribution finding in
  its own right (upstream's literal search fails on the single most common
  defined-term query grammar).
- W3 dry-run: compute the trigger on all 14 task corpora (mining already
  has the densities); confirm the fire set is {banking, employment} + the
  measured no-fit tasks it selects.

Stage 0 artifacts are deterministic reports; no model calls. Only wings
that pass their replay validation advance to live cells.

**Stage 1 (fit band, output wings, sonnet quota ~9 runs): the output 2×2.**
Tasks: banking, employment, DPA (highest omission+synthesis loss).
Arms on the e2e+floor chassis (control cells already judged):
`+echo` (W1), `+citations` (W2), `+echo+citations` (concert).
Decision: a wing is kept if pooled ≥ +2 criteria on its 182-criterion
panel without >25% output growth; concert cell tests interference.

**Stage 2 (no-fit band, merged with Phase D #37): the consumer-window
headline plus read wings.** Tasks: antitrust-risk 209k, acquisition-
diligence 228k, CoC 230k, indenture 248k, tax-TP 292k. Arms per task:
1. `mike_upstream_native_v1` — expected typed `context_overflow` or
   10-round collapse; the row IS the result (gated on auditor B + smoke).
2. `mike_markdown_e2e_v1` — whole-read on the markdown plane; overflow
   expected on the biggest tasks.
3. Lean chassis + signal-fired read wings (W3/W7/W8 + W1/W2 if Stage 1
   passes them, W4 as post-draft guard, W6 where the signal fires) —
   the "certified coverage" arm: deliverable + coverage certificate +
   zero unguarded negatives.
Sequencing per standing plan: sonnet shakeout first, opus-4-8 headline
after, CoC first, quota-typed failures never retried.

**Stage 3 (only if Stage 1/2 leave residual synthesis misses): SLA
assembly.** Reframe SLA-spec from audit arm to per-section deliverable
assembly driver. Blocked today by the two gates the inventory found
(prompt-sha + isolation predicate `sla_workflow !== false` throw), the
all-or-nothing organ stack, and the repair-prompt budget overflow.

## 5. Build list (silo rules apply to every item)

| build | for | size | where | waits on |
|---|---|---|---|---|
| B1 echo tool + authoring backstop | W1 | small | new module + gated wiring in chat.ts/localAssistantTools/lab-beaver-arm | auditor B done (working-tree stability), then immediate |
| B2 citation block (self-limiting) + quote harvester | W2 | small prompt + new harvester module | surface file (append-only) + new module | same |
| B3 negative-assertion guard | W4 | new module; replay driver first | new file, consumers-only | nothing (Stage 0 now) |
| B4 reconciliation retarget | W5 | edit of H1 organ clone (do NOT touch the shared organ) | new module cloning `legalDerivedValueScan` logic | nothing (Stage 0 now) |
| B5 find normalization | W7 | tiny; Beaver arms only, NEVER the native arm (pinned behavior is the baseline) | `findTextMatches` consumer wrapper, flag-gated | auditor B done |
| B6 def-pull + import pull | W3 | medium; expose `definedTermSet`, add heading regex, serve-on-trigger | new module + gated read-path hook | auditor B done |
| B7 coverage certificate emitter | W8 | plumbing (`byDocument` map is already built) | lab-beaver-arm receipts | auditor B done |

Native-arm cells (6, fit band) run before Stage 2 so the no-fit native rows
have a fit-band baseline; gated on auditor B verdict + closing smoke.

## 6. What would falsify the program

- Stage 0: W4/W5 replay precision below ~1.0 on known cases → wing dies.
- Stage 1: neither W1 nor W2 clears +2 pooled → output wings die; the
  fit-band story ends at "whole-read e2e + floor is the ceiling at n=1".
- Stage 2: lean+wings < deepseek whole-read reference on completed no-fit
  tasks → the consumer-window thesis fails and we say so.
