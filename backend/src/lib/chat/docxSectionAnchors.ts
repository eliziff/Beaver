/** Anchor DOCX-derived section nodes onto the Markdown served to search tools. */
import { extractDocxBodyStructure } from "../docxTrackedChanges";
import {
  compileAgreementSkeleton,
  type SkeletonNode,
} from "../legalTextSkeleton";

/** Node kinds that form the derived section spine (never table/row/cell). */
const INDEX_KINDS = new Set<string>([
  "article",
  "part",
  "division",
  "section",
  "subsection",
  "schedule",
]);

/**
 * Strip pandoc/markdown decoration/**
 * Strip pandoc/markdown decoration from the start of a line so we can test
 * whether a display is the line's first real token. Handles `**`, `<u>` inline
 * tags, pandoc-escaped parens, heading/list markers, blockquote/table pipes.
 */
function stripLineDecor(line: string): string {
  let s = line;
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s
      .replace(/^\s+/, "")
      .replace(/^[*_#>`+~|=-]+/, "")
      .replace(/^\\[()]/, "")
      .replace(/^<[^>]*>/, "")
      .trimStart();
    if (s === before) break;
  }
  return s;
}

/** Heading-like continuation after a display: EOL, an em-dash heading
 *  separator, or a closing bold/inline wrap — never `(x)` or space-then-prose
 *  (a body sentence that merely opens with the section number, e.g. "Section
 *  2.01(a) provides that...", must NOT anchor the parent). */
function isHeadingishContinuation(rest: string): boolean {
  const trimmed = rest.trimStart();
  if (!trimmed) return true; // EOL
  if (trimmed.startsWith("— ")) return true; // " — " heading separator
  if (/^-{2,3}\s/u.test(trimmed)) return true; // pandoc renders " — " as " --- "
  // closing bold/inline-wrap before the rest of the heading line
  if (/^(\*\*|<\/?u>)/.test(trimmed)) return true;
  return false;
}

/** Digit-led numeral variant of a display ("Section 1.1" -> "1.1"). Documents
 *  that number sections bare (`**1.1** "Affiliate" means...`) never carry the
 *  synthesized kind word, so the full display can never anchor them — the
 *  no-fit sweep measured whole contract corpora at 0% addressable this way.
 *  Digit-led only: stripping ARTICLE/Schedule kinds would leave single
 *  romans/letters that prefix-match prose. */
function displayNumeralVariant(display: string): string | null {
  const m = /^[A-Za-z]+\s+(\d\S*)$/u.exec(display.trim());
  return m ? m[1] : null;
}

/** Confirms a numeral-variant line is the real heading by its title text:
 *  the skeleton knows the section's heading, so `1.1 Introduction and Scope`
 *  anchors while a prose line that merely opens with the number does not.
 *  Compared on an alphanumeric-normalized plane so bold wraps and smart
 *  quotes in the markdown never break the match. */
function headingConfirms(rest: string, heading: string | undefined): boolean {
  const norm = (value: string) =>
    value
      .replace(/[^0-9A-Za-z]+/gu, " ")
      .trim()
      .toLowerCase();
  const frag = norm(heading ?? "").slice(0, 16);
  if (frag.length < 4) return false;
  return norm(rest).startsWith(frag);
}

/** Offset of the first line at or after `from` whose real first token is
 *  `display` and whose continuation is heading-like (` — `, EOL, or a closing
 *  bold wrap), else null. A body cross-reference that merely starts a line with
 *  the number — "Section 2.01(a) provides..." or "Section 2.01 provides..." —
 *  is rejected because the next char is `(`/space-then-prose, not a heading. */
function anchorDisplayLineStart(
  markdown: string,
  display: string,
  from = 0,
  heading?: string,
): { at: number; matched: number } | null {
  const variant = displayNumeralVariant(display);
  let pos = Math.max(0, from);
  while (pos <= markdown.length) {
    const nl = markdown.indexOf("\n", pos);
    const end = nl === -1 ? markdown.length : nl;
    const body = stripLineDecor(markdown.slice(pos, end));
    if (body.startsWith(display)) {
      const rest = body.slice(display.length);
      if (isHeadingishContinuation(rest))
        return { at: pos, matched: display.length };
    } else if (variant && body.startsWith(variant)) {
      const rest = body.slice(variant.length);
      // Token boundary: "1.1" must never claim "1.10" or "1.1.2"; then the
      // line must either continue heading-like or carry the known title.
      if (
        !/^[\w.]/u.test(rest) &&
        (isHeadingishContinuation(rest) || headingConfirms(rest, heading))
      ) {
        return { at: pos, matched: variant.length };
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return null;
}

/** True when `pos` sits at the start of a line whose first real token (after a
 *  short decoration run: whitespace, `**`, `\`, `(`, `*`, list markers) is the
 *  `(x)`-style enum token — i.e. the token OPENS a heading, not an incidental
 *  body cross-reference like "...10.01(b) and Section 10.01(c) below...". */
function isEnumAtLineStart(
  markdown: string,
  pos: number,
  token: string,
): boolean {
  const lineStart = markdown.lastIndexOf("\n", pos) + 1;
  const prefix = markdown.slice(lineStart, pos);
  // No prose or section number may precede the token — only a short run of
  // markdown decoration.
  const decorRun = prefix.replace(/\s+/g, "");
  if (decorRun.length > 4) return false;
  if (!/^[\s\\*(<>{}\[\]_#`|+\-.~=]*$/.test(prefix)) return false;
  const rest = markdown.slice(pos);
  const m = /^(?:\\?\(([^()\\]*)(?:\\?\)))/.exec(rest);
  return m ? m[1] === token : false;
}

/** First index at or after `from` where `needle` begins a line (after a short
 *  markdown decoration run is stripped), else -1. A body cross-reference that
 *  merely contains the needle mid-line never qualifies. */
function indexOfLineStart(
  markdown: string,
  needle: string,
  from: number,
): number {
  let pos = Math.max(0, from);
  while (pos <= markdown.length) {
    const nl = markdown.indexOf("\n", pos);
    const lineEnd = nl === -1 ? markdown.length : nl;
    if (stripLineDecor(markdown.slice(pos, lineEnd)).startsWith(needle)) {
      return pos;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return -1;
}

/** The trailing enum token of a composed subsection display, e.g. "a" from
 *  "Section 2.01(a)". Null for top-level nodes. */
function subsectionToken(display: string): string | null {
  const m = display.match(/\(([^()]+)\)\s*$/);
  return m ? m[1] : null;
}

/**
 * Anchor a subsection relative to its parent: find the `(a)`-style enum token
 * at or after `from` (pandoc renders it `\(a\)` or `**(a)**`), but ONLY when
 * the token opens its line — an unescaped `(x)` anywhere in the body (a
 * cross-reference like "...(b) and Section 10.01(c) below...") must never win
 * over the real heading. Falls back to the leading fragment of the sub-heading
 * title, also line-anchored. Returns the anchor offset and the position to
 * start the next sibling's search.
 */
function anchorSubsection(
  markdown: string,
  node: SkeletonNode,
  from: number,
): { at: number; next: number } | null {
  const token = subsectionToken(node.display);
  if (token) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // pandoc escapes both parens: `\(a\)`; list items may render bold: `**(a)**`.
    const re = new RegExp(`\\\\?\\(${escaped}\\\\?\\)`, "g");
    re.lastIndex = from;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(markdown))) {
      if (isEnumAtLineStart(markdown, hit.index, token)) {
        return { at: hit.index, next: hit.index + hit[0].length };
      }
    }
  }
  // Fallback: the skeleton holds heading = title + body text; use the leading
  // fragment up to the first sentence boundary, anchored at a line start so a
  // body cross-reference never wins over the real heading.
  const title = node.heading?.trim() ?? "";
  const boundary = title.search(/\.\s|\.$/);
  const frag = boundary >= 0 ? title.slice(0, boundary + 1) : title.slice(0, 32);
  if (frag.length >= 4) {
    const idx = indexOfLineStart(markdown, frag, from);
    if (idx >= 0) return { at: idx, next: idx + frag.length };
  }
  return null;
}

/** Map label -> body offset for every anchorable spine node. Top-level nodes
 *  anchor by line-start display; subsections anchor relative to their parent's
 *  anchor, siblings in document order, recursing through nested parents. */
function anchorSpine(
  markdown: string,
  spine: SkeletonNode[],
): Map<string, number> {
  const anchors = new Map<string, number>();
  // Two spine nodes with the same display (amended/restated docs) must anchor
  // at DIFFERENT line starts: advance a per-display cursor so the second
  // occurrence resolves to the second match, not the first.
  const displayCursor = new Map<string, number>();
  for (const node of spine) {
    if (node.kind === "subsection") continue;
    const from = displayCursor.get(node.display) ?? 0;
    const hit = anchorDisplayLineStart(
      markdown,
      node.display,
      from,
      node.heading ?? undefined,
    );
    if (hit !== null) {
      anchors.set(node.label, hit.at);
      displayCursor.set(node.display, hit.at + hit.matched);
    }
  }
  let pending = spine.filter((node) => node.kind === "subsection");
  for (let pass = 0; pending.length && pass < 8; pass++) {
    const next: SkeletonNode[] = [];
    const byParent = new Map<string, SkeletonNode[]>();
    for (const node of pending) {
      const key = node.parentLabel ?? "";
      if (key && anchors.has(key)) {
        const list = byParent.get(key);
        if (list) list.push(node);
        else byParent.set(key, [node]);
      } else {
        next.push(node);
      }
    }
    for (const [parentLabel, subs] of byParent) {
      subs.sort((a, b) => a.start - b.start);
      let from = anchors.get(parentLabel)!;
      for (const sub of subs) {
        const hit = anchorSubsection(markdown, sub, from);
        if (hit) {
          anchors.set(sub.label, hit.at);
          from = hit.next;
        } else {
          next.push(sub);
        }
      }
    }
    pending = next;
  }
  return anchors;
}

/**
 * Section-level anchored starts/**
 * Section-level anchored starts on a served plane, ascending by offset.
 * Consumer for grep section-context annotation (MIKE_GREP_SECTION_CONTEXT):
 * the enclosing-section lead for a hit offset is the last start at or below
 * it. Subsections are excluded on purpose — a hit's own subsection line is
 * usually the hit's neighborhood already; the section lead is the
 * orientation a coding model cannot see from ±N context lines. Probe
 * 2026-08-06 (zenith supply agreement): skeleton-on-markdown finds 0 nodes,
 * so this MUST stay on the two-plane path (nodes from the docx detectors,
 * anchored into the served markdown) — the oracle-swept design.
 */
export type AnchoredSection = {
  display: string;
  heading: string | null;
  offset: number;
};

/** Section-level anchors with their display/heading text, ascending. */
export function anchoredSectionSpine(
  nodes: SkeletonNode[],
  markdown: string,
): AnchoredSection[] {
  const spine = nodes.filter(
    (node) => INDEX_KINDS.has(node.kind) && node.kind !== "subsection",
  );
  if (!spine.length) return [];
  const anchors = anchorSpine(markdown, spine);
  const out: AnchoredSection[] = [];
  for (const node of spine) {
    const at = anchors.get(node.label);
    if (at !== undefined)
      out.push({
        display: node.display,
        heading: node.heading ?? null,
        offset: at,
      });
  }
  out.sort((a, b) => a.offset - b.offset);
  return out;
}

export function anchoredSectionStarts(
  nodes: SkeletonNode[],
  markdown: string,
): number[] {
  return anchoredSectionSpine(nodes, markdown).map((entry) => entry.offset);
}

/**
 * Consumes the existing .docx detectors/**
 * Consumes the existing .docx detectors to get the derived section tree.
 * Reads the same bytes the drafting-source read uses.
 */
export async function deriveSectionNodes(
  bytes: Buffer,
): Promise<SkeletonNode[]> {
  const body = await extractDocxBodyStructure(bytes);
  if (!body.text) return [];
  return compileAgreementSkeleton(body.text, "drafting", {}).nodes;
}
