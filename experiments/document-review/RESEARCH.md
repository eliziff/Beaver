# Lessons applied to document review

Sources checked November 8, 2026. These are benchmark-design sources, not legal
authority for any individual privilege decision.

| Source | Useful lesson | Consequence here |
| --- | --- | --- |
| [TREC 2010 Legal Track](https://trec.nist.gov/pubs/trec19/papers/LEGAL10.OVERVIEW.pdf), especially topic 304 | Privilege is distinct from responsiveness; their exercise assessed protection even for nonresponsive material. Topics have a designated authority and explicit scope. | Two independent labels, a client and review brief per matter, and irrelevant privileged controls. Disputed gold stays unresolved until adjudication. |
| [TREC 2011 Legal Track](https://trec.nist.gov/pubs/trec20/papers/LEGAL.OVERVIEW.2011.pdf) | Production requests and coding guidelines define relevance. Missing responsive documents matters alongside false positives. | Score recall and precision separately and retain the same brief across nested levels. Never equate exhibit membership with relevance. |
| [Exploration of Open Large Language Models for eDiscovery](https://aclanthology.org/2023.nllp-1.17/) | It evaluates relevance and separately studies the quality of generated reasons. Its text-email setup is narrower than a messy production collection. | Separate designation from work-product quality; preserve attachments, image evidence and bundles rather than presenting email bodies alone. |
| [DISCOG / Learning from Litigation](https://aclanthology.org/2025.acl-industry.46/) | Retrieval/predictive coding and the subsequent generated reasoning are separate stages. | A plausible explanation cannot repair a wrong designation. Keep evidence locators and report stage failures separately. |
| [LegalBench-RAG](https://arxiv.org/abs/2408.10343) | Precise supporting spans are more useful than an entire vaguely related document. | Gold reasons cite short passages or physical pages. A file-level decision still covers the whole file; a quoted relevant sentence does not certify that every attachment was reviewed. |
| [Harvey LAB](https://www.harvey.ai/blog/introducing-harveys-legal-agent-benchmark) | A matter contains instructions, source materials and reviewable work, assessed against specific criteria. | Evaluate useful filenames, supported dates, document descriptions and adequate reasons against fixed criteria, accepting accurate alternative wording. Our existing local LAB corpus also contains related privilege-review tasks; it is a useful format reference, not independent ground truth for these real filings. |
| [HELM](https://crfm.stanford.edu/2022/11/17/helm.html) | Coverage, multiple metrics and standardized adaptation are necessary for interpretable comparisons. | Fix model, prompt, extraction, images, ordering and budget; distinguish text review from file/OCR capability. Publish coverage limits and per-set/per-level results instead of only a pooled number. |
| [Annotation Artifacts](https://aclanthology.org/N18-2017/) | Models can exploit partial-input clues without solving the intended task. | Run metadata-only and content-only provenance probes, simple label baselines, and source/template-held-out checks. Passing one probe is not proof of no shortcuts. |
| [Contrast Sets](https://arxiv.org/abs/2004.02709) | Small meaningful changes can reveal decision boundaries hidden by aggregate accuracy. | Include substantive near-duplicates that change a label, alongside quality-only scan variants that should preserve it when legible. |
| [MT-Bench / LLM-as-a-Judge](https://arxiv.org/abs/2306.05685) | Model judging requires scrutiny; a model preference is not objective truth. | Use a fixed rubric, conceal model identity, retain judgments, and require human calibration before using quality scores as a definitive ranking. Independent model agreement is explicitly qualified as model review. |
| [LiveBench](https://arxiv.org/abs/2406.19314), [contamination mitigation study](https://proceedings.mlr.press/v267/sun25t.html) | Fresh evaluation material and objective scoring help, but superficial transformations are not a reliable contamination cure. | Keep these task-specific labels private; split by entire proceeding and document family, including distractors. Public filings may already be in training data. Renaming or fake metadata does not establish an uncontaminated test. |
| [Datasheets for Datasets](https://arxiv.org/abs/1803.09010) | Document collection, composition, limitations and intended use. | Retain URLs, original hashes, physical page maps, source qualification and every material transformation outside model inputs. |

## Synthetic-document tools

[OrgSmith](https://github.com/peterzat/OrgSmith) is the strongest match for coherent
background collections: deterministic fact ledgers, authored prose, emails,
Office formats, duplicate/version noise and scan transforms. Its own data card
calls the examples specimens rather than representative samples. Its review
findings are useful limitations, not a reason to treat its facts as litigation
gold. The inspected upstream revision is recorded privately with the source.

The source deliberately adds `OrgSmithSynthetic` properties to PDFs/Office
containers, `X-OrgSmith-Synthetic` to email, and synthetic comments to legacy
Office files. Preserve that provenance on archived sources; input copies must
exclude it. Merely removing a PDF Creator field misses other channels. Its draft
noise adds a prominent draft banner and removes trailing blocks: useful background
mess, but insufficient as the only substantive near-duplicate test. Its simulated
OCR protects planted facts from corruption, which makes it easier than real OCR
at precisely the values a benchmark may ask about. Do not feed its archived true
scan text to the candidate as if it were observed OCR.

This experiment uses OrgSmith's facts, DocIR, Word/email renderers and quoted
history. Spreadsheets use its installed XlsxWriter dependency. LibreOffice
prints native files; our Legal PDF Parser reads the actual common review PDFs.
The public example documents are useful for inspecting the tool, but are
excluded from evaluated packets. Original markers and upstream licensing remain
in the private checkout. Document authorship is direct; Codex exec serves
narrow review, judging and blind-inspection tasks.

[Augraphy](https://github.com/sparkfish/augraphy) supplies copier damage, applied
to both real and synthetic documents. Visual checking caught an excessively
destructive fax transform on one font: it was replaced with milder copier noise,
resolution loss and blur. Text must be read back from the resulting pixels;
never assume that an augmentation preserves the facts that decide a label.

[Genalog](https://github.com/microsoft/genalog) combines HTML document templates,
degradation and text alignment, but is in maintenance mode and has extra native
rendering dependencies. It is an alternative for layout generation rather than a
necessary second pipeline here.

[pypdf metadata documentation](https://pypdf.readthedocs.io/en/stable/user/metadata.html)
distinguishes ordinary PDF information from XMP. Our fake export profiles replace
both; they do not change the authoritative original's date or author. Incidental
export dates deliberately differ from meaningful document dates. Export profiles
must be assigned independently of relevance, privilege and real/synthetic origin.

## Acceptance gates

1. Source identity and complete filed-unit coverage, not inferred page boundaries.
2. Exactly ten distinct proceedings; requested Level-3 sizes; strict nested levels.
3. Same-filing-only Level 1, same-litigation additions in Level 2, mixed Level 3.
4. Exact-copy, scan-pair, substantive-version and embedded-component coverage.
5. Separate source author and blind reviewer; adjudicate disagreements and record
   uncertainty. Human calibration is still required for defensible quality claims.
6. No answer keys, manifests, source paths or generator markers in model folders.
7. A filesystem-enabled blind agent examines actual anonymous files, metadata,
   observed text and complete page images. Tool-disabled surface probes are
   useful diagnostics, but do not replace this test. Hold out cases/records after
   repairs, retain actual packets and tool transcripts, and report uncertainty.
8. No label or relevance-score claims while any required gate remains unresolved.

Ten matters support useful case studies, not narrow confidence intervals about
all litigation. Treat the proceeding as the resampling unit. The levels are paired
conditions, not independent observations. Do not turn duplicates into extra
independent evidence. Freeze evaluation input hashes and prevent all family members
and shared distractors from crossing any later training/development/test split.

## Lessons from actually making and testing the documents

The experiments in [RESULTS.md](RESULTS.md) distinguish two construction methods.
The fully authored native histories failed origin detection, including after
repairs. In the paired source-letter experiment, the detector made the same
binary call on every original/edited pair. Controlled changes to authentic
structures are therefore the stronger development direction so far. This is an
inference from small diagnostics, not a validated general result.

For the next source-conditioned fixtures, start with the document's practical
purpose and an authentic structure: who wrote it, to whom, on what occasion,
with which attachments and contemporaneous records. Make the needed changes
against a private fact/edit ledger. Preserve irrelevant ordinary detail instead
of rewriting the entire document into a helpful account of the legal issue.
Check chronology, identities, currencies, arithmetic, references and attachments
against that ledger before rendering. Do not require every author to restate
every planted fact; this made our invented exchanges conspicuous.

A record's language and the review answer have different purposes. Source
insurance correspondence can contain detailed coverage language. The model's
reason for relevance should explain the point simply. Imposing the answer's
plain-language style on every source document produced unusually tidy records.

Controls must cover the whole communication family. Our initial disclosed copy
of advice could affect protection of its other copy; independent reviewers did
not catch that issue. It was replaced with a necessary confidential legal-team
copy. Ordinary lawyer scheduling and business exchanges supply nonprivileged
controls. A future confidentiality contrast should use legally consistent
contexts, rather than contradictory labels on simultaneously disclosed copies.

Origin detection also needs source controls. In three letters, the detector's
reasons concerned genuine-source inconsistencies rather than our date edit.
Comparing both versions in separate blind contexts exposed that confound. Keep
the unchanged document, the registered change, both predictions and their stated
clues. Do not delete an inconvenient genuine typo, select only successful fakes,
or treat a plausible detector explanation as proof of causal detection.

Scoring references need independent source checks too. Two reference models
agreed on month-only dates that were clear to the eye and already identified
precisely in the chronology source gold. A judge then penalized correct candidate
metadata and genuine OCR caveats. Reference review now includes complete page
images and the existing source identification. Date conflicts with that source
are queued even when models agree; the quality judge also sees exactly what OCR
the candidate received. A bundle can legitimately support more than one date,
so supported component dates are recorded rather than forced into a spurious
single-answer disagreement.

Finally, PDF Info/XMP is only part of transport hygiene. Hard links can expose
membership in a lower level; public hash seeds can reconstruct creation order;
mounting sibling levels reveals the real-only core. Current packets use
independent copies, normalized timestamps, private ID/order seeds and isolated
level mounts. These fixes remove specific shortcuts; the observed content
failures show why they cannot substitute for realistic authorship.
