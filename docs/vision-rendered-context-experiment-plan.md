# Vision-rendered context experiment plan

## Question

Can a vision-capable model reason as well as or better than a text-input
baseline when document or graph context is rendered as an image, while using
less effective input context?

Test two deliberately narrow tricks:

1. Render a DOCX as one tall page image and ask the model to read and reason
   over the visual document.
2. Render an existing citator graph or contract self-reference graph as SVG
   and ask the model to reason over the visual graph.

This is an experiment, not a proposed production architecture. Reuse the
existing DOCX benchmark, contract skeleton/reference graph, citation
resolution, and evaluation machinery. Do not add another parser or graph
extractor.

## Hypotheses

- Visual layout may preserve document hierarchy, proximity, tables, and graph
  topology more compactly than serialized text.
- A graph image may make paths, hubs, clusters, cycles, and disconnected
  authorities easier to reason about than an edge list.
- Any apparent gain may instead come from extra layout cues, illegible text
  being silently ignored, or provider-specific image-token accounting.

## Frozen comparisons

Hold the model, effort, prompt, task, answer schema, and source material
constant. Compare paired results on the same frozen cases.

### DOCX arms

- extracted text baseline;
- one tall rendered image;
- page images or readable tiles, as a diagnostic for downscaling loss;
- extracted text plus rendered image, to test whether vision adds signal rather
  than merely replacing text.

Use tasks with exact or human-reviewed answers: heading/section navigation,
cross-reference tracing, table interpretation, footnote linkage, and questions
whose answer requires distant parts of the document. Include a plain linear
prose slice as a negative control.

### Graph arms

- canonical node-and-edge text or JSON baseline;
- the same information rendered as SVG;
- SVG plus canonical text/JSON;
- shuffled-layout SVG with identical nodes and edges, as a layout-cue control;
- graph with labels removed where the task only tests topology.

Start with the existing contract self-reference graph because its edges have a
deterministic source and resolution contract. A citator-graph round can follow
using existing citation identity and note-up machinery. Do not infer legal
validity merely from graph position.

## Rendering constraints

- Record source hash, renderer and version, page dimensions, DPI, image
  dimensions, SVG source hash, layout seed, and every transformation.
- Preserve page boundaries in the tall DOCX image and avoid recompression that
  makes ordinary body text unreadable.
- Set a fixed maximum image budget before seeing outcomes. If the provider
  downsamples the tall image, report that arm as tested rather than quietly
  substituting tiles.
- Keep graph layout deterministic. Prevent label overlap and record unresolved
  or external edges explicitly; never turn an absent edge into evidence of no
  relationship.
- Keep confidential documents, images, prompts, traces, and caches in ignored
  local storage under the existing data contracts.

## Measurements

For every paired case, record:

- exact/task-specific correctness, abstention, and legally material error type;
- evidence fidelity: correct section, node, edge, authority, and pinpoint;
- input, output, cached, and reasoning tokens as reported by the provider;
- source bytes, extracted-text characters/tokens, image count and dimensions,
  SVG bytes and graph size;
- wall time, render time, model time, retries, and cost where available;
- failures caused by unreadable labels, clipping, overlap, downscaling, or
  omitted content.

Provider image tokens are not automatically comparable with text tokens.
Report both provider-billed tokens and a provider-neutral payload description;
call the result context compression only if the same model admits more useful
source material or uses fewer billed input tokens without an accuracy loss.

## Acceptance gates

Keep investigating a visual arm only if it:

- has no regression on exact answers or evidence pinpoints;
- introduces no new legally material hallucination or missed-reference class;
- is a strict win in at least one preregistered dimension: accuracy, admitted
  source coverage, billed input tokens, latency, or cost;
- repeats on a frozen holdout and survives the shuffled-layout or linear-prose
  negative control appropriate to the claim.

Reject the trick if the result depends on unreadable omission, cherry-picked
layouts, a larger total prompt, or token accounting that cannot be compared.

## Smallest useful run

1. Freeze a balanced challenge set from existing DOCX and contract-graph gold,
   including layout-heavy, long-distance, and negative-control cases.
2. Preregister rendering settings, prompts, model/effort, scoring, budgets, and
   stopping rules before running any live arm.
3. Produce deterministic local render artifacts and inspect a sample at the
   exact resolution delivered to the model.
4. Run the text and visual arms in randomized paired order with cache state
   recorded.
5. Score automatically where gold permits, blind-review the residue, and
   publish paired transitions rather than unpaired averages.
6. If the pilot passes, repeat on a disjoint holdout; otherwise retain the
   negative result and stop.

## Decision record to produce

The result note should state which visual signal was tested, what information
was held constant, whether reasoning improved, whether usable context actually
compressed, the failure slices, and a keep/reject decision. A successful
experiment still requires a separate product decision before any runtime path
is added.
