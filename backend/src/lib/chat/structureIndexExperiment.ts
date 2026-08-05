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

function headingTail(node: SkeletonNode): string {
  const heading = node.heading?.trim() ?? "";
  if (!heading) return "";
  const shown =
    heading.length <= MAX_HEADING_CHARS
      ? heading
      : `${heading.slice(0, MAX_HEADING_CHARS).trimEnd()}…`;
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

/** Offset of the first line whose real first token is `display`, else null.
 *  The token must be followed by a non-alphanumeric boundary so a body
 *  cross-reference that merely starts a line with the number is rejected. */
function anchorDisplayLineStart(
  markdown: string,
  display: string,
): number | null {
  let pos = 0;
  while (pos <= markdown.length) {
    const nl = markdown.indexOf("\n", pos);
    const end = nl === -1 ? markdown.length : nl;
    const body = stripLineDecor(markdown.slice(pos, end));
    if (body.startsWith(display)) {
      const after = body.slice(display.length).trimStart();
      if (!after || !/[\p{L}\p{N}]/u.test(after[0])) return pos;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return null;
}

/** The trailing enum token of a composed subsection display, e.g. "a" from
 *  "Section 2.01(a)". Null for top-level nodes. */
function subsectionToken(display: string): string | null {
  const m = display.match(/\(([^()]+)\)\s*$/);
  return m ? m[1] : null;
}

/**
 * Anchor a subsection relative to its parent: find the `(a)`-style enum token
 * at or after `from` (pandoc renders it `\(a\)` or `**(a)**`), falling back to
 * the leading fragment of the sub-heading title. Returns the anchor offset and
 * the position to start the next sibling's search.
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
    const hit = re.exec(markdown);
    if (hit) return { at: hit.index, next: hit.index + hit[0].length };
  }
  // Fallback: the skeleton holds heading = title + body text; use the leading
  // fragment up to the first sentence boundary.
  const title = node.heading?.trim() ?? "";
  const boundary = title.search(/\.\s|\.$/);
  const frag = boundary >= 0 ? title.slice(0, boundary + 1) : title.slice(0, 32);
  if (frag.length >= 4) {
    const idx = markdown.indexOf(frag, from);
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
  for (const node of spine) {
    if (node.kind === "subsection") continue;
    const at = anchorDisplayLineStart(markdown, node.display);
    if (at !== null) anchors.set(node.label, at);
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
): string {
  const spine = nodes.filter((node) => INDEX_KINDS.has(node.kind));
  if (!spine.length) return "";
  const anchors = markdown ? anchorSpine(markdown, spine) : null;
  const lines = spine.map((node) => {
    const at = anchors?.get(node.label);
    return `  ${node.display}${headingTail(node)}${
      at !== undefined ? `  @${at}` : ""
    }`;
  });
  return [
    `SECT-INDEX (derived from the document's own numbering; ${spine.length} numbered sections/parts; @N = offset into the body below this index — read only what the deliverable requires)`,
    ...lines,
  ].join("\n");
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
