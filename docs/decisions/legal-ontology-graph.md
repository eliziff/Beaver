# Legal ontology graph: repository evaluation and durable design

**Status:** architecture decision; no runtime implementation
**Reviewed:** 2026-07-26
**Scope:** open-source graph UI and layout libraries, a renderer-independent legal
ontology artifact, deterministic/model boundaries, Library persistence, and
performance gates for Beaver

## Decision

Use **`@xyflow/react` plus `@dagrejs/dagre`** for the first implementation.

That is the smallest defensible stack for Beaver because:

- React Flow renders custom nodes as normal React components, so a node can use
  Beaver's existing typography, buttons, status indicators, and safe `<a>` links
  without an overlay system.
- It already supplies pan, zoom, selection, edges, grouping, and viewport state.
- Collapse/expand does not require a third package. Beaver can retain the complete
  graph in its Library artifact and deterministically project only the visible
  nodes and edges. React Flow's public performance guide explicitly recommends
  this `hidden`-node approach for deep trees.
- Dagre is MIT-licensed, small in concept, and is the layout engine React Flow
  recommends for a directed tree when speed and simplicity matter.
- Both projects use the MIT license. There is no commercial or account
  dependency.

Do **not** copy React Flow's expand/collapse example: it is a Pro example even
though the React Flow package itself is MIT-licensed. Implement the small
visibility projection directly from the public `hidden` property guidance.

Do not add ELK, Cytoscape, Sigma, Graphology, Mermaid, D3, LogicFlow, or G6 to
the first bundle. Each solves a problem the first version does not yet have.
Keep the legal artifact independent of React Flow so a measured failure can
later justify a different renderer without migrating legal data.

## What the UI actually needs

The legal domain changes the graph requirements:

1. A doctrine is usually a directed acyclic graph, not a strict tree. A factor
   may be relevant to more than one test, and later authorities may limit,
   distinguish, or reinterpret earlier statements.
2. Structural nodes—test, factor, subfactor, exception, definition—must remain
   distinct from evidentiary assertions such as a court's interpretation, an
   application example, or journal commentary.
3. Every legal assertion needs exact evidence and a durable source identity.
   A visual edge must never be the only representation of a legal claim.
4. Large graphs must be explored incrementally. A user should initially see a
   compact doctrinal spine, expand one branch, and load exact passages only
   when a node or assertion is selected.
5. Nodes need normal HTML links and accessible controls. The renderer must not
   force source links into canvas event handlers.
6. Filters must cover at least jurisdiction, court, date or temporal status,
   source type, review status, and relation type.
7. The graph and a research memo must be durable Library artifacts. Browser
   `localStorage` is useful for disposable view preferences, not as the
   authoritative legal record.

## Primary-source comparison

The conclusions below are based on project repositories and official project
documentation, not listicles or vendor comparisons.

| Candidate | Rich nodes and links | Hierarchy and drill-down | Scale and persistence | React/Next and license | Decision |
|---|---|---|---|---|---|
| **React Flow + Dagre** | Arbitrary React components, including normal safe HTML links and controls. `nodrag`, `nopan`, and `nowheel` utility classes prevent controls from fighting canvas gestures. | `parentId` supports subflows/groups. Beaver can compute the visible projection and set `hidden`; the complete domain graph stays intact. Dagre handles directed layouts, although cross-boundary subflow edges are a documented weakness. | Official guidance covers memoization, avoiding broad node subscriptions, simplified styles, and collapsing deep trees. `toObject()` can save renderer state, but Beaver should persist its domain artifact separately. | First-class React. React Flow 12 supports SSR when dimensions and handles are supplied; an interactive graph still hydrates on the client. MIT + MIT. | **Adopt.** |
| **React Flow + ELK/elkjs** | Same rich React renderer. | ELK's layered algorithm supports compound graphs, clusters, ports, routing, and cross-hierarchy edges. | Layout is asynchronous and can use a worker. It is substantially more configurable and complex; elkjs documents React/bundler/worker integration issues and supplies no renderer. | React Flow integration is possible. **EPL-2.0**, not a permissive MIT/Apache/ISC license. | Do not adopt by default. Reconsider only after a failing layout corpus, a license decision, and a worker prototype. |
| **Cytoscape.js** | Canvas/WebGL nodes are excellent for networks, but they are not arbitrary React DOM cards. Links normally require event handlers or a separate details panel. | Compound nodes and selectors are mature. | JSON import/export and graph algorithms are strong. The official WebGL preview shows material gains on thousands of nodes and tens of thousands of edges, with edge-style limitations and initial texture cost. MIT. | Imperative client integration in React is straightforward but not first-class React composition. MIT. | Best measured fallback for a large, glyph-based overview; not the doctrine-card UI. |
| **Sigma + Graphology** | WebGL nodes and labels, not native HTML cards. Rich content belongs in an external panel. | Filtering/highlighting can use Sigma reducers and `hidden` attributes. Compound legal hierarchy is not a core documented abstraction. | Sigma targets thousands of nodes/edges; Graphology supplies graph storage, algorithms, events, and import/export. React Sigma exists, but its docs warn against recreating the instance and require client-only dynamic import in Next. MIT. | React binding available; client-only in Next. MIT projects. | Strong citation-network overview option, but too many pieces and the wrong node model for the first UI. |
| **Mermaid** | SVG flowcharts can have subgraphs and links. Interactive links require relaxing the default strict security level. | Good static grouped diagrams; not a durable incremental graph editor. Changes are made by editing and re-rendering the text definition. | Excellent diffable documentation output. It is not intended to keep a large fractal graph interactively expanded with a details panel. MIT. | Easy to embed, but it would duplicate the chosen renderer. MIT. | Optional deterministic export text only; do not add a runtime dependency. Never render model-authored Mermaid with loose security. |
| **D3 modules** | Can produce SVG, Canvas, or HTML and therefore can do almost anything. | `d3-hierarchy` handles hierarchies; `d3-force` handles networks. All editor, grouping, persistence, and interaction policy would be Beaver code. | Flexible and proven, but force layout is iterative. React Flow notes that `d3-hierarchy` assumes one root and equal node dimensions. ISC. | Works with React only through custom integration. ISC. | Reject: it turns a product feature into a bespoke graph framework. |
| **LogicFlow** | SVG and HTML/custom nodes are supported; official examples include React nodes. | Core editor plus extension and layout packages; group, dynamic-group, minimap, and snapshot plugins exist. | Its data format and adapter API are suitable for flowchart persistence. The package is aimed at business process editing, with a larger editor/plugin surface than this read-mostly legal explorer needs. Apache-2.0. | Framework-agnostic rather than React-native. Apache-2.0. | Credible process-editor alternative, but not the smallest Beaver integration. |
| **AntV G6** | Core canvas elements plus an official React-node extension. Official docs warn that HTML nodes cost more than geometric nodes. | Nested combos, combo/node collapse and expand, layouts, plugins, and interactions are built in. | Official guidance recommends geometric G6 nodes for efficient rendering beyond roughly 2,000 nodes. MIT. | React content requires an additional extension and lifecycle integration. MIT. | Strong permissive-license runner-up if compound hierarchy or scale invalidates React Flow; too broad for version one. |

### React Flow and Dagre evidence

- [`xyflow/xyflow`](https://github.com/xyflow/xyflow) identifies
  `@xyflow/react` as the current React Flow package and the repository as
  MIT-licensed, including commercial use.
- [Custom nodes](https://reactflow.dev/learn/customization/custom-nodes) are
  ordinary React components and may include inputs, charts, and other
  interactive content.
- [Utility classes](https://reactflow.dev/learn/customization/utility-classes)
  provide `nodrag`, `nopan`, and `nowheel` for interactive content in a node.
- [Subflows](https://reactflow.dev/learn/layouting/sub-flows) use `parentId` for
  relative grouping and permit connections inside and outside a group.
- [Performance guidance](https://reactflow.dev/learn/advanced-use/performance)
  recommends memoization, avoiding whole-node subscriptions, simplifying
  styles, and hiding collapsed branches.
- [Save and restore](https://reactflow.dev/examples/interaction/save-and-restore)
  shows `toObject()` serializing nodes, edges, and viewport.
- [Server-side rendering](https://reactflow.dev/learn/advanced-use/ssr-ssg-configuration)
  is supported in React Flow 12 when the server is given node dimensions and,
  where needed, handle positions.
- [React Flow's layout comparison](https://reactflow.dev/learn/layouting/layouting)
  calls Dagre the simple, speed-focused option and recommends it for trees. It
  also records Dagre's limitation when a subflow has edges to outside nodes.
- [`dagrejs/dagre`](https://github.com/dagrejs/dagre) is a client-side directed
  graph layout library under the MIT license.
- The official [expand/collapse example](https://reactflow.dev/examples/layout/expand-collapse)
  is explicitly a Pro example. It is design evidence, not reusable MIT example
  code.

### Scale-focused alternatives

- [Cytoscape.js documentation](https://js.cytoscape.org/) covers compound nodes,
  JSON-serializable element data, and full JSON import/export. It warns that
  whole-graph `cy.json()` updates can be expensive and recommends selective
  element changes on large graphs.
- [`cytoscape/cytoscape.js`](https://github.com/cytoscape/cytoscape.js) is
  MIT-licensed.
- Cytoscape's official
  [WebGL preview](https://blog.js.cytoscape.org/2025/01/13/webgl-preview/)
  reported about 20 to over 100 FPS for a roughly 1,200-node/16,000-edge
  example and about 3 to 10 FPS for a roughly 3,200-node/68,000-edge example
  on the test machine. Those are illustrative project measurements, not Beaver
  performance promises. The same post records provisional APIs, edge-style
  limitations, and initial texture-generation cost.
- [`jacomyal/sigma.js`](https://github.com/jacomyal/sigma.js) describes Sigma as
  an MIT-licensed WebGL renderer for graphs with thousands of nodes and edges,
  built on Graphology.
- [Sigma graph data](https://www.sigmajs.org/docs/advanced/data/) documents
  render-time node and edge reducers and `hidden` attributes for filtering.
- [`graphology/graphology`](https://github.com/graphology/graphology) provides
  an MIT-licensed graph object, algorithms, events, and layouts.
- [Graphology serialization](https://graphology.github.io/serialization.html)
  exports and imports graph attributes, nodes, and edges.
- [React Sigma](https://sim51.github.io/react-sigma/docs/start-introduction/)
  is a binding around an imperative Sigma instance and warns that changing the
  container graph/settings recreates the instance.
- Its [Next.js FAQ](https://sim51.github.io/react-sigma/docs/faq/) says the
  Sigma component must be client-rendered with a dynamic import.

### Other evaluated projects

- [`kieler/elkjs`](https://github.com/kieler/elkjs) is a layout engine, not a
  renderer. It supports workers but documents bundler, React, and worker
  integration issues.
- The [ELK layered algorithm](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html)
  supports ports, clusters, compound graphs, routing, and cross-hierarchy
  edges.
- elkjs is under the
  [Eclipse Public License 2.0](https://raw.githubusercontent.com/kieler/elkjs/master/LICENSE.md),
  which has source-distribution and notice requirements. It does not meet a
  "permissive licenses only" gate.
- [`mermaid-js/mermaid`](https://github.com/mermaid-js/mermaid) is MIT-licensed
  and renders text definitions as diagrams.
- [Mermaid flowcharts](https://mermaid.js.org/syntax/flowchart.html) support
  subgraphs and links, but click/link behavior is disabled by `strict`
  security and enabled by `loose` security.
- [Mermaid security configuration](https://mermaid.js.org/config/usage.html#securitylevel)
  makes `strict` the default, with HTML encoded and clicks disabled.
- [`d3/d3`](https://github.com/d3/d3) is an ISC-licensed, deliberately
  low-level visualization library.
- [D3 hierarchy](https://d3js.org/d3-hierarchy) and
  [D3 force](https://d3js.org/d3-force) are primitives, not a graph editor.
- [`didi/LogicFlow`](https://github.com/didi/LogicFlow) is an Apache-2.0
  business flowchart editor with core, extension, and layout packages.
- LogicFlow's official [examples](https://site.logic-flow.cn/examples/) list
  React nodes, groups, a minimap, and snapshot support; its
  [adapter documentation](https://07.logic-flow.cn/guide/extension/adapter.html)
  covers converting between domain data and renderer data.
- [`antvis/G6`](https://github.com/antvis/G6) is an MIT-licensed graph
  visualization engine with elements, layouts, interactions, and plugins.
- G6 documents [nested combos](https://g6.antv.antgroup.com/en/manual/element/overview),
  [collapse/expand operations](https://g6.antv.antgroup.com/en/api/element),
  and an official [React-node extension](https://g6.antv.antgroup.com/en/manual/element/node/react-node).

## Smallest defensible Beaver stack

### Runtime dependencies

Add only:

```text
@xyflow/react
@dagrejs/dagre
```

Use dependencies Beaver already has for schema validation and normal UI
components. Do not add a second graph store. The Library artifact is the source
of truth; the React Flow arrays are a projection.

### Initial UI

The first view should contain:

- one custom doctrine node component;
- one assertion/source summary component only when expanded;
- plain deterministic edge styles by relation type;
- a right-side details panel for exact passages, authority metadata, public
  links, and Beaver's local viewer link;
- controls for search, jurisdiction, date, source kind, review state, and
  relation kind;
- expand/collapse, fit view, and reset view;
- proposal-review actions kept out of the ordinary read view.

Node cards should show short labels and status only. Full quotations, journal
abstracts, and model explanations belong in the details panel. This is both a
performance rule and a legal legibility rule.

Use real React `<a>` elements with `nodrag` and an allowlisted URL. Use
`target="_blank"` only with `rel="noopener noreferrer"`. Never accept node
markup, event handlers, CSS, or URLs directly from a model.

### Visible projection

The persisted graph can be very large; the rendered graph should not be.

Given:

- selected roots;
- a set of collapsed structural node IDs;
- filters;
- a depth limit; and
- a per-expansion result limit,

a deterministic function produces the visible doctrine nodes, assertions, and
edges. It then supplies only that projection to Dagre and React Flow.

Legal graphs can have shared descendants. Collapsing one parent must not hide a
node that is still reachable from another expanded path. Visibility therefore
must be calculated by reachability from the active roots, not by recursively
mutating or deleting descendant records.

The full graph remains available through indexed adjacency lists. Expanding a
node should retrieve bounded neighboring summaries. Selecting an assertion
loads its exact passages separately. Repeated expansion does not call a model
unless the user explicitly requests new research or the artifact records a
known gap.

### Layout

Sort input nodes and edges by durable ID before calling Dagre, use fixed layout
configuration, and cache the result by:

```text
graph revision
+ visible node IDs
+ visible edge IDs
+ collapsed IDs
+ filter state
+ layout version
```

Do not lay out invisible passages or source records. Do not animate the initial
large layout. A layout worker is not part of version one; add one only if the
measured main-thread layout time breaches the budget.

## Renderer-independent legal artifact

### Core rule

The artifact stores legal meaning and evidence. It does not store a React Flow
graph as the canonical record.

React Flow nodes, handles, edge paths, and positions are disposable renderer
state. A future Cytoscape, G6, print, Markdown, or DOCX renderer must be able to
consume the same legal artifact.

### Envelope

Use a versioned JSON artifact with a vendor media type such as:

```text
application/vnd.mike.legal-ontology+json
```

Suggested filename suffix:

```text
.mike-legal-graph.json
```

Illustrative top-level shape:

```json
{
  "schema": "ca.mike.legal-ontology-graph",
  "schema_version": 1,
  "graph_id": "log_01...",
  "title": "Duty of care",
  "description": "Research graph; not a statement that every proposition is current law.",
  "jurisdictions": ["ca"],
  "temporal_scope": {
    "law_as_of": "2026-07-26",
    "start": null,
    "end": null
  },
  "revision": {
    "revision_id": "rev_01...",
    "number": 4,
    "parent_revision_id": "rev_00...",
    "created_at": "2026-07-26T20:00:00Z",
    "created_by": {"kind": "user", "id": "local"},
    "content_sha256": "sha256:..."
  },
  "content": {
    "doctrine_nodes": [],
    "doctrine_edges": [],
    "sources": [],
    "passages": [],
    "assertions": []
  },
  "proposals": [],
  "model_runs": [],
  "saved_views": []
}
```

The content hash should exclude disposable viewport state. A saved view may
have its own hash.

### Doctrine nodes

Doctrine nodes hold the legal rule's structure, not every quotation that
mentions it.

```json
{
  "id": "dn_01...",
  "kind": "test",
  "label": "Test for ...",
  "statement": "Concise reviewed formulation.",
  "parent_id": null,
  "order": 10,
  "jurisdictions": ["ca"],
  "temporal_scope": {"start": null, "end": null},
  "evidence_ids": ["as_01..."],
  "review": {
    "status": "accepted",
    "reviewed_by": {"kind": "user", "id": "local"},
    "reviewed_at": "2026-07-26T20:00:00Z"
  },
  "provenance": {
    "created_by": "model_proposal_accepted",
    "proposal_id": "pr_01..."
  }
}
```

Initial allowed kinds should be deliberately short:

```text
test
factor
subfactor
element
exception
definition
remedy
procedure
```

Do not add a new kind when a label or an assertion would suffice. One
`parent_id` represents display containment. Cross-cutting legal relationships
belong in doctrine edges.

### Doctrine edges

```json
{
  "id": "de_01...",
  "from": "dn_01...",
  "to": "dn_02...",
  "kind": "requires",
  "directed": true,
  "evidence_ids": ["as_02..."],
  "review": {"status": "accepted"}
}
```

Start with a controlled relation set:

```text
contains
requires
alternative_to
exception_to
limits
defines
precedes
weighs_for
weighs_against
```

Do not encode every case treatment as a doctrine edge. Case-specific
interpretation and application are assertions so their source and proposition
remain explicit.

### Sources

```json
{
  "id": "src_01...",
  "kind": "case",
  "provider": "canlii",
  "provider_id": "...",
  "canonical_citation": "2025 SCC 1",
  "title": "Example v Example",
  "jurisdiction": "ca",
  "court": "SCC",
  "dates": {"decided": "2025-01-01"},
  "source_revision": "provider revision or bulk snapshot ID",
  "content_sha256": "sha256:...",
  "parser": {
    "name": "legal-pdf-parser",
    "version": "...",
    "structure_confidence": 0.99
  },
  "retrieved_at": "2026-07-26T20:00:00Z"
}
```

`kind` begins with `case`, `legislation`, and `journal`. Commentary remains
identifiable as commentary; it must not silently acquire the status of a
judicial or legislative source.

### Exact passages and locators

One passage record is the durable bridge among retrieval, quotations, public
links, the local viewer, and later source validation.

```json
{
  "id": "pass_01...",
  "source_id": "src_01...",
  "source_revision": "provider revision or bulk snapshot ID",
  "locator": {
    "kind": "paragraph",
    "canonical": "para-42",
    "path": [
      {"kind": "section", "label": "7"},
      {"kind": "subsection", "label": "7.3"},
      {"kind": "paragraph", "label": "42"}
    ],
    "page": {"printed": "62", "pdf_index": 71},
    "provider_locator": {"paragraph": "42"}
  },
  "exact_text": "The exact normalized passage text.",
  "exact_text_sha256": "sha256:...",
  "quote_spans": [
    {
      "start": 4,
      "end": 39,
      "exact": "exact text selected for citation",
      "exact_sha256": "sha256:..."
    }
  ],
  "link_request": {
    "mode": "multi_text_fragment",
    "span_indexes": [0]
  },
  "resolved_links": {
    "public": {
      "url": "https://allowed.example/...#:~:text=...",
      "builder": "legal-pinpoint-link",
      "builder_version": "...",
      "validated_at": "2026-07-26T20:00:00Z"
    },
    "local": {
      "library_item_id": "lib_01...",
      "viewer_locator": {"paragraph": "42"}
    }
  }
}
```

Important rules:

- The model selects or proposes source IDs, locators, and quote spans. It does
  not construct URLs.
- Existing deterministic Beaver/ALR-style link builders resolve paragraph,
  section, page, footnote, text-fragment, and multi-text-fragment links.
- A local link stores an opaque Library/resource identity and viewer locator,
  not an absolute filesystem path.
- A cached public URL records the link-builder version and source revision.
  If either changes, regenerate it.
- Exact quote spans are validated against the stored passage. A mismatch
  blocks promotion into reviewed content.
- If a provider cannot form a durable public pinpoint, the local viewer link
  remains available and the public link reports an explicit unavailable state.

### Assertions

Assertions attach legal meaning to evidence without turning every source
passage into a structural doctrine node.

```json
{
  "id": "as_01...",
  "kind": "interpretation",
  "doctrine_node_ids": ["dn_01..."],
  "proposition": "The court treated the factor as necessary but not sufficient.",
  "relation": "limits",
  "source_id": "src_01...",
  "passage_ids": ["pass_01..."],
  "authority_metadata": {
    "source_kind": "case",
    "court": "SCC",
    "jurisdiction": "ca"
  },
  "review": {"status": "accepted"},
  "temporal_scope": {"start": "2025-01-01", "end": null}
}
```

Initial kinds:

```text
interpretation
application_example
legislative_text
journal_commentary
history
treatment
```

The source record, not model wording, determines whether material is a case,
legislation, or commentary. Precedential weight, current-law status, and
positive/negative treatment are reviewable claims, not renderer decorations.

### Model proposals are not verified content

Models write only to `proposals`. They never directly mutate accepted doctrine
nodes, edges, or assertions.

```json
{
  "id": "pr_01...",
  "base_revision_id": "rev_01...",
  "operation": "add",
  "entity_kind": "assertion",
  "target_id": null,
  "candidate": {},
  "evidence_ids": ["pass_01..."],
  "model_run_id": "run_01...",
  "status": "pending",
  "decision": null
}
```

Allowed statuses:

```text
pending
accepted
rejected
superseded
invalid
```

Acceptance is a deterministic transaction:

1. Confirm the proposal's base revision is still current or explicitly merge
   it.
2. Validate the schema, IDs, enum values, source identities, locators, exact
   quote spans, and required evidence.
3. Check for forbidden structural cycles, orphan records, duplicate claims,
   and jurisdiction/date inconsistencies.
4. Copy the candidate into accepted content.
5. Stamp the reviewer, decision, parent revision, and content hash.
6. Save a new immutable Library revision.

“Accepted” means accepted into this research artifact after the configured
review. It is not a representation that the proposition is indisputably
correct or still good law.

### Model-run provenance

```json
{
  "id": "run_01...",
  "provider": "openai",
  "model": "gpt-...",
  "effort": "high",
  "prompt_template": "legal-ontology-proposal",
  "prompt_template_version": 2,
  "retrieval_manifest_sha256": "sha256:...",
  "tool_result_ids": ["pass_01..."],
  "started_at": "2026-07-26T20:00:00Z",
  "completed_at": "2026-07-26T20:00:10Z"
}
```

Record the model and evidence manifest needed to reproduce or audit the
proposal. Do not store hidden chain-of-thought. A short model-provided rationale
may be stored as an ordinary proposal field if it is useful for review.

### Saved views

```json
{
  "id": "view_01...",
  "name": "Canadian current-law overview",
  "graph_revision_id": "rev_01...",
  "layout": {
    "engine": "dagre",
    "version": 1,
    "direction": "TB",
    "positions": {}
  },
  "collapsed_node_ids": ["dn_09..."],
  "filters": {
    "jurisdictions": ["ca"],
    "source_kinds": ["case", "legislation"],
    "review_statuses": ["accepted"]
  },
  "viewport": {"x": 0, "y": 0, "zoom": 1}
}
```

Saved views are optional user state. They do not change legal content and do
not affect the content hash.

## Deterministic, model, and review responsibilities

| Responsibility | Deterministic Beaver code | Model | Human or configured review policy |
|---|---|---|---|
| Retrieve a paragraph, section, page, footnote, or article passage | Resolve provider/bulk/local source, exact locator, and bounded text | Ask for relevant material using structured tool arguments | Select research scope where needed |
| Quote validation | Match exact spans, normalize under a versioned rule, hash, reject mismatch | Propose spans from retrieved text | Resolve ambiguous or materially conflicting text |
| Links | Build public, pinpoint, text-fragment, multi-fragment, and local viewer links | Request a link for known evidence | Review only exceptional/broken-source cases |
| Doctrine extraction | Validate schema and evidence requirements | Propose tests, elements, factors, exceptions, and concise formulations | Accept, edit, or reject legal propositions |
| Interpretation/application | Enforce source type and evidence links | Propose interpretations, examples, distinctions, limitations, and conflicts | Decide the legally defensible characterization |
| Graph structure | Enforce IDs, relation enums, cardinality, dedupe, and configured cycle rules | Propose structural and semantic relationships | Accept disputed relationships |
| Expansion/filtering | Compute visible projection and indexed adjacency; no model call | Optionally propose a new research query when the user asks | Choose scope/depth |
| Layout | Compute positions and edge routes | None | Optionally move/save a view |
| Citation and memo links | Format citations and insert verified links from source records | Draft synthesis prose using evidence IDs | Review analysis and conclusions |
| Versioning | Atomic revision, parent link, diff, hashes, conflict check, migration | None | Name/release a research revision |

The model should never be responsible for:

- graph coordinates or edge paths;
- source metadata already supplied by a provider;
- URL or text-fragment syntax;
- citation numbering;
- renderer HTML, JavaScript, or CSS;
- revision IDs or hashes;
- deterministic deduplication;
- deciding that unsupported material is “verified.”

## Library artifacts and research memos

### Source of truth

Save the JSON legal graph as a normal versioned Library item. Use Beaver's
existing local Library storage and version machinery rather than introducing a
graph database solely for this feature.

Store:

- graph ID, schema version, current revision, and content hash in Library
  metadata;
- the JSON artifact as the durable content;
- a small derived preview containing title, jurisdictions, law-as-of date,
  counts, and review status;
- source documents as existing shared Library/cache references, not duplicated
  blobs.

Cloud-compatible storage can carry the same artifact later. No schema field
should depend on a Windows path.

### Derived research memo

The graph can generate a linked Markdown or DOCX research memo. The memo is a
separate derived artifact and records:

```text
source graph ID
source graph revision
source graph content hash
generation template version
generated-at timestamp
```

The deterministic memo renderer should produce:

1. scope, jurisdictions, and law-as-of date;
2. doctrine outline;
3. accepted interpretations and application examples under each doctrine
   node;
4. exact quotations or bounded excerpts with citations and generated links;
5. conflicts, limitations, and unresolved proposals;
6. source table.

A model may draft connective analysis, but it refers to evidence IDs. Citation
text, footnote numbering, public/local links, and exact quotations are inserted
or validated deterministically after drafting.

Editing the memo must not silently mutate the graph. A user may explicitly send
a memo change back as a proposal.

Mermaid text may be offered as an export for systems that already render it,
but the graph artifact remains authoritative. Beaver does not need to ship
Mermaid to generate a Markdown outline or edge list.

## Performance design and gates

### Strict wins before changing renderer

Apply these measures first:

- render a bounded visible projection, not the full artifact;
- collapse structural branches by default;
- load full passages and source detail on selection;
- memoize custom node and edge components;
- keep node and edge type maps stable;
- subscribe to selected IDs or relevant slices, not the entire nodes array;
- use plain borders and fills; avoid gradients, shadows, animated edges, and
  large embedded document content;
- cache adjacency, visible projection, and layout by graph revision and filter
  state;
- debounce filter-driven re-layout;
- patch only changed nodes rather than replacing the complete graph on small
  interactions;
- preserve the warm API/runtime path; this feature should not introduce a new
  model warmup.

### Benchmark corpus

Build deterministic synthetic and real legal fixtures with:

- total artifact sizes of 1,000, 10,000, and 100,000 records;
- visible projections of 50, 250, and 1,000 nodes;
- sparse, normal, and dense legal edge ratios;
- deep trees, wide factor sets, shared descendants, cross-cutting edges,
  multiple jurisdictions, and source filters;
- short and long labels;
- cold and warm Library loads;
- weak-hardware coverage, not only a development workstation.

Measure:

- added production JavaScript and CSS;
- time to first usable graph;
- data fetch, projection, layout, render, and paint separately;
- expand/collapse p50 and p95;
- filter p50 and p95;
- pan/zoom frame rate;
- peak heap and post-collapse retained heap;
- save/load round-trip and schema validation;
- keyboard navigation and details-link activation.

Suggested initial acceptance budgets—not library claims—are:

- cached expansion of at most 100 new summaries: p95 at or below 150 ms;
- layout of 250 visible nodes: at or below 100 ms on the weak-hardware target;
- pan/zoom: at least 50 FPS at 250 visible nodes;
- no network or model call on repeat expansion of already stored content;
- exact save/load content equality apart from explicitly excluded view state.

The 1,000-visible-node fixture is a stress and escalation test, not a promise
that rich DOM cards should normally be shown at that density.

### Escalation gates

1. **Dagre layout correctness fails:** first alter the visible projection,
   separate structural containment from semantic cross-links, and route dense
   relations to the details panel. If representative compound/cross-hierarchy
   fixtures remain materially unreadable, benchmark G6 as the permissive
   runner-up. Evaluate ELK only if EPL-2.0 is explicitly accepted.
2. **Large overview performance fails:** keep React Flow for doctrine editing
   and benchmark Cytoscape.js or Sigma as a read-only, glyph-based overview.
   Do not force rich HTML cards into the large-network renderer.
3. **Bundle/load budget fails:** lazy-load the graph route and its CSS, omit
   minimap/whiteboard/editor features, and verify actual tree-shaking before
   changing libraries.
4. **Graph editing dominates the product:** only then revisit LogicFlow or G6.
   The current requirement is exploration and reviewed model proposals, not a
   general BPMN-style diagram editor.

## Legal and technical risks

### A graph can imply certainty that the law does not have

Mitigation: keep assertion text, evidence, jurisdiction, temporal scope, review
status, and conflicting authorities visible. Do not use a single green/red
edge as a substitute for the proposition it represents.

### Doctrine is not a pure tree

Mitigation: use one containment parent for display and separate typed edges for
cross-cutting relations. Reachability-based collapse preserves shared
descendants.

### Authorities become stale or are treated negatively

Mitigation: source revision, retrieval date, law-as-of date, temporal scope,
and treatment assertions are first-class. Revalidation produces proposals or
new revisions; it does not silently rewrite a released research artifact.

### Source pages and text-fragment links drift

Mitigation: retain provider identity, locator, source revision, exact text and
hash, link-builder version, and local viewer fallback. Rebuild cached URLs when
the source or builder changes.

### Model hallucination becomes durable

Mitigation: models write proposals only. Exact evidence, schema validity, and
source type are checked before acceptance. Legal characterization remains
reviewable.

### Model content becomes an injection vector

Mitigation: React renders text fields; it does not render model HTML. URLs are
constructed from allowlisted providers/internal routes. Do not use Mermaid
`loose` security for model-produced content.

### Renderer data leaks into the legal model

Mitigation: generate React Flow arrays from the domain artifact. Positions,
handles, collapse state, and viewport are saved views, not doctrine.

### A new graph framework worsens Beaver's load time and maintenance burden

Mitigation: two initial dependencies, route-level lazy loading, one node
component, one details panel, no plugin suite, and measured escalation only.

### License scope expands accidentally

Mitigation: record React Flow and Dagre MIT notices. Do not copy React Flow Pro
examples. Treat ELK's EPL-2.0 as outside the permissive-only default.

## Implementation sequence

No UI runtime work was performed as part of this evaluation. When authorized,
the smallest sequence is:

1. Define the version-1 JSON schema and validator using Beaver's existing schema
   tooling.
2. Create fixtures for a Canadian test, an American test, shared subfactors,
   conflicting interpretations, journal commentary, and exact public/local
   links.
3. Implement and unit-test pure functions for validation, adjacency, visible
   projection, filtering, link resolution, and stable Dagre input.
4. Add a lazy-loaded Library preview route with one custom React Flow doctrine
   node and one details panel.
5. Add save/load as immutable Library revisions and keep renderer state in
   `saved_views`.
6. Add the proposal review transaction. The model writes no accepted graph
   data.
7. Add deterministic Markdown memo generation, followed by DOCX only if the
   existing document pipeline can reuse the same intermediate representation.
8. Run the performance and legal-structure fixtures. Adopt a fallback only
   when a named gate fails.

This sequence preserves the important option: Beaver can change graph
renderers later without changing the legal research artifact or re-running
model extraction.
