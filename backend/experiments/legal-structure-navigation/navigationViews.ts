import type { CrossReferenceEdge, CrossReferenceGraph } from "../../src/lib/legalCrossReference";
import type { AgreementSkeleton, SkeletonNode } from "../../src/lib/legalTextSkeleton";
import type { PageMap, PageSpan } from "../../src/lib/legalDocumentNavigator";

export interface PageSchemes {
  pdfPages: boolean;
  printedLabels: boolean;
}

export function pageSchemes(map: PageMap): PageSchemes {
  return {
    pdfPages: map.pages.some((page) => page.pdfPage !== null),
    printedLabels: map.pages.some((page) => page.printedLabel !== null),
  };
}

export function pageAt(map: PageMap, at: number): PageSpan | null {
  return map.pages.find((page) => page.start <= at && at < page.end) ?? null;
}

export interface PageSections {
  /** provisions whose heading is printed on this page, in reading order */
  starts: SkeletonNode[];
  /** the provision already running when the page opens, deepest first */
  continuedFrom: SkeletonNode[];
}

/**
 * The structural handles for a page — the way off it, and the reason a page
 * read is worth having at all.
 *
 * Overlap is the wrong test and the corpus says so immediately: a node's
 * span runs to the next heading, so the last section of page 1 overlaps
 * page 2 by the marker line alone and would be reported as printed there.
 * What a reader means by "on this page" is where a heading APPEARS, plus
 * the one provision already in progress when the page opens.
 */
export function pageSections(
  skeleton: AgreementSkeleton,
  page: Pick<PageSpan, "start" | "end">,
): PageSections {
  const starts = skeleton.nodes
    .filter((node) => node.start >= page.start && node.start < page.end)
    .sort((left, right) => left.start - right.start || left.depth - right.depth);
  const opened = new Set(starts.map((node) => node.label));
  const continuedFrom = skeleton.nodes
    .filter(
      (node) =>
        node.start < page.start &&
        page.start < node.end &&
        !opened.has(node.label),
    )
    .sort((left, right) => right.depth - left.depth);
  return { starts, continuedFrom };
}

// ---------------------------------------------------------------------------
// Tree neighbourhood
// ---------------------------------------------------------------------------

export interface Neighbourhood {
  node: SkeletonNode;
  /** nearest parent first, up to the root */
  ancestors: SkeletonNode[];
  siblings: SkeletonNode[];
  children: SkeletonNode[];
}

export function nodeNeighbourhood(
  skeleton: AgreementSkeleton,
  label: string,
): Neighbourhood | null {
  const wanted = label.trim().toLowerCase();
  const node = skeleton.nodes.find(
    (candidate) => candidate.label.toLowerCase() === wanted,
  );
  if (!node) return null;

  const byLabel = new Map<string, SkeletonNode>();
  for (const candidate of skeleton.nodes) {
    if (!byLabel.has(candidate.label)) byLabel.set(candidate.label, candidate);
  }

  const ancestors: SkeletonNode[] = [];
  const seen = new Set<string>([node.label]);
  for (let at = node.parentLabel; at; ) {
    const parent = byLabel.get(at);
    // A malformed parent chain must not hang the tool; stop on a cycle.
    if (!parent || seen.has(parent.label)) break;
    seen.add(parent.label);
    ancestors.push(parent);
    at = parent.parentLabel;
  }

  const children = skeleton.nodes.filter(
    (candidate) => candidate.parentLabel === node.label,
  );
  const siblings = skeleton.nodes.filter(
    (candidate) =>
      candidate.label !== node.label &&
      candidate.parentLabel === node.parentLabel &&
      // Top-level nodes share an undefined parent; keep the kind stable so
      // "siblings" of an Article are Articles, not every unparented node.
      (node.parentLabel !== undefined || candidate.kind === node.kind),
  );
  return { node, ancestors, siblings, children };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export interface NodeLinks {
  /** references written inside this node */
  outgoing: CrossReferenceEdge[];
  /** references elsewhere in the document that resolve to this node */
  incoming: CrossReferenceEdge[];
}

export function nodeLinks(graph: CrossReferenceGraph, label: string): NodeLinks {
  const wanted = label.trim().toLowerCase();
  const outgoing: CrossReferenceEdge[] = [];
  const incoming: CrossReferenceEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.sourceLabel?.toLowerCase() === wanted) outgoing.push(edge);
    if (edge.targetLabel?.toLowerCase() === wanted && !edge.selfLoop) {
      incoming.push(edge);
    }
  }
  return { outgoing, incoming };
}

export interface ReferenceHub {
  label: string;
  incoming: number;
}

/**
 * The provisions the document points at most. Orientation before navigation:
 * on an agreement whose gold is fragmented across cross-references, the hubs
 * are where the fragments collect.
 */
export function referenceHubs(
  graph: CrossReferenceGraph,
  limit = 12,
): ReferenceHub[] {
  const counts = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.status !== "resolved" || edge.selfLoop || !edge.targetLabel) continue;
    counts.set(edge.targetLabel, (counts.get(edge.targetLabel) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, incoming]) => ({ label, incoming }))
    .sort((left, right) => right.incoming - left.incoming || left.label.localeCompare(right.label))
    .slice(0, limit);
}
