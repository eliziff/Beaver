/**
 * Deterministic prose-vs-authority-list classifier for citator edge
 * excerpts (research plan workstream D1; H12 stands-for machinery).
 *
 * A citing-context excerpt is usable as an ATTESTED CHARACTERIZATION of
 * the cited case only when it is prose (a court talking about the case),
 * not a string cite ("R. v. A, 2003 SCC 74; R. v. B, 2022 SCC 23; ...").
 * Measured on 3,000 random full-build edges (2026-07-30): cite-token
 * count p50=2 / p90=7 / p99=18; the list signature is >=3
 * semicolon-separated segments each containing a citation token with
 * almost no function words between them.
 *
 * Pure regex/counting; no model calls; receipts name the deciding rule.
 * Typed refusal: "insufficient" is a verdict, never a guess.
 *
 * Citation spotting is delegated to `citationKey.citationsInText`, the
 * shared detector this classifier's CITE_TOKEN was promoted into.
 */
import { citationsInText, hasCitationInText } from "./citationKey";

export type ExcerptClassification = {
  kind: "prose" | "mixed" | "authority_list" | "insufficient";
  citeTokens: number;
  /** semicolon-separated segments that contain at least one cite token */
  citeRuns: number;
  /** fraction of characters covered by citation material */
  citeCharCoverage: number;
  functionWords: number;
  /**
   * Longest contiguous citation-free stretch (trimmed to word
   * boundaries) — the usable characterization text for prose/mixed;
   * null for authority_list/insufficient.
   */
  proseWindow: string | null;
  /** which rule decided, for receipts */
  rule: string;
};

/** Case-name lead-in immediately before a cite ("R. v. Nasogaluak, "). */
const NAME_LEADIN = new RegExp(
  String.raw`(?:[A-Z][\w.'’()‑-]*(?:\s+[\w.'’()‑-]+){0,6}\s+(?:v|c)\.\s+[A-Z][\w.'’()‑-]*(?:\s+[\w.'’()‑-]+){0,6},?\s*)$`,
  "u",
);

/** Pinpoint tails after a cite ("at paras. 30-31", ", par. 86"). */
const PINPOINT = new RegExp(
  String.raw`^\s*(?:,\s*)?(?:at\s+)?para?s?\.?\s+\d+(?:\s*[-–]\s*\d+)?`,
  "u",
);

const FUNCTION_WORDS = new Set(
  (
    "the of to that in a an and is was were be as for on with by it this " +
    "not or which would may must court judge held found stated"
  ).split(" "),
);

const MIN_EXCERPT = 60;
const MIN_PROSE_WINDOW = 40;

type Span = { start: number; end: number };

function citationSpans(excerpt: string): Span[] {
  const spans: Span[] = [];
  for (const match of citationsInText(excerpt)) {
    let { start, end } = match;
    const leadin = excerpt.slice(0, start).match(NAME_LEADIN);
    if (leadin) start -= leadin[0].length;
    const tail = excerpt.slice(end).match(PINPOINT);
    if (tail) end += tail[0].length;
    spans.push({ start, end });
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    // bridge pure connective glue between citations (", ", "; ", " and ")
    if (last && span.start <= last.end + 6) {
      const glue = excerpt.slice(last.end, Math.max(last.end, span.start));
      if (/^[\s,;]*(?:and\s+)?$/u.test(glue)) {
        last.end = Math.max(last.end, span.end);
        continue;
      }
    }
    merged.push({ ...span });
  }
  return merged;
}

export function classifyCitatorExcerpt(excerpt: string): ExcerptClassification {
  const text = excerpt.trim();
  const refusal = (rule: string): ExcerptClassification => ({
    kind: "insufficient",
    citeTokens: 0,
    citeRuns: 0,
    citeCharCoverage: 0,
    functionWords: 0,
    proseWindow: null,
    rule,
  });
  if (text.length < MIN_EXCERPT) return refusal("shorter_than_min_excerpt");

  const spans = citationSpans(text);
  const citeTokens = citationsInText(text).length;
  const citeChars = spans.reduce((sum, span) => sum + (span.end - span.start), 0);
  const citeCharCoverage = citeChars / text.length;
  const citeRuns = text.split(";").filter(hasCitationInText).length;

  // prose segments = text minus citation spans
  const segments: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) segments.push(text.slice(cursor, span.start));
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < text.length) segments.push(text.slice(cursor));
  const functionWords = segments
    .join(" ")
    .toLowerCase()
    .split(/[^a-z']+/u)
    .filter((word) => FUNCTION_WORDS.has(word)).length;

  // Pick the citation-free stretch with the most lowercase words, not
  // the longest one: excerpts space-join document headers ("Tremblay c.
  // Canada (Procureur général) Date 2021-03-15 Référence neutre"), and
  // those metadata runs are capitalized-word/date sequences while real
  // sentence prose — English or French — is mostly lowercase words.
  const lowercaseWords = (text: string) =>
    (text.match(/[\p{L}'’-]+/gu) ?? []).filter(
      (word) => word.length >= 3 && /\p{Ll}/u.test(word[0]),
    ).length;
  const best = segments
    .flatMap((segment) => segment.split("\n"))
    .map((line) => ({ line: line.trim(), score: lowercaseWords(line) }))
    .sort((a, b) => b.score - a.score || b.line.length - a.line.length)[0];
  // excerpt windows truncate mid-word at both ends; trim to word boundaries
  const proseWindow =
    best && best.score >= 4 && best.line.length >= MIN_PROSE_WINDOW
      ? best.line.replace(/^\S*\s+/u, "").replace(/\s+\S*$/u, "")
      : null;

  if (citeRuns >= 3 && functionWords < citeRuns * 4) {
    return {
      kind: "authority_list",
      citeTokens,
      citeRuns,
      citeCharCoverage,
      functionWords,
      proseWindow: null,
      rule: "cite_runs>=3_low_function_words",
    };
  }
  if (citeCharCoverage > 0.5 && functionWords < 8) {
    return {
      kind: "authority_list",
      citeTokens,
      citeRuns,
      citeCharCoverage,
      functionWords,
      proseWindow: null,
      rule: "cite_coverage>0.5_low_function_words",
    };
  }
  if (!proseWindow) return refusal("no_prose_window");
  const kind = citeCharCoverage <= 0.15 && citeTokens <= 2 ? "prose" : "mixed";
  return {
    kind,
    citeTokens,
    citeRuns,
    citeCharCoverage,
    functionWords,
    proseWindow,
    rule: kind === "prose" ? "low_cite_coverage" : "prose_window_with_citations",
  };
}
