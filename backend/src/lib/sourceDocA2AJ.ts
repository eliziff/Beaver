import {
  createSourceDoc,
  type SourceDoc,
  type SourceDocBlock,
} from "./sourceDoc";
import {
  compareStatuteLabels,
  computeStatuteSpine,
  type SpineMark,
} from "./statuteSpine";

/**
 * A2AJ -> SourceDoc.
 *
 * A2AJ hands us Markdown, never the source HTML, so nothing here can claim a
 * provider anchor. `unofficial_text` and each `unofficial_sections` value are
 * distinct provider renditions: whole-document callers compile the former;
 * exact section callers compile one map entry. A map entry's top-level block
 * is therefore native without inventing offsets into the full text.
 * Everything derived from prose -
 * the case paragraph spine, emphasis-marked statute sections, and every nested
 * subsection/paragraph/subparagraph label - is `heuristic`.
 *
 * Statute strategy:
 *   1. provider section map (native spine, heuristic children);
 *   2. one whole-text marker overlay: the shared flat spine plus Markdown
 *      emphasis markers (`**231**`, `**A.01.001**`), with emphasis winning
 *      only an exact locator collision.
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

const SECTION_LABEL = String.raw`\d{1,8}[A-Za-z]{0,3}(?:[.-]\d{1,8}[A-Za-z]{0,3}){0,3}|[A-Za-z]{1,3}(?:[.-][0-9A-Za-z]{1,8}){1,3}`;
const EMPHASIS_SECTION_RE = new RegExp(
  String.raw`^[ \t]*\*\*(${SECTION_LABEL})\*\*(?=$|[ \t])`,
  "gmu",
);
const PROVIDER_PROVISION_LABEL_RE =
  /^(?:\d{1,8}[A-Za-z]{0,3}(?:[.-]\d{1,8}[A-Za-z]{0,3}){0,3}|[A-Za-z]{1,3}(?:[.-][0-9A-Za-z]{1,8}){1,3})$/u;
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
const STATUS_RANGE_RE = new RegExp(
  String.raw`^[ \t]*(?<emphasis>\*\*)?(?<from>\d{1,4})(?:[ \t]+(?<word>to|through|and|à|a|et)[ \t]+|[ \t]*(?<dash>[-–—])[ \t]*)(?<to>\d{1,4})\k<emphasis>[ \t]*[,;:]?[ \t]*(?:\[[ \t]*)?(?:repealed|revoked|abrog(?:ated|é|ée|és|ées)|renumbered|spent|not (?:yet )?in force|omitted)\b`,
  "gimu",
);
const MAX_STATUS_RANGE = 400;

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
    const firstAlphanumeric = first.match(/^(\d+)([A-Za-z]*)$/u);
    const secondAlphanumeric = second.match(/^(\d+)([A-Za-z]*)$/u);
    if (
      firstAlphanumeric &&
      secondAlphanumeric &&
      (firstAlphanumeric[2] || secondAlphanumeric[2])
    ) {
      const number =
        Number(firstAlphanumeric[1]) - Number(secondAlphanumeric[1]);
      if (number) return number < 0 ? -1 : 1;
      const firstSuffix = [...firstAlphanumeric[2].toUpperCase()].reduce(
        (value, character) => value * 26 + character.charCodeAt(0) - 64,
        0,
      );
      const secondSuffix = [...secondAlphanumeric[2].toUpperCase()].reduce(
        (value, character) => value * 26 + character.charCodeAt(0) - 64,
        0,
      );
      if (firstSuffix !== secondSuffix) {
        return firstSuffix < secondSuffix ? -1 : 1;
      }
      continue;
    }
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

function dottedOrderForSource(labels: string[]) {
  const dotted = labels.filter(
    (label) => label.includes(".") && !label.includes("-"),
  );
  const inversions = (order: "component" | "fraction") => {
    let count = 0;
    for (let index = 1; index < dotted.length; index += 1) {
      if (
        compareStatuteLabels(dotted[index - 1], dotted[index], order) > 0
      ) {
        count += 1;
      }
    }
    return count;
  };
  const component = inversions("component");
  const fraction = inversions("fraction");
  if (component !== fraction) {
    return fraction < component
      ? ("fraction" as const)
      : ("component" as const);
  }
  const disagrees = dotted.some(
    (label, index) =>
      index > 0 &&
      Math.sign(
        compareStatuteLabels(dotted[index - 1], label, "component"),
      ) !==
        Math.sign(
          compareStatuteLabels(dotted[index - 1], label, "fraction"),
        ),
  );
  return disagrees ? null : ("component" as const);
}

/**
 * Markdown emphasis is strong enough to preserve a one-provision excerpt, but
 * the first leading-label family owns the run. This keeps federal
 * A.01.001-style regulations while preventing later formula variables
 * (D.1, E.1) from poisoning a numeric statute.
 */
type SectionMarker = {
  label: string;
  start: number;
  contentStart: number;
  source: "emphasis" | "flat" | "range";
  aliases?: string[];
};

function emphasisSectionMarkers(text: string): SectionMarker[] {
  const candidates: SectionMarker[] = [];
  for (const match of text.matchAll(EMPHASIS_SECTION_RE)) {
    const label = match[1];
    // Bold is also how A2AJ renders marginal notes and defined terms
    // ("**Classification of murder**", "**common-law partner**"); a section
    // number always carries a digit.
    if (!/\d/u.test(label)) continue;
    const start =
      match.index + (match[0].length - match[0].trimStart().length);
    const markerEnd = match.index + match[0].length;
    candidates.push({
      label,
      start,
      contentStart: markerEnd + leadingSpaceLength(text, markerEnd),
      source: "emphasis",
    });
  }
  if (!candidates.length) return [];

  const numeric = /^\d/u.test(candidates[0].label);
  const family = candidates.filter(
    (marker) => /^\d/u.test(marker.label) === numeric,
  );
  const dottedOrder = dottedOrderForSource(
    family.map(({ label }) => label),
  );
  if (!dottedOrder) return [];
  const markers: SectionMarker[] = [];
  for (const marker of family) {
    const prior = markers.at(-1);
    if (
      !prior ||
      compareStatuteLabels(marker.label, prior.label, dottedOrder) > 0
    ) {
      markers.push(marker);
    }
  }

  // One bold line-start number is already a far stronger signal than a bare
  // one - the bare-numbered corpora (Ontario statutes and regulations) carry
  // no Markdown emphasis at all - so a single provision excerpt still
  // compiles, provided it covers the document.
  if (!markers.length) return [];
  const start = markers[0].start / Math.max(text.length, 1);
  const span = (text.length - markers[0].start) / Math.max(text.length, 1);
  if (start > MAX_EMPHASIS_START || span < MIN_EMPHASIS_SPAN) return [];
  return markers;
}

function leadingSpaceLength(text: string, at: number) {
  let length = 0;
  while (text[at + length] === " " || text[at + length] === "\t") {
    length += 1;
  }
  return length;
}

function sectionBlocksFromMarkers(
  text: string,
  markers: SectionMarker[],
): SourceDocBlock[] {
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
      aliases: marker.aliases?.map((label) => `sec${label}`),
    });
    if (!PROVIDER_PROVISION_LABEL_RE.test(marker.label)) return;
    const owned: ChildMarker[] = [];
    // `**231** (1) Murder ...` keeps the first subsection on the marker line,
    // where a line-anchored scan cannot see it.
    const inline = INLINE_CHILD_RE.exec(
      text.slice(
        marker.contentStart,
        marker.contentStart + INLINE_CHILD_WINDOW,
      ),
    );
    if (inline) {
      owned.push({
        token: inline[1],
        start:
          marker.source === "flat"
            ? 0
            : marker.contentStart -
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

function statusRangeMarkers(text: string, allowHyphen: boolean) {
  const markers: SectionMarker[] = [];
  for (const match of text.matchAll(STATUS_RANGE_RE)) {
    if (allowHyphen && match.groups?.dash) continue;
    const from = Number(match.groups?.from);
    const to = Number(match.groups?.to);
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from >= to ||
      to > from + MAX_STATUS_RANGE
    ) {
      continue;
    }
    const start =
      match.index + (match[0].length - match[0].trimStart().length);
    const afterMark = match.index + match[0].length;
    markers.push({
      label: String(from),
      aliases: Array.from(
        { length: to - from },
        (_, index) => String(from + index + 1),
      ),
      start,
      contentStart: afterMark + leadingSpaceLength(text, afterMark),
      source: "range",
    });
  }
  return markers;
}

/** Provider section map: native spine, heuristic children. */
function sectionMapBlocks(sectionMap: Record<string, string>) {
  const pieces: string[] = [];
  const blocks: SourceDocBlock[] = [];
  let position = 0;
  const sourceEntries = Object.entries(sectionMap);
  const dottedOrder = dottedOrderForSource(
    sourceEntries.map(([label]) => label),
  );
  const sourceOrder = new Map(
    sourceEntries.map(([label], index) => [label, index] as const),
  );
  // ECMAScript enumerates integer keys before dotted/suffixed keys even when
  // the JSON supplied 4, 4.1, 4.2, 5 or 2, 2A, 3. Reconstruct that legislative
  // order, put a preamble first, and keep every other named entry stable.
  const entries = sourceEntries.sort(([left], [right]) => {
    const leftLabel = left.trim();
    const rightLabel = right.trim();
    const leftPreamble = /^(?:preamble|préambule)$/iu.test(leftLabel);
    const rightPreamble = /^(?:preamble|préambule)$/iu.test(rightLabel);
    if (leftPreamble !== rightPreamble) return leftPreamble ? -1 : 1;
    const leftSection = PROVIDER_PROVISION_LABEL_RE.test(leftLabel);
    const rightSection = PROVIDER_PROVISION_LABEL_RE.test(rightLabel);
    if (leftSection && rightSection) {
      if (dottedOrder) {
        return compareStatuteLabels(leftLabel, rightLabel, dottedOrder);
      }
      const component = compareStatuteLabels(
        leftLabel,
        rightLabel,
        "component",
      );
      const fraction = compareStatuteLabels(
        leftLabel,
        rightLabel,
        "fraction",
      );
      return Math.sign(component) === Math.sign(fraction)
        ? component
        : sourceOrder.get(left)! - sourceOrder.get(right)!;
    }
    return leftSection ? -1 : rightSection ? 1 : 0;
  });
  for (const [rawLabel, rawText] of entries) {
    const label = rawLabel.trim();
    const text = rawText;
    if (!text.trim() || /^\[blank\]$/iu.test(text.trim())) continue;
    if (pieces.length) {
      pieces.push("\n");
      position += 1;
    }
    pieces.push(text);
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
    position += text.length;
  }
  return { text: pieces.join(""), blocks };
}

/* ------------------------------------------------------------------ *
 * Flat text: bare line-start section numbering (Ontario statutes and
 * regulations), and the case paragraph/page spine.
 * ------------------------------------------------------------------ */

const PARAGRAPH_MARK_RE =
  /^[ \t]*(?:\[(\d{1,4})\]|(\d{1,4})\.(?=\s)|(\d{1,4})(?=\s))/gmu;
const PAGE_MARK_RE =
  /\[[ \t]*pages?[ \t]*[.:,;]?[ \t]*(\d{1,4})[ \t]*[.:,;]?[ \t]*[\]\[)}]?[ \t]*[.,;:]?|^[ \t]*\[?[ \t]*page[ \t]*[.:,;]?[ \t]*(\d{1,4})[ \t]*[\])}]?[ \t]*[.,;:]?[ \t]*$/gimu;
const REPORT_PAGE_RE = /\b(?:S\.?C\.?R\.?|R\.?C\.?S\.?)\s+(\d{1,4})\b/iu;

type NumberedMarker = { number: number; start: number; contentStart?: number };
type ParagraphMarker = NumberedMarker & { style: "bracket" | "dot" | "bare" };

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

/**
 * Exact TypeScript port of ALR Quote Verifier's
 * a2aj_structure.monotone_scopes: group markers into ascending runs and
 * choose the lowest starting number, then the earliest scope. A decision
 * whose table of contents repeats every paragraph number must not split its
 * spine in half.
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
          scopes[current][0].number < scopes[best][0].number ||
          (scopes[current][0].number === scopes[best][0].number &&
            current < best)
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
  return scopes;
}

const HEADING_CONNECTORS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "v.",
]);

function looksLikeJoinedHeading(value: string) {
  const heading = value
    .trim()
    .replace(/^\([\p{L}\p{N}]+\)\s+/u, "");
  if (!heading || heading.length > 120 || /[\[\];!?]/u.test(heading)) {
    return false;
  }
  const words = heading.split(/\s+/u);
  return (
    words.length <= 12 &&
    words.some((word) => /^\p{Lu}/u.test(word)) &&
    words.every(
      (word) =>
        HEADING_CONNECTORS.has(word) ||
        /^\p{Lu}[\p{L}\p{M}’'’-]*:?$/u.test(word) ||
        /^\p{Lu}\.$/u.test(word) ||
        /^\d+(?:\.\d+)*[.):]?$/u.test(word),
    )
  );
}

/**
 * A2AJ occasionally joins a heading to the numbered paragraph that follows:
 * `Qualified Privilege [63] ...`. Recover only a unique missing marker
 * bracketed by an already-proven paragraph spine (or immediately before its
 * first marker). This stays fail-closed on bracketed quotations and citations.
 */
function recoverHeadingJoinedParagraphs(
  text: string,
  spine: NumberedMarker[],
) {
  const knownStarts = new Set(spine.map(({ start }) => start));
  const candidates = new Map<number, NumberedMarker[]>();
  for (const match of text.matchAll(/\[(\d{1,4})\]/gu)) {
    if (knownStarts.has(match.index)) continue;
    const number = Number(match[1]);
    let before: NumberedMarker | undefined;
    for (const marker of spine) {
      if (marker.start >= match.index) break;
      before = marker;
    }
    const after = spine.find((marker) => marker.start > match.index);
    const between =
      !!before &&
      !!after &&
      before.number < number &&
      number < after.number;
    const leading =
      !before &&
      !!after &&
      number > 0 &&
      number < after.number &&
      after.number - number <= 2 &&
      after.start - match.index <= 2_000;
    if (!between && !leading) continue;
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    if (!looksLikeJoinedHeading(text.slice(lineStart, match.index))) continue;
    candidates.set(number, [
      ...(candidates.get(number) ?? []),
      { number, start: match.index },
    ]);
  }
  const recovered = [...candidates.values()]
    .filter((matches) => matches.length === 1)
    .flat();
  return [...spine, ...recovered].sort(
    (left, right) => left.start - right.start,
  );
}

function paragraphSourceBlocks(
  text: string,
  spine: NumberedMarker[],
  allMarkers: ParagraphMarker[],
  style: ParagraphMarker["style"],
) {
  const selected =
    style === "bracket"
      ? recoverHeadingJoinedParagraphs(text, spine)
      : spine;
  const boundaries = [
    ...new Set([
      ...allMarkers
        .filter((marker) => marker.style === style)
        .map(({ start }) => start),
      ...selected.map(({ start }) => start),
      text.length,
    ]),
  ].sort((left, right) => left - right);
  const nextOffset = new Map(
    boundaries.map((offset, index) => [
      offset,
      boundaries[index + 1] ?? text.length,
    ]),
  );
  return selected.map((marker) => ({
    kind: "paragraph" as const,
    label: `par${marker.number}`,
    start: marker.start,
    end: nextOffset.get(marker.start) ?? text.length,
    origin: "heuristic" as const,
  }));
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
    shortComplete: boolean;
  }> = [];
  for (const style of ["bracket", "dot", "bare"] as const) {
    for (const scope of monotoneScopes(
      markers.filter((marker) => marker.style === style),
    )) {
      if (scope.length >= minRun) {
        hypotheses.push({ style, markers: scope, shortComplete: false });
      } else if (
        style === "bracket" &&
        scope.length >= 2 &&
        scope.every((marker, index) => marker.number === index + 1)
      ) {
        // Complete short [1]..[N] ladders are real structure in short
        // orders / oral reasons / costs rulings — the full-sweep
        // none-queue inspection found 17/29 sampled "no structure" docs
        // were exactly this shape, killed by minRun. Contiguity from 1
        // excludes quoted-fragment ladders and bracketed years ([1999]
        // parses as 1999).
        hypotheses.push({ style, markers: scope, shortComplete: true });
      }
    }
  }
  if (!hypotheses.length) return [];
  const rank = { bracket: 2, dot: 1, bare: 0 };
  // Short-complete hypotheses are a last resort: they must never enter
  // the primary/fallback decision for full scopes (a tail [1]..[4] list
  // in a big doc would otherwise shadow the real ladder).
  const full = hypotheses.filter((item) => !item.shortComplete);
  const short = hypotheses.filter((item) => item.shortComplete);
  const primary = full.filter((item) => item.markers[0].number <= 5);
  const byStrength = (
    left: (typeof hypotheses)[number],
    right: (typeof hypotheses)[number],
  ) =>
    right.markers.length - left.markers.length ||
    rank[right.style] - rank[left.style] ||
    left.markers[0].number - right.markers[0].number;
  const ordered = [
    ...[...(primary.length ? primary : full)].sort(byStrength),
    ...[...short].sort(byStrength),
  ];
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
    const counts = blocks.map((block) =>
      wordCount(text.slice(block.start, block.end)),
    );
    const boundedCounts = blocks.length > 1 ? counts.slice(0, -1) : counts;
    const medianWords = median(boundedCounts);
    const meanWords =
      boundedCounts.reduce((sum, value) => sum + value, 0) /
      boundedCounts.length;
    // Substance = median prose, or mean pulled up by real reasons
    // (concurrence tails sink the median: "ROWLES, J.A.: I agree."), or
    // at least one full prose paragraph (max) — quoted lists and endnote
    // ladders are uniformly tiny on all three.
    const substantive =
      medianWords >= 12 ||
      meanWords >= 20 ||
      Math.max(...boundedCounts) >= 30;
    if (hypothesis.shortComplete) {
      // The ladder IS the document. Case headers are bounded absolutely
      // (~500-900 chars) OR relatively (half the doc) — sub-1.5KB oral
      // rulings fail the ratio while 2-4KB costs rulings fail the
      // absolute, so accept either; a tail fragment in a 22KB doc fails
      // both plus the size cap.
      if (
        text.length <= 6000 &&
        (blocks[0].start <= 1200 || startRatio <= 0.5) &&
        Math.max(...counts) >= 30
      ) {
        return paragraphSourceBlocks(
          text,
          hypothesis.markers,
          markers,
          hypothesis.style,
        );
      }
      continue;
    }
    const substantiveRatio =
      counts.filter((count) => count >= 12).length / blocks.length;
    if (
      !substantive ||
      markerSpan < 0.05 ||
      (hypothesis.style === "bracket" &&
        text.length > 6000 &&
        startRatio > 0.7 &&
        substantiveRatio < 0.5)
    ) {
      continue;
    }
    if (hypothesis.style !== "bracket" && substantiveRatio < 0.7) continue;
    if (
      hypothesis.style === "bare" &&
      (medianWords < 20 || markerSpan < 0.15 || startRatio > 0.7)
    ) {
      continue;
    }
    return paragraphSourceBlocks(
      text,
      hypothesis.markers,
      markers,
      hypothesis.style,
    );
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

function flatSectionMarkers(
  text: string,
  allowHyphen: boolean,
): SectionMarker[] {
  return computeStatuteSpine(text, allowHyphen).map((marker: SpineMark) => ({
    label: marker.label,
    start: marker.start,
    contentStart: marker.contentStart,
    source: "flat" as const,
  }));
}

function lawSectionBlocks(
  text: string,
  name: string | null | undefined,
): SourceDocBlock[] {
  const allowHyphen =
    /\b(?:rules?|regulations?|r[eè]glements?)\b/iu.test(name ?? "");
  const emphasis = emphasisSectionMarkers(text);
  const flat = flatSectionMarkers(text, allowHyphen);
  let selected: SectionMarker[];
  if (!emphasis.length) {
    selected = flat;
  } else if (!flat.length) {
    selected = emphasis;
  } else {
    const emphasisByOccurrence = new Set(
      emphasis.map(
        ({ label, contentStart }) =>
          `${label.toLowerCase()}:${contentStart}`,
      ),
    );
    if (
      !flat.some(({ label, contentStart }) =>
        emphasisByOccurrence.has(`${label.toLowerCase()}:${contentStart}`),
      )
    ) {
      selected = emphasis;
    } else {
      const byLabel = new Map(
        flat.map((marker) => [marker.label.toLowerCase(), marker] as const),
      );
      for (const marker of emphasis) {
        const key = marker.label.toLowerCase();
        const existing = byLabel.get(key);
        if (!existing || existing.contentStart === marker.contentStart) {
          byLabel.set(key, marker);
        }
      }
      const combined = [...byLabel.values()].sort(
        (left, right) => left.start - right.start,
      );
      selected = coherentSectionMarkers(combined) ? combined : emphasis;
    }
  }

  const ranges = statusRangeMarkers(text, allowHyphen);
  if (ranges.length) {
    const byLabel = new Map(
      selected.map((marker) => [marker.label.toLowerCase(), marker] as const),
    );
    for (const marker of ranges) {
      for (const alias of marker.aliases ?? []) {
        byLabel.delete(alias.toLowerCase());
      }
      byLabel.set(marker.label.toLowerCase(), marker);
    }
    const combined = [...byLabel.values()].sort(
      (left, right) => left.start - right.start,
    );
    if (coherentSectionMarkers(combined)) selected = combined;
  }
  return sectionBlocksFromMarkers(text, selected);
}

function coherentSectionMarkers(markers: SectionMarker[]) {
  const dottedOrder = dottedOrderForSource(
    markers.map(({ label }) => label),
  );
  return !!dottedOrder && markers.every(
    (marker, index) =>
      index === 0 ||
      compareStatuteLabels(
        markers[index - 1].label,
        marker.label,
        dottedOrder,
      ) < 0,
  );
}

/**
 * The prose case spine (paragraphs, reporter pages), shared with the
 * native-markup compiler as the heuristic fallback for whatever a provider's
 * markup does not label.
 */
export function a2ajCaseBlocks(input: {
  text: string;
  citation?: string | null;
  alternateCitation?: string | null;
  dataset?: string | null;
}): SourceDocBlock[] {
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
      blocks: a2ajCaseBlocks(input),
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

  return createSourceDoc({
    ...identity,
    text: input.text,
    blocks: lawSectionBlocks(input.text, input.name),
  });
}
