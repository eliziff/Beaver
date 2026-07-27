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
 *   3. the flat-text spine for bare line-start numbering (Ontario).
 *
 * Cases get the paragraph spine (bracketed, dotted or bare numbering, chosen
 * by longest monotone run) and, for reported decisions, the page spine.
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
        String.raw`^[ \t]*${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[ \t]*\((${CHILD_TOKEN})\)(?=\s)`,
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

/* ------------------------------------------------------------------ *
 * Flat text: bare line-start section numbering (Ontario statutes and
 * regulations), and the case paragraph/page spine.
 * ------------------------------------------------------------------ */

const FLAT_SECTION_RE = new RegExp(
  String.raw`^[ \t]*(\d{1,8}(?:[.-]\d{1,8}){0,3})(?=[ \t]+(?:\(?\d|\p{L})|[ \t]*\()`,
  "gmu",
);
const PARAGRAPH_MARK_RE =
  /^[ \t]*(?:\[(\d{1,4})\]|(\d{1,4})\.(?=\s)|(\d{1,4})(?=\s))/gmu;
const PAGE_MARK_RE =
  /\[[ \t]*pages?[ \t]*[.:,;]?[ \t]*(\d{1,4})[ \t]*[.:,;]?[ \t]*[\]\[)}]?[ \t]*[.,;:]?|^[ \t]*\[?[ \t]*page[ \t]*[.:,;]?[ \t]*(\d{1,4})[ \t]*[\])}]?[ \t]*[.,;:]?[ \t]*$/gimu;
const REPORT_PAGE_RE = /\b(?:S\.?C\.?R\.?|R\.?C\.?S\.?)\s+(\d{1,4})\b/iu;

type NumberedMarker = { number: number; start: number; contentStart?: number };
type ParagraphMarker = NumberedMarker & { style: "bracket" | "dot" | "bare" };
type SectionMarker = {
  label: string;
  start: number;
  style: "integer" | "dot" | "hyphen" | "mixed";
};

function wordCount(text: string) {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function sectionKey(label: string) {
  return label.split(/[.-]/u).map(Number);
}

function compareKeys(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

/**
 * Group numbered markers into ascending runs, preferring the run that starts
 * lowest: a decision whose table of contents repeats every paragraph number
 * must not split its spine in half.
 */
function monotoneScopes(markers: NumberedMarker[], maxGap = 8) {
  const scopes: NumberedMarker[][] = [];
  const byLast = new Map<number, number[]>();
  for (const marker of markers) {
    const candidates: number[] = [];
    for (
      let prior = marker.number - maxGap;
      prior < marker.number;
      prior += 1
    ) {
      candidates.push(...(byLast.get(prior) ?? []));
    }
    const index = candidates.length
      ? candidates.reduce((best, current) =>
          scopes[current][0].number < scopes[best][0].number ? current : best,
        )
      : scopes.length;
    if (index === scopes.length) {
      scopes.push([marker]);
    } else {
      const previous = scopes[index].at(-1)!.number;
      const entries = (byLast.get(previous) ?? []).filter(
        (value) => value !== index,
      );
      if (entries.length) byLast.set(previous, entries);
      else byLast.delete(previous);
      scopes[index].push(marker);
    }
    byLast.set(marker.number, [...(byLast.get(marker.number) ?? []), index]);
  }
  return scopes;
}

function paragraphBlocks(text: string, minRun = 5): SourceDocBlock[] {
  if (!text) return [];
  const markers: ParagraphMarker[] = [];
  for (const match of text.matchAll(PARAGRAPH_MARK_RE)) {
    const [bracket, dot, bare] = match.slice(1);
    markers.push({
      start: match.index,
      number: Number(bracket ?? dot ?? bare),
      style: bracket ? "bracket" : dot ? "dot" : "bare",
    });
  }
  const hypotheses: Array<{
    style: ParagraphMarker["style"];
    markers: NumberedMarker[];
  }> = [];
  for (const style of ["bracket", "dot", "bare"] as const) {
    for (const scope of monotoneScopes(
      markers.filter((marker) => marker.style === style),
    )) {
      if (scope.length >= minRun) hypotheses.push({ style, markers: scope });
    }
  }
  if (!hypotheses.length) return [];
  const rank = { bracket: 2, dot: 1, bare: 0 };
  const primary = hypotheses.filter((item) => item.markers[0].number <= 5);
  const ordered = [...(primary.length ? primary : hypotheses)].sort(
    (left, right) =>
      right.markers.length - left.markers.length ||
      rank[right.style] - rank[left.style] ||
      left.markers[0].number - right.markers[0].number,
  );
  for (const hypothesis of ordered) {
    const allOffsets = markers
      .filter((marker) => marker.style === hypothesis.style)
      .map((marker) => marker.start);
    const nextOffset = new Map(
      allOffsets.map((offset, index) => [
        offset,
        allOffsets[index + 1] ?? text.length,
      ]),
    );
    const blocks = hypothesis.markers.map((marker) => ({
      kind: "paragraph" as const,
      label: `par${marker.number}`,
      start: marker.start,
      end: nextOffset.get(marker.start) ?? text.length,
      origin: "heuristic" as const,
    }));
    const markerSpan =
      (blocks.at(-1)!.start - blocks[0].start) / Math.max(text.length, 1);
    const startRatio = blocks[0].start / Math.max(text.length, 1);
    const bounded = blocks.length > 1 ? blocks.slice(0, -1) : blocks;
    const medianWords = median(
      bounded.map((block) => wordCount(text.slice(block.start, block.end))),
    );
    const substantive =
      blocks.filter(
        (block) => wordCount(text.slice(block.start, block.end)) >= 12,
      ).length / blocks.length;
    if (medianWords < 12 || markerSpan < 0.05) continue;
    if (hypothesis.style !== "bracket" && substantive < 0.7) continue;
    if (
      hypothesis.style === "bare" &&
      (medianWords < 20 || markerSpan < 0.15 || startRatio > 0.7)
    ) {
      continue;
    }
    return blocks;
  }
  return [];
}

function reporterStartPage(...citations: Array<string | null | undefined>) {
  for (const citation of citations) {
    const match = REPORT_PAGE_RE.exec(citation ?? "");
    if (match) return Number(match[1]);
  }
  return null;
}

function pageMarkers(text: string, reportStart: number | null) {
  if (!/\bpage\b/iu.test(text)) return [];
  const markers: NumberedMarker[] = [];
  let priorEnd = -1;
  for (const match of text.matchAll(PAGE_MARK_RE)) {
    const number = Number(match[1] ?? match[2]);
    if (
      match.index < priorEnd ||
      (reportStart !== null && number < reportStart)
    ) {
      continue;
    }
    markers.push({
      number,
      start: match.index,
      contentStart: match.index + match[0].length,
    });
    priorEnd = match.index + match[0].length;
  }
  return markers;
}

function pageBlocks(
  text: string,
  reportStart: number | null,
  requireReportStart: boolean,
): SourceDocBlock[] {
  if (requireReportStart && reportStart === null) return [];
  const markers = pageMarkers(text, reportStart);
  const scopes: NumberedMarker[][] = [];
  const byLast = new Map<number, number[]>();
  for (const marker of markers) {
    const candidates = byLast.get(marker.number - 1) ?? [];
    const index = candidates.length
      ? candidates.reduce((best, current) =>
          scopes[current].at(-1)!.start > scopes[best].at(-1)!.start
            ? current
            : best,
        )
      : scopes.length;
    if (index === scopes.length) {
      scopes.push([marker]);
    } else {
      const previous = scopes[index].at(-1)!.number;
      const entries = (byLast.get(previous) ?? []).filter(
        (value) => value !== index,
      );
      if (entries.length) byLast.set(previous, entries);
      else byLast.delete(previous);
      scopes[index].push(marker);
    }
    byLast.set(marker.number, [...(byLast.get(marker.number) ?? []), index]);
  }
  const ranked = scopes
    .filter((scope) => scope.length >= 3)
    .sort((left, right) => right.length - left.length);
  if (
    !ranked.length ||
    (ranked.length > 1 && ranked[0].length === ranked[1].length)
  ) {
    return [];
  }
  const best = ranked[0];
  const blocks: SourceDocBlock[] = best.slice(0, -1).map((marker, index) => ({
    kind: "page" as const,
    label: `page${marker.number}`,
    start: marker.contentStart!,
    end: best[index + 1].start,
    origin: "heuristic" as const,
  }));
  if (reportStart !== null && best[0].number === reportStart + 1) {
    blocks.unshift({
      kind: "page",
      label: `page${reportStart}`,
      start: 0,
      end: best[0].start,
      origin: "heuristic",
    });
  }
  return blocks;
}

function sectionMarkers(text: string) {
  const markers: SectionMarker[] = [];
  for (const match of text.matchAll(FLAT_SECTION_RE)) {
    const label = match[1];
    markers.push({
      label,
      start: match.index,
      style:
        label.includes(".") && label.includes("-")
          ? "mixed"
          : label.includes("-")
            ? "hyphen"
            : label.includes(".")
              ? "dot"
              : "integer",
    });
  }
  return markers;
}

function sectionSpine(text: string, allowHyphen: boolean) {
  const markers = sectionMarkers(text);
  if (markers.length < 3) return [];
  const scopesFor = (
    styles: Set<SectionMarker["style"]>,
    requireRoot = false,
  ) => {
    const scopes: SectionMarker[][] = [];
    for (const marker of markers) {
      if (!styles.has(marker.style)) continue;
      const value = sectionKey(marker.label);
      const candidates = scopes
        .map((scope, index) => ({
          index,
          key: sectionKey(scope.at(-1)!.label),
        }))
        .filter(
          (item) =>
            item.key.length === value.length &&
            compareKeys(value, item.key) > 0,
        );
      if (candidates.length) {
        const selected = candidates.reduce((best, current) =>
          compareKeys(current.key, best.key) > 0 ? current : best,
        );
        scopes[selected.index].push(marker);
      } else {
        scopes.push([marker]);
      }
      if (scopes.length > 8) {
        const shortest = scopes.reduce(
          (best, scope, index) =>
            scope.length < scopes[best].length ? index : best,
          0,
        );
        scopes.splice(shortest, 1);
      }
    }
    return scopes.filter(
      (scope) =>
        scope.length >= 3 &&
        (!requireRoot ||
          sectionKey(scope[0].label).every((part) => part === 1)),
    );
  };
  const hypotheses = scopesFor(new Set(["integer", "dot"]));
  if (allowHyphen) {
    hypotheses.push(...scopesFor(new Set(["hyphen"]), true));
    hypotheses.push(...scopesFor(new Set(["mixed"]), true));
  }
  if (!hypotheses.length) return [];
  let best = hypotheses.reduce((winner, item) =>
    item.length > winner.length ? item : winner,
  );
  if (sectionKey(best[0].label).length === 1) {
    const expanded: SectionMarker[] = [];
    best.forEach((parent, index) => {
      const end = best[index + 1]?.start ?? text.length;
      const parentNumber = sectionKey(parent.label)[0];
      const descendants = markers.filter(
        (marker) =>
          marker.style === "dot" &&
          marker.start > parent.start &&
          marker.start < end &&
          sectionKey(marker.label)[0] === parentNumber,
      );
      const duplicates = new Set(
        descendants
          .filter(
            (candidate) =>
              descendants.filter((item) => item.label === candidate.label)
                .length > 1,
          )
          .map((item) => item.label),
      );
      expanded.push(parent);
      expanded.push(
        ...descendants.filter((item) => !duplicates.has(item.label)),
      );
    });
    best = expanded;
  }
  const span = (text.length - best[0].start) / Math.max(text.length, 1);
  return span >= 0.1 && best[0].start / Math.max(text.length, 1) <= 0.7
    ? best
    : [];
}

function flatSectionBlocks(text: string, name: string | null | undefined) {
  const spine = sectionSpine(text, /\brules?\b/iu.test(name ?? ""));
  const blocks: SourceDocBlock[] = [];
  spine.forEach((marker, index) => {
    const end = spine[index + 1]?.start ?? text.length;
    const body = text.slice(marker.start, end);
    blocks.push({
      kind: "section",
      label: `sec${marker.label}`,
      start: marker.start,
      end,
      origin: "heuristic",
    });
    const children = childMarkers(body);
    // "3 (1) An occupier ..." keeps the first subsection on the number's own
    // line, where the line-anchored scan cannot see it; the block it opens
    // starts at the section number, as the flat spine has always placed it.
    const leading = new RegExp(
      String.raw`^[ \t]*${marker.label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[ \t]*\((${CHILD_TOKEN})\)(?=\s)`,
      "u",
    ).exec(body);
    if (leading) children.unshift({ token: leading[1], start: 0 });
    blocks.push(...childBlocks(marker.label, children, marker.start, end));
  });
  return blocks;
}

function caseBlocks(input: CompileInput): SourceDocBlock[] {
  return [
    ...paragraphBlocks(input.text),
    ...pageBlocks(
      input.text,
      reporterStartPage(input.citation, input.alternateCitation),
      (input.dataset ?? "").toUpperCase() === "SCC",
    ),
  ];
}

export type A2AJStructureSummary = {
  status: "usable" | "unavailable";
  source: "flat_text" | "section_map";
  counts: { paragraph: number; page: number; section: number };
};

/**
 * The index as the A2AJ tools advertise it. Only the provider section map
 * produces native blocks, so their presence is what "section_map" means.
 */
export function summarizeA2AJSourceDoc(doc: SourceDoc): A2AJStructureSummary {
  return {
    status: doc.status,
    source: doc.blocks.some(({ origin }) => origin === "native")
      ? "section_map"
      : "flat_text",
    counts: {
      paragraph: doc.ranges.paragraph.count,
      page: doc.ranges.page.count,
      section: doc.ranges.section.count,
    },
  };
}

export function compileA2AJSourceDoc(input: CompileInput): SourceDoc {
  const identity = {
    provider: "a2aj" as const,
    id: input.id ?? input.citation,
    url: input.url ?? null,
    docType: input.docType,
  };

  if (input.docType === "cases") {
    return createSourceDoc({
      ...identity,
      text: input.text,
      blocks: caseBlocks(input),
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
  return createSourceDoc({
    ...identity,
    text: input.text,
    blocks: emphasis.length
      ? emphasis
      : flatSectionBlocks(input.text, input.name),
  });
}
