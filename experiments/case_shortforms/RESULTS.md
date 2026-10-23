# Case shortform results - 2026-10-18

The installed generator agrees with a preferred authored name on **87.90%** of
development cases (4,016/4,569) and **86.45%** of the reused historical test
(8,192/9,476), counting tied modal names. Agreement with any authored name is
**88.62%** and **87.51%**, respectively. Current comparisons use corrected v40
evaluation inputs. Popularity is measured by independent source-document counts.
Legitimate name-length variation and reordered initials are not data errors.
The current objective remains
proximity to a validated attainable base-name ceiling, as specified in
[README.md](README.md#objective-approach-the-attainable-information-limit).

The canonical data now uses qualification revision
`case-shortforms.qualified-inputs.v40`. The installed experimental generator has
124 features and 228 trees. It combines the winning v35 numeric ranker and word
statistics with the v38 learned edit decoder and corrected v40 unlabeled
statistics. Earlier full numeric refits were evaluated and lost. Source repairs,
affected initial and representative-name lookups (3,174 rows across 2,989
identities), and runtime party-name memory are
refreshed on both machines. The full prepared-name index has not been regenerated.
Application integration remains separate.
Earlier comparisons retain their separate frozen inputs and results.
Only the current best experimental weight file is retained; superseded models
are discarded at the user's request.
Its citation API is 4, key version 3, and SQLite schema
`case-shortforms.v1`. The database remains stored once at
`%LOCALAPPDATA%/OpenLegalData/cache/case-shortforms/shortforms.sqlite`.
The old citation-API-3 run remains deleted.

## Declaration boundaries and the unlabeled background (v40)

This pass repairs 30 malformed observation spellings and rejects six declarations
that are a quotation, a procedural annotation or damaged PDF font text. Three
additional source-backed caption repairs recover missing parties and remove a
damaged trailing proceeding/report fragment. Raw observations and source witnesses
remain preserved. No generated shortform supplies a target, no initial order is
changed, and alternative-name adjudication remains deferred.

Two distinct causes were found: cleanup blindly stripped closing square brackets
from valid internal year qualifiers, while other malformed delimiters were already
present in source text or truncated parser spans. One shared delimiter check now
protects declarations, captions and generated fragments. Label cleanup unwraps
only a complete surrounding bracket pair. Reviewed spelling corrections apply
again during preparation and refresh. The completed scan finds zero unmatched
round/square delimiters in accepted Gold declaration observations and current
Gold profiles. Five repairs were hidden behind balanced representative spellings;
they leave every exported Gold input unchanged, so the running fit remains valid.

The corrected cohort adds one eligible development case that the existing model
already gets right. Its extra match is a coverage change, not a ranking gain.
There are now 33,795 eligible training entries, 4,569 development entries and
9,476 historical-test entries. Non-quarantined unresolved input/name relations
still cover 9,041 original strings, and 5,650 entries lack at least one party
input. These are unresolved evidence, not automatically bad names.

A restored training case had also remained in the frozen unlabeled caption
catalogue. Removing its two unique party cores changes five name-word counts;
body-word and person-name statistics remain unchanged. No development input's
features change. Two historical-test inputs need rescoring, and neither
prediction changes. The corrected statistics live in the canonical
`word-background.json`; the private correction records the removed catalogue row.

The full v40 refit before this background correction uses 203 trees and takes
1,278.44 seconds. It matches 4,005/4,569 preferred development names: 27 gains and
38 losses against the retained ranker. Every regression was inspected; the
preferred name is second in 37 and third in one. Losses involve company phrase
length, compound personal names and selection of the opposing party. They do
not justify relabelling normal naming variation as bad data. Its historical test
was stopped after development.

The final fit with corrected background statistics takes 1,468.16 seconds,
fitting 33,735 choice sets and 2,109,285 candidates into 210 trees. It matches
4,003/4,569 preferred development names (87.61%) and 4,039 any-authored names:
27 gains and 40 losses against the retained ranker. All gains and losses were
inspected. In 39 losses the preferred answer is second; in one it is third.
The changes again concern company phrase length, compound personal names and
party selection, including opposing preferences for identical party inputs.
Every preferred answer in this eligible development cohort is constructible by
the new fit. These are ranking losses, not a reason to rewrite valid Gold names.

Development selects the retained 228-tree ranker with the expanded decoder and
corrected background: 4,016 preferred and 4,049 any-authored matches. The weaker
final fit is not scored on the historical test. Saved current-best historical
predictions remain 8,192 preferred and 8,292 any-authored matches out of 9,476.
The selected pack is already installed on both machines; superseded weights and
party-name memories are removed. Work is paused after this comparison.
The private final comparison is recorded in `label-final-comparison.json`.

Identical party strings and language can have different preferred authored names
for different decisions. Even an oracle assigning one output to each such input
would miss at least 41/4,569 development preferences and 116/9,476 historical-test
preferences. The corresponding empirical upper bounds are 99.10% and 98.78%.
These are bounds from observed conflicts, not an estimated generalization limit.
Decision identity, citation and court are not current ranking features. This
conflict explains only a small part of the remaining errors and does not establish
saturation or require changing the Gold names.

The private source review and repaired observations are recorded in
`label-boundary-review.json`, `label-hidden-boundary-review.json` and
`label-boundary-cleanup.json`; background changes in
`background-overlap-cleanup.json`; input conflicts in
`input-preference-conflicts.json`. Syntax compilation and actual source/data/model
results are used for validation. No software tests were written or run.

## Caption repairs, initial forms and the selected decoder (frozen v33-v39)

This section records the preceding selection and its original denominators.

The latest source passes make 98 profile corrections: damaged caption boundaries,
footnotes and pinpoints captured as names, judgment prose, missing party words,
and false separators inside initials. Two journal commentaries incorrectly treated
as decisions have their case profiles cleared and four associated observations
rejected; their source evidence remains preserved. Earlier literal caption-tail
repairs are retained. No authored spelling is rewritten and alternative-name
adjudication remains deferred.

Eligibility now recognizes an attested change in initial order, including compact
forms, when at least one spelling has explicit initial structure. This restores
94 existing authored strings across the two initial-form passes. It does not
declare publication-ban changes erroneous, merge identities by initials, or add
generated labels. Learned order programs require support from distinct training
cases; training proposal grammars and party memories remain grouped out of fold.

| Method on identical current inputs | Development preferred | Historical test preferred |
| --- | ---: | ---: |
| Previous expanded generator | 4,003/4,568 | 8,191/9,476 |
| Initial-order refit | 4,015/4,568 | 8,192/9,476 |
| Fresh compact-initial full refit | 3,998/4,568 | 8,183/9,476 |
| Selected: retained ranker with expanded decoder | 4,015/4,568 | 8,192/9,476 |

The fresh full refit takes 991.77 seconds on the desktop, fitting 33,736 choice
sets and 2,109,330 candidates before selecting 96 trees. Against the retained
ranker it gains 34 preferred development answers and loses 51. All 51 regressions
were inspected: 46 put the preferred answer second, two third, two fourth and one
fifth. These are mostly ranking choices between plausible forms. Retaining the
better numeric weights while swapping in the expanded decoder preserves every
development and historical-test prediction, while making both previously
unreachable preferred development cases constructible. Development accuracy,
exact relative source support and any-authored agreement tie; development
construction coverage selects this combination before the new test results are
read. Historical test never selects the winner.

Against the previous expanded generator, the selected pack gains 34 and loses 22
on development. Historical test gains 80 and loses 79; excluding repaired captions
gives 79 gains and 79 losses. This is no meaningful historical accuracy gain.
Both sides receive the caption corrections. Saved old predictions are reused;
only 65 predictions with changed or newly eligible inputs are recomputed across
the two prior methods, rather than rerunning either full corpus.

The final held-out source repair merges a three-entry trial/appeal family into
quarantine. The v38 fit's training text and authored targets did not change; the
three family members are excluded from current evaluation. The retained ranker
was fitted on v35, the new decoder on v38, and all reported current scores use v39.

Remaining eligible failures are predominantly ranking decisions. Development has
353 name-form choices, 158 wrong-party choices and 42 joint or unresolved-side
choices; historical test has 824, 369 and 91 respectively. The preferred answer
is second in 311/553 development failures and 690/1,284 test failures. These
mechanical categories do not adjudicate every unobserved name as invalid.

| Eligible case/language entries | Entries | No preferred answer constructible | Unbuildable preferred strings | Unbuildable authored strings |
| --- | ---: | ---: | ---: | ---: |
| Training | 33,794 | 69 | 95/34,483 | 140/36,419 |
| Development | 4,568 | 0 | 3/4,666 | 9/4,887 |
| Historical test | 9,476 | 15 | 22/9,734 | 39/10,362 |

This construction audit uses the new decoder, five grouped out-of-fold grammars
and memories for training, and a training-only complete grammar and memory for
held-out rows. V38 availability is reused only for identical retained v39 inputs;
the newly quarantined family is excluded. Overall, 84/47,838 eligible entries
(0.18%) lack a constructible preferred answer, and 188/51,668 eligible authored
base strings (0.36%) are unavailable. Each of the three unavailable preferred
development strings has an equally popular constructible alternative.

Those small percentages do **not** describe all Gold declarations. Across the
non-quarantined splits, 9,047 original strings with both parties present still
have an unresolved input/name relation, and 5,652 entries lack at least one party
input. Seven further strings carry specific non-base-name flags. These are
preserved outside eligible accuracy scoring; exclusion does not establish bad
data, irreducible error or saturation. Source review and broader construction
coverage remain separate work.

Private inputs, source receipts, paired regressions and the current comparison
live in `benchmarks/local-data/case-shortforms/`. The active selection and install
are recorded in `caption-selection.json`, `caption-final-comparison.json` and
`caption-final-install.json`. Superseded weights are discarded; predictions and
fit receipts remain. No tests were written or run, no fresh reserved source was
scored, and no full prepared-index rebuild was run.

## Expanded construction and corrected-data refit (frozen v32-v33)

This section records the earlier selection on its original inputs and denominators.
It is superseded by the current comparison above.

Generation retains full parties, legal endings, articles and parenthetical names,
and allows hyphen components, noncontiguous joins, formed initials, learned
abbreviations and paired-party names. Thirty characters is a measured length,
not a hard limit. Training and runtime use the same proposal/features path.
Source-document counts provide linear ranking gains: the modal name receives
the most reward, less popular authored names receive lesser reward, and tied
modal names receive equal credit. Generated outputs never supply targets.

On the same v32 development cases, the expansion makes all 120 previously
unreachable preferred-name cases constructible. It selects 11 of these correctly.
Overall it gains 66 preferred answers and loses 63; 49 regressions place the
preferred answer second. Historical test gains are 156 against 143 losses, with
127 regressions placing the preferred name second. Greater construction coverage
has not solved ranking, and these results do not establish saturation.

Source review repairs two damaged captions and reverses an erroneous earlier
trial/appeal declaration reassignment. Complete authored spellings remain
unchanged. Court metadata now includes registry aliases, the CA qualifier for
known Canadian appellate courts, and one source-confirmed trial qualifier.
Base projection changes 338 target records and makes 142 additional cases
eligible, including the restored appeal. Their original declarations and source
witnesses remain preserved. Publication-ban initials and bilingual or conventional
acronyms are retained; an alignment labelled "reordered" is not a finding of
corrupt data.

The corrected-data fit runs on the desktop in 1,006.94 seconds: 33,709 fitted
choice sets, 2,091,019 candidates and 140 selected trees. LambdaRank already
normalizes queries; this fit removes the extra inverse-pool-size row weighting.
Its initial result matches 4,008/4,569 development cases. On the 4,552 common
cases, the first expansion initially leads 3,994 to 3,993. Inspection of all 56
regressions against that expansion finds the preferred answer second in 53 cases
and third in three. One regression is a broken fragment ending in "obo" without
its beneficiary. The shared fragment rule now rejects a truncated representative
marker while preserving complete party names and authored targets. The narrow
real-data check covers 12 eligible representative-name rows and changes exactly
one prediction, recovering its preferred name. No affected authored target ends
in the marker, and all their targets were already constructible; coverage counts
are unchanged.

After this repair, both fits match 3,994 preferred names on common development
cases. The corrected-data fit wins the specified tie break on relative source
support, 4,009.376 against 4,008.330, and is now selected. This is not convincing
evidence about weighting alone: the cohort and training data also changed.
Historical test results do not select the winner, and comparisons of saved
predictions exclude repaired test captions to avoid crediting caption repairs
as ranking improvements.

On 9,435 common historical cases with unchanged captions and corrected targets,
the final fit matches 8,172 preferred names against the previous generator's
8,138: 155 gains and 121 losses. Against the first expanded fit it gains 129 and
loses 108. On common development cases it gains 67 and loses 64 against the
previous generator. Remaining mechanical development groups are 356 name-form
choices, 159 wrong-party choices and 43 joint or unresolved-side choices. These
are diagnostics, not adjudications that every unobserved alternative is invalid.

The v33 construction audit uses five grouped out-of-fold grammars and party
memories for training rows, and training-only full grammars/memories for held-out
rows. It measures construction separately from the selected ranker's accuracy
above. Only eligible base targets are counted; quarantine
and cases without eligible targets are excluded.

| Eligible case/language entries | Entries | No preferred answer constructible | Unbuildable preferred strings | Unbuildable authored strings |
| --- | ---: | ---: | ---: | ---: |
| Training | 33,772 | 72 | 98/34,457 | 144/36,363 |
| Development | 4,569 | 0 | 3/4,663 | 9/4,883 |
| Historical test | 9,461 | 15 | 22/9,718 | 39/10,337 |

Overall, 87/47,802 cases (**0.18%**) lack a constructible preferred answer.
Individual unavailable preferred strings are 123/48,838 (**0.25%**); all unavailable
authored strings are 192/51,583 (**0.37%**). The three unavailable preferred
development strings each have an equally popular constructible alternative.
Rare abbreviations, language/name conventions and pruned paired components remain
coverage limitations, not adjudicated data errors or an information limit.

Private source receipts, saved predictions, regressions and coverage details live
in `benchmarks/local-data/case-shortforms/construction-*`. Syntax compilation,
the four real repaired lookups and affected representative outputs were checked.
No tests were written or run, no
fresh reserved source was scored, and no full prepared-index rebuild was run.

## Eligible base names: first implementation batch

These comparisons retain their frozen v3 inputs. Their scores do not describe
the revised v4 cohort.

The new target contract excludes document-local procedure, topic, date and judge
labels. Original declarations and source witnesses remain preserved. Unresolved
caption/name relations are flagged for source repair; their exclusion is not a
claim that these cases are solved or irreducible. Of 38,351 training rows, 34,058
have an eligible base target. Of 5,263 development rows, 4,688 do. Target coverage
and naming accuracy have different denominators.

The 400 source checks are case/source-disjoint and divided equally between
discovery and held-aside projection validation. The latter supports all 100
reviewed trailing court/year decompositions. Overall judgments are 341 supported,
54 unresolved, three uncertain and two non-name annotations. These are Codex
source judgments, not independent human gold or validation of every eligibility
rule. A subsequent boundary audit found a document-role label admitted through
corrupted caption prose; the scope was corrected and the earlier fit superseded.

| Same eligible development cases | Authored base matches | Candidate coverage |
| --- | ---: | ---: |
| Frozen existing weights | 4,121/4,688 (87.90%) | Not recomputed |
| Unchanged-recipe base-target control | 4,140/4,688 (88.31%) | 4,571/4,688 (97.50%) |
| Learned edits, set-valued targets and unnormalized case weights | 4,097/4,688 (87.39%) | 4,626/4,688 (98.68%) |

The editor adds 55 reachable targets but gains 33 matches and loses 76. Its paired
change is -0.92 percentage points, with a case/party-grouped 95% interval from
-1.44 to -0.45 points. The proposal expansion is not a successful model change,
and it is not promoted. The comparable control's 19-match improvement over the
old weights also remains uncertain: its interval is -0.04 to +0.84 points.
Neither result is comparable with complete-declaration accuracy above.

The first editor comparison changes proposal generation and supervision together.
A frozen matched pair isolates the proposals under identical set-valued,
case-balanced supervision: the control matches **4,134/4,688 (88.18%)** and the
editor **4,121/4,688 (87.90%)**, with 38 gains and 51 losses. Its paired 95%
interval is -0.74 to +0.17 percentage points. Candidate coverage remains 4,571
versus 4,626. The weights have mean one, preserving the global loss scale relative
to the fixed L2 penalty. These are bounded development experiments;
reserved final targets receive no predictions. Long fitting and corpus jobs run
on the desktop through the configured Tailscale SSH connection. The first editor
fit took 300.41 seconds there; its transfer hashes and runtime are recorded.

Direct inspection covers all 76 initial regressions and 33 gains. Of the losses,
75 rerank existing candidates and only one selects a new proposal. They comprise
58 name-form choices, 13 wrong-party choices and five joint or ambiguous forms.
Among the 591 remaining editor misses, 62 lack a reachable target, 330 concern
the form of the selected party's name, 161 select the wrong party, and 38 are joint
or ambiguous. The matched pair similarly reranks existing candidates in 46 of
51 regressions. Input corruption and incomplete labels are also present; these
counts are mechanical diagnostic categories, not adjudicated error rates or an
attainable ceiling. The editor is not promoted, but the method is not exhausted.
Clear data repair takes priority. Alternative-name adjudication is deferred.

The initial reservation contains 1,188 unused text/language entries in 1,156
documents. Its unscored target pilot is too small for the near-limit claim and
still needs source/identity review. Four published A2AJ bulk partitions provide
a further 58,786 texts absent from the old source inventory, with 1.31 billion
characters. Their file and text hashes were frozen before mining. They are
additional sources, not yet certified independent case targets. Missing provider
index entries do not justify changing native recognition or claiming fresh gold.
Source/family grouping, background exclusions and final review remain required.

## Source cleaning through the 08:00 cutoff

The timed cleaning run stopped at 08:00 Edmonton on 2026-10-18 at revision v26:
58,998 case/language rows, including 53,322 with two qualified parties. Saved
partitions contain 41,239 training, 5,558 development, 11,530 historical test and
671 quarantined rows. Exposure lineage is retained when repaired party groups
join; held-out components never move into training.

The v20–v26 passes apply 228 source-verified caption/party corrections, exclude
239 erroneous declaration observations and recover 97 literal authored names
from captured introduction/reporting wording. These counts are repair operations,
not an accuracy estimate or a claim that all remaining inputs are correct.
Raw evidence and the installed model are unchanged. No new tests were written
or run. Original source hashes, literal spans, printed-page evidence, exact repair
recipes and before/after records remain in the private `data-*` receipts.

Direct inspection found wrong footnote ownership, citation and publisher text
inside party fields, false party splits at initials and slashes, incomplete
company names, genuine incorporation years mistaken for decision dates, and
non-name editorial brackets admitted as declarations. Some authors also cite an
unrelated judgment. A coaccused or an additional respondent can legitimately
explain an apparent name mismatch; the source must be read before excluding it.
Alternative-name adjudication remains deferred. Generated shortforms supply no
targets.

Annual Ontario Reports numbering remains a known identity defect. The audit
found 923 raw first-series keys carrying an annual-era date, and confirmed that
different years can collapse onto one volume/page key. Confirmed conflicting
caption bindings are withheld; the raw index has not been rebuilt. The separate
numbering regimes are documented by [Courthouse Libraries BC](https://www.courthouselibrary.ca/catalogue-item?cid=1269)
and the [Osgoode historical collection](https://digitalcommons.osgoode.yorku.ca/lawreports/10/).
This unresolved extraction issue is not evidence of an irreducible naming error.

The final real-data filter comparison caught a regression on dotted anonymized
initials and corrected it before freezing training inputs. Its remaining changed
decisions concern two French locators and three document/proceeding labels.
No prediction was used to decide these qualification changes.

## Desktop refit on frozen v26 inputs

Both fits ran on `DESKTOP-47KGKA2` through Tailscale, with the same authored base
targets, case-balanced weights, fixed LightGBM 4.7.0 recipe and development
stopping rule. Eligible rows are 33,859 training, 4,553 development, 9,456 historical
test and 579 quarantine. Only authored declarations supply supervision.
Background statistics reuse 4,000 hash-verified real documents disjoint from
current declaration documents, and rebuild 164,368 qualified primary caption
rows. No fresh reserved text is mined or scored.

| Eligible v26 development rows | Authored base matches | Candidate coverage |
| --- | ---: | ---: |
| Refitted control | 4,005/4,553 (87.96%) | 4,441/4,553 (97.54%) |
| Refitted editor | 3,979/4,553 (87.39%) | 4,496/4,553 (98.75%) |

The editor adds 55 reachable targets but gains 31 matches and loses 57: a net
loss of 26, or 0.57 percentage points. Its case/party-grouped 95% interval is
-1.09 to -0.15 points. Inspection covers every one of the 88 changed rows.
All 31 gains use existing control candidates; 56 losses also use existing
control candidates and one uses a new editor proposal. The losses include 45
name-form choices and 12 wrong-party choices under the mechanical side mapping.
These results do not establish that learned edits are exhausted.

All 548 control development misses were read. Of these, 436 have a reachable
authored target and 112 do not. Mechanical side grouping gives 344 name-form
choices, 160 wrong-party choices and 44 joint/unresolved forms. Misses include
over-shortening, unnecessary extra words, acronyms, trading names, personal-name
components and whole-case versus one-party names. Some alternatives appear
equally plausible; no new accepted target is added on that basis.

The control was selected before historical scoring. On the same 9,456 historical
rows, it gains 100 matches and loses 132 against the installed model. The net
change is -0.34 points, with a grouped 95% interval of -0.72 to +0.07 points.
All 232 changed rows were inspected. Nine had suspicious apparent footnote or
citation spillover in the party input and were queued at the cutoff. The
authorized follow-up verifies and repairs them against original sources; these
frozen v26 scores remain unchanged. Other
changes again include plausible naming alternatives and clear name/party choices;
normalized authored agreement is not adjudicated semantic precision.

The new control has 220 numeric trees and is retained as the unpromoted private
`cleaned-refit-model.json`, with `cleaned-refit-party-names.json`. Fits took 176.78
and 284.56 seconds including feature preparation and development evaluation.
Every exported fitting stage agrees with LightGBM within the recorded numerical
tolerance. The input/code protocol, models, predictions, uncertainty, all
development misses and paired-change reviews are retained under `cleaned-refit-*`.
The installed weights remain unchanged. Development and historical test have
been reused; these are bounded comparisons, not fresh-holdout claims.

## Source and identity repairs after the cutoff

The user authorized the next repair/modeling pass after the timed cleaning run.
Revisions v27-v28 apply 17 further profile operations: 14 factual caption/party
repairs and three unsupported reporter bindings withheld. They exclude one
court annotation and rebind one literal authored declaration plus its named
reference to an existing, source-confirmed decision. No alternative name is
inserted and no authored name is rewritten.

The nine original queued captions are all source-verified and repaired. Further
review finds nearby-case prose captured as a caption, possessive punctuation in
provider titles contradicted by the judgment's actual party block, and title or
court labels captured as parties. All 12 remaining authored first-series Ontario
Reports identities were inspected. Another annual-volume collision is confirmed
and its conflicting profiles withheld. A separate author omitted a reporter
edition marker, leaving the same decision in training and historical test under
different identities. Its correct existing identity receives both witnesses and
is quarantined with the combined exposure history; runtime lookup redirects the
incomplete key to that identity. The raw citation index remains unchanged.

Corrected party groups also expose earlier train/held-out overlaps. The current
58,996 rows contain 41,036 training, 5,558 development, 11,516 historical test and
886 quarantine rows. Prior held-out exposure never becomes training. Canonical
installation preserves a verified preceding database snapshot; SQLite integrity,
raw-evidence fingerprints and reviewed observation/profile changes are checked.

Revision v29 refreshes 124 potentially affected identities after a measured
candidate-boundary correction. An unattested shortened phrase cannot end in
lowercase `pour`; a complete party name or explicitly attested name remains
eligible. The real-data audit affects 22 gold rows, loses no reachable authored
target, and causes no agreement regression across the installed model and four
controlled refits. It fixes a truncated French prepositional phrase without
adding name-specific alternatives. Source captions and authored targets are
unchanged by this rule. The installed fitted weights are unchanged.

The private `data-post-cutoff-*`, `data-remaining-identities-final-*` and
`data-preposition-boundary-*` receipts retain sources, exact recipes, before/after
state and validation. Completed v26 and v27 model experiments keep their original
inputs and scores; they are not silently rescored against these later repairs.

## Matched diagnosis after the v26 refit

A frozen desktop diagnosis crosses the installed/refitted model with the original
authored and qualified-base party-name maps. It also swaps weights under fixed
control statistics and adds/removes editor proposals under fixed fitted models.
Every comparison uses the same v26 targets; no new fit or target adjudication
enters this diagnosis. The maps contain 15,786 and 16,082 entries, with 1,398
differing keys.

| Reused development rows, same qualified-base party map | Authored matches |
| --- | ---: |
| Installed model | 4,007/4,553 |
| Refitted control | 4,005/4,553 |
| Control statistics with installed weights | 4,004/4,553 |
| Control with editor proposals | 3,898/4,553 |
| Editor weights/statistics with original proposals | 3,982/4,553 |
| Full editor | 3,979/4,553 |

Changing only the party map gains one development match for the installed model
and seven for the refit. With the same qualified-base map, the historical result
remains 8,259 versus 8,227 matches: 97 gains and 129 losses for the refit, with a
grouped 95% delta interval of -0.72 to +0.06 percentage points. The memory
confound does not explain the net historical regression, although it changes
individual predictions.

Proposal expansion under fixed control weights gains 13 and loses 120 matches.
Removing proposals from the trained editor recovers three matches, with no
losses. The added candidates are poorly ranked by the control, while most of
the trained editor's deficit persists on the original proposal set. Its training
cohort also grows when previously unreachable targets become reachable; a
separate common-cohort fit is needed to isolate that effect.

A deterministic original-source review covers six rows from each of four
development error strata: corporate name form, other name form, wrong party and
joint/unresolved side. The 24 passages confirm authored full-case names,
acronyms, roles inside parenthetical party text, and varying company/personal
name lengths. These are source judgments, not an independent semantic accuracy
sample. They support reusable selection/proposal work without inserting
individual alternative labels. A dangling French preposition is a clear
generation defect; an arbitrary minimum or maximum word count would contradict
other source-authored names.

The private `matched-ranker-*` receipts preserve predictions and paired changes.
The exact original v26 input bytes are preserved as
`cleaned-refit-inputs.v26.json`, verified against the original protocol hash.

## Controlled ranking fits on frozen v27 inputs

Four desktop fits share the same 33,677 eligible training rows, 4,553 development
rows, grouped encodings, background and party-name map. The original-proposal
control and the editor restricted at the ranking stage have the exact same
28,425 fitted case/language choice sets, verified by their ordered identity hash.
The full editor fits 33,223 choice sets. The restricted editor keeps its proposal
learner and statistical encodings fixed; only ranking-stage case inclusion
changes. All fits retain the declared mean-one candidate weighting recipe;
changing the candidate population also changes that global normalization.

| Eligible v27 development rows | Authored matches | Candidate coverage |
| --- | ---: | ---: |
| Installed weights, shared qualified party map | 4,007/4,553 | 4,441/4,553 |
| Binary control | 3,999/4,553 | 4,441/4,553 |
| Full editor | 3,982/4,553 | 4,496/4,553 |
| Editor ranker restricted to control choice sets | 4,008/4,553 | 4,496/4,553 |
| Original proposals, LambdaRank objective | 4,017/4,553 | 4,441/4,553 |

Restricting the editor's ranking cohort gains 58 and loses 32 matches versus the
full editor: +26, with a grouped 95% interval of +0.11 to +1.04 percentage points.
Against the binary control it gains 56 and loses 47; that smaller improvement
remains uncertain (-0.30 to +0.76 points). This supports further work on ranking
supervision rather than dismissing the learned proposal method.

The direct ranking fit changes only the objective parameter to
[`lambdarank`](https://lightgbm.readthedocs.io/en/stable/Parameters.html#objective).
It gains 59 and loses 41 versus the binary control, and gains 57 and loses 47
versus installed weights. Both development intervals include zero. It is selected
by development agreement before historical scoring. On the frozen reused
historical cohort it matches 8,219/9,444 versus 8,247 for installed weights:
104 gains, 132 losses and a grouped delta interval of -0.68 to +0.09 points.
The later source review identified one duplicate-decision exposure in that
cohort; v28 quarantines it. These historical figures remain diagnostic artifacts,
not final held-out proof or a reason to promote the model.

Fits took 157.34 seconds (control), 253.34 (full editor), 394.66 (restricted
editor) and 168.06 (LambdaRank). Exported tree margins agree with LightGBM within
the recorded numerical tolerance. Private `controlled-refit-*` artifacts retain
the full input snapshots, protocols, code, fitted models and paired predictions.

## Final desktop refit on frozen v29 inputs

The previously selected LambdaRank recipe is fitted once after the source and
identity repairs, using 33,676 eligible training rows. The 4,553 development,
9,443 historical-test and 774 quarantined eligible rows retain their exposure
assignments. The repaired duplicate decision is excluded from all three scored
partitions. Only source-authored base names supply targets. No reserved fresh
source receives predictions.

| Same eligible v29 rows and qualified party map | Installed matches | Refit matches |
| --- | ---: | ---: |
| Development | 4,009/4,553 (88.05%) | 4,016/4,553 (88.21%) |
| Reused historical test | 8,246/9,443 (87.32%) | 8,222/9,443 (87.07%) |

The development change is 52 gains and 45 losses, with a grouped 95% interval
of -0.31 to +0.64 percentage points. The historical change is 108 gains and 132
losses, with an interval of -0.67 to +0.13 points. These comparisons demonstrate
no improvement. Most of the net historical loss is in ordinary-party cases;
government-party cases improve. Neither reused cohort estimates fresh accuracy.

All 97 development and 240 historical changed-answer rows were inspected.
Of 537 remaining development misses, 425 already have an accepted candidate and
112 do not. Mechanical grouping gives 337 name-form choices, 156 wrong-party
choices and 44 joint/unresolved forms. The 84 new or changed failure rows were
read alongside 453 unchanged rows previously reviewed in the v26 failure table.
This is answer-table inspection, not original-source adjudication of every miss.
No per-case alternative target is added.

Inspection still exposes apparent citation/page spillover in some captions,
unbalanced parentheses and phrases truncated at a preposition. Different
decisions involving the same parties can also have different authored name
lengths; a uniform shortening rule trades matches between them. These limits
remain recorded for source or selection-rule work. They do not justify claiming
that the data is fully clean or the naming task saturated. Legitimate name-length
variation is expected and is not a data defect. The subsequent v30 pass repairs
damaged captions and broken truncations without adjudicating alternative names.

The desktop fit took 182.2 seconds and exports 180 numeric trees over 109
features, fitted on 28,424 choice sets. The unpromoted model and party map are
`final-cleaned-refit-model.json` and `final-cleaned-refit-party-names.json`.
The private `final-cleaned-refit-*` artifacts retain frozen inputs, source/code
snapshots, numerical export checks, predictions, uncertainty and answer reviews.
All 11 delivered artifacts and current protocol file hashes are verified locally.
The installed model retains its original weights. No new tests were written
or run.

## Caption and fragment-boundary cleaning on v30 inputs

Direct source review applies 345 caption/profile operations across training,
development, historical-test and unlabelled data. These include page-header and
table-column contamination, footnote numbers inside names, neighboring-case
ownership, printed-source spelling damage and nonadversarial headings falsely
split into parties. Twenty-nine unsupported case bindings are withheld. Two
non-name annotations are excluded, and four qualified observations are rebound
to existing source-confirmed cases without redirecting ambiguous raw citation
keys. Authored spellings are preserved; no alternative labels are added.

The corrected dataset contains 58,993 case/language rows: 41,024 training, 5,549
development, 11,507 historical test and 913 quarantined. Joined exposure histories
remain quarantined. The 345 profile operations touch 41 previously labelled rows;
most concern unlabelled input captions. Source hashes and literal locators are
verified, with independent published or printed witnesses for five profiles.

Candidate slicing preserves closing brackets and attached name morphology.
Unattested fragments cannot leave unmatched brackets or stop at a trailing
connector/preposition. Complete names, attested names and hyphenated name tokens
remain eligible. No minimum name length or uniform personal-name shortening rule
is imposed. Legitimate authored name-length variation is expected behavior, not
an annotation defect.

The stored-name boundary scan identifies 570 rows across 533 identities for
refresh. Together with factual repairs and changed party-name dependencies, the
desktop rebuild regenerates 1,755 identities in 40.77 seconds. Valid cached
recommendations are not globally reranked. Raw-table fingerprints, reviewed
label-change allowances, SQLite integrity and the WAL checkpoint pass. The local
canonical v30 installation retains a hash-verified v29 backup. These are data
validation checks, not new tests or a semantic precision estimate.

The private `data-broken-boundaries-*` files retain the suspicion queue, reviewed
sources, exact recipes and application receipts. Original sources remain in
their canonical provider/corpus stores. No real case passages or identifiers are
published as fixtures.

The new v30 desktop model was trained and evaluated without rescoring old models:
4,011/4,552 development matches and 8,200/9,437 reused historical matches. Direct
inspection covers all 541 development misses. It finds two further generation
defects: corporate-suffix removal leaving a dangling ampersand, and candidate
spans cutting through nonbreaking-hyphen name tokens. Historical failure
inspection also exposes caption prose and neighboring-authority contamination.

Revision v31 applies seven further original-source caption repairs, including
three missing-word-space repairs and one OCR character verified against an
official appellate judgment header. Two suspicious short proper names are
confirmed and retained. Corporate suffixes needed after a conjunction stay in
the core, and Unicode hyphens stay inside name tokens. Another 2,944 affected
identities are refreshed in 45.92 seconds. Authored targets and partition
assignments do not change. The two passes total 352 profile operations; both
canonical installations preserve a verified prior snapshot. Exact v30 model and
input artifacts remain separate from the subsequent v31 refit.

## New desktop model on the final cleaned inputs

The selected LambdaRank recipe fits 28,416 choice sets from 33,673 eligible
authored training rows on the desktop in 193.33 seconds. It uses no generated
shortform targets. The new model is `residual-cleaned-refit-model.json`, with its
training-only party map in `residual-cleaned-refit-party-names.json`.

The retained-queue pass reads all 283 previously unchanged caption rows and
repairs seven more records in v32. These remove four section/footnote-boundary
errors, restore a missing party-name opening, remove a duplicated company word
and correct a Roman numeral transcription. Another 628 affected identities are
refreshed. Total v30–v32 profile operations are 359. Authored spellings and
partition assignments remain unchanged after the v30 observation-owner repairs.

Exact frozen training and development records are identical between v31 and
v32. The last seven changes affect nonprimary captions and leave the model's
background unchanged, so they require no duplicate fit. The current model is
evaluated on the corrected historical inputs; development predictions are
retained because their full inputs are identical.

| Final eligible rows | Authored matches | Candidate coverage |
| --- | ---: | ---: |
| Development | 4,027/4,552 (88.47%) | 4,440/4,552 (97.54%) |
| Reused historical test | 8,234/9,437 (87.25%) | 9,156/9,437 (97.02%) |

The 525 development misses contain 413 reachable targets and 112 absent from
the candidate set. Mechanical grouping gives 157 wrong-party choices, 324
name-form choices and 44 joint/unresolved forms. Historical counts are 359,
743 and 101 respectively, with 922 reachable and 281 unreachable targets among
1,203 misses. Name-form differences can be valid alternatives; these groups are
not adjudicated error rates. No alternatives are added to gold, and no method
is declared exhausted. No caption-spillover or malformed-boundary flags remain
in these final failure tables.

The ranking loss still labels every eligible attested name equally, and stopping
and stage selection use any-authored agreement first. Some learned features use
modal names or frequency, but this does not give the final ranking objective a
popularity preference. Aligning the loss and selection metric remains necessary.
Of 561 development misses of a modal name, 441 have a modal candidate available
and 120 do not. Structural grouping gives 355 same-party name-form choices, 172
other-party choices, 25 paired-name targets and nine unresolved alignments. Of
the 120 unavailable preferred forms, 25 are paired names, 24 initialisms, 18
corporate-ending forms, 14 parenthetical names/roles, 12 over the 30-character
cap, six noncontiguous word copies, one abbreviation and 20 other restrictions.
These descriptive groups are not semantic validity judgments. Another 36
development predictions and 99 historical predictions match an attested name
but miss the most popular name; the any-attested metric credits those equally.

The installed weights remain unchanged. Fresh reserved sources are unscored;
both reported cohorts have prior exposure. Final results and the unchanged-input
proof live in private `caption-cleaned-final-*` files. Additional artifact
verification is skipped at the user's request. No new tests are written or run.

## Desktop refit on frozen v8 inputs

Both methods use the same qualified authored base targets, case-balanced weights
with mean one, fixed hyperparameters and development stopping rule. Background
party statistics now read qualified primary-provider profiles instead of
reparsing raw cached captions. All declaration documents and declaration cases
remain excluded from those background counts. Compilation and both fits ran on
the desktop through Tailscale; the installed model remains unchanged.

| Eligible v8 development rows | Authored base matches | Candidate coverage |
| --- | ---: | ---: |
| Refitted control | 4,066/4,616 (88.09%) | 4,499/4,616 (97.47%) |
| Refitted editor | 4,032/4,616 (87.35%) | 4,555/4,616 (98.68%) |

The editor gains 34 matches and loses 68, a net loss of 34. Its grouped 95%
interval is -1.24 to -0.24 percentage points. All 34 gains select candidates
already available to the control; 65 losses also select existing control
candidates, while three select new proposals. The extra proposals make 56 more
authored targets reachable, but ranking remains the main observed problem.
These results do not establish that the edit method is exhausted.

Inspection covers all 102 paired changes and all 550 control development misses.
Of those misses, 433 have a reachable authored target and 117 lack one. The
source review found further contaminated captions, missing name prefixes,
spelling corruption and court/ruling identifiers in party fields. Those inputs
require repair across the data before another fit. Plausible alternative names
are not manually added to the target sets.

The control was selected before historical test scoring. On the same 9,535
eligible historical rows, the installed baseline matches 8,324 (87.30%) and the
new control 8,295 (87.00%), with 91 gains and 120 losses. The grouped 95% change
interval is -0.69 to +0.07 percentage points. Neither candidate is promoted.
This is a reused historical cohort, not fresh held-out evidence; the separately
reserved 58,786 texts remain unmined and unscored. Base-target scores are not
comparable with the complete-declaration percentages elsewhere in this report.

Background compilation took 26.28 seconds. Control and editor fitting, including
their feature preparation and development scoring, took 199.75 and 292.24
seconds respectively. Private `qualified-refit-*` artifacts preserve the frozen
protocol, source hashes, exact v8 inputs, targets, models, predictions and paired
diagnosis separately from subsequent data revisions.

## Input ambiguity and the attainable limit

The new objective is to close at least 95% of the reducible-error gap from a
frozen comparable baseline and finish within one percentage point of a supported
attainable ceiling. This is an ambitious stopping criterion, not a claim that the
population Bayes limit has already been identified.

A first diagnostic examines all 43,614 corrected training/development rows using
the provisional supported court/year base projection. For each group of identical
inputs, a label-aware oracle chooses the name accepted by the greatest number of
rows. It can choose any target string; it is not constrained by current candidates.

| Input equivalence | Distinct inputs | Rows in repeated-input groups | Conflicting groups | Minimum misses on supplied targets | Finite-sample optimal agreement |
| --- | ---: | ---: | ---: | ---: | ---: |
| Exact two supplied party strings | 33,958 | 15,193 | 1,438 | 1,992 | 95.43% |
| Party strings, language, court and year | 42,006 | 2,835 | 456 | 545 | 98.75% |

These are upper bounds for deterministic prediction on these finite supplied
targets, not estimated achievable generalization rates or certified population
ceilings. Most inputs occur once, especially with metadata. Errors in captions,
identity or target projection can create false conflicts, while incomplete
authored-name sets can conceal acceptable shared outputs. Metadata increasing the
oracle does not itself demonstrate useful learnable signal. The result supports
investigating a much higher ambition; it does not justify stopping at either
number or claiming a high-90s predictor is already established.

Repeated-author naming variation answers a different question. On 15,284
case/language rows with at least two declaration documents, a modal name chosen
using all documents is accepted in 87.82% of documents with equal case weighting;
leave-one-document-out modal prediction reaches 80.26%. At five or more documents
(4,018 rows), the figures are 86.94% and 84.76%; at ten or more (1,595 rows), 87.02%
and 86.35%. The all-document figures are optimistic sample estimates; held-out
document prediction is not an upper bound. Repeatedly cited cases are a different
population, and source/case dependence remains. None of these percentages caps
the task of selecting any supported base name.

Conditional entropy does not uniquely determine classification error; it bounds
it. The relevant optimum must use the actual prediction loss and available
information. See [Feder and Merhav, Relations Between Entropy and Error Probability](https://www.ee.technion.ac.il/people/merhav/papers/entropyerrprob.pdf).
Private `naming_limits.py` and `naming-limits.json` retain the exact calculation,
source hashes and conflicting rows. Test examples and scores were not used.

## Controlled refit after data correction

Both generators receive the same corrected captions, qualified labels and
evaluation rows. Original train/development/test membership is retained; the old
audit belongs to training for this full-model comparison. Caption repairs add
102 party-pair group links. Fifty components cross original partitions and are
quarantined in full, removing 240 usable rows from fitting and evaluation.
The resulting split has 38,351 training, 5,263 development and 10,800 test rows.

The recipe keeps all 109 features, the two fitting stages, hyperparameters,
training-only encodings and party-name eligibility policy. The candidate uses
corrected background statistics and training evidence; the baseline keeps its
original statistics and original training-party memory. Development selects
boosting rounds. Candidate bytes are frozen before test scoring.

| Corrected cohort | Existing generator | Clean-data refit | Change, points |
| --- | ---: | ---: | ---: |
| Development | 3,965/5,263 (75.34%) | 3,967/5,263 (75.38%) | +0.04 |
| Reused test | 8,019/10,800 (74.25%) | 8,013/10,800 (74.19%) | -0.06 |

The paired test comparison gains 53 matches and loses 59. Its grouped 95%
improvement interval is **-0.32 to +0.20 percentage points**, using 1,000
resamples of 6,947 case/party components. The predeclared promotion gate requires
no development regression and a positive lower interval endpoint; it fails.
This is a reused test, not a fresh holdout. Source-document correlation and
repeated development selection remain outside the interval's uncertainty model.
The historical 73.58% result below uses different inputs and denominators;
its difference from 74.25% is not a learned-model improvement.

The candidate has 462 trees (257 plus 205), with exported-score error below
2.0e-14 against the fitting library. Fitting and feature preparation take
649.22 seconds; evaluation and development diagnosis take 208.75 seconds.
The existing model and compiled preferred-name database remain installed.
No new tests or model-service calls are used for this comparison.
Private `clean-refit-*` receipts preserve the protocol, inputs, both models,
training-party memories, predictions and development diagnosis.

## Backward analysis and the clarified runtime contract

The intended writing AI invokes case identities; the engine supplies their
representation. The learned model chooses base names. Exact/near collision
detection, court/year qualification and consistent document-wide updates belong
to deterministic rendering. The model must not predict these document-scoped
decisions from an isolated caption. The responsibility boundary is recorded in
[README.md](README.md#intended-use-and-responsibility-boundary).

A conservative development-only diagnostic removes trailing court/year qualifiers
only when supported by that case's metadata and the remainder anchors uniquely
to a supplied party. Labels already matching a party are protected. This changes
the target sets of 351 out of 5,263 development rows. Unsupported qualifiers,
ordinals, introductory words and procedural labels are retained. Every row stays
in this diagnostic denominator; original declarations and compiled data are intact.

| Development agreement | Existing generator | Unpromoted refit |
| --- | ---: | ---: |
| Complete authored name | 3,965 (75.34%) | 3,967 (75.38%) |
| Provisional base-name target | 4,127 (78.42%) | 4,130 (78.47%) |

The predictions are unchanged. These are different targets, not gains from
training or a new held-out result. The projection is a mechanical first pass,
not independently adjudicated base-name gold. The stopping objective is now
proximity to an evidenced attainable limit, rather than the earlier fixed target.
The full authored-name benchmark and its historical results remain available.

Working backward over the 867 missing complete-form candidates gives this
exclusive mechanical inventory:

| First applicable relation | Rows |
| --- | ---: |
| Existing metadata/introducer normalization reaches a candidate | 225 |
| Other prefix or suffix added to an existing candidate | 219 |
| Literal supplied-party span removed or filtered by generation | 45 |
| Regular initialism | 11 |
| All authored labels exceed 30 characters | 33 |
| Other transformation or input disagreement | 334 |

Overlapping checks find 458 rows where an authored name is an existing candidate
plus words at either end, including 383 containing the current prediction that
way. These relations describe targets; they do not establish that the added words
are valid qualifiers or predictable at runtime. The 225-row category uses the
older broad encoding helper and includes introductory/ordinal forms; it is not
the strict court/year projection above. Private `backward_misses.py` and
`backward-misses.json` retain the reproducible analysis and individual rows.

The next model experiment should use validated base-name supervision and infer
reusable naming operations from training misses. Near-collision and qualifier
logic should be developed separately in the existing document disambiguation
operation. This replaces the earlier proposal to make the model predict local
qualifiers using document context. Existing expanded-pool/structured-form failures
remain relevant, but they optimized complete forms under the earlier contract.

## Complete-form error budget

The refit's 1,296 development errors divide into **867 without any exact authored
candidate** and **429 with a correct candidate ranked below the winner**.
Thirty-three of the missing-candidate rows have all labels longer than the
30-character output limit. Candidate coverage is unchanged at 4,396/5,263
(83.53%); selection succeeds on 90.24% of covered rows. These are mechanical
diagnostics, not proof that every missing target is inferable from the inputs.

The current generator consumes party strings and mostly proposes contiguous
spans, plus supplied or training-attested acronyms/names. Complete authored names
also include transformed forms, citation qualifiers and document-local choices.
General cleanup and the unchanged ranker cannot by themselves supply those
missing operations or inputs. Earlier expanded-pool and structured-form trials
also failed to produce a substantial gain; repeating them is not a new strategy.

Source review should distinguish input/target defects, derivable missing naming
operations and valid document-local choices. The targeted 20-witness review below
establishes examples, not their share of all errors. The clarified responsibility
boundary above determines which errors belong to the learned model and which
belong to document rendering; the complete-form counts remain a separate record.

## Historical evaluation

The frozen generator reaches 73.58% on the historical test (8,081/10,983), and
74.23% on the reused grouped audit (5,701/7,680). The starting 46-feature model
scored 72.28% and 73.14%, respectively.

| Evaluation | Rows | Previous 89-feature model | Selected model | Gain, points | Paired 95% interval, points |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reused grouped audit | 7,680 | 5,681 (73.97%) | 5,701 (74.23%) | +0.26 | -0.14 to 0.72 |
| Historical test | 10,983 | 8,031 (73.12%) | 8,081 (73.58%) | +0.46 | 0.16 to 0.79 |

This round gains 144 matches and loses 94 on the test, and gains 108 and loses
88 on the audit, relative to the previous model. The test interval is positive;
the smaller audit gain remains uncertain. Modal-label agreement is 72.03% on
the test. These are exact normalized name matches, not merely choosing a party.
The starting 46-feature model scored 72.28% and 73.14%, so cumulative gains are
1.30 and 1.09 points. One historical-test case has no generated candidates and
remains an unsupported answer in the denominator.

Both evaluation sets have been scored in previous rounds. They are **reused
evaluations**, not fresh holdouts. Strategies and parameters used training and
development evidence; evaluation mismatches did not select them. The intermediate
72-feature candidate was almost flat on the historical test (72.29%). Adding
phrase and neighboring-word evidence then produced the improvement above.

All languages of a case and transitive exact ordered normalized party-pair matches stay
together in the SHA-256 70/10/20 split. Original training has 38,843 case/language
rows; development has 5,351. Reserving one fifth of original training groups gives
31,163 training rows and the 7,680-row audit. The audit covers 6,238 identities
and 4,839 components; the test covers 8,876 identities and 7,043 components.
The final model refits all original training rows; development selects its
boosting round and party-name evidence policy.

Intervals use 1,000 paired bootstrap resamples of case/party-pair components,
seed 93820. They do not account for different cases sharing a source document or
all effects of repeated development selection. Unsupported outputs stay in the
accuracy denominator. The frozen historical benchmark has 55,177 usable two-party
rows out of 61,020 qualified case/language rows. Its 5,843 nonadversarial or
missing-caption rows remain outside that evaluation; title generation is separate.
Current corrected-cohort counts are reported below and do not replace these
historical denominators.

| Historical-test cohort | Rows | Previous agreement | Selected agreement |
| --- | ---: | ---: | ---: |
| Leading corporate | 1,764 | 53.63% | 55.56% |
| Leading Crown | 1,268 | 81.70% | 81.62% |
| Leading government | 700 | 64.00% | 62.86% |
| Leading numbered | 82 | 46.34% | 48.78% |
| Leading ordinary | 7,169 | 77.60% | 77.92% |
| English | 8,717 | 72.58% | 73.08% |
| French | 2,266 | 75.20% | 75.51% |
| At least two documents | 3,905 | 82.38% | 83.12% |
| Same alias in two documents | 3,319 | 86.02% | 86.71% |
| One document | 7,078 | 68.01% | 68.31% |

Marker classes describe the leading party. Ordinary includes organizations
without recognized corporate or government markers. The multiple-document
cohorts are different populations; their higher scores are not overall accuracy.

## Strategies and naming tendencies

Ninety-eight further development comparisons selected joint ranking of name
evidence, conditional word statistics and a modal-label binary objective.
The next round tested 16 fitted configurations plus 12 score blends:

| Development strategy | Matches / 5,351 | Agreement |
| --- | ---: | ---: |
| Reproduced 72-feature control | 3,937 | 73.58% |
| Add phrase evidence | 3,961 | 74.02% |
| Add neighboring-word evidence | 3,957 | 73.95% |
| Combine both additions | 3,975 | 74.28% |
| Separate shortening, with current party choices fixed | At most 3,917 | 73.20% |
| Blend that shortening model with the existing ranker | At most 3,931 | 73.46% |
| Larger candidate-pool prototype with the binary objective | At most 3,932 | 73.48% |

A later grounded-form probe adds literal endings, supplied court/year qualifiers,
full styles and previously attested acronyms. Its development coverage is
4,672/5,351 (87.31%), versus 4,433 (82.84%) for the selected generator. Keeping
exact underlying-name features improves its best early fit only to 3,980
(74.38%). The retained first-witness table does not measure citation popularity.

Further development comparisons keep the original authored labels, case splits
and all 5,351 rows in the denominator:

| Further development strategy | Matches | Agreement |
| --- | ---: | ---: |
| Existing 89-feature control | 3,975 | 74.28% |
| Unlabeled provider-caption word combinations | 3,988 | 74.53% |
| Label components and word-form-conditioned statistics | 3,993 | 74.62% |
| Independent body-word counts and name syntax | 3,999 | 74.73% |
| Combine word-form statistics with body-word/name features | 4,007 | 74.88% |
| Add literal co-citation name overlaps | 4,010 | 74.94% |
| Document metadata and other-case author tendencies | 4,006 | 74.86% |

The selected caption-only strategy combines two small effects. Training encodings
may use an unambiguous party-name component of a qualified declaration, while
scoring still requires the complete original authored label. Word retention
conditions on word-form labels; acronym-only labels still inform party selection
and phrase frequency. Exact-party transfer continues to use original declarations.
The second effect uses fixed word counts from 4,000 hash-verified background
documents, excluding every document containing an accepted declaration, plus
primary provider names excluding every accepted-declaration case. These counts
and numeric trees require no LLM inference.

Context adds little so far. The citation graph contains full citation identities
and literal party-name spans, never the target alias strings. A first citation
in the decision's own header is excluded. The three-match development gain over
the caption-only candidate requires source context beyond the caption interface.
Only 97 of the 239 newly covered targets have their first witness in an actual
declaration document; 117 have a qualified target and possible name overlap in
that external first witness. These are proxy-coverage diagnostics, not accuracy.
The caption-only strategy was frozen before the reused evaluations.

The selected caption-only implementation reproduces every development feature
from the frozen prototype exactly. The reduced-training fit uses 422 trees and
the full-training fit 369. The public trainer reproduces all 422 reduced-fit
trees exactly; full-training word statistics also match exactly. Exported raw
scores match the fitter within 2.7e-14. Scores order names, not calibrated
confidence. The 52 development comparisons in this round retain the original
authored targets. Their table uses reduced training; the full-training model
scores 4,000/5,351 (74.75%) on development before historical-test evaluation.

The final expanded-form/context fits reach 4,020/5,351 (75.13%) and 4,006
(74.86%). The stronger fit selects 23 new forms, only five of which match.
Its 13-match gain over the caption-only candidate falls below the recorded
half-point development threshold for adding a source-context dependency.
Those strategies remain private and were not scored on either evaluation set.

Phrase evidence measures whether a complete word sequence is used as a label,
rather than inferring that choice only from averaged word scores. Neighboring
words help predict where a name starts and stops. Numeric word, phrase and
exact-party evidence use five grouped out-of-fold encodings in training.
Inference uses full-training statistics. Generic/weak-word sets use the full
training partition. Lexical counts are case/language observations, not numbers
of independent documents; language versions remain together in folds.

An attested name competes with other candidates instead of forcibly replacing
the winner after party selection. Development selected one-case/one-document
eligibility, with case count, independent document count and vote share available
to the ranker. This admits a proposal; it does not guarantee selection. Anonymous
party names do not enter the exact-party transfer map. Bare weak openings remain
restricted, while the same word can be a legitimate surname or interior name.
Compact parenthesized initials retain their complete supplied letters.

Later-word retention differs materially: "bank" 66%, "shipping" 61%, "services" 16%, "construction" 25%, "holdings" 26%.
These are training observations with tied modal labels fractionally weighted,
not universal shortening rules. Phrase boundaries add information beyond these
individual-word tendencies.

The larger pool prototype covered 86.36% of development targets but ranked
less accurately. Some newly added prototype forms used approximate features;
this does not rule out a better expansion. Earlier character models, cached
static input embeddings, weaker supra-reference targets, evidence weighting and
alternative objectives did not beat their controls. Separating party choice
and shortening also failed to improve the selected model.

The current historical-test pool covers 82.06% of targets. With it unchanged,
80% overall would require about 97.5% agreement among covered cases, versus
89.7% currently. At least 706 more test names would have to match.
This is a constraint on the current pool, not a ceiling on future strategies.
An earlier development diagnostic found 259 court/year-qualified rows and
55 whose authored names all exceeded 30 characters, alongside alternate captions,
acronyms, noncontiguous names and context-dependent labels. The completed probe uses supplied citation years, existing reporter/court
metadata, literal name forms and previously attested acronyms. Its coverage gain
has not translated into a substantive accuracy gain. Coverage alone does not
establish prediction accuracy.

An exploratory marker-defined subset contains 159 development cases whose
baseline-selected party has an organization word but is classed ordinary.
Only 63 names match (39.62%). Markers such as bank, board, union and university
identify a hypothesis, not adjudicated organization gold. Soft organization
features alone do not improve the control. A blanket bonus for keeping two words
also makes results worse. The useful gains come from conditional word choices
and name boundaries; organization markers do not establish a universal rule.

A descriptive training-only check makes the distinctiveness signal concrete.
Among uniquely anchored, multiword organization names with word-form modal
labels, an opening word present in at least 100 of the 4,000 background documents
is used alone in only **6.15%** of 1,208 case/language observations. If that word
is absent from the retained dictionary (zero or one background document), it is
used alone in **63.53%** of 1,299 observations. Two-or-more-word labels occur in
88.42% and 34.25%, respectively. The organization group is heuristic; these
are descriptive training associations with tied labels fractionally weighted,
not independent-document rates, causal effects or a new accuracy estimate.

A separate naming-variation diagnostic covers 16,066 training/development
case/language rows occurring in multiple documents. Predicting one document's
label from the other documents matches 81.27% of
105,550 case/document pairs, but 74.62% when cases/languages
receive equal weight. Frequently cited cases are more consistent. These are
separate denominators, not an accuracy ceiling.

## Structured representation and target audit

A bounded follow-up freezes a two-point development gate before fitting:
at least 4,115/5,351 matches, against the current reduced-fit 4,007. It replaces
flat competition between qualified strings with shared canonical-name scores
and a conditional model for complete surface forms. Canonical-name supervision
is auxiliary; complete original declarations still determine exact agreement.
The decoder compares every name/form combination jointly, including choices
whose canonical name would not win a greedy first stage.

Both fits use the same expanded pool as the earlier form probe, including
supplied citation-year/court metadata. They do not read citing-document text.
The retained caches provide 268,493 canonical-name training rows, and 175,313
surface-form training rows conditioned on a supervised canonical name. The
training rows cover 26,764 queries with a modal target in the expanded pool.
The expanded flat training pool had 1,582,078 candidates. Development still scores
all 314,158 surface candidates over all 5,351 cases. This is an experimental
input contract with citation metadata, not an installed caption-only replacement.

| Structured development strategy | Exact authored matches | Agreement |
| --- | ---: | ---: |
| Current reduced-fit generator | 4,007 | 74.88% |
| Canonical-name and conditional-form models from scratch | 3,975 | 74.28% |
| Continue the current generator for canonical names; fit conditional forms | 4,005 | 74.85% |

The better probe gains 27 names and loses 29. Its 21 canonical-name rounds and
44 form rounds fail the gate. The two complete fits take 58.03 and 66.10 seconds,
excluding preparation. Exported numeric scores match the fitter within 8.9e-15.
Custom grouped-softmax gradients pass finite-difference checks; joint decoding
passes an independently invented example where greedy decoding chooses wrongly.
Neither probe is scored on test or audit, installed, or used to refresh the data.
This rejects this prototype, not every possible structured model. In particular,
new canonical names without an original candidate use the retained 89-feature
view plus label-free shape features: 156,486/268,493 training names and
29,350/56,804 development names use that fallback.

The mechanical decomposition accounts for all 1,344 current development errors:

| Relation to the expanded pool | Errors |
| --- | ---: |
| Selected canonical name has an exact authored rendering available | 179 |
| An exact authored rendering is available for a different canonical name | 480 |
| An authored canonical name is available, but its exact rendering is absent | 83 |
| No matching authored canonical name under this decomposition | 602 |

Even perfect rendering of the currently selected name could yield only
4,186/5,351 (78.23%). The canonical pool covers 4,749 rows; the exact surface pool
covers 4,672. These are auxiliary mechanical relations, not semantic gold or an
information-theoretic ceiling. A separate inventory of the 602 missing canonical
names finds 16 literal party-word spans, five literal character spans, nine
regular initialisms, 11 noncontiguous/two-party word forms, ten style-separator
forms, 40 overlength labels, 27 rows with only annotation flags, and 484 unresolved
spelling/word relations. Each row is counted once, in that priority. The last
group includes unhandled qualifiers, local labels, alternative names and caption
or spelling disagreements; it does not establish that prediction is impossible.

A new source audit chooses 120 development case/language rows by a fixed hash,
then independently hash-selects one alias and one source witness per row. Review
is blind to predictions and captions. All 120 witness texts match their stored
hashes; they cover 119 independent documents. Codex source inspection finds
117 visible name declarations and three non-name annotations: a translation
header, a judge attribution and a publication-status note. This is case-weighted
sampled-alias validity, not the fraction of cases with no valid label, an
independent human gold set, or independent verification of every citation identity.
Explicit local/procedural labels and a declaration with different spelling remain
valid; difficulty predicting a name is not grounds for rejecting it.

Conservative annotation patterns flag 55 development rows, only 27 of which
have every accepted alias flagged. Reduced training has 385 flagged rows and
204 with every alias flagged. These are review flags, not adjudicated rejections.
The observed contamination deserves qualification work, but these patterns do
not explain a six-point improvement. During that probe, no original target,
denominator, selected model, preferred-name database or historical evaluation
score was changed. The subsequent data-quality pass preserves those inputs
separately and corrects the current prepared dataset.

The next useful evidence is verified source ownership/caption agreement and
actual document-local naming context, with the target declaration excluded from
any prediction input. A new source or input contract must be evaluated separately;
removing difficult declarations is not an accuracy improvement. The new scripts
are `operations.py`, `operation_probe.py`, and the added modes in `review.py`.
Private latest receipts are `operations-plan.json`, `operations-diagnosis.json`,
`operations-fit.json`, `blind-gold-review.json`, `annotation-audit.json`, and
`missing-name-inventory.json`. The selected generator remains at 73.58% historical
test / 74.23% reused audit. Forty-two focused tests pass after this follow-up.
Their current native fixture SHA-256 is
`c9afb2517a79f75ee20763d2e76ebf9d7345e2283b8385a9e42faee48ea8ca38`;
this does not establish equivalence to the unavailable historical extraction DLL.
`operations-validation.json` verifies unchanged gold, generator, prepared-code
fingerprints and frozen feature inputs, plus SQLite integrity and foreign keys.

## Source-backed data corrections

Two qualification passes exclude **1,389 raw observations** that contain
annotations rather than authored case names:

| Annotation | Observations excluded |
| --- | ---: |
| PDF page marker | 409 |
| Translation notice | 359 |
| Judge attribution | 564 |
| Publication status | 10 |
| Editorial instruction | 47 |

Nine declarations retain their supplied names after removing a separate judge
suffix. Repairs to **3,881 distinct case/language profiles** remove supported
citation spillover or restore caption words while preserving fuller supplied
names. The second pass makes 32 profile corrections, three to profiles already
touched in the first pass. These are bounded corrections, not certification of
each complete caption or authority identity.

The first annotation packet has 27 discovery and 27 disjoint validation
witnesses; the second has 31 and 31. A separate citation-spillover packet has
10 and 10 source-document witnesses. Annotation sampling uses the frozen
original training/development assignments; the caption packet also includes
unlabelled profiles. Every inspected source hash matches. Codex read the
passages without predictions; these targeted reviews are not independent human
gold or random-corpus precision estimates. All 117 genuine declarations from
the previous blind packet remain unchanged and usable.

All raw source and extraction tables remain unchanged. The original 61,020 rows,
aliases, captions and grouped assignments remain frozen privately. Current
qualification has **60,428 case/language rows**, including **54,654 two-party
rows**. In 592 original rows, no usable definition remains; 1,106 original
case/language alias labels are excluded. Caption repairs affect 283 retained
qualified rows. Removing invalid labels changes the cohort, not model accuracy.
The corrected input hash is
`ba6400363126b7857de7a4584bea09b091459c5ba3145819327b4b2d500c4c4d`.

The first pass rebuilt all preferred names. The second uses the same preparation
functions for 1,763 affected cases. It preserves 624,565 rows only after proving
the numeric generator code/model and all their profile, alias and exact-party
dependencies are unchanged. Their complete row fingerprint is unchanged; an
additional fixed sample of 128 unaffected cases reproduces all 148 names.

The controlled refit above closes the unchanged-recipe comparison; it does not
establish a model gain from cleaning. Source review also confirms
that a judge note can hide a genuine later declaration from raw extraction;
recovering it needs accurate source spans and ownership, not a replacement label
attached to the judge note's old span. Remaining literal caption mismatches
include valid fuller names, truncated captions and OCR; they are review candidates.

### Targeted review of names outside literal party forms

A further fixed-hash source review uses only corrected development inputs. Of
493 rows whose aliases all lack the existing mechanical literal/initialism
relation to either party, it selects 20 distinct cases and source documents,
then one alias per case. Selection precedes viewing refit predictions. All
selected witness bodies match their stored hashes. Codex source inspection is
targeted diagnosis, not independent human gold or a corpus precision estimate.
No label or input changes enter the frozen refit comparison.

Thirteen witnesses contain genuine authored names needing contextual names,
court qualifiers, reordered initials, topic names, document-local ordinals or
reversed abbreviated styles. Two lose year/court metadata available in the
parallel citation chain; two have incomplete cached captions. One defined term
names a legal rule rather than a case. One citation resolves to a differently
named judgment, checked against the installed primary source and its body hash.
One procedural annotation remains uncertain and is retained. These categories
account for all 20 witnesses; they are not population error rates.

Specific data corrections should preserve identity and year/court evidence
across parallel citations, and recover supported complete captions. Their
population impact must be measured before prioritizing them over method changes.
The current ownership path can retain a reporter-only member even when its
parallel chain supplies a stronger identity and metadata. Citation/name conflicts
need source adjudication, not automatic merging by party names. Genuine local
or contextual names must remain targets even when the current generator cannot
produce them. Source context can establish why an author chose a qualifier;
the clarified runtime contract assigns that choice to deterministic document
rendering, rather than adding document-context prediction to the learned model.
The private `clean-refit-source-review.json` retains the selection and judgments.

## Clear data errors repaired in v4

The v4 repair excluded another **2,435 non-name observations**:
2,427 document-local role labels, seven judge attributions and one directly
verified source misspelling. No replacement declaration or alternative accepted
name is invented for the misspelling. Raw observations, captions, source hashes
and spans are unchanged.

Existing profiles receive **3,612 substantive repairs** and **13,147 whitespace
normalizations**. The repaired families include 713 flagged physical line wraps,
33 captured introductory court prefixes, 97 publisher headers, and eight remaining
source-verified introductory French prepositions. Genuine procedural titles and
hyphens are retained. A further publisher-header capture is rejected after source
inspection reveals judges' names and a company number misread as a reporter page.
The raw malformed key remains evidence for ownership repair; it is not merged
into another authority automatically.

The full captions and authored declarations of **190 joined proceedings** remain
available, with no fictitious single party pair. Another **315 captured contexts**
or passages of reasons supply no caption or parties. Source evidence restores
missing leading caption words. Reference titles no longer acquire a party from
a statutory `c.` section marker. Another **6,257 empty language profiles** preserve
citation fallbacks when a rejected declaration was the only language evidence;
these are bookkeeping rows, not additional caption-error discoveries.

The v4 gold contains **59,075 case/language rows**, including **53,393** with
two parsed parties. Its input hash is
`c6dd607a4fb6827975c92d56a37d27e39663247a8f6454978331b9b66a1f6521`.
The v4 private input snapshot supplied corrected training and held-out
inputs: 41,444 train, 5,640 development, 11,641 historical test and 350 quarantined
rows. Previous partitions are preserved; components crossing them are quarantined.
Base targets and background exclusions must be rebuilt from this revision before
the next fit. Earlier comparison inputs and receipts remain frozen. There is no
new accuracy result, and alternative-name adjudication remains deferred.

Only 28,293 affected case identities are regenerated in the main pass, followed
by nine directly reviewed caption repairs. A fixed sample of 128 identities with
unchanged dependencies exactly reproduces all 145 preferred names. All 44 existing
checks passed during the repair; no tests were added. The prepared-data
audit and raw-table preservation checks passed for v4. The private `data-cleaning-*`
receipts retain the proposed deltas, source evidence, input snapshot and application
receipt. Remaining ownership/parallel-citation metadata losses and unresolved
caption or lexical discrepancies still need source repair; this is not a claim
that the whole dataset is clean.

## Verified ownership and spelling repairs in v5

Seven declarations attached to two reporter/database-only records are reassigned
to the provider cases expressly identified by their source citation chains.
The resolver now follows a unique known provider case within a parallel chain,
including French paragraph wording between citations. Conflicting provider
identities remain unresolved. Raw identities, keys, observations and spans are
preserved. Two reviewed parallel links retain reporter-year metadata and make
indexed citation/style lookups use the verified case. This is citation identity
repair, with no alternative names added.

Direct inspection also confirms two additional misspelled declarations against
the primary judgments. These labels are excluded without inventing replacements.
No named-reference assignment changes are required in the reviewed namespaces.
Only 80 affected identities are regenerated with the existing model. Seven
preferred-name rows change, including evidence counts and methods; none are lost.

The v5 gold has **59,071 case/language rows**, including **53,390** with two
parsed parties. Its input hash is
`f219398d479a565750c53bea481fb743508e7dad71d473c3fb74220a87e50bbe`.
The v5 `data-cleaning-inputs.json` had 41,440 train, 5,638 development,
11,641 historical test and 352 quarantined rows. One repaired identity had been
split between training and development; its two retained language rows are now
quarantined. Saved exposure groups are consumed by the ordinary fitting and
review paths rather than recalculated from the repaired identity alone.

The private `data-ownership-source.sqlite` and accompanying JSON preserve v4 data
and partition lineage. The `data-ownership-*` receipts record source hashes,
decisions, preferred-name deltas and application checks. Raw-table fingerprints
remain identical; SQLite integrity and retained declaration support pass.
No tests, training runs or holdout scoring were performed for v5. The broader
ownership replay and remaining caption/lexical discrepancies remain pending;
these seven declarations do not establish corpus-wide ownership accuracy.

## Caption boundaries and source-label provenance in v6

The case-insensitive party splitter treated uppercase C/V inside party names as
the case separator, even when the caption supplied a later lowercase `c` or `v`.
This truncated anonymized initials and split company names. The shared Python
caption parser now prefers the explicit lowercase separator, retaining the
case-insensitive fallback for other captions. Existing fuller party names are
preserved. Native grammar is unchanged.

The repair updates **1,443 profiles**: 1,436 party-boundary corrections and seven
source-caption corrections for captured headings/citations, a duplicated website
separator and corrupt header encoding. Every correction has a literal full-caption
source witness with a verified body hash. Four repaired profiles have authored
labels: two training, one development and one historical test. All original
declaration spellings, document votes and raw evidence remain unchanged.

Only **764 affected identities** are regenerated with the existing fitted weights.
The result changes 1,448 preferred-name rows, counting generated alternatives and
evidence methods; 1,433 change their displayed text. No preferred rows are lost.
Actual lookup review confirms that the previously truncated anonymous name retains
its complete initials in both languages. These are input/output corrections,
with no new model-accuracy measurement.

The v6 59,071-row gold has input hash
`e0225c8a424b9464324bbe6323da3abb60cda2b6a2a7498118ff3a7b8285fa48`.
The corrected snapshot still contains 41,440 train, 5,638 development, 11,641
historical test and 352 quarantined rows. Prior exposure groups remain fixed.
Base targets and background exclusions still require rebuilding before fitting.
The private `data-initials-*` files preserve source spans, prior affected rows,
preferred-name deltas and the application receipt. No tests, fits or holdout
scoring were run for this repair.

A separate direct provenance audit confirms that all **168,035 accepted
declarations** have raw observation witnesses. Mining copies the native parser's
explicit authored declaration, never its generated `shortName`. The archived
target-loader source matches the saved model's recorded code hash and reads
accepted definitions; compiled generated names never supply gold. The later
complete-form and base-target fits use the same source-label chain. Generated
candidates are scored against source labels. Supported base-target projection
can remove court/year qualifiers while retaining complete originals. The private
`training-label-origin.json` records this audit; it does not certify the semantic
correctness of every source declaration.

## Residual caption review in v7

All 274 remaining caption/party mismatches were inspected against source text.
The review restores 269 complete captions and withholds five unusable captions
from name generation. Four original PDFs, retained by hash in the canonical
corpus, resolve printed names and footnote ownership that the extracted text
could not establish. One stored citation had acquired the final case name in
the body rather than the case named by its own footnote. Other damaged or
incomplete witnesses supply no qualified party pair; their raw evidence remains.

The same review finds a general punctuation error: a detached period after `v`
or `c` can become the first character of the defendant name. Caption cleaning
normalizes this separator, including missing whitespace after its period.
Another 27 profiles have verified source witnesses for this repair. Reviewed
evidence can preserve a full procedural caption and its separately supplied
parties, rather than treating the procedural title as part of a person's name.
Fuller legitimate names are retained; shorter cached captions alone are not
evidence that the supplied names are wrong.

The batch changes **301 profiles**, including **11 labelled training inputs**.
It regenerates only **308 affected identities** with unchanged fitted weights.
There are 127 changed preferred-name rows, including generated alternatives and
methods; 99 change displayed text and none are lost. All authored declaration
labels, document votes, raw-table fingerprints and prior dataset partitions are
unchanged. The five withheld captions have no accepted authored declarations.

The v7 gold retains 59,071 case/language rows, now including 53,391 two-party
rows. Its input hash is
`e9e4fee4dd2715f330f71e6cc7db04ad8c5201df154b9ceed63c29e478a8f6ce`.
The corrected snapshot retains 41,440 train, 5,638 development, 11,641 historical
test and 352 quarantined rows. No tests, fits or holdout scoring ran for this
batch. The private `data-caption-residual-*` receipts retain source spans,
printed-page witnesses, prior profiles, deltas and the application checks.
`data-caption-residuals.json` retains the resolved spelling queue and five
withheld-caption records. These are not additional accepted shortforms.

The subsequent v8 pass resolves all **18 suspicious spellings** against original
printed PDFs, including the official judgment for one incorrect source spelling.
It regenerates 18 identities and changes 13 displayed preferred names. None of
these 18 profiles has an accepted authored declaration, so gold inputs and saved
partitions remain unchanged. The printed source also resolves a corrupted
fraction in an institutional name. The private `data-source-spelling-*` files
preserve page coordinates, hashes, prior rows and the application receipt.

Background-name compilation had continued to reparse raw `case_record` captions,
bypassing the qualified party profiles. It now selects one qualified language
profile per primary-provider case, preferring a nonempty English profile, and
retains all declaration exclusions. Freezing the selected input stream lets the
same compiler run on the desktop without a second statistics implementation or
full provider-database copies. The matched v8 refit freezes source labels,
partitions, numerical recipes and input/code hashes before desktop execution.

## Prepared data and checks

The frozen mining manifest retains all 292,205 nonempty text versions: 18,595 journal
texts and 273,610 A2AJ language versions, totaling 8,592,712,093 characters.
Duplicate texts receive no extra document votes. Full bodies remain in provider
stores; the index retains witnesses, spans, source identifiers and hashes.

| Measure | Current value |
| --- | ---: |
| Indexed identities | 541,638 |
| Identities with a non-fallback name | 437,989 |
| Case/language profiles | 525,608 |
| Ranked case/language/alias rows | 83,539 |
| Preferred case/language rows | 627,374 |
| Exact full-party name keys | 21,617 |
| Raw evidence rows | 275,640 |
| Database size | 266.844 MiB |

| Preferred method | Rows |
| --- | ---: |
| `citation_fallback` | 104,164 |
| `generated` | 254,530 |
| `generated_attested_party` | 191,628 |
| `observed` | 16,845 |
| `observed_single` | 41,792 |
| `title_generated` | 18,415 |

SQLite integrity, reviewed-delta checks and unchanged raw-table fingerprints
pass. Every indexed identity has a preferred row, and every observed
preferred name has declaration evidence. Original gold and model bytes are
preserved; the cleanup itself did not rescore holdouts. The separate controlled
refit above evaluates both generators on frozen v3 inputs. The v8 WAL checkpoint
is clean. Public feature
equality and exact reduced-fit tree reproduction passed at original model
promotion and were not repeated for this data-only cleanup.
The earlier source-only verification confirmed all 292,205 mined full texts,
export metadata and then-current code/model fingerprints. The provider has since
been reimported; a full source replay is not repeated for v4 through v8. The newly reviewed
witnesses match their stored body hashes. Corrected v3 background counts cover 4,000
hash-verified documents, excluding 34,949 declaration documents and 49,482
declaration case identities. The saved model still embeds its original background
statistics; the unpromoted refit uses the regenerated artifact.

All 464,573 generated rows in the earlier audit met empty/length checks. The v4 whole-data
audit measured median 7, P90 12 and maximum 30 characters. Its older broad
weak-single-word heuristic flagged 73 rows. Earlier review found permitted
surnames and interior uses after the opening-word restriction was corrected. The flags are
review candidates, not adjudicated errors.
Length checks and source-style inspection do not establish semantic accuracy.
Earlier unaliased-name review found title boilerplate, an upstream truncated
anonymous caption and non-party fragments. Those failure modes need separate
caption/title work, not additional claims of name precision. The earlier
80-witness declaration review was visible-parser source checking, not blinded
human gold or a precision estimate.

| Operation | Measured time |
| --- | ---: |
| Original full-text mining | 61.84 minutes |
| Original caption recovery/preparation | 20.55 minutes |
| Original selected background counts | 26.44 seconds |
| Rebuild corrected background counts | 85.53 seconds |
| Public reduced fit and exact reproduction proof | 234.48 seconds |
| Full-training fits, excluding feature preparation | 25.08 seconds |
| Original selected-model preferred-name refresh | 672.73 seconds |
| First data-quality preferred-name refresh | 1,715.14 seconds |
| Second data-quality update and validation | 201.90 seconds |
| Verify every current source and compiled fingerprint | 189.16 seconds |
| V4 main data-repair pass | 476.37 seconds |
| V4 prepared-data audit | 21.77 seconds |
| 10,000 V4 prepared lookups | 1.6015 seconds |
| V5 source-backed ownership application | 105.83 seconds |
| V6 caption-boundary application | 68.69 seconds |
| V7 residual-caption application | 77.52 seconds |
| V8 printed-source spelling application | 47.54 seconds |

On 1,000 fixed independently invented two-party inputs, warmed fresh-caption
ranking averages 2.27 ms (median 2.25, P90 3.71), versus 1.19 ms previously
(median 1.29, P90 1.64). This uses no attested-party map. It measures local
runtime cost, not accuracy or production throughput. The JSON model is 14.3 MB,
previously 10.0 MB. Indexed lookups remain separate from fresh-caption ranking.

These are local measurements. The fit timings exclude the complete strategy
search; full-training fit timings also exclude word/statistic feature preparation.
Cold mining and a full preferred-name refresh still exceed a few-minute budget.
Generation uses dictionary lookups and numeric trees with no LLM inference.

Extraction used native SHA-256
`d1dcee54791dbee5da7551d7da9435b55fc9f870f415673c59f4195b85af59e3`.
That immutable DLL was removed by later builds. Current native equivalence is
**unverified**; strict verification does not pass. Explicit `--sources-only`
verification checks source content, export metadata and compiled fingerprints,
leaving `current_engine_matches` null. At the earlier verification, the exact
historical grammar recovered from repository history had parsed JSON identical
to the then-current file; its byte hash differed because LF became CRLF. That
comparison does not certify the currently installed native binary. Focused native
fixtures used artifact
`aad82205e8dbbf0b4e70eae28a6fbd502b7f10f75a1c605e61561b4f9cd53eca`.

Latest private receipts, the current best candidate, source recipes and feature
caches live in ignored `benchmarks/local-data/case-shortforms/`. `iteration2.json`
retains the 98-comparison round; `iteration3.json` preserves the phrase round.
`iteration4-final.json` records this selected recipe, its sources, evaluation
comparisons and final data checks. The `iteration4-*` receipts retain the 52
new development comparisons and exact implementation proofs. The training-only
word tendency and synthetic runtime checks have separate latest receipts.
`analysis.json` and `audit.json` retain the selected candidate's original
evaluation; the prior round's receipts remain frozen separately. The private
`data-quality-*` receipts preserve both cleanup passes and the original inputs.
`preparation.json` and `validation.json` describe the current v32 compiled data.
`quality.json` retains the v4 whole-data audit; v5 through v8 use their recorded
application and delta checks. `verification.json` retains the earlier full-source
verification; it is not a v4 through v32 replay receipt.
Actual source passages and individual real cases are not published as fixtures.
