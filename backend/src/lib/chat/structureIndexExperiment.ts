/**
 * SILO'D LAB EXPERIMENT — derived-section-index arm (`mike_markdown_e2e_index_v1`).
 *
 * Derives the section tree of a .docx at ingest using the EXISTING detectors —
 * `extractDocxBodyStructure` for the plaintext paragraph-stream, then
 * `compileAgreementSkeleton` — and prepends a compact SECT-INDEX to the served
 * markdown so the model can orient and read selectively instead of whole-reading.
 *
 * The index is an ADDRESS table, not just a naming table: every spine line
 * carries the char offset (`@N`) of its section in the served markdown BODY
 * (offset 0 = the first body line below the index). The model orients with
 * `head`, then window-reads exactly the sections it needs via
 * `read_document offset=<@N> max_chars=<window>` — one hop, no guessing, and
 * `find_in_document` matches land on the same body-relative plane.
 *
 * Consumers only: no detector is modified. The whole experiment is gated on
 * `MIKE_STRUCTURE_INDEX === "1"`. To remove it: delete this file, delete the
 * `STRUCTURE_INDEX_ENABLED` branch in the docx read path in
 * `localAssistantTools.ts`, delete `MARKDOWN_E2E_INDEX_*` from
 * `upstreamMikeBenchmarkSurface.ts`, and delete the `mike_markdown_e2e_index_v1`
 * arm entry from `lab-beaver-arm.ts`.
 *
 * Rationale (measured): the markdown already states top-level section numbers
 * in its headings, and pandoc does not flatten subsections — `(a)` items are
 * the literal docx text. What the markdown never states is the COMPOSED
 * subsection identity ("Section 2.01(a)"), which the skeleton derives from the
 * parent section plus the `(a)` token. The index carries that identity once,
 * compactly, so inline markers would only duplicate the heading text.
 *
 * Anchor measurement (covenants credit-agreement.docx, 2026-08-04): top-level
 * spine anchors at 135/136 via the display as a line's first real token (the
 * one miss is a form-bloc clause with a literal placeholder); subsections
 * anchor at ~100% via the parent-relative `(a)`-token search. Naive
 * `indexOf(heading)` is NOT used: a body cross-reference ("Term Loan
 * Commitments" inside a definition) would win over the real heading, and the
 * composed display "Section 2.01(a)" never appears in the markdown.
 */
import { extractDocxBodyStructure } from "../docxTrackedChanges";
import {
  compileAgreementSkeleton,
  type SkeletonNode,
} from "../legalTextSkeleton";

export const STRUCTURE_INDEX_ENABLED =
  process.env.MIKE_STRUCTURE_INDEX === "1";

/** Node kinds that form the derived section spine (never table/row/cell). */
const INDEX_KINDS = new Set<string>([
  "article",
  "part",
  "division",
  "section",
  "subsection",
  "schedule",
]);

const MAX_HEADING_CHARS = 64;
const COMPACT_HEADING_CHARS = 40;

function headingTail(node: SkeletonNode, compact = false): string {
  const heading = node.heading?.trim() ?? "";
  if (!heading) return "";
  // Compact mode also stops at the first sentence/clause boundary: index
  // entries are labels, and a truncated substantive sentence reads as a
  // quotable summary the model may trust without reading the section.
  const boundary = compact ? heading.search(/[.;:]\s/u) : -1;
  const cut = compact
    ? Math.min(
        heading.length,
        COMPACT_HEADING_CHARS,
        boundary >= 0 ? boundary + 1 : Number.POSITIVE_INFINITY,
      )
    : heading.length <= MAX_HEADING_CHARS
      ? heading.length
      : MAX_HEADING_CHARS;
  const shown =
    cut >= heading.length ? heading : `${heading.slice(0, cut).trimEnd()}…`;
  return ` — ${shown}`;
}

/**
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
 * The compact section spine: one line per derived node,
 * `display — heading  @offset` (e.g. `Section 2.01(a) — Subject to the terms
 * and conditions set forth her…  @39811`). When `markdown` is supplied the
 * offset is a body-relative char address in the served markdown; without it
 * the plain naming table is rendered (tests).
 */
export function renderStructureIndex(
  nodes: SkeletonNode[],
  markdown?: string,
  opts?: { compactHeadings?: boolean },
): string {
  const spine = nodes.filter((node) => INDEX_KINDS.has(node.kind));
  if (!spine.length) return "";
  const anchors = markdown ? anchorSpine(markdown, spine) : null;
  const lines = spine.map((node) => {
    const at = anchors?.get(node.label);
    return `  ${node.display}${headingTail(node, opts?.compactHeadings === true)}${
      at !== undefined ? `  @${at}` : ""
    }`;
  });
  return [
    `SECT-INDEX (derived from the document's own numbering; ${spine.length} numbered sections/parts; @N = offset into the body below this index — read only what the deliverable requires)`,
    ...lines,
  ].join("\n");
}

/**
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
export function anchoredSectionStarts(
  nodes: SkeletonNode[],
  markdown: string,
): number[] {
  const spine = nodes.filter(
    (node) => INDEX_KINDS.has(node.kind) && node.kind !== "subsection",
  );
  if (!spine.length) return [];
  const anchors = anchorSpine(markdown, spine);
  const starts = [...anchors.values()];
  starts.sort((a, b) => a - b);
  return starts;
}

/**
 * Scoped-only reads are enforced only when the index actually carries body
 * addresses the model can use. Real corpora produce many spines with headings
 * but few or no @N anchors (HSR: 4 of 5 docs at 0%, the EMP redline at 7%);
 * forcing scoped reads there is a designed-in under-read with no way to
 * address the body. Both thresholds must hold: an absolute floor so a
 * three-line spine never gates, and a fraction floor so a 113-line index with
 * 8 anchors (7% addressable) leaves the document whole-readable.
 */
export const INDEX_MIN_ANCHORED_LINES = 5;
export const INDEX_MIN_ANCHORED_FRACTION = 0.25;

export function indexIsAddressable(
  served: string,
  bodyOffset: number,
): boolean {
  if (bodyOffset <= 0) return false;
  const lines = served
    .slice(0, bodyOffset)
    .split("\n")
    .filter((line) => line.trim().length > 0);
  // First line is the SECT-INDEX banner, not a section entry.
  const entries = lines.slice(1);
  if (!entries.length) return false;
  const anchored = entries.filter((line) => /@\d+\s*$/u.test(line)).length;
  return (
    anchored >= INDEX_MIN_ANCHORED_LINES &&
    anchored / entries.length >= INDEX_MIN_ANCHORED_FRACTION
  );
}

/**
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

/**
 * Prepend the index to the served markdown. A document with no derived
 * structure contributes nothing (typed refusal — the surface stays identical).
 */
export function attachStructureIndex(
  markdown: string,
  index: string,
): string {
  return index ? `${index}\n\n${markdown}` : markdown;
}
