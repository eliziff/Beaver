# Jev structure-arbiter result

## Exact-source OAJD stress test

Footnote-definition rerun: identical case hash, **40/41**, footnotes **5/6**,
median **0.2541 seconds**. The instruction now explicitly includes discursive
notes, unnumbered continuations, and continuity within the note stream.
CAN-J-FAM-L page 21 region 5 remains misclassified as body. The original
receipt is preserved; the new receipt is `raw-stress-footnote-v2.json`.

`run_raw_stress.py --live` scored **37/41**, median **0.2254 seconds**.
Frozen cases SHA-256: `e27e1ba46dbefb6cdb62fb4d09dfe934230984b0817803a2d9df3a559aede0b3`.
The receipt retains exact extracted text, raw line rectangles, complete model
responses, and the prompt. Each call receives up to two preceding and following
extraction blocks. Labels, expectations, source IDs, and editorial descriptions
are excluded from the model state. Coordinates retain their original units;
page dimensions are not supplied or inferred from content extents.

| Reference role | Correct |
| --- | ---: |
| Section/subsection heading | 15/15 |
| Heading continuation | 2/2 |
| Body (including quotation) | 12/12 |
| Folio | 3/3 |
| Running furniture | 3/3 |
| Footnote | 2/6 |

All four errors occur on CAN-J-FAM-L/36/2/8204 page 21: footnote
regions 5–8 were classified as body, with confidence 1.0, 0.99, 0.86,
and 0.65. Footnotes therefore remain an unresolved weakness despite the earlier
perfect synthetic slice. Wrapped-heading continuation and subsection detection
worked on the exact source examples in this run.

Scope: three journals, manually selected cases, with pre-call reference roles
reviewed using extracted context and production annotations. This is not an
independent human-labelled corpus, a fresh browser OCR run, a level-assignment
test, or a real-corpus reading-order benchmark. Several examples were used in
earlier experiments. Geometry is retained OAJD geometry.

Method correction: the earlier heading runner searched the first substring
match anywhere in the article, potentially selecting a contents entry or a
different passage. This runner pins reviewed pages and asserts unique prefix
matches. Earlier text/geometry comparisons also changed the text context, so
their gain cannot be attributed solely to geometry. The 21-case mechanics probe
contains editorial summaries of evidence; its score is not raw OCR accuracy.

## Five-way follow-up mechanics probe

Jev scored **21/21** across five bounded slices in 5.294 seconds total
(approximately 0.252 seconds per independent call):

| Slice | Exact |
| --- | ---: |
| Numbering role | 4/4 |
| Wrapped heading / child subsection | 4/4 |
| Footnote, endnote, body, furniture, folio | 5/5 |
| Candidate reading order | 4/4 |
| Join/split/heading/quotation boundaries | 4/4 |

Every prompt names only evidence included in its state. Geometry cases supply
coordinates or line-height ratios explicitly; no prompt asserts font weight,
font family, indentation, or an upstream role. Reading-order questions choose
between deterministic candidates rather than asking Jev to invent an order.

This is a best-case mechanics probe, not corpus evidence. Most correct answers
had confidence above 0.84, but classifying prose immediately after a heading
was 0.37 and joining two lines of one heading was 0.28. Those low-confidence
successes require real-corpus stress testing before any product use.

## Heading detection and hierarchy

On one frozen 19-candidate Alberta Law Review article:

| Context | Exact | Time |
| --- | ---: | ---: |
| Adjacent blocks only (19 calls) | 16/19 (84.2%) | 5.205 s |
| Complete candidate outline | 16/19 (84.2%) | 0.390 s |
| Complete outline and full 79,634-character article | **17/19 (89.5%)** | **0.569 s** |

All arms correctly rejected the two ordinary-prose candidates. Full context
fixed two local level errors at sections IV and VII, but changed the genuine
section III into a false continuation. Both global arms treated the one-word
third line of a wrapped heading as a new level-2 heading. Full article context
therefore provided a small, non-monotonic gain—not a general solution.

On 11 focused promotion/demotion cases mirrored from existing structure tests,
Jev scored **8/11 (72.7%)** in 0.784 s. It promoted and levelled all seven
heading candidates correctly, including the Roman/letter ladder, uppercase
display heading, and wrapped continuation. It demoted only one of four false
heading proposals: the author name. It incorrectly retained a sentence fragment
and both members of a long numeric run as level-1 headings.

The practical result is asymmetric: Jev is promising as a bounded promotion
and hierarchy witness, but deterministic body-flow, author-role, and dirty/
long-numbering vetoes must remain authoritative. These are frozen manual or
repository-fixture expectations, not promotion-grade corpus gold.

### Revised semantic detection prompt

The initial direct-correction prompt under-specified demotion and mentioned a
style fact in one synthetic state. A corrected, text-only probe used 24
independent cases and asked whether the current candidate itself opens a
semantic section. It scored **21/24 exact (87.5%)**:

- genuine headings: **11/12**;
- wrapped continuations: **4/4**;
- false-heading proposals functionally rejected: **7/8**.

The functional demotion count treats `continuation` as a successful “not a new
heading” decision. Exact taxonomy was 6/8 because one numbered paragraph was
called a continuation rather than `not_heading`. The remaining false
promotion was `15. Historical Note` within a 14–17 paragraph-number run. The
other overall miss was a genuine unnumbered subsection immediately following a
Roman main heading, which Jev treated as a wrapped continuation.

This runner supplies only previous/current/next text. Its instruction discusses
only textual facts actually present: grammatical continuity, numbering,
capitalization, title/byline/contents context, and semantic scope. It makes no
font, bold, indentation, or geometry claim.

## OAJD journal block-quotation probe

Jev 1.13.0 scored **7/8 (87.5%)**, with a **0.249 s** median request time, on
the frozen text-only journal set. It found three clear quotation blocks,
distinguished ordinary prose containing an inline quotation, identified a
reviewer byline as other structure, and rejected two ordinary-prose fragments
that OAJD's production structure had labelled `block_quote`.

Its miss was a distinct quotation introduced by “As one article analogized,”
which it classified as `article_prose` with 0.79 confidence.

The geometry arm scored **8/8 (100%)**, with a **0.311 s** median. It supplied
the exact source lines and normalized line boxes for the previous, current, and
next candidate blocks. The sole text-only miss flipped to `block_quotation`,
although at only 0.58 confidence; all other answers remained correct. The arm
removed OAJD's `type`, `candidate_type`, `region_type`, and `code` fields.
The candidate boundaries themselves were supplied, because this tests Jev as a
role arbiter after segmentation, not as a page-image segmenter.

Exact instruction:

> Classify CURRENT BLOCK by its semantic role in the reconstructed article.
>
> block_quotation: a distinct, extended reproduction of external source
> material, such as quoted interview speech, a judgment, legislation, or
> another publication. It is separate from the article author's narrative,
> even if quotation marks are absent.
>
> article_prose: the article author's own narrative or analysis. This includes
> prose containing a short inline quotation or paraphrase.
>
> other_structure: a heading, byline, citation, footnote, list, table, or other
> non-prose structure.
>
> uncertain: the supplied text is insufficient to distinguish these roles.
>
> Use only the supplied words and textual continuity. Choose the single best
> role for CURRENT BLOCK.

The state contained only `PREVIOUS BLOCK`, `CURRENT BLOCK`, and `NEXT
BLOCK` text. No visual features or upstream role were supplied. The cases span
four journals. Expectations are manual pre-call judgments, not corpus gold.

Run 2026-09-20 against pinned `jev-1.13.0`: **7/8 exact (87.5%)**.
Median end-to-end API latency was 0.252 seconds; the eight calls used 3,574
input and 358 output tokens.

| Slice | Exact |
| --- | ---: |
| Reading-order choice | 3/4 |
| Region-role choice | 4/4 |

Jev selected the expected action for interleaved body columns, the conservative
no-repair case, table-grid source order, compact bottom notes, table numbers,
attached continuation-note labels, and a repeated journal header.

The miss was substantive and confident: for an endnote page whose source order
alternated notes 1/7, 2/8, and so on, Jev chose `source` with probability 0.95
instead of the fixture's `column_major` order (0.04). Confidence gating would
not catch it. The two correct body-order choices were less decisive: 0.62 for
column repair and 0.59 for preserving source order.

This establishes only best-case task compatibility. The inputs are concise
descriptions derived from existing Rust fixtures, not raw OCR packets, and the
eight cases are not corpus evidence. The useful next experiment is therefore a
frozen sample of real ambiguous pages containing actual line text, rectangles,
and the engine's candidate diagnostics. Promotion would require independent
ordered gold and comparison against the existing arbiter; the current result
does not justify a production fallback.

## Real legal-structure gold

A second run used actual passages from all eight retained NSCA structure-gold
decisions. Sampling was deterministic (`20260920`) and balanced up to eight
primary and eight quoted/foreign markers per document. Jev saw each marker and
its passage language, but not the gold role or the gold's sequential derivation
rule.

| Role | Correct | Accuracy |
| --- | ---: | ---: |
| Primary decision spine | 62/64 | 96.9% |
| Quoted or foreign numbering | 10/58 | 17.2% |
| Overall | **72/122** | **59.0%** |

Median latency was 0.260 seconds per 10--16-question document call. The eight
calls used 28,503 input and 4,220 output tokens.

This rejects passage-only Jev as the discriminator. It has a strong `primary`
bias: the 48 false-primary answers averaged primary probability 0.781, while
the ten correctly rejected foreign passages averaged only 0.336. Many embedded
passages read exactly like judicial reasons because they are quotations of
other judgments; semantic plausibility alone cannot establish structural
ownership.

With explicit authorization, two richer arms ran on the identical frozen
sample:

| State supplied | Overall | Primary | Quoted/foreign | Input tokens | Median/document |
| --- | ---: | ---: | ---: | ---: | ---: |
| Passage only | 72/122 (59.0%) | 62/64 | 10/58 | 28,503 | 0.260 s |
| Immediate physical neighbors | 79/122 (64.8%) | 62/64 | 17/58 | 57,799 | 0.308 s |
| ±3 markers + last established primary marker | **91/122 (74.6%)** | 62/64 | 29/58 | 96,929 | 0.409 s |

Context materially helps, confirming that the first question underspecified
the ownership decision. It does not close the gap: even the best-case arm calls
half of embedded markers primary. The 2026 decision remains especially hard
(7/16), so this is not merely one old formatting convention.

There is also no product win on this particular task. This gold's declared
derivation walks markers in order and accepts a marker exactly when its label
equals the next expected primary number. That existing deterministic rule is
122/122 by construction, faster, and auditable. Supplying enough sequence state
to make Jev reproduce it only asks a model to approximate code. Jev should not
replace or arbitrate this primary-versus-embedded numbering decision.

The useful surviving hypothesis is narrower: Jev may arbitrate genuinely
semantic alternatives where deterministic candidates are both valid and no
exact grammar/sequence rule already decides the answer. Real page ordering and
region roles still require the separately retained page/line gold, which is not
mounted on this machine.
