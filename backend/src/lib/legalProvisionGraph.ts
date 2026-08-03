/**
 * Provision graph: extract the relationship graph latent in a contract's
 * skeleton and render it as a standalone SVG.
 *
 * Two edge kinds are materialized from primitives already in the tree:
 *
 *   - **parent** — the explicit hierarchy the skeleton compiled (a section
 *     nested under an article, a subsection under its parent section).
 *   - **cross-reference** — internal provision references resolved by
 *     `crossReferenceGraph` (legalCrossReference.ts), which inherits the
 *     skeleton's SourceDoc index and its integrity gates, so "Section
 *     8.01(a)" becomes an edge from the section that mentions it to
 *     sec8.01(a) — or abstains when the numbering scheme is too thin to
 *     check against.
 *
 * The renderer produces a layered left-to-right digraph: each depth level
 * is a column, nodes are stacked vertically in document order, hierarchy
 * edges run straight between columns, and cross-reference edges are curved.
 *
 * No model calls, no API spend — pure computation over the skeleton.
 */

import { compileAgreementSkeleton, type AgreementSkeleton, type SkeletonNodeKind } from "./legalTextSkeleton";
import { crossReferenceGraph, type CrossReferenceGraph } from "./legalCrossReference";

// ---------------------------------------------------------------------------
// Graph types
// ---------------------------------------------------------------------------

export interface ProvisionGraphNode {
  label: string;
  display: string;
  heading: string;
  depth: number;
  kind: SkeletonNodeKind;
  /** character offset in the source text */
  start: number;
}

export type ProvisionGraphEdgeKind = "parent" | "cross-reference";

export interface ProvisionGraphEdge {
  from: string;
  to: string;
  kind: ProvisionGraphEdgeKind;
  /** the raw reference text, only for cross-reference edges */
  refText?: string;
}

export interface ProvisionGraph {
  nodes: ProvisionGraphNode[];
  edges: ProvisionGraphEdge[];
}

export interface GraphSvgOptions {
  /** Maximum nodes to render before truncating (default 200). */
  maxNodes?: number;
  /** SVG width in px (default computed from depth count). */
  width?: number;
  /** Column gap in px (default 100). */
  columnGap?: number;
  /** Node height in px (default 30). */
  nodeHeight?: number;
  /** Vertical gap between nodes in px (default 8). */
  nodeGap?: number;
  /** Font size for node labels in px (default 11). */
  fontSize?: number;
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

/**
 * Build a provision graph from an already-compiled cross-reference graph.
 *
 * Nodes are the structural provisions (articles, parts, sections,
 * subsections, schedules); table/row/cell nodes are excluded. Edges are
 * parent-child hierarchy links and resolved internal cross-references
 * (non-self-loop, non-external, non-abstained).
 */
export function extractProvisionGraph(
  xref: CrossReferenceGraph,
): ProvisionGraph {
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

  // Parent-child edges — each node points to its container.
  for (const node of structural) {
    if (node.parentLabel && nodeMap.has(node.parentLabel)) {
      const key = `${node.label}|${node.parentLabel}|parent`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({ from: node.label, to: node.parentLabel, kind: "parent" });
      }
    }
  }

  // Cross-reference edges — resolved, non-self-loop edges from the
  // crossReferenceGraph resolver, which has already applied the integrity
  // gate and excluded external / abstained references.
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

/**
 * Convenience: compile a skeleton, resolve its cross-reference graph, and
 * extract the provision graph in one call.
 */
export function compileProvisionGraph(
  text: string,
  id = "",
): { graph: ProvisionGraph; abstained: boolean; note: string | null } {
  const skeleton = compileAgreementSkeleton(text, id);
  const xref = crossReferenceGraph(text, id, { skeleton });
  const graph = extractProvisionGraph(xref);
  return {
    graph,
    abstained: xref.documentAbstained,
    note: xref.note,
  };
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

interface LayoutNode {
  label: string;
  display: string;
  heading: string;
  depth: number;
  kind: SkeletonNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutEdge {
  from: LayoutNode;
  to: LayoutNode;
  kind: ProvisionGraphEdgeKind;
  refText?: string;
}

interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  svgWidth: number;
  svgHeight: number;
}

function layoutGraph(
  graph: ProvisionGraph,
  options: GraphSvgOptions,
): LayoutResult {
  const columnGap = options.columnGap ?? 100;
  const nodeHeight = options.nodeHeight ?? 30;
  const nodeGap = options.nodeGap ?? 8;
  const fontSize = options.fontSize ?? 11;

  // Group nodes by depth, ordered by document position within each level.
  const byDepth = new Map<number, ProvisionGraphNode[]>();
  for (const node of graph.nodes) {
    const bucket = byDepth.get(node.depth) ?? [];
    bucket.push(node);
    byDepth.set(node.depth, bucket);
  }

  // Measure column widths: the widest label in each column.
  // Estimate label pixel width: ~0.62 * fontSize per character for system-ui.
  const charWidth = fontSize * 0.62;
  const columnWidths = new Map<number, number>();
  for (const [depth, bucket] of byDepth) {
    let maxW = 0;
    for (const node of bucket) {
      const w = nodeLabelText(node).length * charWidth;
      if (w > maxW) maxW = w;
    }
    columnWidths.set(depth, Math.max(maxW + 16, 60)); // 8px padding each side
  }

  // Compute x positions: cumulative column widths + gaps.
  const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b);
  const depthX = new Map<number, number>();
  let xCursor = 20; // left margin
  for (const depth of sortedDepths) {
    depthX.set(depth, xCursor);
    xCursor += (columnWidths.get(depth) ?? 80) + columnGap;
  }
  const svgWidth = xCursor - columnGap + 20; // right margin

  // Compute y positions: stack nodes within each column.
  const labelToLayout = new Map<string, LayoutNode>();
  let svgHeight = 20; // top margin
  for (const depth of sortedDepths) {
    const bucket = byDepth.get(depth)!;
    const colX = depthX.get(depth)!;
    const colW = columnWidths.get(depth) ?? 80;
    let yCursor = 20;
    for (const node of bucket) {
      const layout: LayoutNode = {
        label: node.label,
        display: node.display,
        heading: node.heading,
        depth: node.depth,
        kind: node.kind,
        x: colX,
        y: yCursor,
        width: colW,
        height: nodeHeight,
      };
      labelToLayout.set(node.label, layout);
      yCursor += nodeHeight + nodeGap;
    }
    if (yCursor > svgHeight) svgHeight = yCursor;
  }
  svgHeight += 20; // bottom margin

  // Build layout edges.
  const layoutEdges: LayoutEdge[] = [];
  for (const edge of graph.edges) {
    const from = labelToLayout.get(edge.from);
    const to = labelToLayout.get(edge.to);
    if (from && to) {
      layoutEdges.push({ from, to, kind: edge.kind, refText: edge.refText });
    }
  }

  return { nodes: [...labelToLayout.values()], edges: layoutEdges, svgWidth, svgHeight };
}

// ---------------------------------------------------------------------------
// Color palette (dataviz reference palette, light mode)
// ---------------------------------------------------------------------------

const COLORS = {
  surface: "#fcfcfb",
  primaryInk: "#0b0b0b",
  secondaryInk: "#52514e",
  muted: "#898781",
  // Node fills by kind — sequential blue ramp for depth
  article: "#cde2fb",
  part: "#b7d3f6",
  division: "#9ec5f4",
  section: "#ffffff",
  subsection: "#fafaf9",
  schedule: "#fef3e4",
  // Edge strokes
  parentEdge: "#c3c2b7",
  xrefEdge: "#2a78d6", // categorical blue
  xrefEdgeAlpha: "0.45",
  // Node text
  nodeText: "#0b0b0b",
  nodeStroke: "#e1e0d9",
};

function nodeFill(kind: SkeletonNodeKind): string {
  switch (kind) {
    case "article": return COLORS.article;
    case "part": return COLORS.part;
    case "division": return COLORS.division;
    case "section": return COLORS.section;
    case "subsection": return COLORS.subsection;
    case "schedule": return COLORS.schedule;
    default: return COLORS.section;
  }
}

function nodeRadius(kind: SkeletonNodeKind): number {
  switch (kind) {
    case "article":
    case "part":
    case "division":
    case "schedule":
      return 6;
    case "section":
      return 4;
    default:
      return 3;
  }
}

function nodeLabelText(node: { label: string; kind: SkeletonNodeKind; display: string }): string {
  switch (node.kind) {
    case "article":
    case "part":
    case "division":
    case "schedule":
      return node.display;
    default:
      return node.label;
  }
}

// ---------------------------------------------------------------------------
// SVG string builder
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function tooltipText(node: LayoutNode): string {
  const parts = [node.display];
  if (node.heading) parts.push(node.heading);
  return parts.join(": ");
}

/**
 * Render a provision graph as a standalone SVG string.
 *
 * The layout is a layered left-to-right digraph: each depth level is a
 * vertical column, nodes within a column are stacked in document order,
 * parent edges run straight between columns, and cross-reference edges
 * are drawn as quadratic bezier curves with arrowheads.
 *
 * Dark mode is supported via a `prefers-color-scheme: dark` media query
 * inlined in the SVG's `<style>` block.
 */
export function renderProvisionGraphSvg(
  graph: ProvisionGraph,
  options: GraphSvgOptions = {},
): string {
  const maxNodes = options.maxNodes ?? 200;
  const fontSize = options.fontSize ?? 11;

  // Truncate if needed.
  let rendered = graph;
  let truncationNote = "";
  if (graph.nodes.length > maxNodes) {
    const kept = graph.nodes.slice(0, maxNodes);
    const keptLabels = new Set(kept.map((n) => n.label));
    rendered = {
      nodes: kept,
      edges: graph.edges.filter(
        (e) => keptLabels.has(e.from) && keptLabels.has(e.to),
      ),
    };
    truncationNote = `Showing ${maxNodes} of ${graph.nodes.length} provisions.`;
  }

  const layout = layoutGraph(rendered, options);
  const w = options.width ?? layout.svgWidth;
  const h = layout.svgHeight;
  const headerH = truncationNote ? 32 : 0;
  const totalH = h + headerH;

  const lines: string[] = [];

  // SVG opening
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${totalH}" width="${w}" height="${totalH}">`,
  );

  // Inline styles
  lines.push(`<style>
  .pg-surface { fill: ${COLORS.surface}; }
  .pg-edge-parent { stroke: ${COLORS.parentEdge}; stroke-width: 1.2; fill: none; }
  .pg-edge-xref { stroke: ${COLORS.xrefEdge}; stroke-opacity: ${COLORS.xrefEdgeAlpha}; stroke-width: 1.4; fill: none; }
  .pg-edge-xref-arrow { fill: ${COLORS.xrefEdge}; fill-opacity: ${COLORS.xrefEdgeAlpha}; }
  .pg-node-text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: ${fontSize}px; fill: ${COLORS.nodeText}; text-anchor: middle; dominant-baseline: central; }
  .pg-title { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: ${fontSize}px; fill: ${COLORS.muted}; text-anchor: middle; }
  .pg-legend-text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: ${Math.max(fontSize - 1, 9)}px; fill: ${COLORS.secondaryInk}; }
  .pg-abstain { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: ${fontSize}px; fill: ${COLORS.muted}; text-anchor: start; }
  @media (prefers-color-scheme: dark) {
    .pg-surface { fill: #1a1a19; }
    .pg-edge-parent { stroke: #52514e; }
    .pg-edge-xref { stroke: #3987e5; stroke-opacity: 0.55; }
    .pg-edge-xref-arrow { fill: #3987e5; fill-opacity: 0.55; }
    .pg-node-text { fill: #ffffff; }
    .pg-title { fill: #898781; }
    .pg-legend-text { fill: #c3c2b7; }
    .pg-abstain { fill: #898781; }
  }
</style>`);

  // Background
  lines.push(`<rect width="${w}" height="${totalH}" class="pg-surface" />`);

  // Truncation note
  if (truncationNote) {
    lines.push(
      `<text x="${w / 2}" y="16" class="pg-title">${esc(truncationNote)}</text>`,
    );
  }

  const yOff = headerH;

  // Group for content with y-offset
  lines.push(`<g transform="translate(0, ${yOff})">`);

  // Draw edges first (behind nodes).
  // Parent edges: straight lines from right edge of child to left edge of parent.
  for (const edge of layout.edges) {
    if (edge.kind === "parent") {
      const x1 = edge.from.x + edge.from.width;
      const y1 = edge.from.y + edge.from.height / 2;
      const x2 = edge.to.x;
      const y2 = edge.to.y + edge.to.height / 2;
      lines.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="pg-edge-parent" />`,
      );
    }
  }

  // Cross-reference edges: curved paths with arrowheads.
  for (const edge of layout.edges) {
    if (edge.kind === "cross-reference") {
      const x1 = edge.from.x + edge.from.width;
      const y1 = edge.from.y + edge.from.height / 2;
      const x2 = edge.to.x;
      const y2 = edge.to.y + edge.to.height / 2;
      // Control point arcs the curve above or below depending on direction.
      const sign = y2 >= y1 ? 1 : -1;
      const cpy = (y1 + y2) / 2 - sign * Math.min(Math.abs(y2 - y1) * 0.3, 60);
      lines.push(
        `<path d="M${x1},${y1} Q${(x1 + x2) / 2},${cpy} ${x2},${y2}" class="pg-edge-xref" />`,
      );
      // Arrowhead at target
      const arrowSize = 5;
      const angle = Math.atan2(
        y2 - cpy - (cpy - y1),
        x2 - x1,
      );
      const ax1 = x2 - arrowSize * Math.cos(angle - 0.5);
      const ay1 = y2 - arrowSize * Math.sin(angle - 0.5);
      const ax2 = x2 - arrowSize * Math.cos(angle + 0.5);
      const ay2 = y2 - arrowSize * Math.sin(angle + 0.5);
      lines.push(
        `<polygon points="${x2},${y2} ${ax1.toFixed(1)},${ay1.toFixed(1)} ${ax2.toFixed(1)},${ay2.toFixed(1)}" class="pg-edge-xref-arrow" />`,
      );
    }
  }

  // Draw nodes.
  for (const node of layout.nodes) {
    const rx = nodeRadius(node.kind);
    const fill = nodeFill(node.kind);
    const label = nodeLabelText(node);
    const title = tooltipText(node);

    lines.push(
      `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${rx}" ry="${rx}" fill="${fill}" stroke="${COLORS.nodeStroke}" stroke-width="1"><title>${esc(title)}</title></rect>`,
    );
    lines.push(
      `<text x="${node.x + node.width / 2}" y="${node.y + node.height / 2}" class="pg-node-text">${esc(label)}</text>`,
    );
  }

  lines.push(`</g>`); // end y-offset group

  // Legend
  const legendY = totalH - 18;
  let lx = 20;
  const legendItems = [
    { label: "parent/child", cls: "pg-edge-parent" },
    { label: "cross-reference", cls: "pg-edge-xref" },
  ];
  for (const item of legendItems) {
    lines.push(
      `<line x1="${lx}" y1="${legendY}" x2="${lx + 24}" y2="${legendY}" class="${item.cls}" />`,
    );
    lx += 28;
    lines.push(
      `<text x="${lx}" y="${legendY}" class="pg-legend-text" dominant-baseline="central">${item.label}</text>`,
    );
    lx += item.label.length * (fontSize * 0.62) + 20;
  }
  // Node/edge counts
  const xrefEdges = graph.edges.filter((e) => e.kind === "cross-reference").length;
  const parentEdges = graph.edges.length - xrefEdges;
  lines.push(
    `<text x="${w - 20}" y="${legendY}" class="pg-legend-text" text-anchor="end" dominant-baseline="central">${graph.nodes.length} nodes, ${parentEdges} parent, ${xrefEdges} xref edges</text>`,
  );

  lines.push(`</svg>`);
  return lines.join("\n");
}
