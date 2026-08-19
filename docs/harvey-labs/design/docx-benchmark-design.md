# DOCX benchmark design

## Outcome

Beaver now has a corpus-scale, local footnote split/link smoke benchmark over
diverse Word packages. It sits above the split/link benchmark already implemented in
`legal-pdf-parser`; duplicating that engine or the ALR application
would create drift without adding evidence.

It does not yet provide independent gold for general DOCX extraction,
comments, revisions, tables, controls, headers/endnotes, or round-trip fidelity.

The canonical private corpus currently contains 24 byte-unique, least-edited
upstream DOCX packages (10.76 MiB). Derivative editorial families were reduced
to one source document per work; filenames indicating chief, galley, camera,
annotated, ToA/BoA, returned, revised, or final copies were excluded. Its
manifest records structure without making filenames the benchmark identity.
Eighteen packages contain a footnotes part and 16 yield positive footnote
cases. Feature counts mean documents containing a feature, not object totals.

## What was reused from the ALR benchmark

The reusable patterns are:

- immutable JSONL records with explicit `accepted`, `provisional`, and
  `needs_review` states;
- SHA-256 document identity and seed-based stable sampling;
- cheap deterministic evaluation over the full corpus, with expensive model
  arms restricted to one frozen sample;
- a conservative arm that can abstain and a recall-first arm, reporting both
  coverage and accuracy;
- canonical exact partitions plus explicitly reviewed acceptable partitions;
- substantive character-conservation checks that ignore whitespace and
  semicolon split delimiters, but reject inserted or lost source text;
- separate under-split, over-split, boundary-mismatch, character-drift, and
  abstention counts;
- tagged slices, per-case details, aggregate summaries, elapsed time, errors,
  cache telemetry, and model token use;
- paired comparisons on the same cases instead of comparing unrelated sample
  averages;
- human review before candidates become gold, with duplicate text prevented
  from silently overweighting a result.

ALR also has useful specialist benchmarks for supra-link recovery and
deterministic reference replay. Those should supply task-specific gold when
Beaver's supra and citation-link actions are evaluated; their link-outcome labels
(`same exact`, `same source/reanchored`, `wrong`, and `abstain`) are more
meaningful than raw string similarity.

## Local workflow

`benchmarks/docx_corpus/benchmark.py` provides four narrow operations:

1. `scan` verifies every manifest SHA-256, extracts footnotes and their paired
   proposition passages with the legal PDF parser, and runs conservative and
   recall-first deterministic arms.
2. `sample` deduplicates normalized footnote text, uses stable hash ordering,
   favours hard/abstained cases, and spreads first selections across documents.
   It emits provisional rows only.
3. `score` evaluates accepted gold with strict and tolerant exactness,
   character conservation, coverage, precision when attempted, tagged slices,
   and paired transitions. Population intervals/tests are disabled for
   enriched challenge samples.
4. `fixture` feeds accepted cases to the existing live Codex arm runner, which
   already enforces bounded batches, response schemas, caching, token
   telemetry, arbitrary model/effort selection, and exact source preservation.

The full local scan is descriptive until a human-reviewed sample exists.
Character conservation proves that a splitter did not invent or drop text; it
does not prove that the citation boundaries are legally correct.

The first canonical scan parsed all 24 documents without error in 2.37 seconds
with eight workers. It extracted 2,009 footnotes (1,860 unique normalized
texts) and 1,090 citation signals. The conservative replacement gate completed
143 footnotes (7.12% coverage); recall-first returned parts for all 2,009.
Neither arm had a substantive character-conservation failure. These are
coverage and safety results, not boundary-accuracy results; accuracy remains
pending human gold. The frozen review queue contains 80 unique footnotes from
16 documents, deliberately balanced 40/40 between conservative completions and
abstentions; it is a challenge set, not a representative accuracy sample. All
rows remain explicitly `provisional`.

The existing universal-engine ALR compatibility runner was also rerun against
all 405 accepted split-gold rows: conservative produced 144 exact, 7 under, 2
over, 2 boundary mismatches, and 250 abstentions; recall-first produced 324
exact, 0 under, 66 over, and 15 boundary mismatches, with zero character
failures. The standalone synthetic self-test passed.

## Equivalence protocol

Use the emitted frozen-gold subset and its exact case IDs for every arm. At
minimum compare:

- the historical/current Beaver baseline;
- deterministic conservative;
- deterministic recall-first;
- the bounded strong-model direct route;
- the bounded strong-model hybrid route;
- any proposed economy model at the same effort and route.

A candidate is not equivalent merely because its mean accuracy rounds to the
same number. Require:

- no increase in under-splits or character drift;
- no loss of tolerant exactness on the paired cases;
- no regression on `supra` and `ibid`; document-level tracked-change and
  content-control flags remain proxies until note-local gold exists;
- successful DOCX round-trip tests showing unchanged visible citation text;
- provider/link scoring for correct authority and pinpoint, separately from
  splitting;
- reported wall time, live versus cached batches, input/output/reasoning
  tokens, and error rate.

Report population confidence intervals or p-values only for a separately
frozen representative sampling design. Challenge-set results remain
descriptive and must be read by stratum. Statistical significance cannot
rescue a legally material under-split.

## What was deliberately not copied

- The ALR Excel review builders depend on `openpyxl` and application-specific
  workbook columns. JSONL is enough for the first corpus pass; add a review UI
  only if manual adjudication becomes the bottleneck.
- ALR secret discovery, provider clients, runtime globals, and cache layout are
  not benchmark infrastructure and would create coupling.
- Its HTML report generator duplicates data already present in the JSON
  summaries.
- No ALR gold, cache, workbook, or user DOCX was copied by this port. The
  legal PDF parser already contains the independently maintained splitter and
  its recorded 405-case compatibility result.

## Privacy, provenance, and licensing

DOCX packages can contain confidential text, comments, tracked deletions,
custom XML, author metadata, and embedded objects. The copied sources,
source-path manifest, extracted cases, reviewed gold, live fixtures, model
traces, and caches therefore remain in git-ignored `private_*` locations. A
SHA-256 is pseudonymous, not anonymous: it can identify a known public file.

Only an aggregate summary that has been inspected for identifying slices
should be committed. A live fixture contains verbatim footnotes and proposition
passages; running the live benchmark transmits those passages to the selected
provider. Do not do that for privileged or confidential material without the
necessary authority and current provider-retention review.

The inspected ALR repository labels project-authored code Apache-2.0 and
separately warns that upstream data and service terms continue to apply. Its
documents and hand-reviewed corpus do not automatically inherit a right to
redistribute every underlying passage. This port copies no source code or
corpus data, so it adds no ALR notice obligation; any future verbatim code copy
must preserve the applicable Apache licence and notices. Downloaded documents
must remain local unless their own licence or permission allows redistribution.
