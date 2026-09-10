/**
 * Authorities-split benchmark core: ALR gold loader, the deterministic
 * projection from Beaver's native citation occurrences to a footnote
 * partition, and the ALR scoring rules.
 *
 * Gold is read in place from Eli's ALR-Quote-Verifier checkout; nothing is
 * copied into this repository.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { structureNative } from "../../backend/src/lib/structureNative";

export const alrRoot = () => process.env.ALR_QUOTE_VERIFIER_ROOT?.trim() ||
  "C:/Users/elias/Desktop/Martys Qote Verifier/ALR-Quote-Verifier";
const goldDir = () => path.join(alrRoot(), "dev", "benchmarks");

export type GoldRow = {
  id: string;
  sourceDoc: string;
  footnoteNumber: string;
  text: string;
  expected: string[];
  acceptable: string[][];
  tags: string[];
};

const readJsonl = (file: string) => readFileSync(file, "utf8").split(/\r?\n/u)
  .filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);

/** `fast_split_*` gold rows: footnote text plus its accepted citation partition. */
export function loadSplitGold(name: string): GoldRow[] {
  return readJsonl(path.join(goldDir(), name)).flatMap((row) => {
    const text = String(row.verbatim_footnote_text || row.footnote_text || "");
    const expected = (row.verbatim_expected_parts || row.expected_verbatim_parts) as string[];
    if (!text || !Array.isArray(expected) || !expected.length) return [];
    if (row.status && row.status !== "accepted") return [];
    return [{
      id: String(row.id), sourceDoc: String(row.source_doc ?? ""),
      footnoteNumber: String(row.footnote_number ?? ""), text,
      expected: expected.map(String),
      acceptable: ((row.acceptable_partitions as string[][]) ?? [])
        .filter(Array.isArray).map((partition) => partition.map(String)),
      tags: ((row.tags as string[]) ?? []).map(String),
    }];
  });
}

export type PinpointGold = { id: string; partText: string; kind: string;
  fragments: string[]; pages: number[] };

/** `field_gold_provisional.jsonl` parts, minus any field still marked `needs_human`. */
export function loadPinpointGold(name = "field_gold_provisional.jsonl"): PinpointGold[] {
  return readJsonl(path.join(goldDir(), name)).flatMap((row) =>
    ((row.parts as Array<Record<string, any>>) ?? []).flatMap((part) => {
      const fields = part.fields ?? {};
      const fragments = fields.pinpoint_fragments, pages = fields.page_pinpoints;
      if (!fragments || !pages) return [];
      if (fragments.status === "needs_human" || pages.status === "needs_human") return [];
      return [{
        id: `${row.id}#${part.part_index}`, partText: String(part.part_text ?? ""),
        kind: String(fields.kind?.value ?? ""),
        fragments: (fragments.value ?? []).map(String),
        pages: (pages.value ?? []).map(Number).filter(Number.isFinite),
      }];
    }));
}

/* ---------------------------------------------------------------- splitter */

type Anchor = { start: number; end: number };

const depthAt = (text: string, index: number) => {
  let depth = 0, quoted = false;
  for (const character of text.slice(0, index)) {
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
    else if (character === "\u201c") quoted = true;
    else if (character === "\u201d") quoted = false;
    else if (character === "\"") quoted = !quoted;
  }
  return depth + (quoted ? 1 : 0);
};

/**
 * Cut the gap between two adjacent authority anchors. Semicolons are the
 * top-level delimiter and are dropped (the gold partitions drop them too);
 * a sentence period stays with the left part. Anything else — a comma, a
 * parenthetical lead-in such as "(citing" — is not a boundary.
 */
function cutBetween(text: string, gapStart: number, gapEnd: number) {
  if (depthAt(text, gapEnd) > 0) return null;
  const gap = text.slice(gapStart, gapEnd);
  const semicolon = gap.lastIndexOf(";");
  if (semicolon >= 0) return { left: gapStart + semicolon, right: gapStart + semicolon + 1 };
  // A sentence end, not an abbreviation: the period must not follow a
  // single-letter token ("e.g.", "v.") and must open a new sentence.
  const sentence = /(?<![\s.][A-Za-z])\.[\s\u00a0]+(?=[A-Z\u201c"(\d])/gu;
  let last = -1, matched: RegExpExecArray | null;
  while ((matched = sentence.exec(gap))) last = matched.index;
  if (last >= 0) return { left: gapStart + last + 1, right: gapStart + last + 1 };
  return null;
}

/**
 * Beaver's deterministic split: every citation occurrence and every
 * supra/ibid reference is an authority anchor; the footnote is partitioned at
 * the delimiters between consecutive anchors, so every character of the
 * footnote lands in exactly one part.
 */
export function authorityAnchors(text: string): Anchor[] {
  const native = structureNative();
  const raw: Anchor[] = [
    ...native.citationOccurrencesInText(text),
    ...native.authorityReferencesInText(text),
  ].map(({ start, end }) => ({ start, end })).sort((left, right) =>
    left.start - right.start || right.end - left.end);
  return raw.filter((anchor, index) =>
    !raw.slice(0, index).some((prior) => prior.end > anchor.start));
}

export function splitFootnote(text: string): string[] {
  const anchors = authorityAnchors(text);
  if (anchors.length < 2) return text.trim() ? [text] : [];
  const parts: string[] = []; let from = 0;
  anchors.slice(0, -1).forEach((anchor, index) => {
    const cut = cutBetween(text, anchor.end, anchors[index + 1].start);
    if (!cut) return;
    parts.push(text.slice(from, cut.left)); from = cut.right;
  });
  parts.push(text.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/* ----------------------------------------------------------------- scoring */

export const normPart = (value: string) => String(value ?? "").replace(/\s+/gu, " ").trim();
export const normForMatch = (value: string) => normPart(value).replace(/;+$/u, "").trim();
const normPartition = (parts: string[]) => parts.map(normForMatch).filter(Boolean);
const coreCountText = (value: string) => normPart(value).replace(/[\s;]+/gu, "");

const counter = (value: string) => {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return counts;
};
const excess = (left: Map<string, number>, right: Map<string, number>) =>
  [...left].reduce((total, [key, count]) => total + Math.max(0, count - (right.get(key) ?? 0)), 0);

/** ALR `score_character_neutrality`: did the split lose or invent substantive text? */
export function charNeutrality(source: string, parts: string[]) {
  const sourceNorm = normPart(source);
  const joined = normPart(parts.map(normPart).filter(Boolean).join(" "));
  const sourceCore = coreCountText(source), actualCore = coreCountText(joined);
  const sourceCounts = counter(sourceCore), actualCounts = counter(actualCore);
  const loss = excess(sourceCounts, actualCounts), gain = excess(actualCounts, sourceCounts);
  return {
    charCountDelta: joined.length - sourceNorm.length,
    charCountNeutral: joined.length === sourceNorm.length,
    coreCharExact: sourceCore === actualCore,
    coreLossChars: loss, coreGainChars: gain,
    coreLossGainNeutral: loss === 0 && gain === 0,
  };
}

/** ALR `score_parts`: strict canonical match plus any `acceptable_partitions`. */
export function scoreParts(expected: string[], actual: string[], acceptable: string[][]) {
  const candidates = [normPartition(expected)];
  for (const partition of acceptable) {
    const normalized = normPartition(partition);
    if (normalized.length && !candidates.some((seen) => seen.join("\0") === normalized.join("\0")))
      candidates.push(normalized);
  }
  const [canonical] = candidates, actualNorm = normPartition(actual);
  const same = (partition: string[]) => partition.join("\0") === actualNorm.join("\0");
  const matchedIndex = candidates.findIndex(same);
  return {
    expectedCount: canonical.length, actualCount: actualNorm.length,
    strictCountMatch: canonical.length === actualNorm.length,
    countMatch: candidates.some((partition) => partition.length === actualNorm.length),
    strictExactMatch: same(canonical),
    tolerantPartitionMatch: matchedIndex >= 0,
    overSplit: actualNorm.length > canonical.length,
    underSplit: actualNorm.length < canonical.length,
    canonical, actualNorm,
  };
}

/** Exact-span TP: gold and produced parts matched as multisets of normalized text. */
export function spanOverlap(expected: string[], actual: string[]) {
  const remaining = counter(""), gold = normPartition(expected), produced = normPartition(actual);
  for (const part of gold) remaining.set(part, (remaining.get(part) ?? 0) + 1);
  let truePositives = 0;
  for (const part of produced) {
    const count = remaining.get(part) ?? 0;
    if (count > 0) { truePositives += 1; remaining.set(part, count - 1); }
  }
  return { truePositives, goldParts: gold.length, producedParts: produced.length };
}

/* --------------------------------------------------------------- pinpoints */

export type Pinpoint = { kind: string; value: string };
const pinpointKey = (pinpoint: Pinpoint) => `${pinpoint.kind}:${pinpoint.value}`;

/** ALR fragments are CanLII anchors (`par38`, `sec49.2`); pages are integers. */
export function goldPinpoints(row: PinpointGold): Pinpoint[] {
  return [
    ...row.fragments.flatMap((fragment) => {
      const matched = /^(par|sec)(.+)$/u.exec(fragment.trim());
      return matched ? [{ kind: matched[1] === "par" ? "paragraph" : "section",
        value: matched[2] }] : [];
    }),
    ...row.pages.map((page) => ({ kind: "page", value: String(page) })),
  ];
}

export function nativePinpoints(text: string): Pinpoint[] {
  const native = structureNative();
  return [
    ...native.citationOccurrencesInText(text).flatMap((occurrence) => occurrence.pinpoints),
    ...native.authorityReferencesInText(text).flatMap((reference) => reference.pinpoints),
  ].map((pinpoint) => ({ kind: pinpoint.kind, value: pinpoint.text.trim() }));
}

/**
 * ALR gold expands a page range (`at 110-111`) into every page; the native
 * pinpoint grammar emits the two endpoints. Collapsing each side's contiguous
 * numeric runs to their endpoints compares the two symmetrically.
 */
export function endpointNormalized(pinpoints: Pinpoint[]): string[] {
  const byKind = new Map<string, number[]>(); const other: string[] = [];
  for (const pinpoint of pinpoints) {
    const value = Number(pinpoint.value);
    if (!Number.isInteger(value)) { other.push(pinpointKey(pinpoint)); continue; }
    byKind.set(pinpoint.kind, [...(byKind.get(pinpoint.kind) ?? []), value]);
  }
  const runs = [...byKind].flatMap(([kind, values]) => {
    const sorted = [...new Set(values)].sort((left, right) => left - right);
    return sorted.flatMap((value, index) =>
      index && value === sorted[index - 1] + 1 && sorted[index + 1] === value + 1
        ? [] : [`${kind}:${value}`]);
  });
  return [...runs, ...other].sort();
}

export const sameSet = (left: string[], right: string[]) =>
  left.join("\0") === right.join("\0");
