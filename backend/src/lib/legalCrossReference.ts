/**
 * Intra-document cross-reference graph.
 *
 * Contracts are self-referential: "subject to Section 6.3(a)", "except as
 * set forth in Article VI", "the Termination Fee (as defined in Section
 * 8.03(b))". The gold answer to a question about one clause is routinely
 * fragmented across the clauses it points at. This module compiles those
 * pointers into an explicit graph — deterministically, with no model calls —
 * so a composer can be shown the document's own reference structure instead
 * of inferring it from proximity.
 *
 * Layers, deliberately kept apart because they are not the same evidence:
 *
 *   LITERAL edges (`crossReferenceGraph`) — the text says so. A reference
 *     span resolves to a skeleton node or it does not; there is no scoring.
 *     Every edge carries a typed status: resolved / external / unresolved /
 *     abstained.
 *
 *   TERM edges (`definedTermEdges`) — a capitalized quoted term defined once
 *     and used elsewhere. High precision in contracts, but it is an
 *     inference about meaning, not a statement the document makes about
 *     itself. Never merged into the literal edge list.
 *
 *   LEXICAL edges (`lexicalOverlapEdges`) — rare-token overlap between
 *     sections. The weakest class by construction and the one most likely to
 *     be redundant with the retriever's own bm25; kept separable so it can
 *     be measured and, if redundant, retired.
 *
 * Refusal beats guessing (CLAUDE.md rule 5). Resolution is only as good as
 * the skeleton it resolves against, so a document whose skeleton is too thin
 * to carry a numbering scheme abstains WHOLESALE and says so, exactly as
 * docxStructuralLint.checkCrossReferences does — an unresolved edge must
 * mean "this document numbers to that depth and there is no such provision",
 * never "we could not tell".
 *
 * MEASURED ON LEGALBENCH-RAG MINI (69 documents, zero model calls). Read
 * this before wiring the graph into any retrieval arm.
 *
 *   Resolver, over the 45 documents that pass the integrity gate: 2,428
 *   resolved / 307 unresolved / 1,720 external / 4,779 refused of 9,234
 *   references detected. 3.3% of accepted references miss — the graph is a
 *   trustworthy instrument on the documents it accepts.
 *
 *   Alignment with the benchmark's own gold is the negative half. Standing
 *   on a gold fragment of a test whose gold is fragmented, following the
 *   outgoing literal edges reaches OTHER gold fragments at 2.28% precision
 *   on maud against 1.44% for the same character budget spent contiguously
 *   (1.6x better), but at 1.15% vs 6.99% on cuad and 4.06% vs 5.06% on
 *   contractnli (worse), and only 31 of 227 maud gold fragments have any
 *   outgoing edge at all. The weak layers lose to contiguous context
 *   everywhere: defined-term 0.12-1.29%, lexical 0.81-4.57%. On THIS bed the
 *   graph is not a recall mechanism; if it earns arms it will be as
 *   structure shown to a composer, not as extra retrieved context.
 */
import {
  compileAgreementSkeleton,
  type AgreementSkeleton,
  type SkeletonNode,
} from "./legalTextSkeleton";
import { collectDefinedTerms } from "./docxStructuralLint";
import {
  findProvisionReferences,
  joinLocator,
  type ProvisionReference,
} from "./legalReferenceGrammar";

export type CrossReferenceStatus =
  | "resolved"
  | "external"
  | "unresolved"
  | "abstained";

export interface CrossReferenceEdge {
  /** span of the reference text itself ("Section 6.3(a)") */
  sourceStart: number;
  sourceEnd: number;
  /** deepest skeleton node containing the reference, if any */
  sourceLabel: string | null;
  /** the reference as written */
  raw: string;
  /** whitespace-compacted label as written ("6.3(a)", "VI", "(b)") */
  rawLabel: string;
  /** shared locator dialect, or the alias key for roman containers */
  normalizedLocator: string;
  targetLabel: string | null;
  targetStart: number | null;
  targetEnd: number | null;
  status: CrossReferenceStatus;
  /** the target is the node the reference sits in ("this Section 6.3") */
  selfLoop: boolean;
  /** typed reason, present on every non-resolved edge */
  reason?:
    | "external_instrument"
    | "document_abstained"
    | "no_containing_section"
    | "ambiguous_label"
    | "depth_not_numbered"
    | "no_such_provision";
}

export interface CrossReferenceCounts {
  detected: number;
  resolved: number;
  external: number;
  unresolved: number;
  abstained: number;
  selfLoops: number;
  /**
   * resolved / (resolved + unresolved) — the resolver's hit rate over the
   * references it accepted responsibility for (refusals excluded). 1 when it
   * accepted none.
   */
  integrity: number;
}

export interface CrossReferenceGraph {
  /** skeleton nodes, i.e. the graph's vertices */
  nodes: SkeletonNode[];
  edges: CrossReferenceEdge[];
  /** true when the skeleton was too thin to resolve anything against */
  documentAbstained: boolean;
  note: string | null;
  counts: CrossReferenceCounts;
}

/**
 * Minimum addressable nodes before resolution is trusted at all. Below this
 * the document has no numbering scheme worth checking against, so a miss
 * carries no information — mirrors the lint's `topLevelAnchors.length >= 3`
 * gate, applied at document scope rather than per reference.
 */
const MIN_ADDRESSABLE_NODES = 3;

/**
 * A table of contents is not a structure. When a document's contents page is
 * the only place its numbering is visible to the compiler, every reference
 * resolves — to another contents line — and the integrity gate sees a
 * perfectly healthy document. Three of the 69 mini documents look like that,
 * one of them (Acacia Communications: 85 heads, 89 resolved) with no
 * segmentation help at all, so this is a defect in the shipped instrument
 * and not an artifact of recovery.
 *
 * The tell is that the graph has no REACH: every target lands inside a thin
 * prefix. Measured over the corpus the deepest resolved target sits at
 * 0.01-0.02 of the document for the three, and at 0.16 or beyond for every
 * document whose targets are real provisions. Gate at 0.05, in that gap, and
 * only where enough targets exist for the concentration to mean anything.
 */
const MIN_TARGET_REACH = 0.05;
const MIN_TARGETS_FOR_REACH = 3;

const ADDRESSABLE: ReadonlySet<SkeletonNode["kind"]> = new Set([
  "section",
  "subsection",
  "article",
  "part",
  "division",
  "schedule",
]);

export interface CrossReferenceOptions {
  /**
   * Reuse an already-compiled skeleton instead of compiling again. This is
   * also how a caller holding text from an AUTHORITATIVE source scopes the
   * segmentation recovery out — pass
   * `compileAgreementSkeleton(text, id, { recoverExtraction: false })` and the
   * competition cannot run. The default compile below is the Library
   * extraction lane, where recovering lost line breaks is the point; there is
   * deliberately no second flag for it here.
   */
  skeleton?: AgreementSkeleton;
  /** restrict the provision vocabulary (see findProvisionReferences) */
  words?: readonly string[];
  /**
   * Minimum `counts.integrity` before the graph is trusted at all. 0
   * disables the gate and yields the raw resolver census.
   *
   * The mechanism is docxStructuralLint's "no numbering to check against"
   * note generalized from a binary to a rate: when most references the
   * resolver accepted still miss, what is wrong is our view of the
   * document's numbering, not the document. The default is a CALIBRATION,
   * not a law: per-document integrity on the 17 maud merger agreements is
   * sharply bimodal — 0.24, 0.34, 0.36, 0.38, 0.39, 0.39, 0.39, 0.40 for the
   * eight whose sections the skeleton largely misses, then 0.58, 0.75, 0.81,
   * 0.92, 0.96, 0.97, 0.97, 0.98, 1.00 — and the gate sits in the widest gap
   * (0.40 -> 0.58). Re-derive it if the structural detector changes.
   */
  integrityThreshold?: number;
}

export const DEFAULT_INTEGRITY_GATE = 0.5;

export function crossReferenceGraph(
  text: string,
  id = "",
  options: CrossReferenceOptions = {},
): CrossReferenceGraph {
  const skeleton = options.skeleton ?? compileAgreementSkeleton(text, id);
  const nodes = skeleton.nodes;
  const byLabel = new Map<string, SkeletonNode>();
  for (const node of nodes) if (!byLabel.has(node.label)) byLabel.set(node.label, node);

  const addressable = nodes.filter((node) => ADDRESSABLE.has(node.kind));
  const references = findProvisionReferences(text, { words: options.words });

  const counts: CrossReferenceCounts = {
    detected: references.length,
    resolved: 0,
    external: 0,
    unresolved: 0,
    abstained: 0,
    selfLoops: 0,
    integrity: 1,
  };

  const thinSkeleton = addressable.length < MIN_ADDRESSABLE_NODES;
  const documentAbstained = thinSkeleton;
  const containers = orderedContainers(nodes);
  const numbering = numberingUniverse(skeleton);

  const edges: CrossReferenceEdge[] = references.map((reference) => {
    const sourceNode = containingNode(containers, byLabel, reference.start);
    const base: CrossReferenceEdge = {
      sourceStart: reference.start,
      sourceEnd: reference.end,
      sourceLabel: sourceNode?.label ?? null,
      raw: reference.raw,
      rawLabel: reference.label,
      normalizedLocator: locatorFor(reference, sourceNode),
      targetLabel: null,
      targetStart: null,
      targetEnd: null,
      status: "external",
      selfLoop: false,
    };
    if (reference.external) {
      counts.external += 1;
      return { ...base, reason: "external_instrument" };
    }
    if (documentAbstained) {
      counts.abstained += 1;
      return { ...base, status: "abstained", reason: "document_abstained" };
    }
    if (!base.normalizedLocator) {
      // "clause (ii)" outside any numbered section: nothing to hang it on.
      counts.abstained += 1;
      return { ...base, status: "abstained", reason: "no_containing_section" };
    }
    const resolved = resolve(skeleton, byLabel, base.normalizedLocator);
    if (resolved) {
      counts.resolved += 1;
      const selfLoop = resolved.label === sourceNode?.label;
      if (selfLoop) counts.selfLoops += 1;
      return {
        ...base,
        status: "resolved",
        targetLabel: resolved.label,
        targetStart: resolved.start,
        targetEnd: resolved.end,
        selfLoop,
      };
    }
    // Not found. Three different things look identical here and only one of
    // them is a finding; the disposition rules are checkCrossReferences'
    // discipline, ported onto the skeleton's label space.
    const locator = base.normalizedLocator.toLowerCase();
    // (a) the label EXISTS but was dropped from the index as ambiguous —
    //     the near-universal cause is a table of contents repeating every
    //     heading, so the document says the provision exists twice and we
    //     cannot say which. Refuse; never pick one.
    if ((numbering.keyCounts.get(locator) ?? 0) > 1) {
      counts.abstained += 1;
      return { ...base, status: "abstained", reason: "ambiguous_label" };
    }
    // (b) the document does not number this branch to this depth. A miss
    //     then carries no information about the document, only about the
    //     structural detector. Refuse.
    if (!numbersHere(numbering, locator)) {
      counts.abstained += 1;
      return { ...base, status: "abstained", reason: "depth_not_numbered" };
    }
    // (c) siblings at this depth under this parent ARE numbered and this one
    //     is not: a genuine dangling reference.
    counts.unresolved += 1;
    return { ...base, status: "unresolved", reason: "no_such_provision" };
  });

  const accepted = counts.resolved + counts.unresolved;
  counts.integrity = accepted ? counts.resolved / accepted : 1;

  if (thinSkeleton) {
    return {
      nodes,
      edges,
      documentAbstained: true,
      note: `Cross-reference resolution abstained: the document compiles to ${addressable.length} addressable provision(s), below the ${MIN_ADDRESSABLE_NODES} needed for a numbering scheme to check against.`,
      counts,
    };
  }

  // Reach gate: the targets are real provisions, or they are a contents page.
  const targets = edges
    .filter((edge) => edge.status === "resolved" && edge.targetStart !== null)
    .map((edge) => edge.targetStart!);
  const reach = text.length
    ? Math.max(0, ...targets) / text.length
    : 1;
  // Integrity gate. Most of what the resolver accepted still missed, so what
  // is unreliable is our view of this document's numbering, not the
  // document — restate every internal edge as a refusal rather than ship a
  // graph whose targets are mostly wrong.
  const threshold = options.integrityThreshold ?? DEFAULT_INTEGRITY_GATE;
  const contentsOnly =
    threshold > 0 &&
    targets.length >= MIN_TARGETS_FOR_REACH &&
    reach < MIN_TARGET_REACH;
  if (contentsOnly || (accepted > 0 && counts.integrity < threshold)) {
    const gated = edges.map((edge) =>
      edge.status === "external"
        ? edge
        : {
            ...edge,
            status: "abstained" as const,
            reason: "document_abstained" as const,
            targetLabel: null,
            targetStart: null,
            targetEnd: null,
            selfLoop: false,
          },
    );
    return {
      nodes,
      edges: gated,
      documentAbstained: true,
      note: contentsOnly
        ? `Cross-reference resolution abstained: every one of ${targets.length} resolved ` +
          `targets lands in the first ${(reach * 100).toFixed(0)}% of the document, so the ` +
          `only numbering the compiler can see is a table of contents, not the provisions.`
        : `Cross-reference resolution abstained: only ${counts.resolved} of ${accepted} ` +
          `resolvable references (${(counts.integrity * 100).toFixed(0)}%) landed on a ` +
          `compiled provision, below the ${(threshold * 100).toFixed(0)}% needed to trust ` +
          `this document's numbering scheme.`,
      counts: {
        ...counts,
        resolved: 0,
        unresolved: 0,
        selfLoops: 0,
        abstained: counts.abstained + accepted,
      },
    };
  }

  return { nodes, edges, documentAbstained: false, note: null, counts };
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * The locator a reference points at. Sub-only labels ("paragraph (b)") are
 * meaningless standalone and are read relative to the section they sit in,
 * which is what the drafting means: inside Section 8.01, "paragraph (b)" is
 * 8.01(b).
 */
function locatorFor(
  reference: ProvisionReference,
  sourceNode: SkeletonNode | null,
): string {
  if (reference.locator) return reference.locator;
  if (reference.shape === "roman") return reference.aliasKey;
  if (reference.shape === "sub-only" && sourceNode) {
    const head = sectionHead(sourceNode.label);
    if (head) return joinLocator(head, reference.label);
  }
  return "";
}

/** "sec8.01(a)(ii)" -> "8.01" */
function sectionHead(label: string): string {
  const match = label.match(/^sec([^(@]+)/u);
  return match ? match[1] : "";
}

interface ResolvedTarget {
  label: string;
  start: number;
  end: number;
}

function resolve(
  skeleton: AgreementSkeleton,
  byLabel: Map<string, SkeletonNode>,
  locator: string,
): ResolvedTarget | null {
  if (!locator) return null;
  // 1. exact label or alias, through the SourceDoc index (which has already
  //    dropped ambiguous keys, so a hit is unique by construction).
  const position = skeleton.doc.index.get(locator.toLowerCase());
  if (position !== undefined) {
    const block = skeleton.doc.blocks[position];
    return { label: block.label, start: block.start, end: block.end };
  }
  // 2. anchored descendants: a reference to "8" is satisfied by "8.01",
  //    "8.02" even when "8" itself never heads a line. The target span is
  //    the union of the descendants, which is what the reference denotes.
  const prefix = `${locator.toLowerCase()}.`;
  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  let firstLabel: string | null = null;
  for (const [label, node] of byLabel) {
    if (!label.toLowerCase().startsWith(prefix)) continue;
    if (node.start < start) {
      start = node.start;
      firstLabel = label;
    }
    if (node.end > end) end = node.end;
  }
  if (firstLabel !== null) return { label: firstLabel, start, end };
  return null;
}

/** Depth of a locator: "sec8" -> 1, "sec8.01" -> 2, "sec8.01(a)" -> 3. */
function labelDepth(locator: string): number {
  if (!locator.startsWith("sec")) return 1;
  const body = locator.slice(3).replace(/@\d+$/u, "");
  const [numeric, ...subs] = body.split(/(?=\()/u);
  return numeric.split(".").length + subs.length;
}

/** Parent locator: "sec8.01(a)" -> "sec8.01", "sec8.01" -> "sec8", "sec8" -> "". */
function labelParent(locator: string): string {
  if (!locator.startsWith("sec")) return "";
  const body = locator.slice(3).replace(/@\d+$/u, "");
  if (body.endsWith(")")) return `sec${body.replace(/\([^()]*\)$/u, "")}`;
  const at = body.lastIndexOf(".");
  return at < 0 ? "" : `sec${body.slice(0, at)}`;
}

interface NumberingUniverse {
  /** how many index keys each label/alias claims (>1 == ambiguous) */
  keyCounts: Map<string, number>;
  /** "<parent>:<depth>" for every anchored child, mirroring the lint */
  childDepths: Set<string>;
  /** dotless numeric section anchors ("sec7"), the lint's topLevelAnchors */
  topLevelNumeric: number;
  /** ARTICLE/PART/DIVISION nodes, the family roman references live in */
  containers: number;
}

const TOP_LEVEL_NUMERIC = /^sec\d{1,3}[a-z]?$/iu;

/**
 * Does the document number the FAMILY this reference belongs to? Only if it
 * does can a miss mean "no such provision" rather than "our structural
 * detector did not reach here". Families are shape-specific because the
 * numbering schemes are: a merger agreement anchors sec4.2 and art6 but
 * never a bare "sec16", so its 1,357 bare-integer references (Exchange Act
 * Section 16, IRC Section 367, DGCL Section 262 — external references with
 * no instrument on either flank) must abstain rather than be reported as
 * dangling. This is the general rule; nothing here knows what "16" means.
 */
function numbersHere(numbering: NumberingUniverse, locator: string): boolean {
  const parent = labelParent(locator);
  if (parent) return numbering.childDepths.has(`${parent}:${labelDepth(locator)}`);
  if (!locator.startsWith("sec")) return numbering.containers >= MIN_ADDRESSABLE_NODES;
  if (TOP_LEVEL_NUMERIC.test(locator))
    return numbering.topLevelNumeric >= MIN_ADDRESSABLE_NODES;
  return false;
}

/**
 * What the document's numbering scheme actually covers. `keyCounts` is
 * built from the SourceDoc blocks rather than the raw nodes because that is
 * the space `createSourceDoc` de-duplicated: a key it counted twice is a
 * key it deliberately dropped, and that drop is the ambiguity signal.
 */
function numberingUniverse(skeleton: AgreementSkeleton): NumberingUniverse {
  const keyCounts = new Map<string, number>();
  for (const block of skeleton.doc.blocks) {
    for (const key of [block.label, ...(block.aliases ?? [])]) {
      const lower = key.toLowerCase();
      keyCounts.set(lower, (keyCounts.get(lower) ?? 0) + 1);
    }
  }
  const childDepths = new Set<string>();
  let topLevelNumeric = 0;
  let containers = 0;
  for (const node of skeleton.nodes) {
    const label = node.label.toLowerCase();
    const parent = labelParent(label);
    if (parent) childDepths.add(`${parent}:${labelDepth(label)}`);
    else if (TOP_LEVEL_NUMERIC.test(label)) topLevelNumeric += 1;
    if (node.kind === "article" || node.kind === "part" || node.kind === "division")
      containers += 1;
  }
  return { keyCounts, childDepths, topLevelNumeric, containers };
}

/* ------------------------------------------------------------------ */
/* Which node a reference sits in                                      */
/* ------------------------------------------------------------------ */

/** Nodes sorted by start; ties broken deepest-last (document order). */
function orderedContainers(nodes: SkeletonNode[]): SkeletonNode[] {
  return [...nodes].sort((a, b) => a.start - b.start || a.depth - b.depth);
}

/**
 * Deepest node containing `position`. Skeleton spans nest, so the last node
 * that starts at or before the position is the deepest candidate; when the
 * position falls past that node's end, walk up its parent chain.
 */
function containingNode(
  ordered: SkeletonNode[],
  byLabel: Map<string, SkeletonNode>,
  position: number,
): SkeletonNode | null {
  let low = 0;
  let high = ordered.length - 1;
  let at = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (ordered[mid].start <= position) {
      at = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  let node = at >= 0 ? ordered[at] : null;
  while (node && position >= node.end) {
    node = node.parentLabel ? (byLabel.get(node.parentLabel) ?? null) : null;
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Weaker edge classes — separate on purpose                           */
/* ------------------------------------------------------------------ */

export interface WeakEdge {
  sourceLabel: string;
  sourceStart: number;
  sourceEnd: number;
  targetLabel: string;
  targetStart: number;
  targetEnd: number;
  /** what the edge is evidenced by */
  evidence: string;
}

/** Curly quotes are the contract norm; the shared collector reads straight ones. */
function straightenQuotes(value: string): string {
  return value.replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'");
}

/**
 * Defined-term edges: a term defined in exactly one place, used elsewhere.
 * The edge runs from the USE to the DEFINITION, which is the direction a
 * reader (or composer) needs — the clause is in hand, the definition is not.
 *
 * Terms defined more than once are dropped, not ranked: an ambiguous
 * definition site is a refusal, not a coin flip.
 */
export function definedTermEdges(
  text: string,
  skeleton: AgreementSkeleton,
  options: { maxPerTerm?: number } = {},
): WeakEdge[] {
  const maxPerTerm = options.maxPerTerm ?? 64;
  const lines: Array<{ text: string; start: number }> = [];
  let at = 0;
  for (const raw of text.split("\n")) {
    lines.push({ text: straightenQuotes(raw.replace(/\r$/u, "")), start: at });
    at += raw.length + 1;
  }
  const terms = collectDefinedTerms(lines.map((line) => line.text));
  const ordered = orderedContainers(skeleton.nodes);
  const byLabel = new Map<string, SkeletonNode>();
  for (const node of skeleton.nodes)
    if (!byLabel.has(node.label)) byLabel.set(node.label, node);

  const edges: WeakEdge[] = [];
  for (const [term, definedIn] of terms) {
    if (definedIn.length !== 1) continue;
    const definitionOffset = lines[definedIn[0]].start;
    const target = containingNode(ordered, byLabel, definitionOffset);
    if (!target) continue;
    const pattern = new RegExp(
      `(?<![A-Za-z0-9])"?${term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"?(?![a-z0-9])`,
      "gu",
    );
    const seen = new Set<string>();
    for (const match of straightenQuotes(text).matchAll(pattern)) {
      const offset = match.index ?? 0;
      if (offset >= target.start && offset < target.end) continue;
      const source = containingNode(ordered, byLabel, offset);
      if (!source || source.label === target.label) continue;
      if (seen.has(source.label)) continue;
      seen.add(source.label);
      edges.push({
        sourceLabel: source.label,
        sourceStart: source.start,
        sourceEnd: source.end,
        targetLabel: target.label,
        targetStart: target.start,
        targetEnd: target.end,
        evidence: `defined term "${term}"`,
      });
      if (seen.size >= maxPerTerm) break;
    }
  }
  return edges;
}

/**
 * Lexical edges: sections sharing rare tokens. The weakest class, and the
 * one most likely to be redundant with the retriever's own bm25 — kept
 * separable precisely so that redundancy can be measured rather than
 * assumed. No embeddings.
 */
export function lexicalOverlapEdges(
  text: string,
  skeleton: AgreementSkeleton,
  options: { maxSectionsPerToken?: number; minShared?: number; topK?: number } = {},
): WeakEdge[] {
  const maxSectionsPerToken = options.maxSectionsPerToken ?? 3;
  const minShared = options.minShared ?? 2;
  const topK = options.topK ?? 4;
  const sections = skeleton.nodes.filter(
    (node) => node.kind === "section" || node.kind === "subsection",
  );
  if (sections.length < 2) return [];

  const tokensOf = (node: SkeletonNode) =>
    new Set(
      text
        .slice(node.start, node.end)
        .toLowerCase()
        .match(/[a-z][a-z-]{5,}/gu) ?? [],
    );
  const perSection = sections.map(tokensOf);
  const sectionsPerToken = new Map<string, number[]>();
  perSection.forEach((tokens, index) => {
    for (const token of tokens) {
      const bucket = sectionsPerToken.get(token);
      if (bucket) bucket.push(index);
      else sectionsPerToken.set(token, [index]);
    }
  });

  const shared = new Map<string, { a: number; b: number; tokens: string[] }>();
  for (const [token, indexes] of sectionsPerToken) {
    if (indexes.length < 2 || indexes.length > maxSectionsPerToken) continue;
    for (let i = 0; i < indexes.length; i += 1)
      for (let j = i + 1; j < indexes.length; j += 1) {
        const key = `${indexes[i]}:${indexes[j]}`;
        const entry = shared.get(key);
        if (entry) entry.tokens.push(token);
        else shared.set(key, { a: indexes[i], b: indexes[j], tokens: [token] });
      }
  }

  const bySource = new Map<number, Array<{ other: number; tokens: string[] }>>();
  for (const { a, b, tokens } of shared.values()) {
    if (tokens.length < minShared) continue;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const bucket = bySource.get(from) ?? [];
      if (!bucket.length) bySource.set(from, bucket);
      bucket.push({ other: to, tokens });
    }
  }

  const edges: WeakEdge[] = [];
  for (const [from, bucket] of bySource) {
    bucket.sort((left, right) => right.tokens.length - left.tokens.length);
    for (const { other, tokens } of bucket.slice(0, topK)) {
      edges.push({
        sourceLabel: sections[from].label,
        sourceStart: sections[from].start,
        sourceEnd: sections[from].end,
        targetLabel: sections[other].label,
        targetStart: sections[other].start,
        targetEnd: sections[other].end,
        evidence: `${tokens.length} rare tokens: ${tokens.slice(0, 4).join(", ")}`,
      });
    }
  }
  return edges;
}
