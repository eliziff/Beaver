# Harvey tool/context audit (2026-08-01)

Status: smoke evidence, not a winner declaration. One task cannot establish a
general retrieval policy. Token totals below use provider `input_tokens` as the
total; OpenAI cached input is a subset, not an amount to add again.

## Same-task Luna results

Task: `banking-finance/extract-credit-agreement-covenants`. Model and judge were
held constant within the High comparison. A criterion pass rate is shown
because LAB's native task score is fail-closed (one missed criterion fails the
task).

| Arm | Criteria | Input | Output | Total | Wall clock | Calls | Failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Max p0 pilot | 58/65 (89.2%) | 661,013 | 32,644 | 693,657 | 617.90 s | 22 | 0 |
| High p0 | 56/65 (86.2%) | 471,624 | 16,281 | 487,905 | 337.60 s | 23 | 0 |
| High d1 | 55/65 (84.6%) | 432,316 | 14,413 | 446,729 | 295.74 s | 17 | 0 |
| High address | 52/65 (80.0%) | 500,767 | 25,919 | 526,686 | 501.74 s | 24 | 0 |
| High upstream r2 | 58/65 (89.2%) | 102,284 | 19,036 | 121,320 | 356.61 s | 4 | 0 |

The Max row is a pilot, not part of the High A/B. Its higher score cannot be
attributed to the tool surface rather than effort.

## What occupied context

The initial system prompt, resident schemas, and task message were small:

| Arm | Initial estimated tokens |
| --- | ---: |
| p0 | 3,341 |
| d1 | 3,490 |
| address | 3,791 |

That is below one percent of cumulative input. Tool observations dominated.
The High runs exposed 305,354 chars (p0), 313,158 chars (d1), and 303,057
chars (address). A later strict-upstream whole read established the correct
complete extracted-source denominator: about 170,373 chars (141,465 + 14,809
+ 14,099). The resulting gross observation/source ratios are about 1.79x,
1.84x, and 1.78x. An earlier draft of this audit incorrectly used p0's capped
agreement read as if it were complete and reported about 3.3x; that estimate
was wrong. The corrected ratios are not exact semantic-overlap metrics, but
they still show that progressive schema disclosure alone did not keep the
evidence trajectory lean.

The main waste mechanisms were:

- p0 read the full credit agreement and later emitted broad Grep results that
  repeated much of it. Several more broad searches replayed overlapping text.
- d1 used fewer rounds, but broad OR-pattern Greps effectively reconstructed
  the agreement before targeted Reads.
- address used exact provision, exhibit, and table-cell reads successfully,
  but three high-cap `library_find` calls emitted about 107.5k chars. It also
  requested the same outline twice at increasing caps, repeating the first
  prefix.
- p0 disclosed drafting and review schemas on its first call, leaving them in
  every subsequent request. Address delayed drafting disclosure until the end.
- Address generated two complete DOCX drafts because a title already ending
  in `.docx` was sanitized to `...docx.docx`; the model regenerated rather than
  accepting the wrong filename. Filename normalization is now fixed and tested.

## Retrieval versus synthesis

The address tools reached the spreadsheet, Article VIII, section 2.05, exact
provisions, exhibit `HH`, and native table cell `table:2`. Several failed final
criteria were therefore synthesis/selection losses after successful retrieval,
not inaccessible evidence. In particular, maturity dates, historical covenant
schedules, payment grace/equity-cure facts, and the 100% prepayment provision
were present in tool results but omitted or framed incorrectly in the memo.

The rich surface's promising pockets were exact provision reads, native table
cells, exhibits, and verified structural handles. No run exercised editing, and
none used cross-reference/citation-chain traversal, so this task cannot answer
whether rich editing or graph navigation helps.

Two score failures require human adjudication rather than a tooling verdict:

- The spreadsheet reports some ratios that do not match arithmetic from its
  inputs. A strong answer should preserve the reported value and separately
  state the recomputation; the model mostly chose only the recomputed framing.
- One criterion labels 253.75 as Total Consolidated Funded Debt, while the
  spreadsheet labels 257.95 that way and labels 253.75 Senior Secured Debt.

## Upstream whole-document control status

The first strict-upstream High execution used exactly three `read_document`
calls and one `generate_docx` call. It read all three sources once, exposed
about 170,373 source chars, and used 103,357 input plus 20,200 output tokens
(123,557 total) in 382.42 seconds. Its model-visible surface receipt contained
only `read_document`, `find_in_document`, `list_documents`, `fetch_documents`,
and `generate_docx`; progressive disclosure was off.

Its initial 1/65 judge score is invalid and excluded. The tool created a
32,692-byte DOCX with about 51,853 extracted text characters, but the LAB
harvester did not recognize upstream's `generate_docx` name and instead scored
an 8,864-byte DOCX synthesized from the 590-character chat confirmation. The
creation-event alias is fixed and the bad receipt is marked
`valid_for_comparison: false`.

The fresh `upstream-r2` run again used three whole reads and one
`generate_docx`, this time harvesting the actual 33,574-byte generated DOCX.
It scored 58/65 (89.2%) with 102,284 input plus 19,036 output tokens (121,320
total) in 356.61 seconds. Relative to the leanest other High arm, d1, it used
72.8% fewer total tokens and passed three more criteria, although it was 60.87
seconds slower. Its seven misses included five substantive omissions and the
two probable rubric/source conflicts already described. It alone among the
High arms passed the reported-versus-recomputed Total Net Leverage framing and
the interest/fee payment grace-period criterion.

This result is strong evidence that broad whole-document synthesis is a real
baseline, not evidence that it is the general winner. The smoke task asks for
coverage across almost the entire agreement and two companion documents, the
case most favorable to reading every source once. Structure-specific, editing,
and many-document tasks remain untested.

## What coding agents do about repeated context

There is no single canonical plugin. Mature agents combine several layers:

1. **Bound model-visible observations.** Codex has used head/tail limits for
   tool output; Cline now bounds bash, file-read, and search ingestion; ECA
   writes complete output to a cache file and tells the model how to retrieve
   a narrower slice. Full output remains available outside the prompt.
2. **Map first, retrieve second.** Aider sends a graph-ranked repository map
   under an active token budget (normally about 1k tokens), then adds requested
   files. This is the closest coding analogue to a compact legal structure map.
3. **Prune old observations and condense history.** OpenCode protects recent
   tool-output tokens and erases older outputs; OpenHands and Cline can replace
   older history with a summary. This helps overflow but is lossy, so exact
   legal evidence must remain durably rehydratable.
4. **Externalize durable state.** Event stores, file-based plans, MCP memory,
   and bounded subagent results survive compaction without replaying every raw
   observation. They preserve decisions and receipts, not necessarily source
   evidence.
5. **Prevent duplicates at the tool boundary.** Will Chen's upstream Mike
   already keys full reads by document/version and returns a small
   `already_read` receipt. Recent Cline releases likewise mention duplicate
   tool-result prevention. This is stronger than merely asking the model not
   to reread.

Prompt caching is not a context-control mechanism. It can reduce the cost and
latency of processing an unchanged prefix, but the model still receives that
prefix and remains exposed to its length and redundancy.

Primary implementation references:

- Aider repository maps: <https://aider.chat/docs/repomap.html>
- OpenCode pruning/compaction source:
  <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts>
- OpenHands context condenser:
  <https://docs.openhands.dev/sdk/guides/context-condenser>
- Cline changelog (bounded tool ingestion and duplicate-result fixes):
  <https://github.com/cline/cline/blob/main/CHANGELOG.md>
- ECA output cache and context management:
  <https://eca.dev/config/context-management/>
- Codex tool-output limit discussion and source pointer:
  <https://github.com/openai/codex/issues/6426>
- Claude Code prompt caching semantics:
  <https://code.claude.com/docs/en/prompt-caching>

Tool-selection research separately supports treating descriptions and
disclosure policy as experimental variables, not neutral documentation.
ToolScope reports that merging redundant tools and context-aware filtering
improved tool-selection accuracy by 8.38% to 38.6% across its evaluated models
and benchmarks. A controlled EMNLP study found that description edits alone
could move competing-tool usage by more than 10x. JTPRO consequently treats
the global prompt, tool descriptions, and argument descriptions as a joint
rollout-optimized surface rather than hand-written constants:

- ToolScope: <https://aclanthology.org/2026.acl-long.1573/>
- Tool Preferences in Agentic LLMs are Unreliable:
  <https://aclanthology.org/2025.emnlp-main.1060/>
- JTPRO: <https://aclanthology.org/2026.findings-acl.2017/>
- EASYTOOL concise tool instructions:
  <https://aclanthology.org/2025.naacl-long.44/>

This supports a small description ablation on real legal tasks. It does not
support automatically generated or maximally persuasive descriptions: the
objective is correct conditional use, including correct non-use, not raw tool
invocation rate.

Community plugins package the same ideas, but their benchmark claims are
self-reported and they should not be installed into Beaver merely because they
exist. `context-mode` keeps raw tool data outside the prompt, records session
events in local SQLite/FTS5, and returns compact computed results; `headroom`
compresses tool outputs; planning-with-files-style skills externalize a plan,
findings, and progress to ordinary files. The first pattern is directly
relevant, the second risks destroying exact legal wording, and the third helps
continuity but not evidence duplication:

- <https://github.com/mksglu/context-mode>
- <https://github.com/headroomlabs-ai/headroom>
- <https://github.com/modelcontextprotocol/servers> (`server-memory` reference)

The closest research match to Beaver's stable-document observation is CORVUS.
It decouples file-read actions from append-only observations and keeps a
synchronized registry of relevant current file contents. Across two SWE beds
and four models, the paper reports comparable pass rates with 9–50% lower
average input tokens, 15–32% shorter final prompts, and up to 37% fewer
reasoning cycles: <https://arxiv.org/abs/2607.22711>.

## Beaver design implication: exposure, not just reads

A legal matter usually has immutable document versions during one research or
drafting turn. Beaver can exploit this more strictly than a coding agent facing
concurrent edits:

- Key exposure state by `(document_id, version_id, projection)`.
- Track the union of exact source spans emitted to the model.
- On a contained repeat, return a small `already_exposed` receipt with the
  original evidence handle instead of the text.
- On a partially overlapping request, return only unseen spans plus enough
  bounded boundary context to remain intelligible.
- After a mutation, the new durable version gets a fresh exposure namespace;
  other documents remain valid.
- Keep full tool results and exact evidence receipts outside model context for
  audit and deterministic rehydration.

A strict raw-read ratio of 1.0 is too blunt because one source may have
legitimate projections: accepted text, redline markers, table cells, page
geometry, or a cross-reference graph. The benchmark should report both:

- `source_exposure_ratio = unique source characters exposed / source chars`
- `gross_replay_ratio = all source-derived characters emitted / unique source characters exposed`
- per-projection ratios and cross-projection overlap
- duplicate/contained/partial-overlap request counts and chars suppressed

The initial policy hypothesis is a gross replay ratio near 1.0 for immutable
plain-text views, not a universal hard cap on every projection. Any enforcement
must first be A/B tested for recall loss.

## Cross-task evidence through the capital-markets block

The pre-Harvey evidence remains relevant and should not be overwritten by the
new runs:

- Stage 21 found no robust answer-quality difference between legacy and
  address navigation on two LegalBench-RAG pairings, but address exposed about
  75% fewer document characters. The bed was weak: queries leaked document
  names, it had no pages/cases/citations, and its gold penalized following a
  cross-reference needed for comprehension.
- Across 2,941 calls, `library_links`, graph `follow`, and page addressing were
  never used. The new Harvey traces likewise have not used `library_links` or
  graph following. This is evidence that these affordances are not discoverable
  in the current vocabulary/policy, not evidence that legal relationships have
  no value.
- In the 162-run editing campaign, address grammar without disclosure cost
  14.6% more tokens than legacy. Adding progressive disclosure cut tokens by
  29.3% within the same grammar and reduced retyped characters and misquote-
  bearing runs, while correctness stayed inside the replicate floor. Hiding a
  risky retyping editor changed behavior beneficially.
- Those editing runs exposed real table-cell and renumbering gaps. Exact native
  table-cell handles and deterministic delete/renumber support have since been
  added, but the current Harvey tasks exercise reading/synthesis plus document
  creation, not `Edit`; they cannot validate those improvements.

The varied runs materially weaken the premise that a richer retrieval contract
is automatically better. They also show why the result cannot be reduced to one
leaderboard number: judge choice moved several borderline criteria and reversed
the narrow white-collar ordering.

| Task / judge | Upstream whole read | P0 coding | D1 routed coding | Address/rich |
| --- | ---: | ---: | ---: | ---: |
| Banking, Claude | 58/65; 121k tokens | 56/65; 488k | 55/65; 447k | 52/65; 527k |
| White collar, Claude | 45/58; 180k | 44/58; 486k | 44/58; 470k | 41/58; 812k |
| White collar, Codex | 45/58; 180k | 48/58; 486k | 48/58; 470k | 47/58; 812k |
| Capital markets, Codex | 28/32; 74k | 25/32; 193k | 26/32; 211k | 25/32; 311k |

The banking Max P0 pilot reached 58/65, but used 694k tokens. Thus the only
coding result that tied upstream on that task used about 5.7 times the tokens.
Latency did not fall in proportion to tokens: upstream still spent one large
attention/drafting pass, while multi-tool arms paid for more provider cycles.

The judge bridge covered all 232 white-collar arm/criterion pairs. Claude Code
Sonnet 4.6 and Codex GPT-5.6 Sol agreed on 91.4% of verdicts (Cohen's kappa
0.75), but Codex passed 81.0% and Claude 75.0%. Codex was generally more
permissive and changed the arm order. Raw scores from the two judges therefore
must not be merged. Codex is suitable as the fast primary judge for subsequent
blocks only if its identity remains explicit and Claude is retained as a
smaller audit ruler.

### What the trajectories say

- P0 and D1 are practically tied. The additional routing language has not
  earned its prompt or behavioral complexity.
- Address/rich has not won accuracy and is always the most context-expensive
  High arm. On white collar it made 25 `library_find` calls after reading only
  three of six documents. On capital it outlined and read all eight documents,
  then made ten additional finds and seven structure-lint calls.
- The capital P0 and D1 runs already had a gross source-span replay ratio of
  exactly 1.0; white-collar P0 was 1.0097 and D1 1.0816. Duplicate source spans
  are therefore not the main explanation for their token totals.
- The remaining cost is primarily many model/tool cycles, cumulative replay of
  prior observations in later provider calls, large unique tool outputs, and
  optional review tools the model invokes without demonstrated score benefit.
- Some of that behavior is prompt-induced. The non-progressive lean prompt
  tells the model to prefer a long list of deterministic organs and requires
  anchor coverage for extraction/comparison. The progressive `review` domain
  then reveals conflict, term-drift, structure, anchor, drafting, and bilingual
  tools as one bag. In the capital P0 trace this produced seven source-document
  structure-lint calls; in address it produced those same seven calls after
  eight outlines and eight reads. Progressive disclosure reduced initial
  schema size but did not constrain post-disclosure appetite.
- Rich tools can reach exact provisions, cells, and exhibits, as the banking
  trace showed. Their current weakness is orchestration and synthesis, not
  inability to retrieve evidence.

The criterion differences are not random. Across both white-collar judges all
arms missed the transmittal-email cross-reference, the CFTC cooperation-order
cross-reference, the 180-day timeline concern, the email's compliance-
certification point, and the CFTC-offset tax implication. Upstream uniquely
found the undefined compliance-certification term and debarment consequence;
the coding arms more often found the missing Attachment C, its consequences,
and a prioritized negotiation agenda. On capital, every arm missed the
guarantor tax-opinion issue, the indenture-date severity classification, and
correct responsibility attribution. Upstream alone got two severity/summary
criteria that every other arm missed.

These are principally relationship and final-synthesis failures. Merely adding
another search tool will not cure them. The next surface must make cross-source
relationships cheap to inspect and must leave enough context budget for a
coverage pass before drafting.

### Provisional hybrid shape

The evidence now points to an upstream-first hybrid rather than a rich-first
hybrid:

1. Preserve the cheap whole-document path for a modest corpus. One batched read
   followed by drafting is a strong default, not a baseline to discard.
2. Keep literal `Glob`, `Grep`, `Read`, and `Edit` for corpora or tasks that
   exceed a deterministic whole-read budget and for targeted verification.
3. Put legal structure inside those familiar tools. `Grep` should be able to
   return a token-budgeted section/cell map and follow literal document cross-
   references; `Read` should accept the returned, path-qualified coordinates.
   A coordinate from one document must not be guessable or silently reusable
   against another.
4. Keep deterministic legal review tools deferred until the request actually
   calls for that operation. Extraction and checklist work should not trigger a
   general parade of structure lint, drafting lint, term drift, and conflict
   scans without a measured caller benefit.
5. Load the drafting tool only when evidence collection is substantially done,
   and carry the exact requested output filename into its contract so the model
   cannot create a human-title draft and then create it again to fix the name.
6. Retain the versioned exposure registry as an ablation. It is well supported
   by CORVUS and by legal-document immutability, but current replay ratios show
   it is infrastructure hygiene rather than the first-order accuracy/token fix
   for these one-turn runs.

The first completed 25-file tax cell adds a seventh constraint. Address/rich
used 803,594 tokens and 71 calls: 25 outlines, 37 reads, and a broad review
suite. `library_term_drift` required the model to copy 25 durable UUIDs in one
argument; it corrupted at least one identifier and the call failed. Two reads
then guessed a section `3` that the corresponding outlines did not advertise.
The hybrid should therefore present the matter as an immutable, filename-first
filesystem with short disambiguators. Durable UUIDs belong in server receipts,
not in ordinary model arguments. Returned legal coordinates must be executable
path-qualified recipes, not labels the model transfers or guesses across files.

The 25-file tax block remains the planned scale check. No hybrid should be
locked until that already-launched block lands, because it is the task most
likely to expose the limit of the upstream whole-read default.

### Structure-arm fairness audit: contracts, legislation, and citator

The structure arm has not yet received a fair test as one coherent product.
The existing address arm bundled useful coordinates with broad orientation
payloads and a second vocabulary. The hybrid should instead expose legal
structure as optional scopes on familiar search/read calls, with each scope
operating at the legal level the user actually named.

Observed on the Harvey source documents, without model calls:

- Across the seven capital-markets DOCX inputs, the extracted text was 92,140
  characters while default `library_outline` output totalled 20,234 characters
  (22.0%). There were 590 nodes, of which 515 were native table/table-row/cell
  nodes.
- Across the 25 tax DOCX inputs, extracted text was 1,166,898 characters while
  default outlines totalled 198,890 characters (17.0%). Of 15,895 nodes,
  13,909 were table/table-row/cell nodes. Cell-heading previews alone accounted
  for 150,425 source-derived characters before outline truncation.
- This is not evidence against native tables. It is evidence against emitting
  a near-global table coordinate inventory. A literal search that returns one
  executable row recipe preserves the useful structure without paying for
  thousands of unrelated cells.
- The Criminal Code s. 276 real-instrument probe now distinguishes decimal
  provisions (`153` and `153.1`) from parenthetical ancestry (`160`, `160(2)`,
  `160(3)`) and resolves the coordinated outbound list. Target-only output was
  3,150 model-visible characters; inbound was 5,421; outbound was 22,080. The
  combined call stopped at an arbitrary 20-section cap and omitted three
  resolved provisions even though its character budget had room. Completeness
  must be governed by the declared character/result budget and reported
  truncation, not a hidden small count.
- The current citator note-up for `2016 SCC 27` returned about 9,575 characters
  at its default 10-case page. About 865 characters were an always-returned
  provider citation list and whole-graph statistics that do not help answer
  the ordinary note-up question. Its tool description itself is 861
  characters. The existing deterministic `standsForProfile` path returned
  eight authority-ranked attested passages in about 4,615 characters, but is
  not exposed through chat and its existing evidence-receipt builder is not
  wired to the tool result.

The resulting design constraints are:

1. **Exact legal-level scopes.** Contract and legislation calls must accept an
   exact article, section, subsection, paragraph, subparagraph, schedule,
   table, row, cell, page, or paragraph range where the source supports it.
   Decimal provision identifiers are siblings: `150.1` is not a child of
   `150`; parenthetical levels are children. A requested parent may include its
   true descendants, while an exact child stays narrow.
2. **Search first, coordinates second.** Ordinary `Glob`, `Grep`, and whole-file
   `Read` remain valid. `Grep` may search inside one exact legal unit or return
   de-duplicated executable `Read` recipes. It must not emit a global outline
   or cell inventory merely because structure exists.
3. **Bounded graph unions.** One-hop inbound/outbound/both reference reads must
   return a non-overlapping union of the target, its true descendants, and the
   resolved direct neighbours. They report every applied count/character cap
   and which results were omitted. Rich semantic treatment classification is
   explicitly out of scope for this experiment.
4. **Citator scopes match judicial hierarchy.** A note-up call should be able
   to restrict citing decisions to SCC, appellate, trial, an exact normalized
   court code, or all courts. Scope and ranking are independent: a caller may
   ask for newest decisions or the decisions that discuss the cited authority
   most.
5. **Cheap discussion-density ranking.** The first candidate signal is the
   number of resolved citation occurrences in each citing decision, unioned
   across proven citation aliases. Evaluate cheap additions separately:
   distinct citing paragraphs, cited pinpoints, and resolvable short-form/case-
   name mentions after the first full citation. Do not call this treatment or
   good-law classification. Return the component counts so the ranking is
   auditable.
6. **Citator payload and evidence discipline.** Default output should contain
   the query, total matching citers, applied scope/sort, and bounded citing
   passages with pinpoints and evidence handles. Corpus-wide statistics and a
   50-item provider list do not ride on every result. Attested
   characterizations use the already-existing citator receipt path rather than
   unsupported model prose.
7. **Temporal integrity audit (deferred correctness gate).** Offline, compare
   the canonical decision date of every cited node with each citing decision.
   A citing date strictly earlier than a known cited-decision date is
   temporally impossible and must be counted, sampled, and quarantined from
   ranking until resolution/source errors are understood. Unknown dates are
   not failures, and no edge is deleted merely from a citation year or an
   inferred date.
8. **Typed tables underneath, lean projections on demand.** Mature document
   stacks separate table structure from model serialization. Docling keeps
   typed cells and row/column spans in its document model and supplies separate
   serializers; Unstructured retains a plain-text table plus optional HTML;
   MarkItDown deliberately emits lightweight Markdown for LLM consumption.
   Beaver should therefore keep one format-neutral grid (table/sheet, row,
   column, spans, displayed value, source/version and provenance), then render
   the smallest self-contained row/range view the task needs. Markdown is a
   useful default projection, not canonical state. DOCX and XLSX may enter this
   contract from native structure. PDF may enter it only through true table
   parsing in `legal-pdf-parser`; flattened-text guesses must fail
   closed. Rich styles, formulas, and geometry remain undisclosed unless the
   task asks for them.

   Primary references: [Docling Core](https://github.com/docling-project/docling-core),
   [Docling's typed table-cell model](https://docling-project.github.io/docling/reference/docling_document/),
   [Unstructured document elements](https://docs.unstructured.io/open-source/concepts/document-elements),
   and [Microsoft MarkItDown](https://github.com/microsoft/markitdown).

Benchmark the dimensions independently. In particular, compare newest versus
discussion-density ranking at the same court filter and result/character
budget; otherwise a better scope can be mistaken for a better ranker. Record
retrieval recall, useful evidence per exposed character, tool calls, latency,
schema characters, truncation, and final answer correctness.

## Next experiment gates

1. Preserve the completed/scored 25-file tax block and its judge-specific
   artifacts; do not rerun it merely to change the retrieval implementation.
2. Add `h4-legal-grep`: upstream-first whole-read routing plus literal `Glob`,
   `Grep`, `Read`, and `Edit` vocabulary;
   `Grep output_mode=sections` returns a token-budgeted legal coordinate map;
   exact handles and optional literal cross-reference following stay inside
   Grep/Read rather than a competing prose-rich tool family.
3. Add the exposure registry and metrics as an ablation, not an assumed win.
4. Run at least extraction, editing/markup, closing-checklist comparison, and
   drafting tasks at Luna High with model, effort, judge, and order held or
   randomized as preregistered.
5. Only after those runs, A/B two prompt variants that target accuracy versus
   context economy, then run one research-derived CORVUS-style synchronized
   observation experiment.

## H4 exact-trace audit and bundled H6 response

The completed H4 cells changed the design question. H4 operational/neutral
scored 166/232 across banking, white-collar, capital-markets, and tax, versus
154/232 for frozen upstream Mike, while using about 2.03 times as many input
tokens. This is the first aggregate win over the simple upstream whole-read
baseline, but it is not yet lean.

Source-qualified span reconstruction separates retrieval failures from
synthesis failures:

- Banking exposed the missed asset-sale sweep, default interest timing,
  revolver maturity, cost-savings limitation, and equity-cure timing. Most
  misses were therefore synthesis/completeness, not inability to retrieve the
  clause. One equity-cure criterion also conflicts with the source wording.
- Capital exposed about 98.5--99.7% of all eight source documents. Its
  remaining misses are primarily comparison and deliverable synthesis.
- White-collar never read the negotiation-strategy memo or USAO transmittal
  email and exposed only 11.5% of the CFTC settlement. Those omitted sources
  contain the attachment/certification, CFTC cooperation/tax/restitution, and
  priority facts the answer missed.
- Tax reached all 25 filenames but exposed only 68.9% of the tangible-goods
  study and 69.2% of the QCSA. A detailed tangible-goods appendix fell beyond
  the read boundary. Conversely, the QCSA's 15-year useful life, $32 million
  total, ten-year payment period, and $3.2 million annual payment were exposed
  together and still omitted from the comparison. Tax therefore contains
  both a real retrieval-boundary miss and an attention/synthesis miss.

The tool sequence exposes avoidable context cost. Tax called `library_list`,
opened the broad review domain, then issued whole-file reads over all 25
documents despite the coding guidance. It later repeated quality checks that
the creation receipt already supplied. The provider cache was working (roughly
75--80% cache reads on the largest H4 cells), but cache discounts repeated
prefix billing; it does not remove old results from the model's reasoning
context. Per-provider-round receipts now record schema hashes, tool argument
and result bytes, usage, and source-qualified evidence segments so these
effects can be distinguished directly.

The existing SLA workflow is the relevant neglected compiler implementation.
It already composes deterministic anchor coverage, arithmetic conflicts,
deadline arithmetic, defined-term drift, and drafting lint, then performs at
most one correction pass. A retrospective tax audit produced an 8,432-character
repair payload and surfaced high-value omissions including 15 years, 10 years,
$3.2 million, $32 million, $25 million, $42 million, 1.85:1, 6.5%, 6.9%, and
18%. It also produced noise (including area figures and broad term drift), so
the first use is exploratory and must be ablated rather than treated as proven.

H6 `compiler_hybrid` deliberately bundles the fixes that should work together:

1. coding-native resident retrieval with exact legal scopes and H5 immutable
   working sets;
2. filename-first inventory, with `library_list` absent from coding mode and
   IDs disclosed by `Glob` only for duplicate filenames;
3. separate progressive domains for creating an output, revising an existing
   document, and auditing an existing DOCX;
4. machine-obvious read truncation with an executable continuation; and
5. a host-side compiler ledger over up to 32 source documents, exposing only
   bounded typed findings for one correction pass. The correction call keeps
   the instructions, current artifact, and findings but does not replay prior
   tool results, making it a deterministic context checkpoint.

This is a bundled product-shape probe, not a causal experiment. The registered
comparison is in
`hybrid-retrieval-h6-compiler-preregistration-2026-08-01.json`. Trace behavior
comes before ablation: a score win does not prove every component, and a loss
does not justify discarding legal structure or deterministic checks wholesale.

### H6/H7 live fairness findings

Inspection of the completed H6 compiler bundle and H7 SLA traces identified
several implementation effects that must not be mistaken for retrieval-model
quality:

- H6's H5 `working_set` affordance received zero calls on all four tasks. H7
  named it in the Ledger instruction and still received zero calls. Merely
  placing an unfamiliar output mode in the Grep enum did not test the bounded
  evidence-artifact hypothesis.
- White-collar H6 used `Grep(pattern=".")` four times as a lossy whole-file
  reader. Each large result approached the 64,000-character transport ceiling
  while adding line/structure rendering. The operational Grep contract now
  says universal dot patterns are not whole-file reads.
- The automatic anchor audit is source-wide, not Spec-scoped. White-collar's
  first pass reported 93 source-only anchors and caused giant alternation
  regexes and broad re-reads; tax reported 208. This can recover omitted facts,
  but also mixes boilerplate, unrelated agreement terms, derived values, and
  material requirements. Source-only is an omission candidate, not a drafting
  instruction.
- H6 correction behavior varied sharply. Banking reduced source-only anchors
  from 118 to 48 and increased matched anchors from 101 to 192; capital reduced
  33 to 4 and increased 22 to 51. White-collar did not revise its artifact at
  all (93/4/47 before and after). Tax removed all ten draft-only anchors but
  left 208 source-only anchors and moved matched anchors only from 68 to 77.
  This supports automatic checks, but not an indiscriminate all-source repair
  dump.
- The discovery schema continued advertising domains after they were opened.
  White-collar H6 and banking H7 reopened `drafting`; the refreshed schema now
  removes already-opened domains.
- H7 white-collar emitted a valid created artifact with empty chat text. The
  route gated the compiler on non-empty chat and therefore skipped Audit and
  Grounding entirely. The gate now runs when an artifact mutation exists; the
  failed historical cell remains preserved and requires a separate rerun.
- When an artifact existed, the audit concatenated status chat with artifact
  text. It now audits artifacts alone and falls back to chat only when no
  artifact exists.
- Exposure telemetry counted correction-pass reads of generated artifacts in
  the numerator but divided by original-source characters, producing ratios
  above 1.0. New receipts filter the union to uploaded source IDs; historical
  cells require offline recomputation.
- `library_create_docx` still couples a human title to the filename. Banking
  H7 created `Covenant Extraction Memo.docx`, then created
  `covenant-extraction-memo.docx` to satisfy the requested name, causing an
  extra tool call and making the compiler audit two candidate artifacts. This
  is a schema defect: final filename and rendered title need distinct fields.

H8 therefore makes the in-turn evidence artifact a direct treatment: after
Spec, the first source-content retrieval must be a targeted
`Grep(output_mode="working_set")`, followed by `Read` of the returned path and
exact-source gap filling. This artifact is immutable through provider rounds
and the SLA correction checkpoint, but it is not persisted across chat turns
or restart; do not describe it as durable storage. See
`hybrid-retrieval-h8-working-set-first-preregistration-2026-08-01.json`.
