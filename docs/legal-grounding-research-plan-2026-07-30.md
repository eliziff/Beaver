# Legal grounding research plan — framing, lint, and the citation web

Drafted 2026-07-30, after Stages 1–5 (see
`legal-grounding-experiments-2026-07-30.md`) and with Stage 6
(quote-first, 246 cells) in flight. Owner doc for the next stages; each
stage still gets its own frozen hypothesis in the experiment log before
its run. Standing constraints: flat-rate surfaces only, deterministic
machinery first, fail-closed rendering, receipts with hashes,
benchmark labels never promoted to gold, authority/current-law
validation deliberately out of scope for now.

## What is settled (evidence, not vibes)

- The harness carries grounding decisions, not the model family
  (Stage 5 crossed checkers; the only false accept needed Codex in both
  roles).
- Quote-anchored composition is the strongest single lever; the
  deterministic verbatim tier has zero false passes across 17 audited
  clears; whole-quote answers render checker-free.
- Every observed grounding failure is an overreach-framing failure: a
  broad characterization ("has a statutory framework", "regulates")
  resting on a narrow passage.
- On 229 claim-level labeled claims from our receipts: novel-content
  fraction separates rejected framing at 0.69 AUC; abstraction-lexicon
  hits run 3× higher in rejected claims; modality upgrades 3× base
  rate; rejected overreach claims are entity-POOR (abstraction without
  specifics). Register/ladder features are source-class-conditional:
  statute spans are themselves rule-register, so register-mismatch only
  makes sense against case-law spans.
- The citation web has usable structure: 93% of cited keys in the smoke
  citator have one citer (few-citers → few-propositions is visible);
  provider lists give clean citer counts; edge excerpts need a
  deterministic prose-vs-authority-list filter before they read as
  characterizations; 83% of sampled journal articles cite neutral-cited
  cases (a real commentary graph, with page/footnote structure to
  separate body discussion from notes).
- Literature gaps we can own: no public dataset labels LEGAL citation
  mischaracterization; no corpus quantifies gnomic-present rates by
  court level. Nearest transferable designs: biomedical
  citation-integrity (ACCURATE/NOT_ACCURATE), InSciOut/SPICED
  claim-strength ladders, Magesh et al.'s "misgroundedness" definition.

## Workstream A — finish the composition line (in flight)

A1. Stage 6 verdict when the 246 cells land: score frozen H6 gates
    (audited pair everywhere, Claude zero-call cells > 0,
    deterministic-clear rate, answerable rendering vs tiered,
    contract-rejection absorption), verbatim-audit every clear, record,
    archive, commit. If H6 holds, quote_first becomes the recommended
    lane and the experiment's composition contract is settled.

## Workstream B — the misgrounding corpus (breadth first)

Everything downstream needs labeled breadth: model families,
jurisdictions, areas of law, legislation vs case law, commentary.

B1. Integrate the two pending scout reports (mistake corpora;
    stands-for/parenthetical datasets). Acquire what is downloadable:
    Large Legal Fictions data, RegLab audit examples, the AI
    hallucination court-case database (courts describing real
    mischaracterizations, cross-jurisdiction), RAGTruth legal slices,
    ExpertQA-law, biomedical citation-integrity corpus (design
    template).
B2. Assemble the Beaver misgrounding corpus: unified claim/passage/
    label rows from (a) external corpora, (b) our own receipts (grow
    every stage), (c) CSLB adversarial rows, (d) court-database
    described mischaracterizations. Fields: claim, cited span(s),
    source class, jurisdiction, court level, model family (if known),
    label + label provenance (never silently promoted), area of law.
    Stored under the OpenLegalData contract; the repo keeps only the
    builder script and aggregate stats.
B3. Gap-fill generation ONLY if external breadth is thin: elicit
    misgroundings from held-constant runs over new A2AJ items across
    courts/areas (we control jurisdiction and source class), labeled by
    the Stage 5-validated checker AND flagged as judge-labeled, with a
    human-audited subsample.

## Workstream C — deterministic legal lint (H7 + H10)

C1. Implement `legalClaimLint` (backend lib, pure deterministic):
    - QUIP-family: novel-content-word fraction + char/word n-gram
      precision of claim vs cited spans;
    - abstraction lexicon (novel-in-claim), absolutes/booster deltas
      (Hyland-style), modality-upgrade (claim strong / span weak);
    - entity-profile: claims that are entity-poor AND high-novel are
      the overreach shape; entity mismatches (dates, amounts, section
      refs present in claim, absent in span) flagged separately;
    - claim-strength ladder and register-mismatch, GATED ON SOURCE
      CLASS (case-law spans only, per the inversion finding);
    - temporal lint (H10): "X followed/applied/distinguished Y" where
      date(X) < date(Y) → hard flag (dates from receipts/case_doc);
      plus the one-sentence date-ordering note in composition prompts.
    Every rule carries a receipt (which feature fired, with values).
C2. Calibrate on the misgrounding corpus (B2); publish per-source-class
    thresholds with ROC tables in the log. Derive the register/ladder
    lexicons empirically from the free rhetorical-role corpora
    (Savelka & Ashley US segmentation; LegalSeg) instead of hand lists
    — log-odds token mining offline, ship static lexicons. Measuring
    gnomic-present by court level on those corpora is novel and cheap.
C3. Stage 7 ablation (frozen before run): arms on the Stage 6 matrix +
    breadth items — (i) lint-gated cascade: quoted claims free,
    lint-clean paraphrases → checker as today, lint-flagged → checker
    with the fired lint receipts IN the checker prompt; (ii) lint as
    composition feedback: submission returns lint warnings for one
    revision pass, no extra model calls; (iii) incumbent quote_first.
    Gates: no audited-pair regression, checker-call reduction or
    decision-quality gain, lint receipts never alter text.

## Workstream D — the citation web as a framing prior (H9 + H11)

D1. Infrastructure: full-corpus citator build (noteup.sqlite over all
    225k cases — hours, schedule as background); deterministic
    prose-vs-authority-list classifier for edge excerpts (reuse the
    structure machinery's list/ladder detection); journals commentary
    edges (article → case) with body-vs-footnote classification via the
    native page/footnote structure.
D2. Stands-for profiles: per cited case, the prose citing contexts
    (cases) + body commentary contexts (journals), citer counts from
    provider lists, court level, decision date, opinion length. Profile
    quality tiers: rich (many prose contexts), thin (few), none.
D3. Stage 8 ablations (each frozen separately):
    - feed-forward: "other courts cite this case for: …" (top prose
      contexts / parentheticals) in the composition prompt; measure
      framing-rejection rate and audited decisions;
    - lint form: claim content diverging from the stands-for profile,
      weighted by (citer count, court level) — low-citer trial decision
      + rule-register claim + no profile overlap = hot flag (Eli's
      hierarchy prior, operationalized);
    - temporal feed-forward from D1 dates (pairs with C1's lint).
D4. H11 register prior joins here once C2's court-level lexicons exist:
    claim shape permitted per court level, validated on the corpus, not
    hand-asserted.

## Workstream E — small-flags-large-reviews (H8)

E1. Only after C3: replace/augment the lint tier with Haiku via
    `claude -p` as a cheap flagger (flat-rate); ablate lint-only vs
    haiku-only vs lint+haiku on identical cells. Kept last because C
    may make it unnecessary — the literature cascade insight survives
    either way.

## Sequencing and integration points

1. A1 (Stage 6 verdict) — immediate on run completion.
2. B1 (scout integration) — as reports land; B2 corpus build next.
3. C1–C2 implementation + calibration — start now (receipts + free
   corpora suffice to begin); C3 Stage 7 run after A1.
4. D1 full citator build kicked off in background early (it is the
   long pole); D2–D3 after C3.
5. E1 last.

Each stage: pre-registered hypothesis in the experiment log →
implementation with unit tests → run → receipts archived with hashes →
results by amendment → commit. Deterministic components ship with the
same discipline as the rest of Beaver (typed refusals, receipts, no
silent caps). Nothing here touches authority/current-law validation.
