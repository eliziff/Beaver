import { collectDefinedTerms } from "../../src/lib/docxStructuralLint";
import type { AgreementSkeleton, SkeletonNode } from "../../src/lib/legalTextSkeleton";

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
