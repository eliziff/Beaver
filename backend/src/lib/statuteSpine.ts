/**
 * Statute section-spine detection, ported from the corpus-proven grammar in
 * ALR-Quote-Verifier's verifier_core/a2aj_structure.py (section_structure).
 * Measured there across the full A2AJ laws corpus; measured here by
 * scripts/skeleton-oracle-probe.py + skeleton-oracle-diff.ts.
 *
 * The design insight being ported: statute heads are bare numbers at line
 * start ("164 (1) Every one commits..."), which no per-line guard can safely
 * accept — a year, a dollar figure, a page number all look identical. Safety
 * comes from a document-level competition instead: marks join strictly
 * increasing same-arity scopes, and only a scope with enough members
 * covering enough of the document becomes the spine. One addition beyond
 * the oracle: dot-terminated heads ("2. (1) A person who...", the NT/PE
 * drafting style the oracle misses) compete as their own style, so both
 * corpus families resolve.
 */

export type SpineStyle = "integer" | "dot" | "dotterm";

export interface SpineMark {
  /** section label, e.g. "164" or "672.53" */
  label: string;
  /** absolute offset of the first digit */
  start: number;
  /** absolute offset of the text after the mark and its trailing space */
  contentStart: number;
  style: SpineStyle;
}

/**
 * Bare-number head: digits (optionally dotted, up to four components)
 * followed by content on the same line — "7 (1) This Act", "5.2 Nothing",
 * "2 Le présent". Mirrors the oracle's SECTION_MARK_RE (hyphenated rule
 * numbers excluded: the skeleton has no instrument name to gate them on).
 */
const BARE_MARK_RE =
  /^([ \t]*)(\d{1,8}(?:\.\d{1,8}){0,3})(?=[ \t]+(?:\(?\d|[A-Za-zÀ-ÿ])|[ \t]*\()/gmu;

/**
 * Dot-terminated head: "2. (1) A person", "12. In this Act". The oracle's
 * label regex cannot end at a bare dot, so this style is collected
 * separately and competes as its own hypothesis.
 */
const DOTTERM_MARK_RE = /^([ \t]*)(\d{1,8})[.)](?=[ \t]+\S)/gmu;

/** Heading-like continuation, as in legalTextSkeleton's line guards. */
const DOTTERM_CONTENT_RE = /^["'“«(A-Za-zÀ-ÿ0-9]/u;

const key = (label: string): number[] =>
  label.split(".").map((part) => Number(part));

const sameArity = (a: number[], b: number[]) => a.length === b.length;

const greater = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
};

function collectMarks(text: string): SpineMark[] {
  const marks: SpineMark[] = [];
  for (const match of text.matchAll(BARE_MARK_RE)) {
    const start = (match.index ?? 0) + match[1].length;
    const label = match[2];
    const contentStart =
      start + label.length + lengthOfSpaces(text, start + label.length);
    marks.push({
      label,
      start,
      contentStart,
      style: label.includes(".") ? "dot" : "integer",
    });
  }
  for (const match of text.matchAll(DOTTERM_MARK_RE)) {
    const start = (match.index ?? 0) + match[1].length;
    const label = match[2];
    const afterMark = start + label.length + 1;
    const contentStart = afterMark + lengthOfSpaces(text, afterMark);
    const lineEnd = text.indexOf("\n", contentStart);
    const rest = text
      .slice(contentStart, lineEnd < 0 ? undefined : lineEnd)
      .replace(/\r$/u, "");
    if (!DOTTERM_CONTENT_RE.test(rest)) continue;
    marks.push({ label, start, contentStart, style: "dotterm" });
  }
  return marks.sort((a, b) => a.start - b.start);
}

function lengthOfSpaces(text: string, at: number): number {
  let length = 0;
  while (text[at + length] === " " || text[at + length] === "\t") length += 1;
  return length;
}

/**
 * The oracle's scope competition: each mark joins the strictly increasing
 * same-arity scope with the greatest last key, or opens a new scope; at
 * most eight scopes live at once (smallest evicted); scopes with fewer
 * than three members are noise.
 */
function scopesFor(
  marks: SpineMark[],
  styles: ReadonlySet<SpineStyle>,
): SpineMark[][] {
  const scopes: SpineMark[][] = [];
  for (const mark of marks) {
    if (!styles.has(mark.style)) continue;
    const value = key(mark.label);
    let best = -1;
    let bestKey: number[] | null = null;
    for (let i = 0; i < scopes.length; i += 1) {
      const last = key(scopes[i][scopes[i].length - 1].label);
      if (!sameArity(value, last) || !greater(value, last)) continue;
      if (bestKey === null || greater(last, bestKey)) {
        best = i;
        bestKey = last;
      }
    }
    if (best >= 0) scopes[best].push(mark);
    else scopes.push([mark]);
    if (scopes.length > 8) {
      let smallest = 0;
      for (let i = 1; i < scopes.length; i += 1) {
        if (scopes[i].length < scopes[smallest].length) smallest = i;
      }
      scopes.splice(smallest, 1);
    }
  }
  return scopes.filter((scope) => scope.length >= 3);
}

/**
 * Return the winning section spine for statute-style text, or [] when no
 * hypothesis clears the oracle's guards (>= 3 members, spine spans >= 10%
 * of the text, first section starts in the first 70%).
 */
export function computeStatuteSpine(text: string): SpineMark[] {
  if (!text) return [];
  const marks = collectMarks(text);
  if (marks.length < 3) return [];

  // Bare-style marks take precedence over dot-terminated ones rather than
  // competing on length: Ontario-drafting paragraph lists ("1. The person
  // is registered...") are dot-terminated and nested INSIDE bare-number
  // sections, so a longer dotterm chain is usually a paragraph list, not
  // the spine. Dot-terminated sections are the spine only where bare marks
  // do not exist at all (the NT/PE drafting style).
  return (
    winner(scopesFor(marks, new Set<SpineStyle>(["integer", "dot"])), marks, text) ??
    winner(scopesFor(marks, new Set<SpineStyle>(["dotterm"])), marks, text) ??
    []
  );
}

function winner(
  hypotheses: SpineMark[][],
  marks: SpineMark[],
  text: string,
): SpineMark[] | null {
  if (!hypotheses.length) return null;
  let best = hypotheses[0];
  for (const hypothesis of hypotheses) {
    if (hypothesis.length > best.length) best = hypothesis;
  }

  // An integer spine legitimately contains dotted top-level provisions
  // (Criminal Code ss. 672.53, 672.54): pull unambiguous dotted descendants
  // into their parent interval; duplicated descendant labels stay out.
  if (key(best[0].label).length === 1 && best[0].style !== "dotterm") {
    const expanded: SpineMark[] = [];
    for (let i = 0; i < best.length; i += 1) {
      const parent = best[i];
      const end = i + 1 < best.length ? best[i + 1].start : text.length;
      const parentNumber = key(parent.label)[0];
      const descendants = marks.filter(
        (mark) =>
          mark.style === "dot" &&
          mark.start > parent.start &&
          mark.start < end &&
          key(mark.label)[0] === parentNumber,
      );
      const counts = new Map<string, number>();
      for (const mark of descendants) {
        counts.set(mark.label, (counts.get(mark.label) ?? 0) + 1);
      }
      expanded.push(parent);
      expanded.push(
        ...descendants.filter((mark) => counts.get(mark.label) === 1),
      );
    }
    best = expanded;
  }

  const span = (text.length - best[0].start) / text.length;
  const startRatio = best[0].start / text.length;
  return span >= 0.1 && startRatio <= 0.7 ? best : null;
}
