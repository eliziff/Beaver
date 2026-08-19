# Citators and a defensible Beaver good-law service

Status: research complete; proposed implementation and benchmark contract.

## Decision

Beaver should build a transparent Canadian citator, but it should not initially
claim that a case is simply “good law.” A case can be reversed on one issue,
remain useful on another, be binding in one jurisdiction and merely persuasive
in another, or depend on a statutory version that is no longer in force.

The defensible first product is therefore:

1. a versioned citation and appellate-history graph;
2. exact citation contexts and proposition/pinpoint scope;
3. high-precision, evidence-backed treatment candidates;
4. a separate jurisdiction, hierarchy, and date analysis; and
5. conservative warnings that always open the underlying passages.

The safe neutral state is:

> No verified negative treatment found in indexed coverage through
> YYYY-MM-DD.

It is not a green “valid” flag. Absence of a detected problem is not proof that
none exists.

## Evidence boundary

Commercial citator internals are proprietary. This note treats vendor help,
methodology, training material, and product documentation as **documented**.
Patents are **disclosed possible designs**, not proof of the current production
implementation. The architecture proposed for Beaver is **our inference** from
those public facts and ordinary information-retrieval practice.

## What the established services publicly document

| Service | Documented mechanics | Human and machine roles | Publicly documented cadence and limits |
| --- | --- | --- | --- |
| Westlaw KeyCite | Separates direct history, negative treatment, and citing references; the most negative treatment drives the prominent flag. Headnotes/Key Numbers and depth-of-treatment tools narrow results to a point of law. KeyCite Overruling Risk identifies a case that relied on an authority later invalidated on the relevant point. | Westlaw documents attorney-created headnotes and classifications, while Overruling Risk is expressly an AI feature. Public materials do not disclose the complete production classifier or which individual edges receive human review. | Alerts report later changes, but no reliable public end-to-end SLA was found. |
| Lexis Shepard’s | Uses editorial treatment phrases, subsequent appellate history, headnote-level filtering, and an overall signal controlled by the strongest negative treatment. A signal is not changed by user filters. Shepard’s At Risk follows an issue-specific three-case path: case A relied on B; later case C seriously undermined B on the same point, in the same jurisdiction, after A, and the reliance appeared in the majority opinion. | Lexis says attorney-editors follow a 29-step process. At Risk uses structured headnote, time, jurisdiction, and opinion-role conditions. | A newly added case can have no signal until processing is complete; the public US help does not promise an exact delay. |
| Bloomberg Law BCite | Provides Direct History, Case Analysis, a Table of Authorities, and Citing Documents. Bloomberg’s Points of Law isolates reasoning and links it to citing cases. | Bloomberg describes BCite as a combination of human intelligence and automation and separately says it uses ML/NLP. It does not publicly specify the exact label model, review allocation, or correction workflow. | Its database is described as continuously updated, without a public treatment-label SLA. |
| vLex / Vincent | US Cert combines case-to-case citations, language patterns, and appellate history. UK and Irish treatment labels are editorial. Precedent Map and citation-in-context expose the graph and frequently cited passages. | Cert combines technology with a lawyer review team; UK/Ireland labels come from the legal team. Vincent’s generative case analysis is a separate feature and is not evidence that an LLM assigns citator status. | US Cert says treatments are updated weekly, with exceptions for especially important federal cases. Current vLex guidance says Canadian citation links are **unclassified**, unlike the US, UK, and Ireland. |
| CanLII RefLex | Recognizes case and legislative citations, tolerates common variants, resolves parallel citations, and builds case-to-case and case-to-provision links. Its note-up ranks discussion intensity and identifies possible unfavourable mentions. | Most links are automated. RefLex learns parallel-citation associations and incorporates manual guidance; CanLII deliberately favours reliability even if that means fewer links. Possible unfavourable mentions and some history relations are programmatic and can be wrong. | CanLII generally posts decisions within two working days of receipt, uploads legislation about monthly, and publishes feeds for corrected decisions. That is source availability, not a guarantee that every treatment is classified then. |
| Lexis QuickCITE Canada | Separates case history from treatment and supports positive, cautionary, negative, neutral, and information-only signals. It distinguishes majority, minority, and dissent use. Its legislation citator works at the section level and labels unconstitutional, constitutionality discussed, considered, referred to, and cited treatment. | The public help defines an editorial treatment taxonomy but does not publish the complete allocation between automation and editors. | Case citator records are added within one to two days of a case going online and update daily; recent bare citations may receive fuller treatment within 72 hours. The legislation citator updates weekly. |
| UK ICLR Citator+ / historical JustCite | ICLR records subsequent consideration and appellate history. JustCite exposed positive, neutral, and negative relationships through a precedent map and linked parallel reports. | ICLR says qualified barristers or solicitors perform the indexing and experienced editors check it. Historical JustCite described legally trained editors. | ICLR is limited to the reported material it indexes. JustisOne closed in 2022 and its users moved to vLex, so its old documentation describes useful design, not a current independent service. |

Primary support:

- [KeyCite flags and negative-treatment workflow](https://legal.thomsonreuters.com/blog/westlaw-tip-of-the-week-checking-cases-with-keycite/),
  [Westlaw editorial enhancements](https://legal.thomsonreuters.com/en/products/westlaw/editorial-enhancements),
  [KeyCite depth-of-treatment support](https://support.thomsonreuters.com.au/product/westlaw-precision-australia/articles/westlaw-precision-australia-guide-using-keycite),
  and [KeyCite Overruling Risk in Canada](https://www.thomsonreuters.ca/en/products/westlaw-edge/features/keycite-overruling-risk.html).
- [Shepard’s signal rules](https://supportcenter.lexisnexis.com/app/answers/answer_view/a_id/1088155),
  [Shepard’s editorial and headnote features](https://www.lexisnexis.com/en-us/products/lexis/shepards.page),
  and [Shepard’s At Risk conditions](https://supportcenter.lexisnexis.com/app/answers/lexisplus_answer/a_id/1102050).
- [Bloomberg’s description of BCite and Points of Law](https://assets.bbhub.io/bna/sites/7/2021/05/Bloomberg-Law-for-Litigators.pdf)
  and [its account of ML/NLP in BCite](https://pro.bloomberglaw.com/about/our-approach-to-ai/).
- [vLex Cert methodology and cadence](https://support.vlex.com/document-types/case-law/cert-tm)
  and [current jurisdiction-specific treatment coverage](https://support.vlex.com/vlex-library/vlex-library-home/content-and-document-types/how-to-analyze-case-authority-and-precedent).
- [CanLII’s RefLex methodology](https://www.canlii.org/info/reflex.html),
  [manual guidance in RefLex 3](https://blog.canlii.org/2015/03/17/canlii-professional-users-news/amp/),
  and [automated note-up/history limitations](https://blog.canlii.org/2020/11/17/a-new-wave-of-improvements-on-canlii-%F0%9F%8C%8A/amp/).
- [QuickCITE Canada’s complete public treatment, history, scope, and update
  rules](https://support.lexisnexis.ca/app/answers/answer_view/a_id/1083640/~/note-up-with-quickcite-canadian-citator).
- [ICLR’s editorial treatment methodology](https://www.iclr.co.uk/blog/archive/judicial-consideration-a-reporters-guide-to-good-law/)
  and [current ICLR case-information fields](https://www.iclr.co.uk/products/iclr-4/how-to-use-iclr-4/).

Thomson Reuters also holds a patent describing an implied-overruling design
that forms `(overruling case, overruled case, relying case)` triples and uses
dates, jurisdictions, citation paragraphs, headnotes, Key Numbers, and text
similarity to test whether the same issue is involved. This is a useful public
design reference, but a patent describes permitted embodiments and must not be
represented as the exact current KeyCite implementation
([US 11,615,492 B2](https://patents.google.com/patent/US11615492B2/en)).

## The common operating model

The public evidence supports a common pipeline:

1. **Ingest and version sources.** Acquire opinions, dockets, legislation,
   amendments, and corrections. Preserve source identity, retrieval time,
   language, and content hash.
2. **Resolve identity.** Detect a citation and map neutral citations, reporter
   citations, database citations, docket numbers, case names, and parallel
   citations to one authority. Ambiguous citations remain unresolved.
3. **Build typed edges.** Keep same-litigation history separate from a later
   case’s treatment of a precedent. Store the exact citing span, pinpoint,
   opinion part, and target proposition or provision.
4. **Classify the relationship.** Examples include affirmed, reversed, varied,
   followed, applied, explained, distinguished, criticized, not followed, and
   overruled. A relationship can have more than one label and can cover only
   part of a judgment.
5. **Apply authority context.** Court hierarchy, jurisdiction, date,
   publication or precedential status, majority versus separate opinion, and
   the legal issue determine weight. These facts do not change what the citing
   court said; they change its legal significance.
6. **Derive a warning.** Commercial services often show the strongest negative
   result first, but retain the underlying history and treatment report so the
   researcher can inspect scope.
7. **Update and correct.** New decisions, appeals, amendments, corrigenda, and
   editorial corrections invalidate affected derived results and alerts.

This explains why embeddings alone cannot make a citator. They may help align
two propositions, but identity, appellate history, statutory versions,
pinpoints, court relationships, and evidence receipts are exact structured
facts.

## Opinion-aware integration

The decision-roster work supplies a missing citator input: exact opinion
boundaries and the judges who authored or joined each opinion. Join a citation
edge to an opinion only when both use the same source hash and the edge's text
offset falls inside that opinion's exact `[start, end)` range. This makes the
opinion role and result position deterministic metadata on the edge.

Treatment classification must support two experimental modes. In combined
mode, one model response finds opinion boundaries and classifies the selected
citation contexts together. In staged mode, the treatment classifier receives
the completed opinion extraction. The same frozen cases, resolved citation
edges, model, and effort are used to measure whether joint attention improves
either task enough to outweigh its larger schema and coupled failures. No
production mode is selected before that ablation.

In both modes, explicit treatment markers and the existing
prose-versus-authority-list classifier select citation contexts; the model is
not asked to classify every bare citation. The parsed opinion and treatment
records remain independently validated and stored even when they came from one
response.

The treatment classifier decides only what the citing passage says: who is
speaking, the treatment label and scope, and the exact supporting quote. Code
supplies the resolved citation edge, source offsets, target identity, court,
date, and containing opinion. A party submission, quoted source, concurrence,
or dissent is retained as evidence but cannot silently become treatment by the
deciding court.

A cited decision need not be in the local corpus. A resolved external citation
key can receive treatment events from in-corpus citing decisions; the target's
full text is needed only to align the treatment to a target proposition. A
citing decision outside the corpus must itself be acquired before its treatment
can be classified.

Case-level indicators are derived views over immutable events. Direct history,
substantive treatment, citation-only references, opinion position, and
proposition scope remain separate in storage even when the interface surfaces
the most consequential event first.

## Why “good law” is not a binary case property

Three independent questions must stay separate:

- **What happened to this decision?** The same proceeding may have been
  affirmed, reversed, quashed, varied, remanded, reconsidered, or appealed.
- **How did another decision treat it?** A later court may follow one
  proposition, distinguish another, or criticize dicta without impairing the
  holding.
- **How much weight does that treatment carry here?** A directly controlling
  appellate decision differs from a coordinate court, another province, a
  tribunal, a concurrence, or a foreign court.

Shepard’s own documentation notes that an overall signal follows the strongest
negative treatment regardless of point of law or rendering court. Its
headnote-level report exists because the overall badge is only a triage device.
Lexis also stresses that an overruled case can retain followed points of law.
Beaver should preserve that nuance instead of copying only the badge.

Depth is also not validity. A long discussion is useful for prioritization, and
a frequently quoted paragraph may identify the proposition in play, but neither
fact makes the treatment positive or controlling.

## Canadian constraints

Canada needs more than a US treatment classifier:

- Canada has federal and provincial/territorial court paths, national and
  local tribunals, and a non-linear relationship between some federal and
  provincial bodies. The [Department of Justice hierarchy](https://www.justice.gc.ca/eng/csj-sjc/just/07.html)
  is a starting map, not a complete binding-authority rule engine.
- Vertical and horizontal stare decisis operate differently. The Supreme Court
  of Canada explains that lower courts generally follow higher courts while
  coordinate-court rules differ by level
  ([R v Kirkpatrick, 2022 SCC 33](https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19458/index.do)).
- A superior-court constitutional declaration binds lower courts in the same
  jurisdiction but does not automatically bind courts across Canada; federalism
  matters ([R v Sullivan, 2022 SCC 19](https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/19390/index.do)).
- English and French, common law and Quebec civil law, historical Privy Council
  appeals, neutral and pre-neutral citations, reporter abbreviations, tribunal
  reconsiderations, publication bans, oral reasons, and corrigenda all require
  explicit handling.
- CanLII aims to publish distributed written decisions, but some oral decisions
  never become written reasons and publication restrictions can delay others.
  Its documents are not official, automated enhancements can require
  correction, decisions are generally posted two working days after receipt,
  and legislation is generally uploaded monthly
  ([CanLII FAQ](https://www.canlii.org/info/faq.html)).
- Current vLex documentation treats Canadian citation relationships as
  unclassified. Free Canadian note-up data is therefore valuable evidence, not
  a ready-made reviewed treatment gold set.
- Official legislation must be versioned by provision. Federal Justice Laws
  exposes current-to dates, amendments not in force, related provisions, and
  prior versions; general point-in-time coverage begins only in 2003 for Acts
  and 2006 for regulations
  ([Justice Laws help](https://laws-lois.justice.gc.ca/eng/FAQ/?wbdisable=true)).
  Provincial and territorial systems differ.
- Legislative status has separate axes: enacted, in force, amended, repealed,
  constitutionally inoperative, subject to a suspended declaration, and
  judicially interpreted. A judicial warning cannot replace amendment and
  commencement tracking.

Data rights also constrain the design. CanLII prohibits systematic downloading
and external indexing except where authorized
([terms of use](https://www.canlii.org/info/terms.html)); the UK National
Archives requires a separate licence for computational analysis of Find Case
Law records
([licensing terms](https://caselaw.nationalarchives.gov.uk/permissions-and-licensing)).
Beaver should use licensed or expressly bulk-downloadable sources, not scrape
consumer sites.

For Canada, the existing A2AJ integration is the sensible bulk substrate:
A2AJ offers API and Parquet access to bilingual cases and legislation and
retains upstream-licence metadata
([A2AJ data access](https://a2aj.ca/data/)). It is still an unofficial
reproduction, so high-consequence results should link to and, where possible,
verify against the official source.

## Failure modes

An automatic citator will otherwise produce predictable mistakes:

- treating a party’s submission, quoted passage, headnote, concurrence, or
  dissent as the court’s holding;
- matching “was not overruled” or a historical description as current negative
  treatment;
- resolving an ambiguous case name or reporter citation to the wrong decision;
- applying a negative label to the whole case when only one proposition was
  affected;
- treating “distinguished” as invalidation rather than factual or legal
  non-application;
- missing history where the appellate decision does not identify the lower
  decision clearly—an express limitation in QuickCITE’s public help;
- treating a case under an earlier statute as invalid merely because the
  provision was later amended;
- ignoring the effective date, territorial scope, suspended remedy, or later
  appeal of a constitutional ruling;
- retaining stale edges after a corrigendum or replacement judgment; and
- interpreting missing citations as evidence of validity despite corpus gaps.

These are not theoretical concerns. A 2018 study reviewed 357 relationships
that at least one of Shepard’s, KeyCite, or BCite marked negative. Within that
selected sample, Shepard’s and KeyCite missed or mislabeled about one-third and
BCite more than two-thirds. Because the sample included only relationships
flagged by at least one service, those figures are not population-wide error
rates, but they prove that commercial flags also require inspection
([Paul Hellyer, *Evaluating Shepard’s, KeyCite, and BCite for Case Validation
Accuracy*](https://scholarship.law.wm.edu/libpubs/131/)).

Likewise, an expert-annotated 2026 preprint reports only 67.7% accuracy for the
best tested model on its fine-grained precedent-treatment task. It is promising
benchmark material, not evidence that an LLM can replace an editor
([*Validate Your Authority*](https://arxiv.org/abs/2605.17691)).

## Proposed Beaver architecture

### Stage 1 — exact note-up graph

Use the shared `OpenLegalData` SQLite runtime and existing provider adapters.
Ingest A2AJ bulk snapshots first, CourtListener/CAP bulk data for the US, and
official or licensed feeds elsewhere. Reuse deterministic citation extraction;
for US citations, the open-source
[eyecite](https://freelawproject.github.io/eyecite/find.html) parser and
[CourtListener citation graph/API](https://www.courtlistener.com/c/) are
appropriate inputs.

Store:

- canonical authority and provider IDs;
- every citation alias and parallel citation;
- source/version hash, language, court, jurisdiction, date, docket, and
  opinion role;
- citation edges with exact source spans and target candidates;
- provider-native paragraph/page/section locators and deterministic links; and
- explicit coverage windows and unresolved-citation queues.

Ship note-up and “cited by” before treatment badges. It is already useful and
does not overclaim.

### Stage 2 — verified direct history and legislation versions

Build same-litigation families from provider metadata, dockets, explicit
appellate language, party/docket identity, and court path. A red direct-history
warning requires an official outcome or an unambiguous source passage. Keep
pending appeal, leave granted/refused, supplementary reasons, costs, and
reconsideration distinct from reversal.

For legislation, create immutable provision versions and events for enactment,
commencement, amendment, repeal, and official correction. Attach judicial
treatment to the exact provision and version. Never infer present in-force
status from a case citation.

### Stage 3 — treatment candidates

Run cheap deterministic rules when explicit treatment language is close to a
resolved citation and occurs in the court’s reasons. Send only ambiguous new
edges—not user queries or whole corpora—to a bounded model classifier.

The classifier receives:

- the citing paragraph and bounded neighbours;
- the cited proposition/pinpoint where available;
- majority/dissent and judgment-section metadata;
- the requested fixed label schema; and
- an instruction to return the supporting span or abstain.

Its result remains `machine_candidate` until a high-precision rule, independent
corroboration, or human review promotes it. The model never writes a status
sentence or URL and is never needed at lookup time.

### Stage 4 — proposition-level indirect risk

Only after direct treatment is reliable, evaluate triples:

1. A relied on B for proposition P;
2. later C invalidated B for materially the same proposition P;
3. the relevant jurisdiction, date, and opinion-role conditions hold.

Present this as “possible indirect risk,” not “overruled.” Show all three
passages and let the user inspect the proposition alignment. Embeddings may
generate candidates, but exact paragraphs, dates, and graph edges determine
the receipt.

### Stage 5 — review, corrections, and alerts

Prioritize human review for severe labels, highly cited authorities, SCC and
appellate decisions, conflicts between sources, and user-reported errors.
Corrections are append-only review events; derived badges are rebuilt from the
reviewed facts. Incremental ingestion invalidates only affected graph
neighbourhoods and watched authorities.

This design is fast on weak hardware: SQLite handles exact graph traversal,
contexts are precomputed once, and no model call occurs when a user opens or
notes up a case.

## Minimal durable record

Do not copy a commercial taxonomy wholesale. A compact neutral record is
enough:

- `authority`: canonical ID, type, jurisdiction, court, decision date;
- `authority_alias`: citation text, normalized form, source, confidence;
- `document_version`: source URL/ID, language, retrieved time, content hash;
- `citation_edge`: citing/cited IDs, exact span, pinpoints, opinion role;
- `history_edge`: same-matter relation and verified outcome;
- `treatment_assertion`: label, scope, proposition, evidence span, method,
  confidence class, reviewer state;
- `provision_version`: enactment, effective interval, amendment lineage;
- `coverage_receipt`: provider, court, date range, last successful update; and
- `review_event`: correction, author, reason, timestamp, superseded assertion.

Raw probabilities are diagnostic data, not user-facing legal conclusions.

## User-facing contract

Use four evidence states:

- **Verified invalidating history** — direct reversal, quashing, or equivalent,
  with the official source.
- **Negative treatment — review** — a later authority criticized, declined to
  follow, questioned, or otherwise impaired a proposition.
- **Possible indirect risk — review** — a two-hop proposition dependency.
- **No verified negative treatment found** — always accompanied by coverage
  and update time.

“Distinguished,” “appeal pending,” “amended legislation,” and “unclassified”
remain separate badges. Every badge opens the exact cited and citing passages,
history chain, court/jurisdiction context, source version, and why the badge was
assigned.

## Gold set and equivalence plan

Build two locked sets: a natural-prevalence evaluation set and a deliberately
balanced diagnostic set. Do not call vendor output or model-generated labels
gold.

The first Canadian release set should contain:

- 2,000 citation identities covering neutral, CanLII, parallel reporter,
  French, pre-neutral, OCR-damaged, and ambiguous forms;
- 400 case families with official prior/subsequent history;
- 1,000 citing relationships, including majority, concurrence, dissent,
  submissions, string cites, and every supported treatment label;
- 150 indirect-risk triples with same-point and different-point controls; and
- 200 provision/version events covering commencement, amendment, repeal,
  constitutional treatment, suspended remedies, and appeals.

Stratify across the SCC, federal courts, every province and territory,
appellate and trial courts, tribunals, Quebec civil law, older authorities,
English, French, bilingual documents, and published corrections. Split by case
family and cited authority so near-duplicate relationships cannot cross train
and test sets.

Ground truth requires:

1. exact source snapshots and hashes;
2. official dockets or legislation where available;
3. two independent Canadian legal annotators;
4. a third adjudicator for disagreement;
5. a fixed label guide with proposition and evidence-span annotations; and
6. explicit `unknown` and `insufficient_source` outcomes.

Measure:

- citation-resolution precision, recall, ambiguity abstention, and alias error;
- strict citation-edge target and evidence-span accuracy;
- exact appellate-family and outcome accuracy;
- macro-F1 plus severity-weighted treatment error;
- severe-negative recall and false-warning rate;
- proposition-scope and majority/separate-opinion accuracy;
- indirect-risk precision and different-point false positives;
- provision/version and effective-date accuracy;
- freshness lag from upstream publication and correction replay;
- evidence-link and source-hash integrity; and
- cold/warm p50/p95 latency, incremental ingest time, database size, and model
  cost.

Compare the same frozen inputs across:

1. citation graph only;
2. deterministic treatment rules;
3. bounded model classification;
4. rules plus model abstention and review; and
5. manually queried KeyCite Canada and QuickCITE results where the licence
   permits comparison.

Commercial signals are comparison observations, not copied training labels or
automatic truth. Record disagreements and have annotators decide from the
underlying judgments.

Initial release gates:

- at least 99.5% precision for automatic citation linking, with abstention on
  ambiguity;
- 100% evidence-span and provenance presence for every displayed warning;
- no silent severe-history miss in the locked SCC/appellate critical set;
- at least 95% precision and 95% recall for automatically displayed severe
  treatment on the broader gold set; otherwise retain human review;
- no green or unqualified “good law” conclusion; and
- under 50 ms p95 for a warm local note-up lookup on the weak-hardware test
  machine.

## What Beaver can and cannot defensibly replicate

Beaver can reproduce the useful foundation: citation normalization, parallel
identity, exact contexts, provider pinpoints, appellate families, provision
versions, jurisdiction-aware note-up, deterministic links, transparent
receipts, incremental alerts, and a reviewable treatment layer.

It cannot initially reproduce the historical completeness, proprietary
headnotes/taxonomies, licensed collections, editorial workforce, or correction
operations behind KeyCite, Shepard’s, QuickCITE, BCite, and ICLR. It also
cannot promise that an unflagged authority is valid beyond its recorded
coverage. Those are data and editorial-operation gaps, not problems that a
larger prompt or model can erase.

The credible goal is therefore not “KeyCite clone.” It is a local-first,
auditable Canadian citator whose narrower claims are fully supported and whose
coverage can expand without changing the evidence contract.
