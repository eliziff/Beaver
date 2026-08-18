import {
  createSourceDoc,
  createTextSourceDoc,
  sourceDocPhraseSpans,
  tokenizeSourceText,
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
 * provider anchor. When `unofficial_text` is present it remains the immutable
 * rendition: provider section-map labels become native only when their text
 * aligns uniquely inside it. A map alone remains a valid section-granular
 * rendition. Everything derived from prose -
 * the case paragraph spine, emphasis-marked statute sections, and every nested
 * subsection/paragraph/subparagraph label - is `heuristic`.
 *
 * Statute strategy:
 *   1. one whole-text marker overlay: the shared flat spine plus Markdown
 *      emphasis markers (`**231**`, `**A.01.001**`), with emphasis winning
 *      only an exact locator collision.
 *   2. uniquely aligned provider-map labels replace matching heuristic blocks
 *      and add exact missing blocks without replacing the full rendition.
 *   3. provider section map alone (native spine, heuristic children).
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

function providerSectionChildren(
  label: string,
  text: string,
  offset: number,
  sectionEnd: number,
) {
  const children = childMarkers(text);
  const leading = new RegExp(
    String.raw`^[ \t]*${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[ \t]*\((${CHILD_TOKEN})\)(?=\s)`,
    "u",
  ).exec(text);
  if (leading) {
    children.unshift({ token: leading[1], start: leading[0].length - 1 });
  }
  return childBlocks(label, children, offset, sectionEnd);
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
    // Some corpora keep the number in the body ("34(1) Parent ..."); the
    // A2AJ section map strips it and opens with "(1) ...", which the
    // line-anchored scan already catches at offset 0.
    blocks.push(...providerSectionChildren(label, text, position, end));
    position += text.length;
  }
  return { text: pieces.join(""), blocks };
}

/**
 * Overlay provider section evidence without changing the whole-document
 * rendition. Content must occur exactly once. A reconstructed locator supplies
 * safe outer bounds; a missing locator is added only when the provider value
 * itself is a byte-exact slice, because token alignment alone cannot recover
 * punctuation or whitespace boundaries.
 */
function overlaySectionMap(
  text: string,
  reconstructed: SourceDocBlock[],
  sectionMap: Record<string, string>,
) {
  const blocks = [...reconstructed];
  const searchDoc = createTextSourceDoc(text);
  const entries = Object.entries(sectionMap)
    .map(([rawLabel, rawText]) => ({
      label: rawLabel.trim(),
      text: rawText,
    }))
    .filter(
      ({ label, text: value }) =>
        label &&
        value.trim() &&
        !/^\[blank\]$/iu.test(value.trim()),
    );
  const labelCounts = new Map<string, number>();
  for (const { label } of entries) {
    const key = label.toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }

  for (const { label, text: providerText } of entries) {
    const providerLabel = `sec${label}`;
    const key = providerLabel.toLowerCase();
    if (labelCounts.get(label.toLowerCase()) !== 1) continue;
    const providerTokens = tokenizeSourceText(providerText);
    if (!providerTokens.length) continue;
    const matches = sourceDocPhraseSpans(
      searchDoc,
      providerTokens.map(({ word }) => word),
      { limit: 2 },
    );
    if (matches.length !== 1) continue;
    const [match] = matches;
    const exactStart = match.start - providerTokens[0].start;
    const exactEnd = exactStart + providerText.length;
    const exact =
      exactStart >= 0 &&
      text.slice(exactStart, exactEnd) === providerText;
    const matchingBlocks = blocks
      .map((block, index) => ({ block, index }))
      .filter(
        ({ block }) =>
          block.kind === "section" &&
          !block.parentLabel &&
          [block.label, ...(block.aliases ?? [])].some(
            (candidate) => candidate.toLowerCase() === key,
          ),
      );
    if (matchingBlocks.length > 1) continue;
    if (matchingBlocks.length === 1) {
      const { block, index } = matchingBlocks[0];
      if (match.start < block.start || match.end > block.end) continue;
      blocks[index] = { ...block, origin: "native" };
      if (
        exact &&
        block.label.toLowerCase() === key &&
        PROVIDER_PROVISION_LABEL_RE.test(label)
      ) {
        for (let position = blocks.length - 1; position >= 0; position -= 1) {
          const child = blocks[position];
          if (
            child.parentLabel?.toLowerCase() === key &&
            child.start >= block.start &&
            child.end <= block.end
          ) {
            blocks.splice(position, 1);
          }
        }
        blocks.push(
          ...providerSectionChildren(
            label,
            providerText,
            exactStart,
            exactEnd,
          ),
        );
      }
      continue;
    }

    if (!exact) continue;
    blocks.push({
      kind: "section",
      label: providerLabel,
      start: exactStart,
      end: exactEnd,
      origin: "native",
    });
    if (PROVIDER_PROVISION_LABEL_RE.test(label)) {
      blocks.push(
        ...providerSectionChildren(
          label,
          providerText,
          exactStart,
          exactEnd,
        ),
      );
    }
  }

  return blocks.sort(
    (left, right) =>
      left.start - right.start ||
      Number(!!left.parentLabel) - Number(!!right.parentLabel),
  );
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
type CaseParagraphMode = "generic" | "a2aj" | "courtlistener";
export type CaseBlockExcludedRange = Readonly<{ start: number; end: number }>;
const DOT_PROVISION_OPENING_RE =
  /^\d{1,4}\.\s+\(\d{1,4}\)\s+/u;
const PROVISION_LANGUAGE_RE =
  /\b(?:Act|Code|Regulations?|Rules?|shall|must)\b/iu;
const TIGHT_DOT_PARAGRAPH_MARK_RE =
  /^[ \t]*(\d{1,4})\.(?=\p{Lu})/gmu;
const COURTLISTENER_GLYPH_PARAGRAPH_MARK_RE =
  /^[ \t]*[¶\u0095•][ \t]*(\d{1,4})(?=\s|[.,;:—-]|$)/gmu;

function wordCount(text: string, lettersOnly = false) {
  const pattern = lettersOnly
    ? /\p{L}+(?:['’][\p{L}]+)*/gu
    : /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  return text.match(pattern)?.length ?? 0;
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

/**
 * Is this short ladder the document's paragraph numbering, rather than one
 * numbered fragment among several?
 *
 * The question used to be asked as "are there no other markers at all", which
 * a reported citation answers wrongly: `[1936] SCR 4` and `[2021] 1 SCR 1`
 * print the year at line start, so it parses as a marker and every modern
 * four-paragraph SCC ruling failed. Ask it of the ladders instead — no other
 * marker may form a run, and none may carry a number this ladder could have
 * continued. A lone year is neither.
 */
function soleLadder(
  scope: NumberedMarker[],
  markers: NumberedMarker[],
  scopes: NumberedMarker[][],
) {
  const last = scope[scope.length - 1].number;
  return (
    scopes.every((other) => other === scope || other.length === 1) &&
    markers.every(
      (marker) =>
        scope.includes(marker) || marker.number < 1 || marker.number > last + 1,
    )
  );
}

/**
 * Weights for the paragraph-label chain, mirroring the universal legal PDF
 * engine's footnote backbone (`select_label_backbone` in
 * legalpdf_engine/footnote_pairing.py). Evidence is priced rather than gated,
 * so the spine is whichever ladder the document argues for most strongly
 * instead of whichever one a threshold happens to admit.
 *
 * Two orderings were tried before this and both failed, in opposite
 * directions, measured over all 224,972 A2AJ case documents: preferring
 * early-opening ladders as a tier let a five-marker overview outrank the
 * hundred-marker spine below it (340 decisions, up to 115 paragraphs each),
 * and ranking on length alone pushed 7,576 decisions off paragraph 1.
 *
 * Neither is answered by pricing the opening number, because on a source that
 * renders every glyph "the spine starts at 1" is not a preference to be
 * outbid — it is an invariant. A chain may only begin at paragraph 1, so the
 * score decides one question only: among the ladders that do start at 1,
 * which is the document's spine. Being unable to find the 1 means something
 * else is wrong (usually a heading-joined `[1]`, which is a candidate here),
 * and relaxing the requirement would only hide that.
 */
const SPINE_SCORE = {
  /** A marker the source itself put at the start of a line. */
  lineStart: 1,
  /** Recovered from `II. Judicial History [6]` — real, but weaker evidence. */
  headingJoined: 0.6,
  /** Recovered from a sentence-shaped heading; weaker still. */
  sentenceJoined: 0.35,
  /** Paid once per consecutive link, rewarding an unbroken ladder. */
  adjacentLink: 0.3,
} as const;

type SpineCandidate = ParagraphMarker & { score: number };

/**
 * Every marker the document offers for one style, priced by how it presents
 * itself. Heading-joined labels enter as ordinary weaker candidates rather
 * than through a separate recovery pass with its own windowing rules.
 */
function spineCandidates(
  text: string,
  eligible: ParagraphMarker[],
  style: ParagraphMarker["style"],
): SpineCandidate[] {
  const line = eligible
    .filter((marker) => marker.style === style)
    .map((marker) => ({ ...marker, score: SPINE_SCORE.lineStart }));
  if (style === "bare") return line;
  const known = new Set(line.map(({ start }) => start));
  const joined = headingJoinedCandidates(text, known, style).map(
    (candidate) => ({
      number: candidate.number,
      start: candidate.start,
      style,
      score: candidate.formal
        ? SPINE_SCORE.headingJoined
        : SPINE_SCORE.sentenceJoined,
    }),
  );
  return [...line, ...joined];
}

/**
 * The best-scoring chain of consecutive paragraph numbers rooted at 1.
 *
 * Neither end is negotiable. A chain may only open on paragraph 1, and a hole
 * ends it rather than being bridged — on a source that renders every glyph,
 * both a missing 1 and a missing middle mean the evidence is not what it
 * appears to be. What the score decides is which of the competing ladders
 * rooted at 1 the document actually argues for: a quoted ladder, a table of
 * paragraph cross-references or a stray year forms its own chain and loses on
 * weight, with no bespoke gate needed to exclude it.
 */
function selectSpineChain(candidates: SpineCandidate[]) {
  const ordered = [...candidates].sort(
    (left, right) => left.start - right.start || left.number - right.number,
  );
  const empty = { chain: [] as SpineCandidate[], score: 0 };
  if (!ordered.length) return empty;
  const best: number[] = [];
  const parent: number[] = [];
  // Best chain ending on each value so far in reading order. Only `value - 1`
  // can extend a chain, so the predecessor lookup is a single probe.
  const bestByValue = new Map<number, number>();
  let group = 0;
  while (group < ordered.length) {
    let end = group;
    while (end < ordered.length && ordered[end].start === ordered[group].start) {
      end += 1;
    }
    for (let index = group; index < end; index += 1) {
      const candidate = ordered[index];
      // Only paragraph 1 may open a chain; everything else must be reached.
      best[index] =
        candidate.number === 1 ? candidate.score : Number.NEGATIVE_INFINITY;
      parent[index] = -1;
      const previous = bestByValue.get(candidate.number - 1);
      if (previous !== undefined && best[previous] > Number.NEGATIVE_INFINITY) {
        const linked =
          best[previous] + candidate.score + SPINE_SCORE.adjacentLink;
        if (linked > best[index] + 1e-9) {
          best[index] = linked;
          parent[index] = previous;
        }
      }
    }
    // Deferred so two candidates sharing an offset cannot chain to each other.
    for (let index = group; index < end; index += 1) {
      const prior = bestByValue.get(ordered[index].number);
      if (prior === undefined || best[index] > best[prior] + 1e-9) {
        bestByValue.set(ordered[index].number, index);
      }
    }
    group = end;
  }
  let tail = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (best[index] === Number.NEGATIVE_INFINITY) continue;
    if (tail === -1 || best[index] > best[tail] + 1e-9) tail = index;
  }
  if (tail === -1) return empty;
  const chain: SpineCandidate[] = [];
  for (let cursor = tail; cursor !== -1; cursor = parent[cursor]) {
    chain.push(ordered[cursor]);
  }
  chain.reverse();
  return { chain, score: best[tail] };
}

/**
 * Is this short chain the document's numbering, or one fragment among several?
 *
 * Being rooted at 1 does not settle it: a quoted statutory provision numbered
 * `1.` `2.` is rooted too. The chain must also be the only ladder its style
 * offers — nothing left over may carry a number this chain could have
 * continued, and nothing left over may form a run of its own. A lone reported
 * year is neither; the `[4] [5] [6]` below a fractured `[1] [2]` is both.
 */
function soleChain(
  chain: readonly SpineCandidate[],
  candidates: readonly SpineCandidate[],
) {
  const claimed = new Set(chain.map(({ start }) => start));
  const last = chain[chain.length - 1].number;
  const rest = candidates
    .filter(({ start }) => !claimed.has(start))
    .sort((left, right) => left.start - right.start);
  if (rest.some(({ number }) => number >= 1 && number <= last + 1)) {
    return false;
  }
  for (let index = 1; index < rest.length; index += 1) {
    if (rest[index].number > rest[index - 1].number) return false;
  }
  return true;
}

/**
 * The engine's endnote test (`detect_endnote_mode`), with character offset
 * standing in for page number. A ladder that lives entirely in the document's
 * tail is a note block, not the paragraph spine — the discrimination that
 * separates `CITT PR-2014-016a`'s `[1]..[137]` endnotes from real reasons.
 */
const ENDNOTE_TAIL_FRACTION = 0.75;
const ENDNOTE_MIN_LABELS = 8;
const ENDNOTE_TAIL_SHARE = 0.7;

function endnoteShaped(chain: readonly NumberedMarker[], length: number) {
  if (chain.length < ENDNOTE_MIN_LABELS || length <= 0) return false;
  const threshold = ENDNOTE_TAIL_FRACTION * length;
  const tail = chain.filter((marker) => marker.start > threshold).length;
  return tail / chain.length >= ENDNOTE_TAIL_SHARE;
}

/** A reset closes a CourtListener candidate instead of reviving an old list. */
function contiguousScopes(markers: NumberedMarker[]) {
  const scopes: NumberedMarker[][] = [];
  let current: NumberedMarker[] = [];
  for (const marker of markers) {
    if (
      current.length &&
      marker.number === current.at(-1)!.number + 1
    ) {
      current.push(marker);
      continue;
    }
    if (current.length) scopes.push(current);
    current = [marker];
  }
  if (current.length) scopes.push(current);
  return scopes;
}

function paragraphMarkers(text: string, mode: CaseParagraphMode) {
  const markers: ParagraphMarker[] = [];
  for (const match of text.matchAll(PARAGRAPH_MARK_RE)) {
    const [bracket, dot, bare] = match.slice(1);
    const style = bracket ? "bracket" : dot ? "dot" : "bare";
    markers.push({
      start: match.index,
      number: Number(bracket ?? dot ?? bare),
      // CourtListener uses bare and dotted Arabic labels interchangeably.
      style: mode === "courtlistener" && style === "bare" ? "dot" : style,
    });
  }
  if (mode === "courtlistener") {
    const knownStarts = new Set(markers.map(({ start }) => start));
    for (const pattern of [
      TIGHT_DOT_PARAGRAPH_MARK_RE,
      COURTLISTENER_GLYPH_PARAGRAPH_MARK_RE,
    ]) {
      for (const match of text.matchAll(pattern)) {
        if (knownStarts.has(match.index)) continue;
        markers.push({ number: Number(match[1]), start: match.index, style: "dot" });
      }
    }
  }
  return markers.sort((left, right) => left.start - right.start);
}

function outsideExcludedRanges<Marker extends NumberedMarker>(
  markers: Marker[],
  ranges: readonly CaseBlockExcludedRange[],
): Marker[] {
  const ordered = ranges
    .filter(({ end, start }) => end > start)
    .slice()
    .sort((left, right) => left.start - right.start);
  let index = 0;
  return markers.filter((marker) => {
    while (ordered[index] && ordered[index].end <= marker.start) index += 1;
    const range = ordered[index];
    return !range || marker.start < range.start || marker.start >= range.end;
  });
}

/**
 * `3. (1) ...` in a case rendition is a quoted statutory provision, not a
 * decision's dot-numbered paragraph. A subsection opening plus legislative
 * language is specific enough to exclude it even when the source quotes only
 * one provision.
 */
function quotedDotProvisionStarts(text: string, markers: ParagraphMarker[]) {
  const dots = markers.filter((marker) => marker.style === "dot");
  const quoted = new Set<number>();
  for (const marker of dots) {
    const next = text.indexOf("\n", marker.start);
    const line = text.slice(marker.start, next < 0 ? text.length : next);
    if (DOT_PROVISION_OPENING_RE.test(line) && PROVISION_LANGUAGE_RE.test(line)) {
      quoted.add(marker.start);
    }
  }
  return quoted;
}

const HEADING_MAX_LENGTH = 120;
const HEADING_LEVEL_WORD_CAP = 12;
/**
 * How long a level may run when nothing but its brevity says it is a heading.
 * Courts write sentence-case headings in two to four words — `Standard of
 * review`, `Decision under review`, `Factual background` — while prose that
 * happens to reach a paragraph number mid-line runs longer: `The court relied
 * on its earlier decision [3]`, `APPEAL from a judgment of the Court of Appeal
 * for Ontario [1]`. Six words is where the two populations separate.
 */
const SENTENCE_LEVEL_WORD_CAP = 6;

/**
 * A word a heading capitalises and prose does not. Only words of four letters
 * or more count: a heading leaves `of`, `the`, `and` and `for` in lower case,
 * so testing those would make every real title fail.
 */
const TITLE_WORD_RE = /^[^\p{L}]*\p{Lu}/u;

/**
 * Marks a heading does not carry. A semicolon or an exclamation joins or
 * exclaims a clause, and square braces are the corpus's own reporter and
 * editorial marks — `[Emphasis added.]`, or the paragraph numbers themselves,
 * which is what keeps a prose line that already opens with `[8]` from being
 * read as a heading for the `[12]` it cites later on.
 */
const NOT_IN_HEADING_RE = /[;!\[\]{}]/u;

/** How a heading level opens: on a capital letter, or on a digit. */
const LEVEL_OPENS_RE = /^[\p{Lu}\p{N}]/u;

/**
 * How prose closes and a heading does not. A trailing question mark is left
 * out deliberately: courts pose questions as headings — `Is there merit in the
 * appeal?` — and never end one with a full stop.
 */
const LEVEL_CLOSES_LIKE_PROSE_RE = /[.,;]$/u;
/**
 * A heading level opens with an enumerator: `II.`, `B.`, `3.`, `(2)`, `(iv)`.
 * Courts number the lower levels in lower case and close them with a bracket
 * as readily as with a stop — `a) Standard of Review`, `ii. Discussion`,
 * `b. Background` — so a single letter or a roman numeral of either case, and
 * either terminator, all count. A bare letter is admitted, which is also why
 * the level below must then begin with a real title word.
 */
const HEADING_ENUMERATOR_RE =
  /^(?:\([\p{L}\p{N}]{1,5}\)|\p{L}[.)]|[IVXLCDM]{1,4}[.)]|[ivxlcdm]{1,4}[.)]|\d{1,3}(?:\.\d{1,3})*[.)])$/u;

/** The word that must follow an enumerator for it to have opened a level. */
function headingLevelOpener(word: string | undefined) {
  return (
    !!word && !HEADING_ENUMERATOR_RE.test(word) && LEVEL_OPENS_RE.test(word)
  );
}

/**
 * One level of a heading path, once its enumerator has been taken off.
 *
 * A level is judged by its shape, not by the case of every word in it. Judging
 * it word by word was this grammar's largest defect: it required Title Case
 * throughout, and courts do not write headings that way. Measured over the
 * whole A2AJ corpus, that rule rejected `Standard of review`, `The law`,
 * `On appeal`, `Decision under review`, `A. Basis of the claim` and every
 * French heading — roughly a quarter of a million real headings — because each
 * carries a lowercase word after the first.
 *
 * What a heading does hold to is shape: it is short, it opens on a capital or
 * a digit, and it does not close the way a sentence closes. How short it may
 * be depends on how much else about it announces a heading.
 */
function headingLevel(level: readonly string[], enumerated = false) {
  if (!level.length || level.length > HEADING_LEVEL_WORD_CAP) return false;
  // A level that is nothing but its own enumerator is still a level: courts
  // set `II.` on a line of its own above the title it numbers. The same rule
  // is what lets a case-name heading parse, `R. v. Smith` splitting into `R.`
  // and `Smith` around the `v.`
  if (level.length === 1 && HEADING_ENUMERATOR_RE.test(level[0])) return true;
  const text = level.join(" ");
  if (!LEVEL_OPENS_RE.test(text) || LEVEL_CLOSES_LIKE_PROSE_RE.test(text)) {
    return false;
  }
  // A question announces itself, and courts pose long ones — `Did the
  // institution reasonably exercise its discretion?`. So does a colon, though
  // that also admits judicial attributions (`GILLESE J.A.:`, `BY THE COURT:`),
  // which are not headings at all; they are left in for now because recovering
  // the paragraph they precede is right, but whether they should be reaching
  // this grammar rather than a rule of their own is an open question.
  if (/[?:]$/u.test(text)) return true;
  // Title case says heading on its own and may run long. So does an enumerator
  // the author put there: `A. Allegation that clause 1 of the agreement was not
  // complied with` is a heading in sentence case running ten words, and prose
  // does not open on `A.` or `I.`. The short cap is for a level with nothing
  // but its brevity to recommend it, so a level that was numbered has already
  // stopped being that case and keeps the long cap instead.
  const titleCased = level.every(
    (word) =>
      word.replace(/[^\p{L}]/gu, "").length < 4 || TITLE_WORD_RE.test(word),
  );
  return titleCased || enumerated || level.length <= SENTENCE_LEVEL_WORD_CAP;
}

/**
 * A2AJ renders a decision's heading path inline, so a joined heading is not
 * one title but a stack of them: `II. Judicial History A. Judgments on the
 * Application ...`. Reading it as a single title is what the twelve-word cap
 * was measuring, and it is why real SCC headings were rejected.
 *
 * So parse the levels instead of widening the cap: split at enumerators, and
 * require every level to be heading-shaped — an unenumerated prefix is exactly
 * one level, which keeps single-title headings ("Qualified Privilege",
 * "COSTS") deciding as they always have.
 */
function looksLikeJoinedHeading(value: string) {
  const heading = value
    .trim()
    .replace(/^\([\p{L}\p{N}]+\)\s+/u, "");
  if (
    !heading ||
    heading.length > HEADING_MAX_LENGTH ||
    NOT_IN_HEADING_RE.test(heading)
  ) {
    return false;
  }
  const words = heading.split(/\s+/u);
  // `enumerated` records whether the author numbered this level, which is
  // evidence about the level that its own words no longer carry once the
  // enumerator has been split off.
  const levels: { words: string[]; enumerated: boolean }[] = [
    { words: [], enumerated: false },
  ];
  for (const [index, word] of words.entries()) {
    if (
      HEADING_ENUMERATOR_RE.test(word) &&
      headingLevelOpener(words[index + 1])
    ) {
      if (levels[levels.length - 1].words.length) {
        levels.push({ words: [], enumerated: true });
      } else {
        levels[levels.length - 1].enumerated = true;
      }
      continue;
    }
    levels[levels.length - 1].words.push(word);
  }
  return levels.every((level) => headingLevel(level.words, level.enumerated));
}

function looksLikeSentenceHeading(value: string, following: string) {
  const heading = value
    .trim()
    .replace(/^\([\p{L}\p{N}]+\)\s+/u, "");
  const words = heading.split(/\s+/u);
  return (
    heading.length <= 120 &&
    words.length >= 4 &&
    words.length <= 18 &&
    /^\p{Lu}/u.test(heading) &&
    words.some((word) => /^\p{Ll}/u.test(word)) &&
    !/[\[\].,;:!?]/u.test(heading) &&
    /^\s*\p{Lu}/u.test(following)
  );
}

type HeadingCandidate = ParagraphMarker & {
  formal: boolean;
  sentence: boolean;
};

function headingJoinedCandidates(
  text: string,
  knownStarts: ReadonlySet<number>,
  style: "bracket" | "dot",
): HeadingCandidate[] {
  const candidates: HeadingCandidate[] = [];
  const markerRe =
    style === "bracket" ? /\[(\d{1,4})\]/gu : /(\d{1,4})\.(?=\s)/gu;
  for (const match of text.matchAll(markerRe)) {
    if (knownStarts.has(match.index)) continue;
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const heading = text.slice(lineStart, match.index);
    const formal =
      looksLikeJoinedHeading(heading) &&
      (style === "bracket" || !/\./u.test(heading));
    const sentence =
      style === "bracket" &&
      looksLikeSentenceHeading(
        heading,
        text.slice(match.index + match[0].length),
      );
    if (!formal && !sentence) continue;
    candidates.push({
      number: Number(match[1]),
      start: match.index,
      style,
      formal,
      sentence,
    });
  }
  return candidates;
}

/**
 * A2AJ occasionally joins a heading to the numbered paragraph that follows:
 * `Qualified Privilege [63] ...` or `II. Judicial History [6] ...`. Recover a
 * missing marker only where the sequence itself asks for it: the number must
 * be absent from the line-start run, and its one recovered occurrence must sit
 * inside the gap its neighbours bracket.
 *
 * That window is the evidence. A candidate is admitted when it is the only
 * marker of its number *between* the two line-start markers that surround the
 * hole, not merely the only one in the document — a `[6]` in a later footnote
 * cannot veto the real heading-joined paragraph 6, and a `[6]` sitting outside
 * the gap can never fill it. Recovery runs before the strict +1 spine is
 * chosen, so a real heading join never splits it, and a hole with no evidence
 * still fractures the spine rather than being bridged.
 */
function recoverHeadingJoinedMarkers(
  text: string,
  markers: ParagraphMarker[],
  style: "bracket" | "dot",
) {
  const lineMarkers = markers.filter((marker) => marker.style === style);
  if (!lineMarkers.length) return lineMarkers;
  const candidates = headingJoinedCandidates(
    text,
    new Set(lineMarkers.map(({ start }) => start)),
    style,
  );
  const within = (number: number, from: number, to: number) =>
    candidates.filter(
      (candidate) =>
        candidate.number === number &&
        candidate.start > from &&
        candidate.start < to,
    );
  const recovered = new Map<number, ParagraphMarker>();
  const recover = (candidate: ParagraphMarker) => {
    recovered.set(candidate.start, candidate);
  };
  // Formal headings may fill a complete run of holes (e.g. `Costs 26.` then
  // `DETERMINATION 27.` before line-start `28.`). Every omitted number must
  // have exactly one matching formal heading in the gap, so a real source hole
  // is never guessed.
  for (let index = 1; index < lineMarkers.length; index += 1) {
    const before = lineMarkers[index - 1];
    const after = lineMarkers[index];
    if (before.number >= after.number) continue;
    const between: ParagraphMarker[] = [];
    for (let number = before.number + 1; number < after.number; number += 1) {
      const found = within(number, before.start, after.start).filter(
        (candidate) => candidate.formal,
      );
      if (found.length !== 1) {
        between.length = 0;
        break;
      }
      between.push(found[0]);
    }
    for (const candidate of between) recover(candidate);
  }
  // A sentence-style heading is intentionally narrower: one exactly bracketed
  // label filling a single hole, with an uppercase paragraph start.
  for (let index = 1; index < lineMarkers.length; index += 1) {
    const before = lineMarkers[index - 1];
    const after = lineMarkers[index];
    if (after.number !== before.number + 2) continue;
    const found = within(
      before.number + 1,
      before.start,
      after.start,
    ).filter((candidate) => candidate.sentence);
    if (found.length === 1) recover(found[0]);
  }
  const first = lineMarkers[0];
  const leading = within(first.number - 1, first.start - 2_000, first.start)
    .filter((candidate) => candidate.formal);
  if (leading.length === 1 && leading[0].number > 0) recover(leading[0]);
  return [...lineMarkers, ...recovered.values()].sort(
    (left, right) => left.start - right.start,
  );
}

/**
 * The pre-existing permissive fallback, still used by the generic prose path
 * (`generic`). It recovers against an already-chosen spine rather than before
 * scope selection, which is why the source-specific modes do not use it.
 */
function recoverHeadingJoinedParagraphs(
  text: string,
  spine: NumberedMarker[],
  style: "bracket" | "dot",
) {
  const knownStarts = new Set(spine.map(({ start }) => start));
  const candidates = new Map<number, NumberedMarker[]>();
  const markerRe =
    style === "bracket" ? /\[(\d{1,4})\]/gu : /(\d{1,4})\.(?=\s)/gu;
  for (const match of text.matchAll(markerRe)) {
    if (knownStarts.has(match.index)) continue;
    const number = Number(match[1]);
    let before: NumberedMarker | undefined;
    for (const marker of spine) {
      if (marker.start >= match.index) break;
      before = marker;
    }
    const after = spine.find((marker) => marker.start > match.index);
    const between =
      !!before && !!after && before.number < number && number < after.number;
    const leading =
      !before &&
      !!after &&
      number > 0 &&
      number < after.number &&
      after.number - number <= 2 &&
      after.start - match.index <= 2_000;
    if (!between && !leading) continue;
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const heading = text.slice(lineStart, match.index);
    const formal =
      looksLikeJoinedHeading(heading) &&
      (style === "bracket" || !/\./u.test(heading));
    const sentence =
      style === "bracket" &&
      !!before &&
      !!after &&
      before.number + 1 === number &&
      number + 1 === after.number &&
      looksLikeSentenceHeading(
        heading,
        text.slice(match.index + match[0].length),
      );
    if (!formal && !sentence) continue;
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
  recoverHeadings = false,
  extraBoundaries: readonly number[] = [],
) {
  const selected =
    recoverHeadings && style !== "bare"
      ? recoverHeadingJoinedParagraphs(text, spine, style)
      : spine;
  const boundaries = [
    ...new Set([
      ...allMarkers
        .filter((marker) => marker.style === style)
        .map(({ start }) => start),
      ...selected.map(({ start }) => start),
      ...extraBoundaries,
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

function paragraphBlocks(
  text: string,
  minRun = 5,
  mode: CaseParagraphMode = "generic",
  excludedRanges: readonly CaseBlockExcludedRange[] = [],
): SourceDocBlock[] {
  if (!text) return [];
  // `generic` is the prose fallback behind native markup and PDFs —
  // input whose glyphs may not all have survived. The source-specific modes
  // read a complete rendered text, so they alone assume an unbroken ladder.
  // Measured over all 224,972 A2AJ case documents, holding generic mode to the same
  // strict +1 rule cost 910 whole spines and rewrote 45,565 more.
  const strict = mode !== "generic";
  const markers = paragraphMarkers(text, mode);
  const visibleMarkers = outsideExcludedRanges(markers, excludedRanges);
  const quotedProvisionStarts = strict
    ? quotedDotProvisionStarts(text, visibleMarkers)
    : new Set<number>();
  const eligibleMarkers = visibleMarkers.filter(
    (marker) => !quotedProvisionStarts.has(marker.start),
  );
  const hypotheses: Array<{
    style: ParagraphMarker["style"];
    markers: NumberedMarker[];
    allMarkers: ParagraphMarker[];
    shortComplete: boolean;
    score: number;
  }> = [];
  for (const style of ["bracket", "dot", "bare"] as const) {
    // The rooted chain is for the A2AJ bulk corpus, whose text is a complete
    // rendered decision and which is the corpus this rule was measured against
    // (224,972 documents). CourtListener keeps its existing contiguous-run
    // selection: no CourtListener corpus is available to measure the rooted
    // rule on, and its own fixtures already pin a longest-run answer that
    // starts above 1, so imposing the invariant there would be a change made
    // blind rather than a change shown to be right.
    if (mode === "a2aj") {
      const scoped = spineCandidates(text, eligibleMarkers, style);
      const { chain, score } = selectSpineChain(scoped);
      // A ladder confined to the document's tail is a note block.
      if (chain.length < 2 || endnoteShaped(chain, text.length)) continue;
      if (chain.length >= minRun) {
        hypotheses.push({
          style,
          markers: chain,
          allMarkers: scoped,
          shortComplete: false,
          score,
        });
      } else if (style === "bracket" && soleChain(chain, scoped)) {
        // Complete short [1]..[N] ladders are real structure in short orders,
        // oral reasons and costs rulings, which minRun alone would discard.
        // Being rooted at 1 is not enough to admit one: a quoted statutory
        // provision numbered `1.` `2.` is rooted too, so the ladder must also
        // be the only numbering of its style the document offers.
        hypotheses.push({
          style,
          markers: chain,
          allMarkers: scoped,
          shortComplete: true,
          score,
        });
      }
      continue;
    }
    const recovered =
      strict && style !== "bare"
        ? recoverHeadingJoinedMarkers(text, eligibleMarkers, style)
        : eligibleMarkers.filter((marker) => marker.style === style);
    // Recovery scans the rendered source for a missing label. CourtListener
    // footnote containers are outside the decision spine, so do not let a
    // recovered candidate put them back after the initial fence.
    const styleMarkers = strict
      ? mode === "courtlistener"
        ? outsideExcludedRanges(recovered, excludedRanges)
        : recovered
      : markers.filter((marker) => marker.style === style);
    // A source-specific mode scopes on strict +1: a hole is filled by the
    // heading-joined evidence above or it fractures the spine, because gap
    // tolerance would silently advertise a paragraph range the source never
    // had. The lossy generic path keeps its tolerance.
    const scopes =
      mode === "courtlistener"
        ? contiguousScopes(styleMarkers)
        : monotoneScopes(styleMarkers, strict ? 1 : 8);
    for (const scope of scopes) {
      if (scope.length >= minRun) {
        hypotheses.push({
          style,
          markers: scope,
          allMarkers: strict ? styleMarkers : markers,
          shortComplete: false,
          score: 0, // scope selection ranks on length, not evidence weight
        });
      } else if (
        style === "bracket" &&
        scope.length >= 2 &&
        scope.every((marker, index) => marker.number === index + 1) &&
        (!strict || soleLadder(scope, styleMarkers, scopes))
      ) {
        // Complete short [1]..[N] ladders are real structure in short
        // orders / oral reasons / costs rulings — the full-sweep
        // none-queue inspection found 17/29 sampled "no structure" docs
        // were exactly this shape, killed by minRun. Contiguity from 1
        // excludes quoted-fragment ladders.
        hypotheses.push({
          style,
          markers: scope,
          allMarkers: strict ? styleMarkers : markers,
          shortComplete: true,
          score: 0, // scope selection ranks on length, not evidence weight
        });
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
  // Evidence is ranked by weight, and opening near paragraph 1 is only the
  // tiebreak inside `byStrength`. Filtering to early openers first — whether
  // as an exclusion or merely as a preceding tier — lets a five-marker
  // overview outrank the hundred-marker spine beneath it the moment recovery
  // finds a `[1]`: measured over the corpus that cost 340 A2AJ decisions up to
  // 115 paragraphs each (2016 ONCA 542 fell from 120 blocks to 5).
  const primary = full.filter((item) => item.markers[0].number <= 5);
  const byStrength = (
    left: (typeof hypotheses)[number],
    right: (typeof hypotheses)[number],
  ) =>
    right.markers.length - left.markers.length ||
    rank[right.style] - rank[left.style] ||
    left.markers[0].number - right.markers[0].number;
  // Every strict-mode chain is rooted at paragraph 1, so the opening number no
  // longer separates them: rank on the weight of the evidence instead, with
  // the style rank breaking exact ties.
  const byScore = (
    left: (typeof hypotheses)[number],
    right: (typeof hypotheses)[number],
  ) => right.score - left.score || rank[right.style] - rank[left.style];
  const ordered =
    mode === "a2aj"
    ? [...[...full].sort(byScore), ...[...short].sort(byScore)]
    : [
        ...[...(primary.length ? primary : full)].sort(byStrength),
        ...[...short].sort(byStrength),
      ];
  for (const hypothesis of ordered) {
    const allOffsets = (strict ? hypothesis.allMarkers : markers)
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
      wordCount(text.slice(block.start, block.end), mode === "courtlistener"),
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
          hypothesis.allMarkers,
          hypothesis.style,
          !strict,
          excludedRanges.map(({ start }) => start),
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
      hypothesis.allMarkers,
      hypothesis.style,
      !strict,
      excludedRanges.map(({ start }) => start),
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
 * The generic prose case fallback (paragraphs, reporter pages), shared with
 * native-markup compilers for whatever a provider's markup does not label.
 * A2AJ compilation opts into its stricter source-specific paragraph mode below.
 */
function caseBlocks(
  input: {
    text: string;
    citation?: string | null;
    alternateCitation?: string | null;
    dataset?: string | null;
  },
  mode: CaseParagraphMode = "generic",
  excludedRanges: readonly CaseBlockExcludedRange[] = [],
): SourceDocBlock[] {
  return [
    ...paragraphBlocks(input.text, 5, mode, excludedRanges),
    ...pageBlocks(
      input.text,
      reporterStartPage(input.citation, input.alternateCitation),
      (input.dataset ?? "").toUpperCase() === "SCC",
    ),
  ];
}

/** Generic fallback retained for native-markup, CourtListener and PDF paths. */
export function a2ajCaseBlocks(input: {
  text: string;
  citation?: string | null;
  alternateCitation?: string | null;
  dataset?: string | null;
}): SourceDocBlock[] {
  return caseBlocks(input);
}

/** CourtListener's rendered HTML needs source-specific paragraph fences. */
export function courtlistenerCaseBlocks(
  input: {
    text: string;
    citation?: string | null;
    alternateCitation?: string | null;
    dataset?: string | null;
  },
  excludedRanges: readonly CaseBlockExcludedRange[] = [],
): SourceDocBlock[] {
  return caseBlocks(input, "courtlistener", excludedRanges);
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
      blocks: caseBlocks(input, "a2aj"),
    });
  }

  if (
    !input.text.trim() &&
    input.sectionMap &&
    Object.keys(input.sectionMap).length
  ) {
    const mapped = sectionMapBlocks(input.sectionMap);
    if (mapped.blocks.length) {
      return createSourceDoc({
        ...identity,
        text: mapped.text,
        blocks: mapped.blocks,
      });
    }
  }

  const reconstructed = lawSectionBlocks(input.text, input.name);
  return createSourceDoc({
    ...identity,
    text: input.text,
    blocks:
      input.sectionMap && Object.keys(input.sectionMap).length
        ? overlaySectionMap(input.text, reconstructed, input.sectionMap)
        : reconstructed,
  });
}
