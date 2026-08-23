import { grammarRegExp, grammarTable } from "./grammarCorpus";

/** Canonical corpus identity key; keep every consumer on this one normalizer. */
export function citationLookupKey(value: string): string {
  let normalized = (value || "").normalize("NFKC")
    .replace(/[–—]/gu, "-")
    .replace(/(?<=\d)\.(?=\d)/gu, "dot")
    .replace(/(?<=\d)-(?=\d)/gu, "dash")
    .replace(/(?<=\d)\/(?=\d)/gu, "slash");
  return normalized.toLowerCase().replace(/ß/gu, "ss").replace(/[^a-z0-9]+/gu, "");
}

export type CitationMatch = { text: string; start: number; end: number };

// Detection only: identification still goes through citationLookupKey/caselawCitator.
const CITATION_IN_TEXT_SOURCE = [
  String.raw`\b(?:19|20)\d{2}\s+[A-Z]{2,8}\s+\d+\b`,
  String.raw`\[\d{4}\]\s+[A-Z](?:\.[A-Z]){1,4}\.?\s+No\.?\s+\d+(?:\s+\([A-Z.]+\))?`,
  String.raw`\[\d{4}\]\s+(?:\d+\s+)?[A-Z][A-Za-z.]{1,12}(?:\s+[A-Z][A-Za-z.]{0,12}){0,3}\s+\d+`,
  String.raw`\b\d+\s+[A-Z][A-Za-z.']{1,14}\s*(?:\(\d[a-z]{0,2}\))?\s+\d+\b`,
  String.raw`\bCanLII\s+\d+\b`,
  String.raw`\(\d{4}\),?\s+\d+\s+[A-Z][A-Za-z.]{1,14}`,
].join("|");
const CITATION_IN_TEXT = new RegExp(CITATION_IN_TEXT_SOURCE, "gu");
const CITATION_IN_TEXT_TEST = new RegExp(CITATION_IN_TEXT_SOURCE, "u");
const US_CITATION_IDS = [
  "cite.us.reporter.full",
  "cite.us.reporter.short",
  "cite.us.reporter.custom.full",
  "cite.us.reporter.custom.short",
  "cite.us.journal.full",
  "cite.us.journal.short",
  "cite.us.law.full",
  "cite.us.law.short",
] as const;
let usCitationPatterns: RegExp[] | undefined;

const STANDARD_FULL_CANDIDATE =
  /(?=(?<citation>(?<![A-Za-z0-9])(?<volume>[1-9][0-9]*) (?<reporter>[^;\r\n]{1,180}?),? (?<page>[0-9]+|_+)(?![A-Za-z0-9])))/g;
const STANDARD_SHORT_CANDIDATE =
  /(?=(?<citation>(?<![A-Za-z0-9])(?<volume>[1-9][0-9]*) (?<reporter>[^;\r\n]{1,180}?),? at\s?(?:p(?:\.|age)?)? (?<page>[0-9]+|_+)(?![A-Za-z0-9])))/g;
const COMMON_US_LAW =
  /(?<![A-Za-z0-9])\d+\s+U\.?\s*S\.?\s*C\.?(?:\s*§+\s*|\s+)\d(?:[A-Za-z0-9().-]*[A-Za-z0-9)])?(?![A-Za-z0-9])/g;
const RESIDUAL_US_CUE = /§|\b(?:admin\.|cas\.|code|comp\.|gov't|lab\.|misc\.?|reg\.|stat\.|t\.?c\.?m\.?)\b/giu;
let standardSurfaces: ReadonlyMap<string, "journal" | "reporter"> | undefined;

function splitLiteralAlternation(source: string): string[] {
  const inner = source.startsWith("(?:") && source.endsWith(")")
    ? source.slice(3, -1)
    : source;
  const values: string[] = [];
  let start = 0;
  let escaped = false;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "|") {
      values.push(inner.slice(start, index));
      start = index + 1;
    }
  }
  values.push(inner.slice(start));
  return values;
}

function usStandardSurfaces(): ReadonlyMap<string, "journal" | "reporter"> {
  if (standardSurfaces) return standardSurfaces;
  const defs = grammarTable("citations").defs;
  const decoded = new Map<string, "journal" | "reporter">();
  for (const [name, kind] of [
    ["us_reporters", "reporter"],
    ["us_journals", "journal"],
  ] as const) {
    for (const source of splitLiteralAlternation(defs[name])) {
      const key = source
        .replaceAll(String.raw`\s*`, "")
        .replaceAll(" ", "")
        .replace(/\\(.)/g, "$1");
      // Journal is the deterministic product classification for four
      // strings that reporters-db authors in both catalogues.
      if (kind === "journal" || !decoded.has(key)) decoded.set(key, kind);
    }
  }
  standardSurfaces = decoded;
  return decoded;
}

function pushMatch(found: CitationMatch[], match: RegExpExecArray): void {
  found.push({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  });
}

function standardUsMatches(value: string): CitationMatch[] {
  const surfaces = usStandardSurfaces();
  const found: CitationMatch[] = [];
  for (const pattern of [STANDARD_SHORT_CANDIDATE, STANDARD_FULL_CANDIDATE]) {
    for (const match of value.matchAll(pattern)) {
      const citation = match.groups?.citation;
      const reporter = match.groups?.reporter;
      if (!citation || !reporter || !surfaces.has(reporter.replace(/\s+/g, ""))) continue;
      found.push({ text: citation, start: match.index, end: match.index + citation.length });
    }
  }
  return found;
}

function usFallbackRanges(value: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();
  for (const cue of value.matchAll(RESIDUAL_US_CUE)) {
    const start = value.lastIndexOf("\n", cue.index - 1) + 1;
    const nextBreak = value.indexOf("\n", cue.index + cue[0].length);
    const end = nextBreak < 0 ? value.length : nextBreak;
    const key = `${start}:${end}`;
    if (!seen.has(key)) { seen.add(key); ranges.push({ start, end }); }
  }
  return ranges;
}

function usPatterns(): RegExp[] {
  usCitationPatterns ??= US_CITATION_IDS.map((id) =>
    grammarRegExp("citations", id, "g"));
  return usCitationPatterns;
}

export function citationsInText(
  text: string,
  options: { extendedUsFallback?: boolean } = {},
): CitationMatch[] {
  const value = text || "";
  const found = [...value.matchAll(CITATION_IN_TEXT)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  found.push(...standardUsMatches(value));
  COMMON_US_LAW.lastIndex = 0;
  for (let match = COMMON_US_LAW.exec(value); match; match = COMMON_US_LAW.exec(value)) {
    pushMatch(found, match);
  }
  for (const range of options.extendedUsFallback === false ? [] : usFallbackRanges(value)) {
    const candidate = value.slice(range.start, range.end);
    for (const pattern of usPatterns()) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(candidate); match; match = pattern.exec(candidate)) {
        found.push({ text: match[0], start: range.start + match.index, end: range.start + match.index + match[0].length });
      }
    }
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const resolved: CitationMatch[] = [];
  for (const match of found) {
    const previous = resolved.at(-1);
    if (previous && match.start < previous.end) continue;
    resolved.push(match);
  }
  return resolved;
}

export function hasCitationInText(text: string): boolean {
  return CITATION_IN_TEXT_TEST.test(text || "") || citationsInText(text).length > 0;
}
