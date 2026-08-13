/**
 * Provision graph: extract the relationship graph latent in a contract's
 * skeleton and render it as an interactive HTML visualization.
 *
 * Two edge kinds are materialized from primitives already in the tree:
 *
 *   - **parent** — the explicit hierarchy the skeleton compiled (a section
 *     nested under an article, a subsection under its parent section).
 *   - **cross-reference** — internal provision references resolved by
 *     `crossReferenceGraph` (legalCrossReference.ts).
 *
 * The HTML renderer produces a self-contained page using Cytoscape.js
 * (inlined from node_modules) with dagre hierarchical layout. Containers
 * (ARTICLE, PART, DIVISION, SCHEDULE) render as COMPOUND NODES that
 * visually group their child provisions. Two views:
 *
 *   - **Graph** — all edges visible; cross-references shown as curved
 *     blue arrows over the hierarchy. Press `1` or click "Graph".
 *   - **Tree** — parent-child edges only; a clean top-down taxonomy.
 *     Press `2` or click "Tree".
 *
 * No model calls, no API spend — pure computation over the skeleton.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileAgreementSkeleton, type AgreementSkeleton, type SkeletonNodeKind } from "../../backend/src/lib/legalTextSkeleton";
import { crossReferenceGraph, type CrossReferenceGraph } from "../../backend/src/lib/legalCrossReference";

// ---------------------------------------------------------------------------
// Graph types
// ---------------------------------------------------------------------------

export interface ProvisionGraphNode {
  label: string;
  display: string;
  heading: string;
  depth: number;
  kind: SkeletonNodeKind;
  start: number;
}

export type ProvisionGraphEdgeKind = "parent" | "cross-reference";

export interface ProvisionGraphEdge {
  from: string;
  to: string;
  kind: ProvisionGraphEdgeKind;
  refText?: string;
}

export interface ProvisionGraph {
  nodes: ProvisionGraphNode[];
  edges: ProvisionGraphEdge[];
}

export interface GraphHtmlOptions {
  title?: string;
  maxNodes?: number;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const STRUCTURAL_KINDS = new Set<SkeletonNodeKind>([
  "article",
  "part",
  "division",
  "section",
  "subsection",
  "schedule",
]);

const CONTAINER_KINDS = new Set<SkeletonNodeKind>([
  "article",
  "part",
  "division",
  "schedule",
]);

export function extractProvisionGraph(xref: CrossReferenceGraph): ProvisionGraph {
  const structural = xref.nodes.filter((n) => STRUCTURAL_KINDS.has(n.kind));
  const nodeMap = new Map(structural.map((n) => [n.label, n]));

  const nodes: ProvisionGraphNode[] = structural.map((n) => ({
    label: n.label,
    display: n.display,
    heading: n.heading.slice(0, 80),
    depth: n.depth,
    kind: n.kind,
    start: n.start,
  }));

  const edges: ProvisionGraphEdge[] = [];
  const edgeSet = new Set<string>();

  for (const node of structural) {
    if (node.parentLabel && nodeMap.has(node.parentLabel)) {
      const key = `${node.label}|${node.parentLabel}|parent`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({ from: node.label, to: node.parentLabel, kind: "parent" });
      }
    }
  }

  for (const edge of xref.edges) {
    if (edge.status !== "resolved" || edge.selfLoop) continue;
    if (!edge.sourceLabel || !edge.targetLabel) continue;
    if (!nodeMap.has(edge.sourceLabel) || !nodeMap.has(edge.targetLabel)) continue;

    const key = `${edge.sourceLabel}|${edge.targetLabel}|xref`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push({
        from: edge.sourceLabel,
        to: edge.targetLabel,
        kind: "cross-reference",
        refText: edge.raw,
      });
    }
  }

  return { nodes, edges };
}

export function compileProvisionGraph(
  text: string,
  id = "",
): { graph: ProvisionGraph; abstained: boolean; note: string | null } {
  const skeleton = compileAgreementSkeleton(text, id);
  const xref = crossReferenceGraph(text, id, { skeleton });
  return {
    graph: extractProvisionGraph(xref),
    abstained: xref.documentAbstained,
    note: xref.note,
  };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/\\/gu, "\\\\");
}

function jsStr(s: string): string {
  return JSON.stringify(s);
}

/** Resolve the experiment's development-only browser dependencies. */
function vendorPath(relative: string): string {
  return resolve(__dirname, "..", "..", "backend", "node_modules", relative);
}

let _cytoscapeJs: string | null = null;
let _dagreJs: string | null = null;
let _cytoscapeDagreJs: string | null = null;

function loadVendorScripts(): { cy: string; dagre: string; cyDagre: string } {
  if (_cytoscapeJs && _dagreJs && _cytoscapeDagreJs) {
    return { cy: _cytoscapeJs, dagre: _dagreJs, cyDagre: _cytoscapeDagreJs };
  }
  _cytoscapeJs = readFileSync(vendorPath("cytoscape/dist/cytoscape.min.js"), "utf-8");
  _dagreJs = readFileSync(vendorPath("dagre/dist/dagre.min.js"), "utf-8");
  _cytoscapeDagreJs = readFileSync(
    vendorPath("cytoscape-dagre/dist/cytoscape-dagre.min.js"),
    "utf-8",
  );
  return { cy: _cytoscapeJs, dagre: _dagreJs, cyDagre: _cytoscapeDagreJs };
}

/**
 * Render a provision graph as a self-contained HTML page using Cytoscape.js
 * with dagre hierarchical layout. All JS is inlined — no network needed.
 *
 * Containers (ARTICLE, PART, DIVISION, SCHEDULE) become compound parent
 * nodes that visually group their children. Two views:
 * - **Graph** (default): hierarchy + cross-reference edges
 * - **Tree**: parent-child only, top-down taxonomy
 */
export function renderProvisionGraphHtml(
  graph: ProvisionGraph,
  options: GraphHtmlOptions = {},
): string {
  const title = esc(options.title ?? "Provision Graph");
  const maxNodes = options.maxNodes ?? 300;

  let rendered = graph;
  let truncationNote = "";
  if (graph.nodes.length > maxNodes) {
    const kept = graph.nodes.slice(0, maxNodes);
    const keptLabels = new Set(kept.map((n) => n.label));
    rendered = {
      nodes: kept,
      edges: graph.edges.filter((e) => keptLabels.has(e.from) && keptLabels.has(e.to)),
    };
    truncationNote = `Showing ${maxNodes} of ${graph.nodes.length} provisions.`;
  }

  const xrefCount = graph.edges.filter((e) => e.kind === "cross-reference").length;
  const parentCount = graph.edges.length - xrefCount;

  // Build a node lookup and parent chain walker.
  const nodeById = new Map(rendered.nodes.map((n) => [n.label, n]));
  const parentEdgeByChild = new Map<string, string>();
  for (const e of rendered.edges) {
    if (e.kind === "parent") parentEdgeByChild.set(e.from, e.to);
  }

  /** Walk up the parent chain to find the nearest container ancestor label. */
  function containerAncestor(label: string): string | null {
    const seen = new Set<string>();
    let cursor: string | undefined = label;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parentLabel = parentEdgeByChild.get(cursor);
      if (!parentLabel) return null;
      const parentNode = nodeById.get(parentLabel);
      if (parentNode && CONTAINER_KINDS.has(parentNode.kind)) return parentLabel;
      cursor = parentLabel;
    }
    return null;
  }

  // Build cytoscape elements.
  const elements: Record<string, unknown>[] = [];

  for (const node of rendered.nodes) {
    const isContainer = CONTAINER_KINDS.has(node.kind);
    const el: Record<string, unknown> = {
      data: {
        id: node.label,
        label: isContainer ? node.display : node.label,
        display: node.display,
        heading: node.heading,
        kind: node.kind,
        depth: node.depth,
        container: isContainer,
      },
    };
    if (!isContainer) {
      const ancestor = containerAncestor(node.label);
      if (ancestor) el.data.parent = ancestor;
    }
    elements.push(el);
  }

  for (const edge of rendered.edges) {
    const targetIsContainer = CONTAINER_KINDS.has(
      nodeById.get(edge.to)?.kind ?? ("section" as SkeletonNodeKind),
    );
    elements.push({
      data: {
        id: `${edge.from}|${edge.to}|${edge.kind}`,
        source: edge.from,
        target: edge.to,
        kind: edge.kind,
        refText: edge.refText ?? "",
        hideInGraph: edge.kind === "parent" && targetIsContainer,
      },
    });
  }

  const { cy: cyJs, dagre: dagreJs, cyDagre: cyDagreJs } = loadVendorScripts();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
:root {
  --surface: #fcfcfb;
  --surface2: #f5f4f1;
  --ink: #0b0b0b;
  --ink2: #52514e;
  --muted: #898781;
  --border: #e1e0d9;
  --blue: #2a78d6;
  --blue-bg: #cde2fb;
  --orange: #eb6834;
  --orange-bg: #fde8d6;
  --xref: #2a78d6;
  --parent-edge: #c3c2b7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #1a1a19;
    --surface2: #222221;
    --ink: #ffffff;
    --ink2: #c3c2b7;
    --muted: #898781;
    --border: #383835;
    --blue: #3987e5;
    --blue-bg: #1c3a5e;
    --orange: #d95926;
    --orange-bg: #4a2818;
    --xref: #3987e5;
    --parent-edge: #52514e;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--surface);
  color: var(--ink);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
  flex-wrap: wrap;
}
header h1 { font-size: 14px; font-weight: 600; white-space: nowrap; }
header .stats { font-size: 11px; color: var(--ink2); white-space: nowrap; }
header .spacer { flex: 1; }
.toolbar { display: flex; align-items: center; gap: 6px; }
.toolbar button {
  font-family: inherit; font-size: 11px; padding: 4px 10px;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--surface); color: var(--ink); cursor: pointer;
  white-space: nowrap;
}
.toolbar button:hover { background: var(--surface2); }
.toolbar button.active { background: var(--blue); color: #fff; border-color: var(--blue); }
.toolbar input {
  font-family: inherit; font-size: 11px; padding: 4px 8px;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--surface); color: var(--ink); width: 170px; outline: none;
}
.toolbar input:focus { border-color: var(--blue); }
#cy { flex: 1; width: 100%; min-height: 0; background: var(--surface); }
.tooltip {
  position: fixed; pointer-events: none; z-index: 100;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 5px; padding: 7px 10px; font-size: 11px;
  line-height: 1.35; max-width: 320px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.10);
  display: none;
}
.tooltip.on { display: block; }
.tooltip .tt-display { font-weight: 600; }
.tooltip .tt-heading { color: var(--ink2); margin-top: 2px; }
.tooltip .tt-kind { color: var(--muted); font-size: 10px; text-transform: uppercase; margin-top: 2px; }
.tooltip .tt-xref { color: var(--blue); font-size: 10px; margin-top: 2px; }
.truncation-note {
  padding: 5px 18px; font-size: 11px; color: var(--orange);
  background: var(--orange-bg); border-bottom: 1px solid var(--border); flex-shrink: 0;
}
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <span class="stats">${graph.nodes.length} nodes &middot; ${graph.edges.length} edges &middot; ${parentCount} parent &middot; ${xrefCount} xref</span>
  <span class="spacer"></span>
  <div class="toolbar">
    <button id="btn-graph" class="active">Graph</button>
    <button id="btn-tree">Tree</button>
    <input id="search" type="text" placeholder="Search…" autocomplete="off">
    <button id="btn-fit">Fit</button>
    <button id="btn-reset">Reset</button>
  </div>
</header>
${truncationNote ? `<div class="truncation-note">${esc(truncationNote)}</div>` : ""}
<div id="cy"></div>
<div id="tooltip" class="tooltip"></div>
<script>${cyJs}<\/script>
<script>${dagreJs}<\/script>
<script>${cyDagreJs}<\/script>
<script>
(function() {
  var elements = ${JSON.stringify(elements)};

  var cy = cytoscape({
    container: document.getElementById('cy'),
    elements: elements,
    style: [
      { selector: 'node[container]', style: {
        'background-color': '#e8eef5', 'background-opacity': 0.45,
        'border-color': '#b0afaa', 'border-width': 1.5, 'border-style': 'dashed',
        'label': 'data(label)', 'font-size': '13px', 'font-weight': 'bold',
        'color': '#52514e', 'text-valign': 'top', 'text-halign': 'center',
        'text-margin-y': -7, 'padding': '22px', 'shape': 'round-rectangle',
        'compound-sizing-wrt-labels': 'include'
      }},
      { selector: 'node[kind="section"]', style: {
        'background-color': '#ffffff', 'border-color': '#c3c2b7', 'border-width': 1,
        'label': 'data(label)', 'font-size': '11px', 'color': '#0b0b0b',
        'text-valign': 'center', 'text-halign': 'center',
        'shape': 'round-rectangle', 'width': 'label', 'height': 'label', 'padding': '7px'
      }},
      { selector: 'node[kind="subsection"]', style: {
        'background-color': '#fafaf9', 'border-color': '#e1e0d9', 'border-width': 1,
        'label': 'data(label)', 'font-size': '10px', 'color': '#52514e',
        'text-valign': 'center', 'text-halign': 'center',
        'shape': 'round-rectangle', 'width': 'label', 'height': 'label', 'padding': '5px'
      }},
      { selector: 'edge[hideInGraph]', style: { 'display': 'none' }},
      { selector: 'edge[kind="parent"]', style: {
        'width': 1, 'line-color': '#c3c2b7', 'target-arrow-color': '#c3c2b7',
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'curve-style': 'bezier'
      }},
      { selector: 'edge[kind="cross-reference"]', style: {
        'width': 1.4, 'line-color': '#2a78d6', 'line-opacity': 0.4,
        'target-arrow-color': '#2a78d6', 'target-arrow-opacity': 0.4,
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.8,
        'curve-style': 'unbundled-bezier'
      }},
      { selector: 'node.highlighted', style: {
        'border-color': '#2a78d6', 'border-width': 2.5
      }},
      { selector: 'edge.highlighted', style: {
        'width': 2.5, 'line-opacity': 0.85, 'target-arrow-opacity': 0.85,
        'line-color': '#2a78d6', 'target-arrow-color': '#2a78d6'
      }},
      { selector: 'node.dimmed', style: { 'opacity': 0.15 }},
      { selector: 'edge.dimmed', style: { 'opacity': 0.06 }},
      { selector: 'node.search-match', style: {
        'border-color': '#eb6834', 'border-width': 3
      }}
    ],
    layout: { name: 'dagre', rankDir: 'LR', spacingFactor: 1.2, nodeDimensionsIncludeLabels: true },
    wheelSensitivity: 0.3,
    minZoom: 0.08,
    maxZoom: 3
  });

  // Tooltip
  var tooltip = document.getElementById('tooltip');
  cy.on('mouseover', 'node', function(evt) {
    var d = evt.target.data();
    var html = '<div class="tt-display">' + escH(d.display || d.label) + '</div>';
    if (d.heading) html += '<div class="tt-heading">' + escH(d.heading) + '</div>';
    html += '<div class="tt-kind">' + escH(d.kind) + '</div>';
    tooltip.innerHTML = html;
    tooltip.classList.add('on');
  });
  cy.on('mousemove', function(evt) {
    tooltip.style.left = (evt.originalEvent.clientX + 14) + 'px';
    tooltip.style.top = (evt.originalEvent.clientY + 14) + 'px';
  });
  cy.on('mouseout', 'node', function() { tooltip.classList.remove('on'); });

  // Edge tooltips
  cy.on('mouseover', 'edge[kind="cross-reference"]', function(evt) {
    var d = evt.target.data();
    if (d.refText) {
      tooltip.innerHTML = '<div class="tt-xref">' + escH(d.refText) + '</div>';
      tooltip.classList.add('on');
    }
  });
  cy.on('mouseout', 'edge', function() { tooltip.classList.remove('on'); });

  // Click to highlight neighbours
  cy.on('tap', 'node', function(evt) {
    var node = evt.target;
    cy.elements().removeClass('highlighted dimmed search-match');
    node.addClass('highlighted');
    node.neighborhood().addClass('highlighted');
    cy.elements().not(node).not(node.neighborhood()).addClass('dimmed');
  });
  cy.on('tap', function(evt) {
    if (evt.target === cy) cy.elements().removeClass('highlighted dimmed');
  });

  // View switching
  var currentView = 'graph';
  document.getElementById('btn-graph').addEventListener('click', function() { setView('graph'); });
  document.getElementById('btn-tree').addEventListener('click', function() { setView('tree'); });

  function setView(view) {
    if (view === currentView) return;
    currentView = view;
    document.getElementById('btn-graph').classList.toggle('active', view === 'graph');
    document.getElementById('btn-tree').classList.toggle('active', view === 'tree');
    cy.elements().removeClass('highlighted dimmed search-match');
    if (view === 'tree') {
      cy.edges('[kind="cross-reference"]').style({ 'display': 'none' });
      cy.layout({ name: 'dagre', rankDir: 'TB', spacingFactor: 1.15, nodeDimensionsIncludeLabels: true }).run();
    } else {
      cy.edges('[kind="cross-reference"]').style({ 'display': 'element' });
      cy.edges('[hideInGraph]').style({ 'display': 'none' });
      cy.layout({ name: 'dagre', rankDir: 'LR', spacingFactor: 1.2, nodeDimensionsIncludeLabels: true }).run();
    }
  }

  // Search
  var searchInput = document.getElementById('search');
  var searchTimer;
  searchInput.addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function() {
      var q = searchInput.value.trim().toLowerCase();
      cy.elements().removeClass('search-match dimmed');
      if (!q) return;
      var matches = cy.nodes().filter(function(n) {
        var d = n.data();
        return (d.label||'').toLowerCase().indexOf(q) >= 0 ||
               (d.display||'').toLowerCase().indexOf(q) >= 0 ||
               (d.heading||'').toLowerCase().indexOf(q) >= 0;
      });
      if (matches.length) {
        matches.addClass('search-match');
        cy.elements().not(matches).addClass('dimmed');
        cy.animate({ fit: { eles: matches, padding: 60 }, duration: 350 });
      }
    }, 200);
  });
  searchInput.addEventListener('keydown', function(evt) {
    if (evt.key === 'Escape') { searchInput.value = ''; cy.elements().removeClass('search-match dimmed'); cy.fit(undefined, 40); }
  });

  // Fit / Reset
  document.getElementById('btn-fit').addEventListener('click', function() { cy.fit(undefined, 40); });
  document.getElementById('btn-reset').addEventListener('click', function() {
    cy.elements().removeClass('highlighted dimmed search-match');
    searchInput.value = '';
    if (currentView === 'tree') setView('graph');
    cy.fit(undefined, 40);
  });

  // Keyboard
  document.addEventListener('keydown', function(evt) {
    if (evt.key === 'f' && !evt.ctrlKey && !evt.metaKey && document.activeElement !== searchInput) {
      evt.preventDefault(); searchInput.focus();
    }
    if (evt.key === '1' && !evt.ctrlKey && !evt.metaKey && document.activeElement !== searchInput) setView('graph');
    if (evt.key === '2' && !evt.ctrlKey && !evt.metaKey && document.activeElement !== searchInput) setView('tree');
  });

  cy.fit(undefined, 40);

  function escH(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// SVG rendering (deprecated stub)
// ---------------------------------------------------------------------------

export interface GraphSvgOptions {
  maxNodes?: number;
  width?: number;
  columnGap?: number;
  nodeHeight?: number;
  nodeGap?: number;
  fontSize?: number;
}

export function renderProvisionGraphSvg(
  _graph: ProvisionGraph,
  _options: GraphSvgOptions = {},
): string {
  return `<!-- SVG renderer deprecated; use renderProvisionGraphHtml() for interactive Cytoscape.js output -->`;
}
