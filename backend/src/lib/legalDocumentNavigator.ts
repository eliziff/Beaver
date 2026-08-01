/**
 * Document navigation: the addressing layer a model can actually call.
 *
 * The deterministic structure work compiles a section tree
 * (`compileAgreementSkeleton`) and a cross-reference graph
 * (`crossReferenceGraph`), and until now neither was reachable from a model
 * turn. `library_read section=` could read one node; nothing could ask for a
 * page, for a node's neighbours, or for a single edge — so any printed page
 * number, whether it reached us from a pinpoint citation, an index, an
 * exhibit stamp or a contents page, was a dead end, and 4,414 resolved
 * references were invisible to the only consumer that could use them.
 *
 * This module is the join: one addressing scheme that a page number, a
 * contents entry and a cross-reference edge all resolve into.
 *
 * Three rules it keeps.
 *
 *   A page is a READING WINDOW, never a provision. Page spans report the
 *   sections that overlap them precisely so a caller can move to the
 *   structural address, which is the one that survives re-pagination and the
 *   one an answer should cite.
 *
 *   Pages are OUR OWN printed data. `[page N]` markers are emitted at a line
 *   start by the PDF and journals compilers (`legalPdfSourceDoc`,
 *   `localPdfLookup`, `journalArticles`); reading them back is parsing our
 *   own output, not detecting page structure in someone else's document.
 *   Nothing here infers, recovers or validates a page boundary.
 *
 *   Refusal beats guessing (CLAUDE.md rule 5). A document with no pages says
 *   so and names what to use instead. A page label that does not exist
 *   reports the range that does, rather than returning the nearest thing.
 */
import type {
  CrossReferenceEdge,
  CrossReferenceGraph,
} from "./legalCrossReference";
import type { AgreementSkeleton, SkeletonNode } from "./legalTextSkeleton";

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface PageSpan {
  /** 1-based position in the document — the sheet, whatever it is called */
  ordinal: number;
  /** the PDF page number, when the artifact recorded one */
  pdfPage: number | null;
  /** the label printed on the sheet, which may be roman or prefixed ("iv", "A-3") */
  printedLabel: string | null;
  /** includes the marker line, so a read shows which page it is on */
  start: number;
  end: number;
}

export interface PageMap {
  pages: PageSpan[];
  /**
   * Where the map came from. `artifact` is the engine's page records;
   * `markers` is recovered from rendered text and knows one number per page
   * without knowing which sense it is; `unpaginated` is a document with no
   * fixed pages at all (a DOCX is not paginated until something renders
   * it); `unindexed` is a paged document whose index could not be built,
   * which is a state of our pipeline and never a fact about the document.
   */
  source: "artifact" | "markers" | "unpaginated" | "unindexed";
}

/**
 * Which addressing schemes actually work on this document.
 *
 * A PDF always has PDF page numbers. Printed labels are DETECTED — from
 * headers and footers, and left unresolved when they conflict — so a PDF
 * whose furniture carries no page number is not unaddressable, it is
 * addressable by PDF page only. Saying otherwise reports a detection miss as
 * a missing document feature.
 */
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

/**
 * Exactly the shape the compilers print: `[page <label>]` alone on a line.
 * Anchored to a line start so a body sentence that happens to contain the
 * bracketed words cannot be mistaken for a page boundary.
 */
const PAGE_MARKER_RE = /^\[page ([^\]\n]{1,40})\]$/gmu;

/**
 * Fallback map, for text whose compiler printed markers but whose artifact
 * is not in hand (journal bodies, A2AJ reports).
 *
 * `legalPdfSourceDoc` prints `printed || String(physicalNumber)`, so a bare
 * "12" here is genuinely ambiguous between the two senses and BOTH fields
 * carry it. Saying "12 is the printed label" would be inventing provenance
 * the text does not carry.
 */
export function pageMapFromMarkers(text: string): PageMap {
  const pages: PageSpan[] = [];
  PAGE_MARKER_RE.lastIndex = 0;
  for (let match = PAGE_MARKER_RE.exec(text); match; match = PAGE_MARKER_RE.exec(text)) {
    const label = match[1].trim();
    if (!label) continue;
    if (pages.length) pages[pages.length - 1].end = match.index;
    const numeric = /^\d{1,6}$/u.test(label) ? Number(label) : null;
    pages.push({
      ordinal: pages.length + 1,
      pdfPage: numeric,
      printedLabel: label,
      start: match.index,
      end: text.length,
    });
  }
  return { pages, source: pages.length ? "markers" : "unpaginated" };
}

/**
 * The authoritative map. `compileLegalPdfSourceDoc` already lays the engine's
 * page records onto the text plane and keeps both numbers — `anchor` carries
 * `page=<physical>` and `aliases` carries the printed label whenever the
 * engine's header/footer detection found one that differs. This reads that
 * back rather than re-deriving anything: the PDF engine owns detection.
 */
export function pageMapFromSourceDoc(doc: {
  blocks?: readonly {
    kind: string;
    label: string;
    start: number;
    end: number;
    anchor?: string;
    aliases?: string[];
  }[];
}): PageMap {
  const pages: PageSpan[] = [];
  // A rendition whose provider compiler has not landed carries no blocks at
  // all; that is "this document has no pages", not a crash in a read tool.
  if (!Array.isArray(doc?.blocks)) return { pages, source: "unpaginated" };
  for (const block of doc.blocks) {
    if (block.kind !== "page") continue;
    const physical = /^page=(\d{1,6})$/u.exec(block.anchor ?? "");
    const pdfPage = physical ? Number(physical[1]) : null;
    const printed =
      block.aliases?.find(
        (alias: string) => alias.trim() && alias.trim() !== String(pdfPage),
      ) ?? null;
    pages.push({
      ordinal: pages.length + 1,
      pdfPage,
      printedLabel: printed ? printed.trim() : null,
      start: block.start,
      end: block.end,
    });
  }
  pages.sort((left, right) => left.start - right.start);
  for (const [index, page] of pages.entries()) page.ordinal = index + 1;
  return { pages, source: pages.length ? "artifact" : "unpaginated" };
}

export type PageLookup =
  | { status: "found"; page: PageSpan; matchedOn: "pdf" | "printed"; text: string }
  | { status: "no_pages" }
  | {
      status: "not_found";
      requested: string;
      sense: "pdf" | "printed";
      count: number;
      first: string | null;
      last: string | null;
    };

const describePage = (page: PageSpan): string =>
  page.printedLabel && page.printedLabel !== String(page.pdfPage)
    ? `PDF page ${page.pdfPage ?? page.ordinal} (printed "${page.printedLabel}")`
    : `PDF page ${page.pdfPage ?? page.ordinal}`;

export function pageLabel(page: PageSpan): string {
  return describePage(page);
}

/**
 * Resolve a page request in ONE numbering scheme, chosen by the caller.
 *
 * The PDF page and the printed label are two different things to ask for,
 * not two readings of one request. The printed label is the number ON THE
 * SHEET, and it is what the record is cited by -- a pinpoint in a brief, an
 * index, an exhibit stamp, a transcript line, a table of contents. The PDF
 * page is where the sheet sits in the file. Front matter, inserted exhibits
 * and re-scanned appendices all make them diverge, and each is the right
 * answer to a different question. The caller says which it means; nothing
 * here decides on its behalf.
 *
 * Unqualified, digits are a PDF page — the scheme every PDF has — and
 * anything else ("iv", "A-3") can only be a printed label. `pdf:` and
 * `printed:` override.
 */
export function resolvePage(
  map: PageMap,
  text: string,
  requested: string,
): PageLookup {
  if (!map.pages.length) return { status: "no_pages" };
  const raw = requested.trim();
  const qualified = /^(pdf|printed)\s*[:=]\s*(.+)$/iu.exec(raw);
  const wanted = (qualified?.[2] ?? raw).trim();
  const sense: "pdf" | "printed" =
    (qualified?.[1].toLowerCase() as "pdf" | "printed" | undefined) ??
    (/^\d{1,6}$/u.test(wanted) ? "pdf" : "printed");

  const page =
    sense === "pdf"
      ? map.pages.find((candidate) => String(candidate.pdfPage) === wanted)
      : map.pages.find(
          (candidate) =>
            candidate.printedLabel?.toLowerCase() === wanted.toLowerCase(),
        );
  if (!page) {
    return {
      status: "not_found",
      requested: raw,
      sense,
      count: map.pages.length,
      first: describePage(map.pages[0]),
      last: describePage(map.pages[map.pages.length - 1]),
    };
  }
  return {
    status: "found",
    page,
    matchedOn: sense,
    text: text.slice(page.start, page.end),
  };
}

/** Every page overlapping a span — the filter behind a page-scoped search. */
export function pagesInRange(
  map: PageMap,
  from: PageSpan,
  to: PageSpan,
): PageSpan[] {
  const low = Math.min(from.ordinal, to.ordinal);
  const high = Math.max(from.ordinal, to.ordinal);
  return map.pages.filter(
    (page) => page.ordinal >= low && page.ordinal <= high,
  );
}

/** The page a character offset falls on, for labelling a search hit. */
export function pageAt(map: PageMap, at: number): PageSpan | null {
  return map.pages.find((page) => page.start <= at && at < page.end) ?? null;
}

export type PageSelection =
  | { status: "ok"; pages: PageSpan[] }
  | { status: "empty" }
  | { status: "failed"; token: string; lookup: PageLookup };

/**
 * Parse a page scope: "47", "12-18", "3,5,9", "printed:47", or any mix.
 *
 * Ranges are resolved END BY END and then taken by position, so "printed:iv
 * - printed:2" spans the front matter into the body even though neither
 * endpoint is comparable as a number. Every endpoint goes through the same
 * two-scheme resolution as a single page, so an ambiguous endpoint refuses
 * here exactly as it would there rather than quietly picking a reading.
 */
export function selectPages(
  map: PageMap,
  text: string,
  spec: string,
): PageSelection {
  const tokens = spec
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return { status: "empty" };

  const chosen = new Map<number, PageSpan>();
  for (const token of tokens) {
    // Split on a hyphen that separates two endpoints, not one inside a label
    // like "A-3": the separator has whitespace, or the token has exactly one
    // hyphen with digits on both sides.
    const range =
      /^(.+?)\s+-\s+(.+)$/u.exec(token) ?? /^(\d{1,6})-(\d{1,6})$/u.exec(token);
    if (range) {
      const from = resolvePage(map, text, range[1]);
      if (from.status !== "found") return { status: "failed", token, lookup: from };
      const to = resolvePage(map, text, range[2]);
      if (to.status !== "found") return { status: "failed", token, lookup: to };
      for (const page of pagesInRange(map, from.page, to.page)) {
        chosen.set(page.ordinal, page);
      }
      continue;
    }
    const single = resolvePage(map, text, token);
    if (single.status !== "found") return { status: "failed", token, lookup: single };
    chosen.set(single.page.ordinal, single.page);
  }
  return {
    status: "ok",
    pages: [...chosen.values()].sort((left, right) => left.ordinal - right.ordinal),
  };
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

export type FollowDirection = "none" | "out" | "in" | "both";

export interface GraphScope {
  seed: SkeletonNode;
  /** the seed first, then everything reached, in document order after it */
  nodes: SkeletonNode[];
  /** hops actually used — lower than asked when the neighbourhood closes */
  depth: number;
}

/**
 * The provisions reachable from one provision along the document's own
 * literal references — the scope behind "search this clause and everything
 * it depends on".
 *
 * Only RESOLVED edges expand the scope. An unresolved or external reference
 * names no span in this document, so following it could only widen the
 * search to nothing; and an abstained document has no trustworthy edges at
 * all, which the caller sees as a scope of one.
 *
 * A node's span already contains its children, so a seeded scope covers the
 * subtree without walking it.
 */
export function graphScope(
  skeleton: AgreementSkeleton,
  graph: CrossReferenceGraph,
  seedLabel: string,
  options: { follow?: FollowDirection; depth?: number } = {},
): GraphScope | null {
  const wanted = seedLabel.trim().toLowerCase();
  const seed = skeleton.nodes.find(
    (node) => node.label.toLowerCase() === wanted,
  );
  if (!seed) return null;

  const follow = options.follow ?? "none";
  const limit = Math.max(0, Math.min(options.depth ?? 1, 3));
  const byLabel = new Map<string, SkeletonNode>();
  for (const node of skeleton.nodes) {
    if (!byLabel.has(node.label)) byLabel.set(node.label, node);
  }

  const reached = new Map<string, SkeletonNode>([[seed.label, seed]]);
  let frontier = [seed.label];
  let hops = 0;
  for (; follow !== "none" && hops < limit && frontier.length; hops += 1) {
    const next: string[] = [];
    const inFrontier = new Set(frontier);
    for (const edge of graph.edges) {
      if (edge.status !== "resolved" || edge.selfLoop) continue;
      const forward =
        (follow === "out" || follow === "both") &&
        edge.sourceLabel !== null &&
        inFrontier.has(edge.sourceLabel);
      const backward =
        (follow === "in" || follow === "both") &&
        edge.targetLabel !== null &&
        inFrontier.has(edge.targetLabel);
      const other = forward ? edge.targetLabel : backward ? edge.sourceLabel : null;
      if (!other || reached.has(other)) continue;
      const node = byLabel.get(other);
      if (!node) continue;
      reached.set(other, node);
      next.push(other);
    }
    frontier = next;
    if (!next.length) {
      hops += 1;
      break;
    }
  }

  const rest = [...reached.values()]
    .filter((node) => node.label !== seed.label)
    .sort((left, right) => left.start - right.start);
  return { seed, nodes: [seed, ...rest], depth: Math.min(hops, limit) };
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
