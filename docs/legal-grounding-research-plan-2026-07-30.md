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

B4 (recon finding, 2026-07-30): the Charlotin probe plan as first
    registered ("121 Canadian Misrepresented rows become adversarial
    probes") does not survive contact with the data. Every
    Charlotin-origin row in corpus-v1.jsonl — all 1,426 misrepresented,
    875 false_quotes, 2,964 fabricated — is a PARAPHRASED episode
    description (text_is_paraphrase=true, no spans, no question): they
    identify sanction incidents, not replayable claims, so they cannot
    grow the claim-level positive class directly. The only claim-level
    span-bearing rows today are beaver_receipts (494 grounded / 63
    misgrounded, checker-labeled) and RegLab (176/14, expert-labeled).
    Revised plan: mine the SANCTIONING JUDGMENTS — courts describing a
    fake or misrepresented authority usually quote the offending
    proposition verbatim in the reasons; the Canadian judgments are
    A2AJ-fetchable by origin_id/citation. Extracting those quoted
    propositions yields claim-level positives with judicial (not
    checker) provenance, plus the real authority the filing purported
    to rely on where the court names it. This is local-data-first
    (A2AJ bulk) and needs a small extraction pass, not generation;
    episodes whose reasons do not quote the offending text stay
    incident-level rows and are used only for counts.

Standing directive (2026-07-30): build on existing repos/bases over
hand-rolling, everywhere possible. For the H13 attestation index the
candidates under evaluation are infini-gram (suffix-array exact counts)
and Data Portraits (Bloom membership, the base under QUIP-Score); the
sqlite trigram index ships only as an explicitly-marked interim behind
the corpusAlienness() seam.

US-MATERIALS DIRECTIVE (2026-07-30, Eli): build and validate every
idea, to some scale, against US materials as well as Canadian —
benchmarks, labeled corpora, and the research literature centre on US
law, so US validation is where external evidence lives. Canadian law
remains the main goal; US validation is a requirement, not a pivot.
First concrete act: set up the RegLab expert labels PROPERLY —
retrieve the sources their responses actually cite so the
source-anchored features (claim vs its own purported source) can run
on expert labels instead of only the source-free screens.
`fetch_reglab_sources.py`: eyecite extraction (CourtListener's own
parser; base-repos rule) over the 208 labeled responses → 711 case
mentions / 442 distinct citations (57 responses cite no cases —
statute-only, coverage reported honestly) → CourtListener
citation-lookup + opinion fetch, cached with hashes under
`misgrounding-corpus/us_sources/`.

EXTERNAL VALIDATION — NEGATIVE RESULT (2026-07-30, RegLab slice of the
misgrounding corpus, 174 grounded vs 32 misgrounded/ungrounded
expert-labeled responses): the word-trigram alienness signal INVERTED
(AUC 0.372) and prompt-share was chance (0.550). Diagnosis, recorded
before any threshold ships: (1) reference mismatch — grounded US
responses quote US statutes verbatim, which is maximally alien to the
Canadian reference, so faithful quoting scores alien; jurisdiction-
matched references are REQUIRED (a US reference from CourtListener
bulk / CLERC is the fix); (2) unit mismatch — the signal is calibrated
on claims, these are full responses; segment before scoring; (3) scope
boundary — RegLab misgrounding is largely RELATIONAL (real citation,
plausible register, wrong support), which lexical lint cannot see and
the H12 stands-for machinery targets. H13's validated scope is
claim-level, same-jurisdiction composed-overreach screening; it is NOT
a general misgrounding detector, and no threshold generalizes past
that scope until the jurisdiction-matched, claim-segmented re-test
passes.

RE-TEST — SOURCE-ANCHORED VALIDATION PASSES (2026-07-30, same RegLab
expert labels, sources retrieved): with responses segmented into
claims (`segment_reglab_claims.py`, eyecite full_span citation
masking; 1,704 claims / 766 cited) and each claim scored against the
TEXT OF THE CASES IT CITES (CAP static casebodies; 289/442 citations
resolved, 45 LEXIS/WL out-of-corpus by construction), the shipped
`lintLegalClaim` features discriminate expert-labeled misgrounding:
response-level max-pooled novel_content_fraction AUC 0.829 grounded
vs misgrounded (106 vs 8 responses — n small, stated plainly; 0.703
vs all 15 bad), claim-level 0.637 under weak labels (456 vs 81
claims). Max-pooling beats mean-pooling everywhere, confirming the
one-bad-claim mechanism behind response labels. Claim segmentation
ALONE un-inverted the alienness signal (unattested share max-pooled
0.689 vs misgrounded even against the mismatched Canadian reference;
mean-pooled still inverted) — the prior negative result was unit
mismatch first, reference mismatch second. prompt_only_share holds
directionally (0.635–0.652 max-pooled). Receipts:
us_sources/claim_features.jsonl + manifest.json (hashes inside).
Remaining gates for production thresholds: US-reference alienness
index, and more labeled misgrounded responses (n=8 is a smoke pass,
not a calibration).

JURISDICTION-MATCHED INDEX RESULT (2026-07-30, first gate closed):
rebuilt the alienness reference from CAP bulk volume zips — 17,547
docs / 229M chars across 16 US reporters, seeded stratified volumes
(seed 47), matching the Canadian reference's scale — and re-ran the
identical scorer with ALIENNESS_INDEX_PATH at trigrams-en-us.sqlite
(15.97M distinct trigrams). unattested_trigram_share max-pooled AUC
vs misgrounded rose 0.689 -> 0.781 (vs all bad 0.561 -> 0.625);
mean-pooling and claim-level remain ~chance under weak labels, as the
one-bad-claim mechanism predicts. novel_content_fraction (index-free)
unchanged at 0.829, confirming the delta is the reference and nothing
else moved. Verdict: reference-jurisdiction mismatch was real and
recoverable; H13's alienness prong now validates on expert labels in
BOTH jurisdictions at the response level. The n=8 gate still stands —
no production threshold until more labeled positives exist.

C2 CONFIGURATION DECISION (2026-07-30, three-way calibration over 553
labeled claims, pre-stated rule: best AUC at matched operating points,
ties to boundary robustness then base preference): WORD-TRIGRAMS WIN.
word-trigram 0.694 beats every tokengrams configuration at the current
reference scale — char n=12/16/20/24 = 0.677/0.675/0.659/0.640; GPT-2
token n=3/4/5/8 = 0.624/0.646/0.608/0.588; char n=30/50 saturate
(~100% unattested for accepted and rejected alike). Mechanism: our
230M-char reference sample is ~4 orders below QUIP's web-scale corpus,
so contrast lives at coarse word granularity; the QUIP-canonical long
spans presume a reference we don't have. Two follow-ups queued: (a)
serve word n-grams FROM tokengrams via a u32 word-id stream (word
vocab > 65k), retiring the hand-rolled sqlite while keeping the
winning signal — satisfies the base directive; (b) rebuild the
reference at full-corpus scale (tokengrams makes this cheap) and
re-run this table, since reference size is the binding constraint on
the finer-grained signals. Engine choice (tokengrams, MIT,
Windows-native) is settled regardless; only the stream encoding was in
question. Labels remain checker-derived; the breadth corpus re-test
still gates production thresholds.

## Workstream C — deterministic legal lint (H7 + H10 + H13 + H14)

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
C4. Evidence-layer ensemble & redundancy protocol (added 2026-07-30,
    per Eli's directive — binds C and D):
    No witness is discarded for weak solo performance, and none is
    adopted for strong solo performance. Signals currently at risk of
    haphazard treatment either way: H13 alienness (strong alone),
    H14 prompt gravitation (weak alone, AUC 0.602), citator thinness /
    citer-count priors, court hierarchy, proposition diversity,
    consensus-language-vs-citation-mass inversion, modality/absolutes/
    superlative lexicons, temporal ordering. Any of these may be
    subsumed by another in concert, or may carry unique marginal value
    only in combination — that is an empirical question with a
    protocol, not a judgment call:
    - One feature matrix per labeled claim (misgrounding corpus +
      receipt-derived labels kept separate), every deterministic
      witness a column, citator-derived columns (citer count, court
      level of citing/cited, profile tier, proposition diversity)
      joined from local stores. Zero model calls; the matrix is a
      derived artifact with a manifest hash.
    - Solo report: per-feature AUC/ROC per source class and
      jurisdiction (what we already do).
    - In-concert report: frozen combination rules first (OR/AND of
      calibrated flags, rank-sum) — fitted combiners only with nested
      cross-validation, and any fitted model is a measuring
      instrument for redundancy analysis, never a shipping artifact.
    - Marginal value: ΔAUC (or Δrecall at fixed FP) of adding the
      witness to the best subset without it. Redundancy: a witness
      whose removal changes no subset's performance.
    - Decision rule: ship a witness only on held-out marginal value;
      retire a witness only on demonstrated redundancy in concert.
    - Sample-size gate: at today's positive counts (n=7-8 expert
      misgrounded; n≈51 checker-labeled) all combination verdicts are
      EXPLORATORY and must be labeled so in the log; the protocol
      binds once the positive class grows (Charlotin probes, corpus
      breadth). Exploratory verdicts never retire a witness.

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
    FOOTNOTE-PAIR PRONG (added 2026-07-30): journal footnote citations
    are editor/peer-verified proposition↔authority pairs — for each
    footnote citing case C, the body proposition the footnote anchors
    is an attested characterization of C with editorial provenance.
    All machinery exists: journals-lane native footnote blocks, the
    engine's proposition-per-note-reference extraction (sentence +
    passage-since-prior-note), the ported note-crossrefs module for
    supra/ibid resolution, and ALR's proposition/footnote pairing
    system as the read-only reference design. In-text discussion
    contexts stay the richer signal; footnote pairs are the breadth
    signal (and cover US cases cited in Canadian journals). Ambiguity
    of what a citation supports relative to its proposition is recorded
    per-pair, not assumed away.
    US external complement (scout-verified): CourtListener
    Parentheticals/ParentheticalGroup bulk CSVs (1M+ judge-written
    parentheticals clustered into propositions with frequency+quality
    weights, public domain), LePaRD (21.9M citing-context→quoted-
    passage pairs, CC-BY-NC-SA), δ-Stance (signal polarity), courts-db
    (US court levels) + a ~30-row hand map for A2AJ court codes.
    FOOTNOTE-PAIR PRONG BUILT (2026-07-30):
    scripts/pair_journal_footnotes.py — a lightweight adapter of the
    TFP footnote_pairing_v2 essentials (engine best_chain backbone DP,
    monotone first-occurrence ref assignment, _sentence_at) over the
    public_endpoint.db plaintext export, three label dialects
    (N<TAB>, N.<TAB>, N<spaces>), page map walked as data. Output
    citator/journal_commentary.sqlite (proposition + passage + hashes
    per paired note, case citations keyed for the citator join;
    crossref/truncation/ambiguity witnesses per article). Wired into
    standsForProfile as sourceKind "commentary" (classifier-gated,
    sentence-exact, court prose outranks commentary, null when DB
    absent). Digital-native articles' upstream fn_ref/fn_label
    annotations (journals.db final contracts) become the preferred
    source for those articles once fully registered; the plaintext
    lane is the breadth pass and states its own quality.
    UPSTREAM-PAIRS SURVEY (2026-07-30): oajd/journals.db
    article_final_contracts registers 6,937 packages, ALL resolving
    locally (zero missing) to data/final_contracts/<DATASET>/<vol>/
    <issue>/<article_id>/pages.jsonl with per-page annotations[]
    (taxonomy_name fn_label/fn_ref carrying pair_id/note_id/offsets
    from footnote_pairing_v2, plus fn_crossref); 78/80 sampled
    packages carry pairs. Same article_id space as public_endpoint.db
    (6,710 overlap; 227 absent are MCGILL-LJ-BACKCAT/elias). Includes
    MCGILL-LJ-ERUDIT (454) — the bare-label French lane the plaintext
    adapter deliberately does not handle (a fourth bare-N dialect was
    tried and reverted: page-number furniture shares its shape and
    regressed paired notes 237k->178k). Wiring the upstream lane
    supersedes further plaintext dialect work.
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
