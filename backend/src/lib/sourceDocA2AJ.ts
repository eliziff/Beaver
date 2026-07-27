import { buildA2AJStructure } from "./a2ajStructure";
import {
  createSourceDoc,
  type SourceDoc,
  type SourceDocBlock,
} from "./sourceDoc";

/**
 * A2AJ -> SourceDoc.
 *
 * A2AJ hands us Markdown, never the source HTML, so nothing here can claim a
 * provider anchor. The one exception is `unofficial_sections`: that map is
 * provider-supplied section granularity (the bulk corpus column read by
 * a2ajLocalBulk, and the same text `/fetch?section=` returns), so a top-level
 * block taken straight from it is `native`. Everything derived from prose -
 * the case paragraph spine, emphasis-marked statute sections, and every nested
 * subsection/paragraph/subparagraph label - is `heuristic`.
 *
 * Statute strategy, in order:
 *   1. provider section map (native spine, heuristic children);
 *   2. Markdown emphasis markers - `**231** (1) ...` federal statutes and
 *      `**A.01.001** ...` federal regulations, neither of which the flat-text
 *      spine has ever matched;
 *   3. the proven flat-text spine for bare line-start numbering (Ontario).
 */

type CompileInput = {
  citation: string;
  docType: "cases" | "laws";
  text: string;
  id?: string;
  url?: string | null;
  dataset?: string | null;
  name?: string | null;
  alternateCitation?: string | null;
  sectionMap?: Record<string, string> | null;
};

const SECTION_LABEL = String.raw`\d{1,8}(?:[.-]\d{1,8}){0,3}|[A-Za-z]{1,3}(?:[.-][0-9A-Za-z]{1,8}){1,3}`;
const EMPHASIS_SECTION_RE = new RegExp(
  String.raw`^[ \t]*\*\*(${SECTION_LABEL})\*\*(?=$|[ \t])`,
  "gmu",
);
const SECTION_LABEL_RE = new RegExp(String.raw`^(?:${SECTION_LABEL})$`, "u");
const CHILD_TOKEN = String.raw`\d+(?:\.\d+)?|[A-Za-z](?:\.\d+)?|[ivxlcdmIVXLCDM]+`;
const CHILD_MARK_RE = new RegExp(
  String.raw`^[ \t]*\((${CHILD_TOKEN})\)(?=\s)`,
  "gmu",
);
const INLINE_CHILD_RE = new RegExp(
  String.raw`^[ \t]*\((${CHILD_TOKEN})\)(?=\s)`,
  "u",
);
// Span gates borrowed from the flat-text spine: the provisions must actually
// cover the document rather than trail off its end.
const MIN_EMPHASIS_SPAN = 0.1;
const MAX_EMPHASIS_START = 0.7;
const INLINE_CHILD_WINDOW = 24;

/**
 * Legislative numbering is decimal-fraction ordered, not numeric: 83.01 comes
 * before 83.1, and 487.0551 before 487.06. Comparing `Number("01")` with
 * `Number("1")` collapses those to one key, which is why the existing engine
 * drops s. 231(6.1) once it has seen (6.01).
 */
function compareLabelParts(left: string[], right: string[]) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const first = left[index] ?? "";
    const second = right[index] ?? "";
    if (first === second) continue;
    const digits = /^\d*$/u.test(first) && /^\d*$/u.test(second);
    if (!digits) return first < second ? -1 : 1;
    if (index === 0) {
      const difference = Number(first || 0) - Number(second || 0);
      if (difference) return difference < 0 ? -1 : 1;
      continue;
    }
    const width = Math.max(first.length, second.length);
    const padded = first.padEnd(width, "0");
    const other = second.padEnd(width, "0");
    if (padded !== other) return padded < other ? -1 : 1;
  }
  return 0;
}

function labelParts(label: string) {
  return label.split(/[.-]/u);
}

function romanValue(token: string) {
  const values: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  };
  let total = 0;
  let prior = 0;
  for (const character of [...token.toLowerCase()].reverse()) {
    const value = values[character];
    if (!value) return null;
    total += value < prior ? -value : value;
    prior = Math.max(prior, value);
  }
  return total || null;
}

type ChildMarker = { token: string; start: number };
type ChildLevel = 1 | 2 | 3 | 4;

/**
 * Roman numerals and letters share an alphabet, so (c), (d), (i) and (C), (D)
 * are ambiguous in isolation. Resolve by continuity: a marker that continues
 * the run already in progress belongs to that run. Only the classic "(h) then
 * (i)" case needs lookahead.
 */
function romanPreferred(
  head: string,
  counters: Map<ChildLevel, string[]>,
  next: string | undefined,
) {
  if (head.length > 1) return true;
  const value = romanValue(head);
  if (value === null) return false;
  const upper = head === head.toUpperCase();
  const alphaLevel: ChildLevel = upper ? 4 : 2;
  const alphaValue = upper
    ? head.charCodeAt(0) - 64
    : head.charCodeAt(0) - 96;
  const priorRoman = counters.get(3);
  if (priorRoman?.length === 1 && Number(priorRoman[0]) + 1 === value) {
    return true;
  }
  const priorAlpha = counters.get(alphaLevel);
  if (priorAlpha?.length === 1 && Number(priorAlpha[0]) + 1 === alphaValue) {
    // (h) followed by (i): only a following (ii) proves a subparagraph run.
    return (
      head.toLowerCase() === "i" && (next ?? "").toLowerCase() === "ii"
    );
  }
  // A fresh marker can only open a Roman run with "i", and only beneath a
  // lettered paragraph. Uppercase "I" stays a letter: uppercase Roman runs do
  // not open inside a provision.
  return !upper && head === "i" && counters.has(2);
}

function classifyChild(
  token: string,
  counters: Map<ChildLevel, string[]>,
  next: string | undefined,
): { level: ChildLevel; value: string[] } | null {
  const [head, ...suffix] = token.split(".");
  if (/^\d/u.test(token)) {
    return { level: 1, value: token.split(".") };
  }
  if (romanPreferred(head, counters, next)) {
    const value = romanValue(head);
    return value === null ? null : { level: 3, value: [String(value)] };
  }
  const upper = head === head.toUpperCase();
  return {
    level: upper ? 4 : 2,
    value: [
      String(upper ? head.charCodeAt(0) - 64 : head.charCodeAt(0) - 96),
      ...suffix,
    ],
  };
}

/**
 * Turn one provision's child markers into nested `sec<label>(a)(i)` blocks.
 * `offset` is where the provision text starts in the SourceDoc text.
 */
function childBlocks(
  section: string,
  children: ChildMarker[],
  offset: number,
  sectionEnd: number,
): SourceDocBlock[] {
  const blocks: SourceDocBlock[] = [];
  const counters = new Map<ChildLevel, string[]>();
  const labels = new Map<ChildLevel, string>();
  children.forEach((child, position) => {
    const classified = classifyChild(
      child.token,
      counters,
      children[position + 1]?.token,
    );
    if (!classified) return;
    const prior = counters.get(classified.level);
    if (prior && compareLabelParts(classified.value, prior) <= 0) return;
    counters.set(classified.level, classified.value);
    labels.set(classified.level, `(${child.token})`);
    for (let deeper = classified.level + 1; deeper <= 4; deeper += 1) {
      counters.delete(deeper as ChildLevel);
      labels.delete(deeper as ChildLevel);
    }
    const suffix = [...labels.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, label]) => label)
      .join("");
    blocks.push({
      kind: "section",
      label: `sec${section}${suffix}`,
      start: offset + child.start,
      end: offset + (children[position + 1]?.start ?? sectionEnd - offset),
      origin: "heuristic",
      parentLabel: `sec${section}`,
    });
  });
  return blocks;
}

function childMarkers(text: string) {
  const markers: ChildMarker[] = [];
  for (const match of text.matchAll(CHILD_MARK_RE)) {
    markers.push({ token: match[1], start: match.index });
  }
  return markers;
}

/**
 * Statute compiler for the Markdown emphasis shape. One pass for the section
 * spine, one pass for child markers, then a linear merge - no per-section
 * rescan of the document.
 */
function emphasisSectionBlocks(text: string): SourceDocBlock[] {
  const markers: Array<{ label: string; start: number; end: number }> = [];
  for (const match of text.matchAll(EMPHASIS_SECTION_RE)) {
    const label = match[1];
    // Bold is also how A2AJ renders marginal notes and defined terms
    // ("**Classification of murder**", "**common-law partner**"); a section
    // number always carries a digit.
    if (!/\d/u.test(label)) continue;
    const prior = markers.at(-1);
    if (
      prior &&
      compareLabelParts(labelParts(label), labelParts(prior.label)) <= 0
    ) {
      continue;
    }
    markers.push({
      label,
      start: match.index + (match[0].length - match[0].trimStart().length),
      end: match.index + match[0].length,
    });
  }
  // One bold line-start number is already a far stronger signal than a bare
  // one - the bare-numbered corpora (Ontario statutes and regulations) carry
  // no Markdown emphasis at all - so a single provision excerpt still
  // compiles, provided it covers the document.
  if (!markers.length) return [];
  const start = markers[0].start / Math.max(text.length, 1);
  const span = (text.length - markers[0].start) / Math.max(text.length, 1);
  if (start > MAX_EMPHASIS_START || span < MIN_EMPHASIS_SPAN) return [];

  const children = childMarkers(text);
  const blocks: SourceDocBlock[] = [];
  let cursor = 0;
  markers.forEach((marker, position) => {
    const sectionEnd = markers[position + 1]?.start ?? text.length;
    blocks.push({
      kind: "section",
      label: `sec${marker.label}`,
      start: marker.start,
      end: sectionEnd,
      origin: "heuristic",
    });
    const owned: ChildMarker[] = [];
    // `**231** (1) Murder ...` keeps the first subsection on the marker line,
    // where a line-anchored scan cannot see it.
    const inline = INLINE_CHILD_RE.exec(
      text.slice(marker.end, marker.end + INLINE_CHILD_WINDOW),
    );
    if (inline) {
      owned.push({
        token: inline[1],
        start:
          marker.end -
          marker.start +
          (inline[0].length - inline[0].trimStart().length),
      });
    }
    while (cursor < children.length && children[cursor].start < marker.start) {
      cursor += 1;
    }
    while (cursor < children.length && children[cursor].start < sectionEnd) {
      owned.push({
        token: children[cursor].token,
        start: children[cursor].start - marker.start,
      });
      cursor += 1;
    }
    blocks.push(
      ...childBlocks(marker.label, owned, marker.start, sectionEnd),
    );
  });
  return blocks;
}

/** Provider section map: native spine, heuristic children. */
function sectionMapBlocks(sectionMap: Record<string, string>) {
  const pieces: string[] = [];
  const blocks: SourceDocBlock[] = [];
  let position = 0;
  for (const [rawLabel, rawText] of Object.entries(sectionMap)) {
    const label = rawLabel.trim();
    const text = rawText.trim();
    if (!text) continue;
    if (pieces.length) {
      pieces.push("\n");
      position += 1;
    }
    pieces.push(text);
    if (SECTION_LABEL_RE.test(label)) {
      const end = position + text.length;
      blocks.push({
        kind: "section",
        label: `sec${label}`,
        start: position,
        end,
        origin: "native",
      });
      const children = childMarkers(text);
      // Some corpora keep the number in the body ("34(1) Parent ..."); the
      // A2AJ section map strips it and opens with "(1) ...", which the
      // line-anchored scan already catches at offset 0.
      const leading = new RegExp(
        String.raw`^[ \t]*${label.replace(/[.*+?^${}()|[\]\\-]/gu, "\\$&")}[ \t]*\((${CHILD_TOKEN})\)(?=\s)`,
        "u",
      ).exec(text);
      if (leading) {
        children.unshift({ token: leading[1], start: leading[0].length - 1 });
      }
      blocks.push(...childBlocks(label, children, position, end));
    }
    position += text.length;
  }
  return { text: pieces.join(""), blocks };
}

function heuristic(blocks: { kind: string; label: string; start: number; end: number }[]) {
  return blocks.map((block) => ({
    kind: block.kind as SourceDocBlock["kind"],
    label: block.label,
    start: block.start,
    end: block.end,
    origin: "heuristic" as const,
  }));
}

export function compileA2AJSourceDoc(input: CompileInput): SourceDoc {
  const identity = {
    provider: "a2aj" as const,
    id: input.id ?? input.citation,
    url: input.url ?? null,
    docType: input.docType,
  };

  if (input.docType === "cases") {
    // The paragraph/page spine is the proven one; SourceDoc changes how it is
    // queried, not what it finds.
    const structure = buildA2AJStructure({
      text: input.text,
      docType: "cases",
      citation: input.citation,
      alternateCitation: input.alternateCitation,
      dataset: input.dataset,
      name: input.name,
    });
    return createSourceDoc({
      ...identity,
      text: structure.text,
      blocks: heuristic(structure.blocks),
    });
  }

  if (input.sectionMap && Object.keys(input.sectionMap).length) {
    const mapped = sectionMapBlocks(input.sectionMap);
    if (mapped.blocks.length) {
      return createSourceDoc({
        ...identity,
        text: mapped.text,
        blocks: mapped.blocks,
      });
    }
  }

  const emphasis = emphasisSectionBlocks(input.text);
  if (emphasis.length) {
    return createSourceDoc({ ...identity, text: input.text, blocks: emphasis });
  }

  const structure = buildA2AJStructure({
    text: input.text,
    docType: "laws",
    name: input.name,
  });
  return createSourceDoc({
    ...identity,
    text: structure.text,
    blocks: heuristic(structure.blocks),
  });
}
