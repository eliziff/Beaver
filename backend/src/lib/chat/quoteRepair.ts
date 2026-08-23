import { tokenizeTextNative } from "../structureNative";
import { escapeRegExp as escapeRegex } from "../text";

/**
 * Deterministic near-miss repair for failed quotation claims, ported in
 * approach from ALR-Quote-Verifier (Eli's reference implementation; see
 * `_quote_match_score` / `_build_corrected_citation` there): token-level
 * alignment between a claimed quotation and its cited span. Where ALR
 * emits McGill-style bracket-edited corrections, Beaver's verbatim tier
 * accepts only contiguous substrings of the span — so the repair offered
 * here is the span's own best-matching contiguous token window, which
 * passes the tier by construction when requoted exactly.
 */

const TOKEN_RE = /\p{L}[\p{L}\p{N}'’‐-―-]*|\p{N}+/gu;

const MIN_COPY_TOKENS = 8;
const MIN_COPY_CHARS = 51;
const COPY_SEED_CHARS = 25;
const MIN_COPY_DISTINCT_CONTENT_TOKENS = 4;
const COPY_STOP_WORDS = new Set(
  "a an and are as at be but by for from has have if in into is it its of on or that the their there these this to was were will with which would when who whom whose".split(" "),
);
const MAX_MARKED_QUOTE_CHARS = 4_000;
const MAX_MARKED_QUOTE_EDITS = 4;
const MAX_FUZZY_SOURCE_CHARS = 50_000;

type SpanToken = { norm: string; start: number; end: number };

function tokenizeWithOffsets(text: string): SpanToken[] {
  const tokens: SpanToken[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    tokens.push({
      norm: match[0]
        .replace(/[‘’‚′]/gu, "'")
        .replace(/[–—−‐-―]/gu, "-")
        .toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

export type QuoteRepair = {
  /** Matched tokens of the longest common contiguous run. */
  matched: number;
  /** Word-token count of the claimed quotation. */
  claimTokens: number;
  /** matched / claimTokens (0 when the claim has no word tokens). */
  score: number;
  /**
   * The cited span's own contiguous text covering the longest common
   * token run — verbatim in the span by construction — or null when the
   * overlap is too thin to ground a suggestion.
   */
  excerpt: string | null;
};

/**
 * Longest common CONTIGUOUS token run between claim and span (classic
 * O(n*m) DP), rendered back to the span's original characters. Inputs
 * are capped to keep rejection-path cost bounded; spans here are
 * passage-scoped receipts, not documents.
 */
export function nearestVerbatimExcerpt(
  claimBody: string,
  spanText: string,
): QuoteRepair {
  const claim = tokenizeWithOffsets(claimBody).slice(0, 400);
  const span = tokenizeWithOffsets(spanText).slice(0, 4_000);
  const empty: QuoteRepair = {
    matched: 0,
    claimTokens: claim.length,
    score: 0,
    excerpt: null,
  };
  if (!claim.length || !span.length) return empty;
  let best = 0;
  let bestSpanEnd = 0;
  let previous = new Array<number>(claim.length + 1).fill(0);
  for (let i = 1; i <= span.length; i += 1) {
    const current = new Array<number>(claim.length + 1).fill(0);
    for (let j = 1; j <= claim.length; j += 1) {
      if (span[i - 1].norm !== claim[j - 1].norm) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] > best) {
        best = current[j];
        bestSpanEnd = i;
      }
    }
    previous = current;
  }
  const excerpt =
    best >= 6
      ? spanText.slice(
          span[bestSpanEnd - best].start,
          span[bestSpanEnd - 1].end,
        )
      : null;
  return {
    matched: best,
    claimTokens: claim.length,
    score: best / claim.length,
    excerpt: excerpt !== null && excerpt.length >= 25 ? excerpt : null,
  };
}

/**
 * One bounded repair suggestion line for a rejection message, or null
 * when no cited span overlaps the claim enough to suggest honestly
 * (thin overlap must stay a plain rejection — never a lookalike quote).
 */
export function quoteRepairSuggestion(
  claimBody: string,
  spans: string[],
): string | null {
  let best: QuoteRepair | null = null;
  for (const span of spans) {
    const repair = nearestVerbatimExcerpt(claimBody, span);
    if (repair.excerpt !== null && (best === null || repair.score > best.score))
      best = repair;
  }
  if (best === null || best.score < 0.5) return null;
  const excerpt =
    best.excerpt!.length > 600
      ? best.excerpt!.slice(0, best.excerpt!.lastIndexOf(" ", 600))
      : best.excerpt!;
  return `closest verbatim excerpt of its cited span: “${excerpt}” — if this serves, resubmit quoting it exactly as shown`;
}

export type VisibleEvidenceText = {
  evidenceId: string;
  text: string;
  labels?: string[];
};

export type MarkedQuoteSpan = { text: string; start: number; end: number };
type MarkedQuote = MarkedQuoteSpan & { markedStart: number; markedEnd: number };
type CopyToken = { norm: string; start: number; end: number };

function representation(value: string) {
  return value
    .normalize("NFC")
    .replace(/\u00a0/gu, " ")
    .replace(/[\u201c\u201d\u201e\u201f]/gu, '"')
    .replace(/[\u2018\u2019\u201a\u201b]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function detectMarkedQuotes(text: string): MarkedQuote[] {
  const quotes: MarkedQuote[] = [];
  for (const match of text.matchAll(/^[ \t]*>+[ \t]?(.*)$/gmu)) {
    const body = match[1].trim();
    if (!body) continue;
    const relativeStart = match[0].indexOf(body);
    const start = match.index + relativeStart;
    quotes.push({ text: body, start, end: start + body.length, markedStart: match.index, markedEnd: match.index + match[0].length });
  }
  for (const match of text.matchAll(/"([^"\r\n]+)"|\u201c([^\u201d\r\n]+)\u201d|\u2018([^\u2019\r\n]+)\u2019|\u00ab([^\u00bb\r\n]+)\u00bb/gu)) {
    const body = match.slice(1).find((value) => value !== undefined)!;
    const markedStart = match.index;
    const markedEnd = markedStart + match[0].length;
    if (quotes.some((quote) => markedStart >= quote.markedStart && markedEnd <= quote.markedEnd)) continue;
    const start = markedStart + match[0].indexOf(body);
    quotes.push({ text: body, start, end: start + body.length, markedStart, markedEnd });
  }
  return quotes.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function markedQuoteSpans(text: string): MarkedQuoteSpan[] {
  return detectMarkedQuotes(text).map(({ text, start, end }) => ({ text, start, end }));
}

function markedQuotes(text: string): MarkedQuote[] {
  return detectMarkedQuotes(text);
}

function alteredQuotePattern(quote: string) {
  if (quote.length > MAX_MARKED_QUOTE_CHARS) return null;
  const edits = [...quote.matchAll(/\[[^\]\r\n]+\]|\u2026|\.{3}/gu)];
  if (!edits.length || edits.length > MAX_MARKED_QUOTE_EDITS) return null;
  let cursor = 0;
  let pattern = "";
  let literal = "";
  for (const edit of edits) {
    const before = quote.slice(cursor, edit.index).replace(/\s+$/u, "");
    const next = edit.index + edit[0].length;
    const after = quote.slice(next);
    const adjacent =
      /[\p{L}\p{N}'\u2019]$/u.test(before) ||
      /^[\p{L}\p{N}'\u2019]/u.test(after);
    pattern += escapeRegex(before).replace(/ /gu, "\\s+");
    literal += before;
    pattern += edit[0].startsWith("[")
      ? adjacent
        ? "\\S*"
        : "\\s+(?:\\S+\\s+)?"
      : "[\\s\\S]*?";
    cursor = next;
    if (!adjacent || !edit[0].startsWith("[")) {
      while (quote[cursor] === " ") cursor += 1;
    }
  }
  const tail = quote.slice(cursor);
  pattern += escapeRegex(tail).replace(/ /gu, "\\s+");
  literal += tail;
  if (!/[\p{L}\p{N}]/u.test(literal)) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "u");
}

export function sourceSupportsMarkedQuote(quote: string, source: string) {
  const expected = representation(quote);
  const available = representation(source);
  if (!expected) return false;
  if (available.includes(expected)) return true;
  if (available.length > MAX_FUZZY_SOURCE_CHARS) return false;
  return alteredQuotePattern(expected)?.test(available) === true;
}

function copyTokens(text: string): CopyToken[] {
  return tokenizeTextNative(text).map(({ word, start, end }) => ({
    norm: word,
    start,
    end,
  }));
}

function unmarkedChunks(text: string, quotes: MarkedQuote[], labels: string[]) {
  const marker = "\u0000";
  let clean = text;
  for (const { markedStart: start, markedEnd: end } of [...quotes].sort((a, b) => b.markedStart - a.markedStart)) {
    clean = clean.slice(0, start) + marker + clean.slice(end);
  }
  clean = clean.replace(
    /\[@[^\]\r\n]+\]|\[\d+\]|\[\[[^\]\r\n]+\]\]|\[[^\]\r\n]+\]\([^\)\r\n]+\)|https?:\/\/\S+/gu,
    marker,
  );
  for (const label of [...new Set(labels.filter((value) => value.length >= 4))]) {
    clean = clean.replace(new RegExp(escapeRegex(label), "giu"), marker);
  }
  return clean.split(marker).filter(Boolean);
}

function copiedRun(chunks: string[], sources: VisibleEvidenceText[]) {
  for (const source of sources) {
    const sourceTokens = copyTokens(source.text);
    if (sourceTokens.length < MIN_COPY_TOKENS) continue;
    const windows = new Map<string, number[]>();
    for (let index = 0; index <= sourceTokens.length - MIN_COPY_TOKENS; index += 1) {
      const key = sourceTokens.slice(index, index + MIN_COPY_TOKENS).map(({ norm }) => norm).join("\u0001");
      const positions = windows.get(key);
      if (positions) positions.push(index);
      else windows.set(key, [index]);
    }
    for (const chunk of chunks) {
      const prose = copyTokens(chunk);
      for (let index = 0; index <= prose.length - MIN_COPY_TOKENS; index += 1) {
        const key = prose.slice(index, index + MIN_COPY_TOKENS).map(({ norm }) => norm).join("\u0001");
        for (const sourceIndex of windows.get(key) ?? []) {
          let left = 0;
          while (
            index - left > 0 &&
            sourceIndex - left > 0 &&
            prose[index - left - 1].norm === sourceTokens[sourceIndex - left - 1].norm
          ) left += 1;
          let right = MIN_COPY_TOKENS;
          while (
            index + right < prose.length &&
            sourceIndex + right < sourceTokens.length &&
            prose[index + right].norm === sourceTokens[sourceIndex + right].norm
          ) right += 1;
          const run = prose.slice(index - left, index + right);
          const normalizedLength = run.map(({ norm }) => norm).join(" ").length;
          if (normalizedLength < COPY_SEED_CHARS || normalizedLength < MIN_COPY_CHARS) continue;
          const contentTokens = new Set(run.map(({ norm }) => norm).filter((word) =>
            word.length > 2 && !COPY_STOP_WORDS.has(word)
          ));
          if (contentTokens.size < MIN_COPY_DISTINCT_CONTENT_TOKENS) continue;
          return {
            evidenceId: source.evidenceId,
            copied: chunk.slice(run[0].start, run.at(-1)!.end),
          };
        }
      }
    }
  }
  return null;
}

export function groundedProseIntegrityErrors(
  text: string,
  citedEvidenceIds: readonly string[],
  visibleEvidence: VisibleEvidenceText[],
) {
  const quotes = markedQuotes(text);
  const cited = visibleEvidence.filter(({ evidenceId }) =>
    citedEvidenceIds.includes(evidenceId),
  );
  const errors = quotes.flatMap(({ text: body }) => {
    if (cited.some(({ text }) => sourceSupportsMarkedQuote(body, text))) return [];
    const repaired = cited
      .map((source) => ({ source, suggestion: quoteRepairSuggestion(body, [source.text]) }))
      .find(({ suggestion }) => suggestion);
    const source = repaired?.source ?? cited[0];
    const suggestion = repaired?.suggestion;
    return [`quoted text ${JSON.stringify(body)} does not match its cited evidence${
      source ? `; ${source.evidenceId} source window: ${JSON.stringify(source.text)}` : ""
    }${suggestion ? `; ${suggestion}` : ""}`];
  });
  const copied = copiedRun(
    unmarkedChunks(text, quotes, visibleEvidence.flatMap(({ labels = [] }) => labels)),
    visibleEvidence,
  );
  if (copied) {
    errors.push(
      `unmarked copied passage ${JSON.stringify(copied.copied)} matches visible evidence ${copied.evidenceId}; quote it explicitly or write a genuine paraphrase`,
    );
  }
  return errors;
}
