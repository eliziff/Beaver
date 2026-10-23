# Case shortforms experiment

The prepared dataset contains ranked names authors use and a preferred shortform
for every indexed case and available language. Cases without authored labels use
a deterministic generator fitted to the installed journal and A2AJ full texts.
Application behavior is unchanged; this feature lives in `experiments/`.

Runtime generation uses regular expressions, aggregate naming statistics and
numeric decision trees. It makes no LLM calls. Statistical fitting is an offline
development step; lookup and generation do not require the fitting dependencies.

The current experimental pack retains the winning numeric ranker and adds the
expanded initial-form decoder. Its corrected-input comparison, source repairs,
remaining failures and coverage denominators are recorded in
[RESULTS.md](RESULTS.md). Application integration and a full prepared-index refresh
remain separate.

Training targets come from accepted explicit declarations in the source texts.
Generated names are proposals scored against those targets; the compiled
`case_shortform` output table never supplies training gold. A case without an
authored declaration does not become a training example because it has a generated
lookup name. Party-name memory and learned edits also use the source declarations.
Separate base targets may remove supported court/year qualifiers, with the
complete originals and their witnesses retained.

## Browser playground

Open [dist/shortforms.html](dist/shortforms.html) directly in Chrome or Edge. It
embeds the current best model, its training-only party-name memory and the
original Python inference functions. Pyodide 0.28.3 loads from its public CDN;
after loading, names are processed in a browser worker without a server or LLM.
The classic worker supports opening the file directly from disk.

Type one name or paste a whole case title into the single textbox. A plain list
of unique shortforms updates as you type, in model ranking order. Single names
work on their own. Recognized case titles use the existing caption parser;
otherwise the complete input is treated as one name. Authored training-only
party-name memory remains enabled. The shared caption grammar is compiled into
the bundle at build time.

Rebuild from the repository root after changing the selected pack:

```powershell
python experiments/case_shortforms/build_playground.py --party-names benchmarks/local-data/case-shortforms/background-clean-retained-party-names.json
```

`--model` defaults to the installed `model.json`; pass the training-only party-name
memory belonging to that model. The generated HTML lives in the ignored `dist/`
build directory and includes private model data. No source documents or evaluation
records are bundled. The browser page does not alter data or train a model.

## Intended use and responsibility boundary

The intended consumer is an AI writing legal analytical prose. It invokes a
registered case identity and any pinpoint; the engine owns its representation.
The learned short-name model proposes a context-independent base name. It does
not decide whether other citations make that name ambiguous, choose a court/year
qualifier, or manage references throughout a document.

Document-scoped rendering is deterministic. Compare distinct cited identities,
then choose the least additional supported information that distinguishes a
collision group: court, year, both, or a fuller citation when necessary. Different
decisions can share both court and year. A repeated reference to the same case
does not create a collision. Use actual court identity, not just a court level
shared across jurisdictions.

Near collisions need conservative, explicit rules for plausibly confusable names;
generic fuzzy string similarity alone must not trigger widespread qualification.
Compare only authorities in the document, preserve meaningful differences, and
never infer or merge identities from similar display names. Unaffected names stay
unqualified. References retain their case identities so a later collision can
update earlier engine-owned renderings consistently, without text replacement
inside quotations or ordinary authored prose.

Training and evaluation should distinguish an authored base name from its
document-specific disambiguators. Preserve complete declarations and provenance;
derive a separate base target only where decomposition is supported. Unresolved
procedural/topic labels stay visible rather than acquiring invented base labels.
Report target coverage and base-name agreement separately from complete-form
agreement and renderer ambiguity checks. The preliminary development calculation
in [RESULTS.md](RESULTS.md) is not a new model-accuracy gain.

Document-local topic, procedure, date and judge labels are ineligible for base-name
training and accuracy scoring. `evidence.base_name_flag` records those exclusions;
`base_targets.qualify` preserves the complete evidence and builds a separate
eligible target set. Corrupted party fields containing judgment prose cannot
justify a name through an accidental word match. Unresolved input/name relations
also remain flagged for source repair. A case with another eligible name stays
evaluable; a case without one contributes to the coverage report, not the accuracy
denominator. Exclusion is not evidence that a difficult naming problem is solved.

This is the intended integration contract. The experiment's current `disambiguate`
helper handles exact normalized collisions by appending the full citation; minimal
court/year qualifiers, near-collision handling and application integration remain
to be implemented using the existing registered-evidence and rendering paths.

## Objective: approach the attainable information limit

Develop the non-LLM base-name generator until it eliminates at least 95% of
reducible error relative to a frozen comparable baseline and comes within one
absolute percentage point of a defensibly estimated attainable ceiling. The
earlier fixed 80% target is retired. The present ambition is mid-to-high-90s
agreement if supported by the validated input/target contract, not stopping at
an arbitrary milestone. Document disambiguation remains outside the model.

Let `A0` be baseline accuracy and `C` the attainable accuracy under the same
fixed inputs, targets and population. The operational objective is
`C - A <= min(0.01, 0.05 * (C - A0))`, with uncertainty in `C` reported.
Establish the contract and validate base-name targets first. Preserve original
authored declarations and report unresolved target coverage explicitly.

Prefer the name most often used in the source documents, while retaining lesser
credit for less common attested names. Popularity-sensitive ranking and modal-name
agreement are primary; any-attested-name agreement is secondary. Tied modal names
receive equal credit. Validity and preference are separate: author disagreement
does not make a valid alternative a data error, but document frequency can
establish a preference among alternatives. LambdaRank uses integer relevance
labels whose [linear gains](https://lightgbm.readthedocs.io/en/stable/Parameters.html#label_gain)
equal independent source-document counts. Development
stopping uses modal-name agreement; relative document support and any-attested
agreement break ties between fitted stages. No generated name supplies a target.
LambdaRank normalizes each choice set internally; row weights are uniform so a
larger proposal pool does not reduce a case's influence a second time. Reordered
initials can be legitimate publication-ban naming conventions. Preserve their
authored targets unless source evidence establishes a concrete error.
Eligibility accepts names containing the same initials in another order when
at least one spelling has explicit initial structure. Dotted and compact
spellings have the same eligibility; their authored strings remain unchanged.
Reordered initial spellings do not transfer through exact-party memory.
The editor learns position patterns and reusable initial
block movements from at least two training cases; training uses grouped
out-of-fold programs. Reordering proposals retain every initial and do not enumerate
arbitrary permutations. Moving a parenthesized block or the final initial to the
front can transfer across initial counts.
Paired names can also copy the outer initial block from a parenthesized anonymous
party, without changing its stored name.
Neither current candidate coverage nor a label-aware finite-sample oracle is a
population information limit. Identical inputs with incompatible target sets
provide evidence of ambiguity; sparse labels, erroneous ownership and incomplete
caption/qualifier recovery can also create apparent conflicts. Merely supplying
more identifying metadata can raise a finite-sample oracle without showing that
a model can learn the mapping for unseen cases.

Use independent source evidence, repeated-document analysis and source-aware,
case-grouped validation to estimate the limit and audit residual errors. Improve
target recovery, input fidelity, reusable naming operations and ranking while
there remains demonstrated reducible error. Do not classify a hard example as
irreducible solely because existing models miss it. Final completion needs a
validated improvement and a supported residual-gap estimate on data reserved
from strategy selection; recycled evaluations cannot establish that claim alone.
No model-service inference or new tests are part of the current session.

## Execution plan

Work in the following order. Each stage produces a usable artifact or a measured
decision; source review and model searches must not become open-ended substitutes
for implementation. Private inputs and receipts remain in the existing ignored
`benchmarks/local-data/case-shortforms/` directory. Application integration follows
validation of the experiment.

1. **Fix the learning contract and establish a comparable baseline.** Preserve
   complete declarations, derive separately supported base names and qualifiers,
   and record unresolved decomposition explicitly. Begin with source review of
   400 independent witnesses: 200 transformed labels, 100 unchanged controls and
   100 conflicting-input examples, split into rule-development and held-aside
   validation packets. Weight estimates by their population strata. Expand only
   where uncertainty could account for the proposed improvement. Do not turn a
   procedural label into an invented base name or remove a year embedded in a
   party's actual name. Record caption, language and fixed case fields available
   to the model; exclude document collision information. Re-score the frozen
   model and fit one unchanged-recipe control on these targets. Report base
   agreement, target coverage and the original complete-form score separately.
   Owners: `evidence.py`, `training_data.py`, `analyze.py`, existing source review.

2. **Reserve credible final evidence before more selection.** Inventory local
   sources for case targets that have never entered a fit or strategy decision.
   If none provide a sufficient independent tranche, obtain a later public source
   tranche through existing ingestion. Freeze its manifest before inspecting
   errors. A reshuffle of the repeatedly used test is not fresh evidence. Hold
   case/language and litigation-family groups together; remove held-out cases and
   declaration documents from training labels, encodings and relevant background
   counts. Include both new cases with familiar parties and genuinely unfamiliar
   parties, reporting these separately. Keep the historical test as a regression
   reference. Size the final tranche for the residual-gap claim, accounting for
   grouping rather than choosing a convenient fixed number of rows.

3. **Repair input losses and turn misses into operation supervision.** Inspect
   the 1,438 conflicting party-input groups to separate real ambiguity from
   citation ownership, incomplete captions and incomplete label sets. Start with
   known parallel-citation metadata loss and supported missing caption words;
   measure their reach before broad extraction work. Preserve all supported
   party-name variants and provenance without merging distinct decisions. Align
   training base labels to parties and extract reusable operations: copying
   spans, selecting a name head, dropping words, joining noncontiguous pieces,
   abbreviation/initial formation, initial-order changes and supported lexical
   alias substitutions. Retain uncertain alignments as uncertain. Build the
   operation vocabulary from training only; development diagnoses generalization.
   Owners: `prepare.py`, `party_alias.py`, `training_data.py`, `operations.py`.

4. **Replace the fixed-span proposal bottleneck with learned edit programs.**
   Start with a compact token-edit decoder and short beam, combining copied
   tokens with training-supported abbreviation and alias operations. Retain the
   current generator as the measured control. Extend existing party-name memory
   to supported caption variants and multiple plausible names; never retrieve a
   held-out case's own declaration. Score every output with the same complete
   features, avoiding the approximate feature fallback used by earlier expanded
   pools. Fit base-name choices jointly: do not freeze a losing party or stem
   before shortening. Compare the control, edit decoder and decoder with party
   memory, then add specialist person/organization scoring only if error evidence
   warrants it. Use case-balanced graded supervision: source-document support
   rewards the modal name most while retaining credit for other authored names. Reuse the
   small numeric models and grouped encodings; no LLM inference or generic neural
   generator is required. Owners: `shortform.py`, `analyze.py`, `party_alias.py`.

   Measure candidate reachability and selection accuracy separately. If a correct
   base cannot be proposed, fix the operation or input; if it is proposed but
   loses, improve selection. A larger pool alone is not a successful experiment.
   For every change, record paired gains/losses, affected family, unsupported
   outputs, latency and size on the same development cases. Admit complexity
   only for a reproducible net benefit, not an isolated favorable slice. Recompute
   the remaining error budget after a winner; investigate the largest remaining
   recoverable family before the next bounded batch of hypotheses.

5. **Implement deterministic document naming separately.** Extend the existing
   `disambiguate` operation to select sufficient court/year qualifiers, with full
   citation fallback when court and year still collide. Add conservative near-name
   rules after examining confusing pairs and unrelated negative controls; generic
   edit distance is not sufficient. Verify exact collisions are resolved, repeated
   identities are consistent, unrelated names stay unqualified, and adding a new
   case updates all engine-owned references. Reuse the registered-evidence,
   authority-identity and rendering paths for later integration. Qualifier logic
   and document features never enter the base-name model's objective.

6. **Demonstrate saturation, then promote.** Freeze the winning model, target
   rules and renderer before final evaluation. Compare against the stage-one
   baseline on identical inputs and use source-aware grouped uncertainty. Audit
   residual errors against source evidence and distinguish acceptable unobserved
   names, input defects, missing information and remaining algorithm errors.
   Report conservative bounds when target or ceiling uncertainty is unresolved;
   finite-sample oracle percentages cannot certify completion. Claim the near-limit
   goal only when the residual-gap criterion is supported on reserved evidence.
   Otherwise continue from the largest demonstrated reducible error family.
   Promote a validated winner, refresh canonical prepared names once, and verify
   compiled/source provenance. Native extraction changes additionally require
   their owning independent corpus gate; the unavailable historical extraction
   binary is not evidence of current native equivalence.

The first execution batch is stages 1 and 2 plus a training-only operation
inventory. Its deliverable is validated supervision, a frozen control/evaluation
manifest and a ranked list of transformations for the first decoder experiment.
Do not run another unchanged complete-form refit, generic feature sweep or
document-context learning experiment. The existing negative results already
cover those directions. No new test files are required in this session; use
source-backed evaluation and the existing relevant validation paths.

The source-review packets now contain 400 case/source-disjoint witnesses, divided
equally between discovery and held-aside projection validation. All 100 transformed
validation names support the frozen trailing court/year decomposition. These are
Codex source judgments, not independent human gold; they do not establish the
validity of every target or a population accuracy ceiling. A later scope audit
also found and excluded a document-local label that had matched judgment prose in
a corrupted party field. Its earlier control fit is superseded, not a result.

`base_batch.py` freezes eligible targets and fits an unchanged-recipe control and
a learned editor on the same development cohort. `edit_decoder.py` learns word
deletion, noncontiguous copying, attested abbreviation, initial selection and
two-party naming programs. Training uses programs learned outside each case
group's fold. New outputs receive the full candidate features, including their
source word coverage and boundaries; they do not borrow another name's feature
vector. The editor treats every eligible alternative as positive and balances
cases during fitting. The original generator's candidates and feature values are
unchanged on all 5,263 corrected development cases (27,326 candidates).

The reserved-source manifest contains 1,188 new text/language entries in 1,156
documents. `fresh_evidence.py` excludes documents already used in another
language, mines a prediction-blind target inventory, and excludes previous gold
cases and known litigation families. Final source review, source/family grouping,
background exclusions and sufficient sample size remain necessary before scoring.
Neither historical test rows nor this candidate inventory are final proof.

The original-proposal base control scores 4,140/4,688 eligible development rows.
The first learned editor reaches more targets but scores 4,097; it is not
promoted. A matched pair holds set-valued targets and case weights constant:
4,134 matches for the control and 4,121 for the editor. Direct review finds that
75 of the first editor's 76 regressions select a different existing candidate;
only one selects a newly proposed form. These results call for repairing inputs
and selection, not declaring learned editing exhausted. Weights are normalized
to mean one so the fixed L2 penalty retains its scale. [RESULTS.md](RESULTS.md)
records the comparable denominators, gains/losses and uncertainty.

The active batch repairs clear source/input errors before further modeling.
`prepare.qualify_profiles` removes captured publisher headers, citation spillover
and introductory prose, repairs physical wrapping with attested spellings, and
preserves genuine hyphens. Several joined proceedings retain their caption and
authored declarations but do not supply a fictitious single party pair. Captured
judgment prose supplies no caption. Source-backed corrections and rejections
retain source hashes and spans in the private index; raw evidence stays intact.
The same qualification runs when rebuilding or refreshing prepared data.
Alternative-name adjudication and manually expanding accepted target sets are
deferred. The repair passes preserve the installed weights; separate desktop
refits measure behavior on their frozen inputs.
Seven source-verified parallel-citation declarations now belong to their known
provider cases. Two further primary-source-confirmed spelling errors are excluded,
and verified parallel links retain reporter years and resolve indexed lookups.
Uppercase C/V initials are no longer mistaken for the case separator when the
caption supplies a lowercase `c` or `v`. Source-verified caption repairs also
remove captured headings/citations and correct corrupt website headers. This
repairs 1,443 more profiles, including four labelled profiles across training,
development and historical test, without changing their authored labels.
The residual source review repairs another 301 profiles: 269 complete-caption
corrections, 27 additional detached-separator corrections, and five unusable
captions withheld from name generation. Full procedural captions can retain
their separately verified party pair. Another 18 source spellings are now
corrected against original printed PDFs. The repair preserves authored labels.
The timed cleaning snapshot is `case-shortforms.qualified-inputs.v26`, frozen at
08:00 Edmonton on 2026-10-18. The authorized follow-up advances the canonical
revision to `case-shortforms.qualified-inputs.v32`. The private
`data-cleaning-inputs.json` contains corrected training and held-out rows with
previous partitions preserved and conflicting components quarantined. The
ordinary fitting and review paths honor those saved assignments. The current
58,993 rows comprise 41,024 train, 5,549 development, 11,507 historical test and
913 quarantined rows. Corrected groups retain their exposure history; a group
joining training and held-out components is quarantined. Earlier v3 and v8
comparison inputs and denominators remain historical artifacts.

Subsequent direct source review corrects footnote ownership, OCR and encoding,
missing caption words, slash-containing names and false opposing-party pairs.
It preserves genuine incorporation years and valid multilingual names. The last
six declaration passes through the cutoff exclude 239 reviewed non-name, corrupted or wrongly cited
observations and recover 97 literal authored names from captured declaration
wording. Raw texts, names, citations and locators remain intact. No generated
shortform becomes a training target. These repairs apply to training and held-out
data; they do not establish that every remaining record is correct.

The follow-up applies 17 more profile operations, excludes a court-label
declaration and rebinds one authored declaration plus its named reference to an
existing source-confirmed decision. This repairs a duplicate decision that
previously spanned training and historical test; its combined exposure is
quarantined and both citation forms resolve to the same prepared record.
Three further unsupported reporter profiles are withheld. A real-data audit
also supports rejecting unattested shortened phrases ending in lowercase
`pour`, while preserving complete or attested names. All 124 potentially
affected stored identities are refreshed with the installed weights.

Revision v30 applies 345 source-reviewed caption operations, including 29
unsupported bindings withheld rather than assigned a neighboring caption. It
excludes two non-name observations and moves four qualified observations to
existing source-confirmed cases. Original spellings and raw evidence stay
unchanged. Review distinguishes footnote counters and table columns from genuine
numbers inside company names. Broken shortened fragments are rejected when they
leave unmatched brackets or end inside a prepositional phrase; complete and
attested names remain valid. Stored malformed names and source/party-name
dependencies are refreshed across 1,755 case identities. Valid stored
recommendations are not globally reranked. Legitimate differences in authored
name length are expected variation, not defects to clean or reasons to add
individual alternative labels.

Reviewing the new v30 model's failures finds seven further source-confirmed
caption repairs, applied in v31 without changing authored targets or partitions.
Corporate suffix removal now preserves a suffix needed after a conjunction,
and candidate spans keep Unicode hyphens inside a name token. This prevents
dangling ampersands and cuts inside nonbreaking-hyphen names. Another 2,944
affected identities are refreshed; complete source-confirmed proper names that
resemble function words remain valid.

The retained-queue review then reads all 283 unchanged caption rows. Revision v32
repairs seven further records, including four footnote/section-boundary errors,
a lost party-name opening, a duplicated company word and a Roman numeral
transcription. It refreshes 628 affected identities and leaves source-authored
targets and partitions unchanged. The current pass totals 359 caption/profile
operations across v30–v32. Exact frozen training/development records and the
model's background are unchanged by the last seven nonprimary-caption repairs,
so the new v31 fit also applies to the final v32 training inputs.

An unresolved reporter-numbering defect can merge annual Ontario Reports cases
from different years under the same volume/page key. Confirmed conflicting
caption bindings are withheld. The raw identity index has not been rebuilt, and
native equivalence remains unverified. This is a remaining data/identity issue,
not evidence that a naming method is exhausted.

Background name statistics now consume the qualified primary-provider party
profiles rather than reparsing raw stored captions. Their deterministic text
selection still excludes every accepted-declaration document and case. The
background input stream can be frozen and compiled on the desktop without
copying complete provider databases. A new matched control/editor refit uses
these inputs. The frozen v8 `qualified-refit-*` artifacts and final v26
`cleaned-refit-*` artifacts remain separate from the installed model and older
comparisons. The v26 run reuses only the 4,000 real document texts from the frozen
v8 background, verifies their hashes and current declaration exclusions, and
rebuilds all 164,368 background caption rows from current qualified profiles.
Both v26 models are trained. The control was the selected v26 private candidate;
the installed model remains unchanged because the reused historical comparison
does not demonstrate improvement. Detailed misses, paired changes and remaining
input issues are recorded in [RESULTS.md](RESULTS.md#desktop-refit-on-frozen-v26-inputs).

A matched inference diagnosis removes the party-map confound. Four subsequent
fits isolate ranking-stage training inclusion and a direct ranking objective.
Restricting the editor's ranking choice sets recovers 26 development matches
versus its full-cohort fit; LambdaRank gives the highest development agreement
in that batch. The installed model remains ahead on its reused historical
comparison. The selected recipe has been refitted on v29 after source repairs
and duplicate-decision quarantine, under a separate `final-cleaned-refit-*`
protocol. It gains seven development matches but loses 24 historical matches
against installed weights and remains unpromoted. The remaining errors include
input defects and legitimate authored naming variation; this does not establish
the task's attainable ceiling. See the
[final comparison](RESULTS.md#final-desktop-refit-on-frozen-v29-inputs).
These comparisons use authored targets throughout. New fits remain separate
from installed weights and from the unscored fresh source reservations.

After the v30–v32 caption and boundary repairs, the new desktop fit matches
4,027/4,552 development targets (88.47%) and 8,234/9,437 reused historical targets
(87.25%). Only the newly trained model is scored in this pass. Its exact
training/development inputs and background are unchanged by the last v32 source
repairs, so another identical fit is unnecessary. Remaining name-form differences
include legitimate variation; no per-case alternative gold is added. The new
model remains separate from the installed weights. See the
[current results](RESULTS.md#new-desktop-model-on-the-final-cleaned-inputs).
Only the current best experimental model is kept. Historical results remain,
but their superseded weight files are discarded at the user's request.

Long fits and corpus jobs run on the desktop through the configured Tailscale SSH
alias. Transfer only frozen code/inputs and verify hashes before execution; keep
the same relative paths in its durable training directory. Reuse the existing
training environment, including the pinned LightGBM version. Private execution
receipts record the actual host and runtime. Keep heavy runs sequential.

The additional bulk reservation freezes 58,786 unused texts from CITT, ONCA, RAD
and RPD before target mining. It reads their canonical provider Parquet files,
including rows absent from the citation-key index, without changing the installed
provider store. `fresh_evidence.py --fetch-reserved` materializes the same verified
files on the compute host. Its optional frozen metadata-only SQLite inputs avoid
copying the full provider text database. Unknown reporter keys do not acquire
case identities. Target/source review and achieved independent sample size still
govern whether this tranche can support final evaluation.

```powershell
python -X utf8 experiments/case_shortforms/base_batch.py reserve
python -X utf8 experiments/case_shortforms/base_batch.py review
# Preserve and complete the source judgments before freezing targets.
python -X utf8 experiments/case_shortforms/base_batch.py freeze
python -X utf8 experiments/case_shortforms/base_batch.py operations
python -X utf8 experiments/case_shortforms/base_batch.py control
python -X utf8 experiments/case_shortforms/base_batch.py editor
python -X utf8 experiments/case_shortforms/base_batch.py freeze-set
python -X utf8 experiments/case_shortforms/base_batch.py set-control
python -X utf8 experiments/case_shortforms/base_batch.py set-editor
python -X utf8 experiments/case_shortforms/fresh_evidence.py
python -X utf8 experiments/case_shortforms/fresh_evidence.py --reserve-bulk
# On the compute host, materialize the already-frozen sources before mining.
python -X utf8 experiments/case_shortforms/fresh_evidence.py --fetch-reserved --manifest base-final-bulk-source-manifest.json
```

Private outputs retain one current comparison and its input/code hashes. Reviewed
packets and final manifests refuse accidental overwrites. Canonical model/data
replacement follows validation; these commands do not promote a candidate.

## Use the prepared data

The database is stored once at
`%LOCALAPPDATA%/OpenLegalData/cache/case-shortforms/shortforms.sqlite`.
It contains case identities, cleaned captions, ranked aliases, evidence counts
and preferred names. It stores no full document bodies.

```powershell
$env:LEGAL_STRUCTURE_NATIVE=(Resolve-Path 'native/legal-structure-node/target/release/legal_structure_node.dll').Path
python -X utf8 experiments/case_shortforms/lookup.py '<case-key>' --top 5
python -X utf8 experiments/case_shortforms/lookup.py 'New Cedar Homes Ltd v Aster'
```

Replace `<case-key>` with an indexed identity from the SQL query below. The
caption is independently invented. The CLI also accepts formatted
citations and full captions with citations. A key or `a2aj:<id>` needs no native
call. Indexed lookup reads only the prepared database; it does not reopen source
texts. New captions use the frozen generator and evidence about the same party
from other cases. Ambiguous citations or repeated captions return candidates
instead of choosing a decision. Language fallback reports the returned language.
A missing caption returns an explicit citation fallback with review required.

Python consumers can import `lookup(connection, key, language="en", top=10)` and
`lookup_style(connection, style)` from `lookup.py`. Batch consumers can query:

```sql
SELECT c.identity, c.citation, s.language, p.style, s.shortform, s.method
FROM case_shortform s JOIN case_record c ON c.id=s.case_id
LEFT JOIN case_profile p ON p.case_id=s.case_id AND p.language=s.language;

SELECT spelling, definition_documents, reference_documents, document_count
FROM case_alias WHERE case_id=? AND language=?
ORDER BY document_count DESC, definition_documents DESC, length(spelling), normalized;
```

`case_shortform` distinguishes `observed`, `observed_single`, `generated`,
`generated_attested_party`, `title_generated` and `citation_fallback`. An observed
name has at least two independent declaration documents; a single-source label
is explicitly marked. Counts describe evidence, not calibrated confidence.

## Build and refresh

Use the existing native addon and local datasets from the repository root. The
addon and screen grammar must agree. No new dependency or native build is needed.
The installed database is already prepared; rebuilding is not required to use it.
Use one native artifact for the entire pipeline; its SHA-256 is recorded in
`meta.engine`. Concurrent builds can replace the canonical DLL. Continuing an
existing run requires the matching immutable copy retained in the canonical
build directory, held loaded until validation finishes.
For replacement, mine to a separate `--output` path and pass it as `--database`
to the remaining stages. Validate it before replacing the installed database.

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:LEGAL_STRUCTURE_NATIVE=(Resolve-Path 'native/legal-structure-node/target/release/legal_structure_node.dll').Path
python -X utf8 -m unittest discover -s experiments/case_shortforms -p 'test_shortforms.py'
python -X utf8 experiments/case_shortforms/mine.py
python -X utf8 experiments/case_shortforms/prepare.py
python -X utf8 experiments/case_shortforms/training_data.py
python -X utf8 experiments/case_shortforms/analyze.py --evaluate test
python -X utf8 experiments/case_shortforms/prepare.py --refresh
```

`mine.py` defaults to every nonempty installed text. `--every N --limit N` is an
explicit pilot. Paths follow `open_legal_data_bridge.data_root()` and existing
provider configuration; journal discovery can follow the installed FTS index's
`source_path`. Explicit `--journals` and `--a2aj` overrides are available.

`prepare.py` recovers captions from full-text witnesses, cleans declarations,
resolves parallel/history ownership and compiles the prepared tables.
`--refresh` reapplies label qualification, repairs supported inconsistencies
between cached party fields and their caption, rebuilds ranked aliases, and
recomputes preferred names and party-name evidence without reading source bodies.
It also applies a newly fitted generator when one has been selected.
`--evidence` revalidates all declarations after ownership
changes while reusing recovered captions. Current timings are in [RESULTS.md](RESULTS.md).

`verify.py` reads and SHA-256 hashes every installed full text, checks ordered
streams, export metadata, discovery code, prepared generation and citation engine,
and reuses the index only when they match. Changed source texts or the engine
require extraction again. Its receipt also reports retained excerpt/caption errors.
Cold mining still misses the requested few-minute
budget; hash verification does not discover new evidence. The strict default
also requires the original native binary. For model-only work on the qualified
snapshot, `verify.py --sources-only` checks all source streams, export metadata
and compiled code/model fingerprints. Its receipt explicitly leaves current
native-engine equivalence unchecked. This narrower check does not replace the
strict gate for extracting or certifying a current native index.

Private reports and source-review packets live in ignored
`benchmarks/local-data/case-shortforms/`. The included `model.json` contains
numeric trees, aggregate provenance and lexical statistics. It contains no case
IDs, source passages or document histories. Raw discovery, source preparation and subsequent generation
retain their code fingerprints in the private index.

## Data-quality corrections and historical scores

The common-issue passes exclude translation headers, PDF page markers, judge
attributions, publication-status notes and editorial instructions from usable name declarations. Raw
observations and source witnesses remain in the index. Genuine local labels,
brands containing language words, anonymized names and author spelling choices
are retained. Caption repairs remove supported citation/signal spillover and
restore words from the existing caption; a fuller supplied name survives an
abbreviated caption. Ambiguous caption/identity disagreements require review.
When an author supplies a name followed by a comma and a judge attribution,
qualification keeps the supplied name. A later declaration absent from raw
extraction is not invented or assigned the earlier annotation's span.
Delimiter checks cover accepted declaration observations as well as displayed
Gold names. Label cleanup removes a surrounding bracket pair only when it wraps
the whole label, preserving internal year qualifiers and initial groups.
Unmatched delimiters are ineligible until source review repairs them. Reviewed
declaration corrections retain their original observation keys and source
witnesses and apply again during preparation and refresh. These repairs do not
change the order of anonymized initials.

The original 61,020 qualified case/language rows, captions, aliases and grouped
split assignments are frozen in private `gold-original.json`. Historical
accuracy and earlier feature caches refer to those inputs. Current qualification
produces a corrected cohort, identified by `meta.data_quality` and its input hash.
Changing that cohort is not a model accuracy gain. Current model selection and
its corrected-input scores are recorded in [RESULTS.md](RESULTS.md). The following
controlled comparison is historical.
`word-background.json` owns the current unlabeled statistics. Declaration changes
must preserve exclusion of all labelled cases and source documents; older,
more conservative exclusions can remain. A restored labelled case must be removed
from the caption catalogue before fitting.

The controlled comparison freezes the unchanged recipe and scores both models
on identical corrected rows and inputs: 74.25% for the existing model versus
74.19% for the refit on 10,800 reused test rows. Repair-created party-pair links
are unioned with original groups; 50 components crossing original partitions
(240 usable rows) are quarantined. The paired interval crosses zero, so the
candidate remains private. Original feature caches and historical denominators
remain tied to `gold-original.json`.

Backward analysis finds 867 development rows without an exact complete authored
candidate and 429 with a correct candidate that loses ranking. The next model
work is to derive validated base-name supervision and learn recurring shortening
operations from the remaining misses. Document-dependent disambiguation belongs
to the deterministic renderer described above, not to the trained model.
See [RESULTS.md](RESULTS.md) for the complete-form and provisional base-name counts.

Private `data-quality-*` receipts retain source checks, exact approved deltas,
the original input fingerprints and final validation. See [RESULTS.md](RESULTS.md)
for counts and remaining limits.

## Bounded representation and source-audit probes

`operation_probe.py` tests a shared canonical-name score with conditional scores
for complete rendered names. It consumes the retained private feature caches from
the frozen earlier form/word probes, whose hashes are saved before fitting. The
canonical component is auxiliary supervision; exact scoring still requires a
complete original authored label. Joint decoding considers every name/form
combination. This probe uses citation metadata and is not the installed generator.

```powershell
python -X utf8 experiments/case_shortforms/operation_probe.py check
python -X utf8 experiments/case_shortforms/operation_probe.py prepare
python -X utf8 experiments/case_shortforms/operation_probe.py fit
python -X utf8 experiments/case_shortforms/review.py --gold-development --count 120 --output benchmarks/local-data/case-shortforms/blind-gold-review.json
python -X utf8 experiments/case_shortforms/review.py --annotation-audit --output benchmarks/local-data/case-shortforms/annotation-audit.json
```

Use the one-thread environment above for fitting. The probe declares a two-point
development gate before fitting and does not automatically score holdouts or
replace the generator. Both declared variants failed that gate. The gold-review
command prepares the latest private packet and refuses to overwrite completed
source judgments. It samples one alias per
development case/language, chooses a source independently, verifies its full-text
hash and omits predictions/captions from the packet. Source review found genuine
non-name annotations as well as valid unusual declarations. Annotation flags
identify review candidates and never alter the corpus, gold or denominator.
See [RESULTS.md](RESULTS.md) for the decomposition, results and audit limits.

## Evidence and storage

The shared `legalpdf.grammar_tables` compiler and `AnchoredPattern` screen complete
texts. Known provider spellings reuse the installed citation lookup; novel
registered forms are verified once. Small excerpts are batched to the existing
citation engine. Full documents do not go through native RPC during mining.

Three evidence tiers remain distinct:

- `definition`: an authored bracketed or quoted declaration by a full citation.
- `named_citation`: an authored abbreviated name by a full citation.
- `named_reference`: a named supra uniquely tied to an earlier declaration or a
  whole party-name sequence in that document.

Only accepted authored definitions train the generator. Parser-inferred
`shortName` values never become targets. `evidence.py` removes declaration
introducers and excludes translation notices and generic local roles.
`prepare.py` follows history through unkeyed parallel citations and equivalent
French leave wording. Bare court markers require a matching party name or acronym,
preserving genuine initials. Conflicting
known provider identities are quarantined; an unresolved underlying decision
cannot silently become a name for its leave decision. References inherit the
accepted declaration's identity or its rejection. Forward and ambiguous
references do not become links. Court-qualified declarations recognize the
registry's translated and dotted court forms. Caption preparation removes
unambiguous footnote markers, citation signals and a trailing known citation.

Raw `case_record`, `case_key`, `case_name`, `case_seen`, `alias`, `observation` and
`source` retain the inventory, original witnesses, spans, source identifiers,
full-text hashes and occurrence counts. Prepared `case_profile`,
`clean_observation`, `case_alias`, `party_shortform` and `case_shortform` contain
cleaned captions, resolved evidence, document counts and selected names. Raw
`alias.reusable` is only the miner's initial screen; preparation owns the final
qualification.

Votes count independent documents. Exact duplicate texts, including repeated
language columns, do not receive extra votes. Alias lists rank independent
usage; the preferred name is the highest-ranked declaration. Length is a ranking
feature rather than a hard limit that excludes longer authored names.
Authority identities are never inferred from a short name. `disambiguate` appends
the citation when different authorities share a name in a document.

## Generation and evaluation

The generator preserves full parties alongside cleaned cores, contiguous spans,
surnames, parenthetical names and supplied anonymized initials. Learned proposals
copy nonadjacent words, form initials, apply training-supported abbreviations and
combine both parties. Hyphen components and Crown names can compete. Bracket
balance and complete endings are enforced when constructing proposals. Length,
weak openings, numeric fragments and partial initials are scoring features.

A numeric tree ranker uses 124 features covering name shape, word retention,
party selection, attested names and construction operations. Word decisions depend on position, party
type and neighboring words; party-selection statistics also consider the
opponent type. Phrase rates and label frequencies capture author-used word
sequences, while boundary statistics learn where those sequences begin and end.
These are case/language observations, not independent document support or
calibrated confidence. Word statistics back off to party-type priors. Lexical
statistics and exact-party name evidence use five folds of case/party-pair groups: each
training row's values come from the other folds. Inference uses statistics from
all training rows. Generic/weak-token sets use the complete training partition.
The included JSON model contains numeric trees with stable tie breaking.
Training word counts are regenerated with `training_data.py` into ignored
`benchmarks/local-data/case-shortforms/word-background.json`; `--background` on
`analyze.py` selects an explicit artifact. The recipe hash-verifies 4,000 corpus
documents and excludes all documents with accepted declarations. Separate primary
provider-name counts exclude every accepted-declaration case. Regenerate these
counts when the corpus or declaration set changes. Individual source witnesses
stay private; the saved generator contains aggregate dictionaries and hashes.

Word-retention statistics use unambiguous name components for learning, including
known citation-year/court suffixes. Acronym-only labels contribute to party and
phrase statistics without counting as dropping every name word. All training
ranking targets and evaluation labels retain the complete authored forms.
Exact-party transfer also retains original declarations. Both numeric-tree stages
use all features; the second refines the first stage's scores. Development chooses
each stage's stopping round using modal-name agreement.
Lookup and generation need neither a model service nor LightGBM/NumPy. Fitting
uses the existing local [LightGBM installation](https://lightgbm.readthedocs.io/en/stable/Python-Intro.html)
and NumPy, one thread, seed 51273. Every export is checked against the training
library on all development candidates.

An author-used whole-word name or acronym from other training cases becomes
a candidate with features describing its case count, independent document count
and vote share. It competes in the same ranking as the other names. Development
selects the evidence policy, including whether one-case/one-document evidence
helps; a single witness is evidence, not a guaranteed replacement. Anonymous
initials never transfer between cases. This is lexical name reuse, not an entity
merge. Additional initialisms are formed from caption words and judged against
authored training targets. The learned editor and its statistics use the same
training-only folds as name memory. Paired-name separators use authored language
statistics. Nonadversarial titles have a separate title rule; unresolved names
use a citation fallback.

Evaluation groups all languages of a case and all cases sharing an exact ordered party
pair into the same SHA-256 70/10/20 split. Ordinary development additionally
reserves one fifth of the original training groups using the independent
`case-shortforms-audit-v1:` hash prefix. Generic words, weak openings, word
statistics and transferable party names use only the remaining training rows.
The default command fits and reports development results without scoring either
holdout:

```powershell
python -X utf8 experiments/case_shortforms/analyze.py --model benchmarks/local-data/case-shortforms/candidate-model.json
```

Freeze the strategy before using `--evaluate audit`; it fits without those audit
groups and scores them. `--evaluate test` refits on all original training rows
and scores the historical test. The audit comes from historical training
data, not newly collected documents. Both the audit and historical test have
already been scored in earlier rounds and are reused evaluations. Candidate
strategies use training/development evidence; their errors must not select
subsequent strategies. Repeated tuning on either evaluation would invalidate
that separation.

Development selects the boosting round and party-name policy. Unsupported
candidates stay in accuracy denominators. Title generation is outside the
two-party evaluation. The `alias_supported_by_two_documents` slice requires
at least two documents to use the same modal alias; `at_least_two_documents`
also includes cases whose documents use different aliases. Neither slice is
overall accuracy.

The analysis also measures leave-one-document-out naming agreement, using only
training/development labels. It predicts each document's label from the other
documents about that case. Case/language and document-weighted averages have
different denominators; this is a naming-variation diagnostic, not a ceiling.

The analysis receipt records the index at fitting time; `quality.json` measures
the compiled names after refresh. Pass `--baseline` with a private analysis
receipt to compare frozen predictions on common held-out identities/languages.
Both outputs are scored against current qualified labels, excluding groups
containing a previous training/development identity. Paired intervals resample
case/party-pair components, not individual language rows. They do not model
correlation between different cases cited in the same document. Results and
limits are in [RESULTS.md](RESULTS.md).

```powershell
python -X utf8 experiments/case_shortforms/quality.py
python -X utf8 experiments/case_shortforms/audit.py --count 128
python -X utf8 experiments/case_shortforms/review.py
```

`quality.py` measures every prepared name, samples cases without aliases and
benchmarks 10,000 indexed lookups. `audit.py` compares screened declarations with
full native extraction on a fixed sample; it measures parser agreement, not
independent gold. `review.py` prepares accepted source witnesses with fixed seed
60281 and verifies their hashes. Independent source judgments belong in the
private packet. The packet includes the parser's proposed label and authority;
reading it is a source check, not a blinded precision estimate. Rerunning a
harness replaces its latest output.

Caption quality is separate from bounded-name checks. The latest unaliased
sample contains known title and caption-input defects, including an anonymous
name truncated before generation; [RESULTS.md](RESULTS.md) records them. Title
shortening is outside the two-party score and has known weak outputs.

Recognition remains bounded by the shared grammar and registry. Bare mentions
without a citation/reference marker are not mined. An exhaustive character pass
cannot recover a name absent from the available witnesses. Authored agreement
measures imitation, not all acceptable names. A2AJ `en`/`fr` are text columns;
journal `en` is routing metadata, not a language classification. Sources are the
existing A2AJ bulk installation and journal public-endpoint export; their exact
metadata and hashes remain in the private index. Corpus passages and individual
observations are not published as fixtures.
