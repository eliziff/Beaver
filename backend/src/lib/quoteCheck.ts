import { mapBounded } from "./mapBounded";
import type { AuthoritiesDraft, AuthorityOccurrence } from "./authoritiesDomain";
import { editorialQuote, quoteTextComparison, sourceLocator } from "./authoritiesDiscrepancy";
import { sequenceOpcodes } from "mike/shared/sequence-diff.mjs";
import { legalSourceOperations } from "./legalSourceApplication";
import { canonicalJsonSha256 } from "./hash";
import { structureNative } from "./structureNative";
import { reject } from "./applicationError";
import { splitQuoteCitationUnits, type QuoteCitationUnit } from "./quoteCitationSplit";
import type { LegalSourceReference, LegalSourceLocator } from "./legalSources";

export type QuoteLink = { quoteId: string; occurrenceId: string };
export function decodeQuoteLinks(value: unknown): QuoteLink[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500 || value.some((item) =>
    !item || typeof item.quoteId !== "string" || typeof item.occurrenceId !== "string"))
    reject(400, "Quote links must contain quoteId and occurrenceId strings (maximum 500).");
  const links = value as QuoteLink[];
  if (new Set(links.map(({ quoteId }) => quoteId)).size !== links.length)
    reject(400, "Each quote may have only one explicit citation link.");
  return links;
}

/** Uses the same native quotation and authority scans as document ingestion. */
export function splitQuoteChecks(draft: AuthoritiesDraft, links: QuoteLink[],
  splitUnits: QuoteCitationUnit[]) {
  const bodyOffsets = new Map<string, number>();
  const anchors: Array<[number, number]> = [];
  let position = 0;
  for (const unit of draft.units.filter(({ kind }) => kind === "body").sort((a, b) => a.ordinal - b.ordinal)) {
    bodyOffsets.set(unit.id, position);
    anchors.push(...unit.footnoteRefs.map(([id, offset]) => [id, position + offset] as [number, number]));
    position += unit.text.length + 1;
  }
  anchors.sort((a, b) => a[1] - b[1]);
  const rows = draft.units.flatMap((unit) => structureNative().markedQuoteSpans(unit.text)
    .map((quote) => {
      const id = canonicalJsonSha256([unit.id, quote.start, quote.end, quote.text]);
      const bodyOffset = bodyOffsets.get(unit.id);
      const globalEnd = (bodyOffset ?? 0) + quote.end;
      const anchor = bodyOffset === undefined ? undefined : anchors.find(([, at]) => at >= globalEnd && at - globalEnd <= 400);
      const nextNote = anchor ? [anchor[0], anchor[1] - (bodyOffset ?? 0)] : undefined;
      const noteUnits = nextNote ? draft.units.filter((item) =>
        item.kind === "footnote" && item.footnoteId === nextNote[0]) : [];
      const occurrences = [...new Set([
        ...unit.occurrenceIds.filter((key) => {
          const at = draft.occurrences[key]?.start;
          return at >= quote.end && at - quote.end <= 400 && (!nextNote || at < nextNote[1]);
        }),
        ...noteUnits.flatMap((item) => item.occurrenceIds),
      ])].map((key) => draft.occurrences[key]).filter((item): item is AuthorityOccurrence => !!item);
      const candidates = (noteUnits.length ? noteUnits : [unit]).flatMap((sourceUnit) =>
        (splitUnits[draft.units.indexOf(sourceUnit)]?.parts ?? []).filter((part) =>
          sourceUnit !== unit || (part.end > quote.end && part.start - quote.end <= 400 &&
            occurrences.some((item) => item.unitId === sourceUnit.id && item.start >= part.start && item.start < part.end)))
          .map((part) => {
            const matching = occurrences.filter((item) => item.unitId === sourceUnit.id &&
              item.start >= part.start && item.start < part.end);
            const first = matching[0];
            return { id: first?.id ?? `part:${sourceUnit.id}:${part.start}`,
              citation: first?.citation || part.reference,
              kind: first?.kind ?? (part.fields.kind === "statute" ? "legislation" :
                part.fields.kind === "case" ? "case" : "commentary"),
              pinpoints: first?.pinpoints ?? [], text: part.text,
              unitId: sourceUnit.id, start: part.start, end: part.end };
          }));
      const explicit = links.find((link) => link.quoteId === id);
      if (explicit && !draft.occurrences[explicit.occurrenceId] && !candidates.some(({ id }) => id === explicit.occurrenceId))
        reject(400, "A quote link names an unknown citation occurrence.");
      return { id, unitId: unit.id, start: quote.start, end: quote.end, quote: quote.text,
        context: unit.text, pageNumbers: unit.pageNumbers,
        candidates,
        occurrenceId: explicit?.occurrenceId ?? (candidates.length === 1 ? candidates[0].id : null),
        linkMethod: explicit ? "explicit" as const : "mechanical" as const };
    }));
  if (links.some((link) => !rows.some(({ id }) => id === link.quoteId)))
    reject(400, "A quote link names an unknown quotation.");
  return rows;
}

export type QuoteResult = ReturnType<typeof splitQuoteChecks>[number] & { status: string; detail: string;
  receipt: null | { source: LegalSourceReference; sourceSha256: string; passageSha256: string;
    locator: LegalSourceLocator | null; text: string; errors: string[];
    comparison: ReturnType<typeof quoteTextComparison> } };
export async function checkQuotes(draft: AuthoritiesDraft, links: QuoteLink[] = [],
  signal?: AbortSignal, progress?: (completed: number, total: number, row: QuoteResult,
    citationUnits: Array<QuoteCitationUnit & { unitId: string }>) => void,
  sources = legalSourceOperations, window?: { offset: number; limit: number }) {
  const citationUnits = await splitQuoteCitationUnits(draft.units.map(({ text }) => text), signal);
  const unitReceipts = citationUnits.map((split, index) => ({ unitId: draft.units[index].id, ...split }));
  const all = splitQuoteChecks(draft, links, citationUnits);
  const rows = window ? all.slice(window.offset, window.offset + window.limit) : all;
  // Quotations from one authority share its resolution and each passage is read once.
  const resolutions = new Map<string, ReturnType<typeof sources.resolve>>();
  const passages = new Map<string, ReturnType<typeof sources.readPassage>>();
  const memo = <T>(cache: Map<string, T>, key: string, load: () => T) => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key)!;
  };
  let completed = 0;
  const quotes = await mapBounded(rows, async (row): Promise<QuoteResult> => {
    signal?.throwIfAborted();
    const occurrence = row.occurrenceId ? draft.occurrences[row.occurrenceId] : null;
    const candidate = row.candidates.find(({ id }) => id === row.occurrenceId);
    const authority = occurrence?.authorityId ? draft.authorities[occurrence.authorityId] : candidate;
    let status = row.candidates.length > 1 ? "ambiguous" : "unresolved";
    let receipt: QuoteResult["receipt"] = null;
    let detail = "Select the citation that supplies this quotation.";
    if (authority && (occurrence || candidate)) {
      try {
        const kind = authority.kind === "commentary" ? "journal" : authority.kind;
        const resolved = kind === "other" || kind === "reference" ? null : await memo(resolutions,
          JSON.stringify([kind, authority.citation]), () => sources.resolve({ text: authority.citation, kind, signal }));
        if (resolved?.status === "found") {
          const pinpoints = occurrence?.pinpoints ?? candidate?.pinpoints ?? [];
          const locator = pinpoints.length === 1 ? sourceLocator(pinpoints[0]) : null;
          const read = await memo(passages, JSON.stringify([resolved.value, locator]),
            () => sources.readPassage({ source: resolved.value, ...(locator ? { locator } : {}), signal }));
          if (read.status === "found" && read.values.some((item) => item.role !== "context" && item.text.trim())) {
            const selected = read.values.filter((item) => item.role !== "context");
            const text = selected.map((item) => item.text).join("\n");
            const errors = structureNative().groundedProseErrors(`“${row.quote}”`, [row.id],
              [{ evidenceId: row.id, text, labels: [] }]);
            status = errors.length ? "mismatch" : "verified";
            detail = locator ? "Compared with the cited passage." : "Compared with the available source text; no unique pinpoint supplied.";
            receipt = { source: resolved.value,
              sourceSha256: structureNative().documentRevision(read.values[0].documentArtifact),
              passageSha256: canonicalJsonSha256(text), locator: locator ?? null, text, errors,
              comparison: quoteTextComparison(row.quote, text) };
          } else { status = "unavailable"; detail = "The source passage could not be read."; }
        } else { status = resolved?.status === "ambiguous" ? "ambiguous" : "unavailable";
          detail = "The citation did not resolve to a unique available source."; }
      } catch (error) {
        signal?.throwIfAborted();
        status = "unavailable"; detail = "Source retrieval failed; this quotation has not been verified.";
      }
    }
    const quote = { ...row, status, detail, receipt } as QuoteResult;
    progress?.(++completed, rows.length, quote, unitReceipts);
    return quote;
  });
  return { mode: links.length ? "assisted" : "mechanical", quotes, total: all.length,
    citationUnits: unitReceipts,
    counts: Object.fromEntries(["verified", "mismatch", "ambiguous", "unresolved", "unavailable"]
      .map((status) => [status, quotes.filter((row) => row.status === status).length])) };
}

// Quotation scoring against source text: how much of an authored quotation a source passage
// contains, where it sits, and the source-side words it corresponds to. Ported from
// ALR-Quote-Verifier alr_quote_verifier.py (_quote_match_score, _trim_to_text_region,
// _source_side_quote_fragment_text, _has_plausible_partial_content_overlap and their helpers).
const WORD = String.raw`[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*`;
// An editorial bracket is short and on one line; a stray "[" in extracted source text must not
// swallow the pages up to the next "]".
const TOKEN = new RegExp(String.raw`\.\.\.|\[[^\][\n]{1,80}\]|${WORD}|["“”‘’]|[^\p{L}\p{N}_\s]`, "gu");
const WORD_TOKEN = new RegExp(WORD, "gu");
const SINGLE_WORD = new RegExp(`^${WORD}$`, "u");
const DOUBLE_QUOTES = new Set(['"', "“", "”", "«", "»", "„"]);
const SINGLE_QUOTES = new Set(["'", "‘", "’", "‚"]);
const QUOTES = new Set([...DOUBLE_QUOTES, ...SINGLE_QUOTES]);
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "…", "..."]);
const DASHES = /[-­‐-―−]/gu;
const DASH = /^[-­‐-―−]$/u;
/** Sources longer than this are scored by anchored word windows, not a whole-text alignment. */
export const LONG_SOURCE_CHARS = 80_000;
const LONG_SOURCE_TOKENS = 8_000;
const NON_CONTENT = new Set(("a an and are as at be been being by for from in is it its of on or that " +
  "the their to was were with").split(" "));

export type QuoteToken = { text: string; start: number; end: number };

const mergeable = (token: string) => /[\p{L}\p{N}]/u.test(token) || /^\[.*\]$/su.test(token);
const wordlike = (token: string) => /[\p{L}\p{N}]/u.test(token);

/** Words, bracketed insertions, ellipses, quotation marks and punctuation; adjoining words merge. */
export function quoteTokens(text: string): QuoteToken[] {
  const raw = [...(text ?? "").matchAll(TOKEN)].map((match) => ({ text: match[0], start: match.index,
    end: match.index + match[0].length }));
  const merged: QuoteToken[] = [];
  for (let i = 0; i < raw.length;) {
    let { text: value, start, end } = raw[i], next = i + 1;
    while (next < raw.length && raw[next - 1].end === raw[next].start &&
        mergeable(raw[next - 1].text) && mergeable(raw[next].text)) {
      value += raw[next].text; end = raw[next].end; next++;
    }
    merged.push({ text: value, start, end }); i = next;
  }
  return merged;
}
const tokens = (text: string) => quoteTokens(text).map(({ text }) => text);

/** Lower-cased words, as the plausibility and region checks count them. */
export function quoteWords(text: string) {
  return [...(text ?? "").matchAll(WORD_TOKEN)].map((match) => match[0].toLowerCase());
}

function stripTrailingPunctuation(values: string[]) {
  let end = values.length;
  while (end > 0 && TRAILING.has(values[end - 1])) end--;
  return values.slice(0, end);
}

const collapseInitialCase = (text: string) => (text ?? "").replace(/^\[([A-Za-z])\](?=[A-Za-z])/u, "$1");

/** Smart quotes, dashes, joined words, outer quotation marks and trailing punctuation are not wording. */
export function normalizeQuoteForCompare(text: string) {
  let value = (text ?? "").trim();
  if (!value) return "";
  value = value.replace(/[“”]/gu, '"').replace(/[’‘]/gu, "'").replace(DASHES, "-")
    .replace(/(?<=[\p{L}\p{N}])\s*-\s*(?=[\p{L}\p{N}])/gu, " ").replace(/\s+/gu, " ").trim();
  if (value.length >= 2 && QUOTES.has(value[0]) && QUOTES.has(value.at(-1)!)) value = value.slice(1, -1).trim();
  return value.replace(/(?<=[A-Za-z0-9])"\s*(?=[.,;:!?…])/gu, "").replace(/[.,;:!?…]+$/u, "").trim();
}
export const quoteExactKey = (text: string) => collapseInitialCase(normalizeQuoteForCompare(text));
/** Two authored quotations with this key are the same quotation. */
export const quoteDedupeKey = (text: string) => quoteExactKey(text).toLowerCase();

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function findExact(needle: string, haystack: string) {
  needle = (needle ?? "").trim();
  if (!needle || !haystack) return -1;
  if (SINGLE_WORD.test(needle)) {
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${escapePattern(needle)}(?![\\p{L}\\p{N}])`, "iu").exec(haystack);
    return match ? match.index : -1;
  }
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}
function exactInSource(quote: string, source: string) {
  if (findExact(quote, source) >= 0) return true;
  const [q, s] = [collapseInitialCase(quote), collapseInitialCase(source)];
  return (q !== quote || s !== source) && findExact(q, s) >= 0;
}

function equivalentToken(token: string) {
  if (DOUBLE_QUOTES.has(token)) return '"';
  if (SINGLE_QUOTES.has(token)) return "'";
  if (DASH.test(token)) return "-";
  let value = token.replace(/[’‘]/gu, "'").replace(DASHES, "-");
  const initial = /^\[([A-Za-z])\]([A-Za-z]+)$/u.exec(value);
  if (initial) value = initial[1] + initial[2];
  return /^[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*$/u.test(value) ? value.toLowerCase() : value;
}
function alignmentAliases(values: string[]) {
  const aliases = new Map<string, string>();
  for (const token of values) {
    const match = /^([A-Za-z]+)((?:\[[A-Za-z]+\])+)$/u.exec(equivalentToken(token));
    if (!match) continue;
    const base = match[1].toLowerCase(), expanded = base + match[2].replace(/[[\]]/gu, "").toLowerCase();
    aliases.set(base, `${base}|${expanded}`); aliases.set(expanded, `${base}|${expanded}`);
  }
  return aliases;
}
function alignmentToken(token: string, aliases: Map<string, string>) {
  let value = equivalentToken(token);
  if (/^[A-Za-z]+(?:\[[A-Za-z]+\])+$/u.test(value)) value = value.replace(/\[([A-Za-z]+)\]/gu, "");
  const lowered = value.toLowerCase();
  return aliases.get(lowered) ?? lowered;
}
function bracketSuffixExact(quote: string, source: string) {
  const quoted = stripTrailingPunctuation(tokens(quote)), aliases = alignmentAliases(quoted);
  if (!aliases.size) return false;
  const needle = quoted.filter(wordlike).map((token) => alignmentToken(token, aliases));
  const words = tokens(source).filter(wordlike).map((token) => alignmentToken(token, aliases));
  if (!needle.length || needle.length > words.length) return false;
  for (let at = 0; at + needle.length <= words.length; at++)
    if (needle.every((word, index) => words[at + index] === word)) return true;
  return false;
}

const matchedSize = (left: string[], right: string[]) => sequenceOpcodes(left, right)
  .filter(([tag]) => tag === "equal").reduce((sum, [, a0, a1]) => sum + a1 - a0, 0);

function anchorPhrases(words: string[]) {
  const phrases: string[][] = [], seen = new Set<string>();
  for (const size of [8, 6, 5, 4, 3]) {
    if (words.length < size) continue;
    for (let start of [0, Math.floor(words.length / 4), Math.floor(words.length / 2), Math.max(0, words.length - size)]) {
      start = Math.max(0, Math.min(start, words.length - size));
      const phrase = words.slice(start, start + size), key = phrase.join("\u0000");
      if (phrase.length && !seen.has(key)) { seen.add(key); phrases.push(phrase); }
    }
  }
  return phrases;
}
function findPhrase(words: string[], phrase: string[]) {
  for (let at = words.indexOf(phrase[0]); at >= 0 && at + phrase.length <= words.length;
    at = words.indexOf(phrase[0], at + 1)) if (phrase.every((word, index) => words[at + index] === word)) return at;
  return -1;
}
function longSourceScore(quoted: string[], source: string) {
  const needle = quoted.filter(wordlike).map((token) => token.toLowerCase());
  if (!needle.length) return 0;
  const words = quoteWords(source);
  if (!words.length) return 0;
  const present = new Set(words);
  const overlap = needle.filter((word) => present.has(word)).length / needle.length;
  if (overlap < 0.6) return overlap;
  let best = 0;
  const seen = new Set<string>();
  for (const phrase of anchorPhrases(needle)) {
    const at = findPhrase(words, phrase);
    if (at < 0) continue;
    const start = Math.max(0, at - needle.length), end = Math.min(words.length, at + phrase.length + needle.length * 3);
    if (seen.has(`${start}:${end}`)) continue;
    seen.add(`${start}:${end}`);
    best = Math.max(best, matchedSize(words.slice(start, end), needle) / needle.length);
    if (best >= 0.98) break;
  }
  return best || Math.min(overlap, 0.59);
}

/** Fraction of the quotation's tokens the source contains in order; 1 when it contains it exactly. */
export function quoteMatchScore(quote: string, source: string) {
  const q = (quote ?? "").trim(), s = (source ?? "").trim();
  if (!q || !s) return 0;
  const quoted = stripTrailingPunctuation(tokens(q));
  if (!quoted.length) return 0;
  const key = quoteExactKey(q).toLowerCase();
  if (key && exactInSource(key, quoteExactKey(s).toLowerCase())) return 1;
  if (bracketSuffixExact(q, s)) return 1;
  if (s.length > LONG_SOURCE_CHARS) return longSourceScore(quoted, s);
  const sourceTokens = tokens(s);
  if (!sourceTokens.length) return 0;
  if (sourceTokens.length > LONG_SOURCE_TOKENS) return longSourceScore(quoted, s);
  return matchedSize(sourceTokens, quoted) / quoted.length;
}

function contentWords(text: string) {
  return quoteWords(text).filter((word) => !NON_CONTENT.has(word) && !(word.length === 1 && /\p{L}/u.test(word)));
}
/** A partial match is plausible only when enough of the quotation's content words occur in the source. */
export function plausibleContentOverlap(quote: string, source: string) {
  const needle = [...new Set(contentWords(quote))];
  if (!needle.length) return true;
  const present = new Set(contentWords(source));
  if (!present.size) return false;
  const overlap = needle.filter((word) => present.has(word)).length;
  if (overlap <= 0) return false;
  if (needle.length <= 2) return true;
  if (needle.length <= 4) return overlap >= 2;
  return overlap / needle.length >= 0.35;
}

function longSourceRegion(quote: string, text: string, window: number) {
  const words = quoteWords(quote);
  for (const phrase of anchorPhrases(words)) {
    const match = new RegExp(`(?<![\\p{L}\\p{N}_])${phrase.map(escapePattern).join("[^\\p{L}\\p{N}_]+")}(?![\\p{L}\\p{N}_])`, "iu").exec(text);
    if (match) return text.slice(Math.max(0, match.index - window), Math.min(text.length, match.index + match[0].length + quote.length + window));
  }
  return "";
}

/** The window of the source where the quotation best matches, so alignment never spans distant text. */
export function quoteRegion(quote: string, fullText: string, window = 300) {
  const q = (quote ?? "").trim(), text = (fullText ?? "").trim();
  if (!q || !text) return fullText;
  const at = findExact(q.slice(0, 40), text);
  if (at >= 0) return text.slice(Math.max(0, at - Math.floor(window / 2)), Math.min(text.length, at + q.length + Math.floor(window / 2)));
  if (text.length > LONG_SOURCE_CHARS) return longSourceRegion(q, text, window);
  const quoted = tokens(q);
  if (!quoted.length) return text;
  const step = Math.max(1, Math.floor(quoted.length / 2)), source = tokens(text), lower = text.toLowerCase();
  const positions: number[] = [];
  let from = 0;
  for (const token of source) {
    let at = lower.indexOf(token.toLowerCase(), from);
    if (at < 0) at = from;
    positions.push(at); from = at + Math.max(1, token.length);
  }
  let best = 0, bestAt = 0;
  for (let i = 0; i <= source.length - quoted.length; i += step) {
    const score = quoteMatchScore(q, source.slice(i, i + quoted.length * 2).join(" "));
    if (score > best) { best = score; bestAt = i; }
  }
  const first = Math.max(0, bestAt - quoted.length), last = Math.min(source.length - 1, bestAt + quoted.length * 3);
  if (last < 0) return text;
  return text.slice(positions[first], positions[last] + source[last].length);
}

function onlyBracketed(text: string) {
  const meaningful = stripTrailingPunctuation(tokens(text)).filter((token) =>
    !QUOTES.has(token) && !TRAILING.has(token) && token.trim());
  return meaningful.length === 1 && /^\[[^\]]+\]$/u.test(meaningful[0]);
}
export const isOnlyBracketedQuote = onlyBracketed;

/** The source's own words that correspond to the quotation, for links and display. */
export function sourceSideQuoteFragment(sourceRegion: string, quote: string, maxChars = 900) {
  const spans = quoteTokens(sourceRegion ?? ""), quoted = tokens(quote ?? "");
  if (!spans.length || !quoted.length) return "";
  const source = spans.map(({ text }) => text), aliases = alignmentAliases(quoted);
  const ranges: Array<[number, number]> = [];
  for (const [tag, i1, i2, j1, j2] of sequenceOpcodes(source.map((token) => alignmentToken(token, aliases)),
    quoted.map((token) => alignmentToken(token, aliases)))) {
    if ((tag !== "equal" && tag !== "replace") || i2 <= i1 || j2 <= j1) continue;
    const sourceWords = source.slice(i1, i2).filter(wordlike).length, quoteWordCount = quoted.slice(j1, j2).filter(wordlike).length;
    if (tag === "replace" && (sourceWords > quoteWordCount + 2 || quoteWordCount > sourceWords + 2)) continue;
    if (!sourceWords || !quoteWordCount) continue;
    ranges.push([i1, i2]);
  }
  if (!ranges.length) return "";
  const clusters: Array<Array<[number, number]>> = [];
  for (const range of ranges) {
    if (!clusters.length || range[0] - clusters.at(-1)!.at(-1)![1] > 8) clusters.push([range]);
    else clusters.at(-1)!.push(range);
  }
  const score = (cluster: Array<[number, number]>) => {
    const start = cluster[0][0], end = cluster.at(-1)![1];
    return [source.slice(start, end).filter(wordlike).length, -(end - start)];
  };
  let best = clusters[0];
  for (const cluster of clusters.slice(1)) {
    const [a, b] = score(cluster), [c, d] = score(best);
    if (a > c || (a === c && b > d)) best = cluster;
  }
  const start = best[0][0], end = best.at(-1)![1];
  if (end <= start) return "";
  let fragment = sourceRegion.slice(spans[start].start, spans[end - 1].end).replace(/\s+/gu, " ").trim();
  const firstWord = quoteWords(quote)[0];
  if (!(firstWord && /^\d+$/u.test(firstWord)))
    fragment = fragment.replace(/^(?:\[\s*\d{1,4}\s*\]|\d{1,4}\s*\(\d{1,4}\)|\d{1,4})\s+/u, "").trim() || fragment;
  if (!fragment || onlyBracketed(fragment) || fragment.length > maxChars) return "";
  return fragment;
}

/** The quotation marks an authored quotation used, or the ones its delimiter style implies. */
export function outerQuoteMarks(raw: string, style?: string | null): [string, string] {
  const value = (raw ?? "").trim();
  if (value.length >= 2 && QUOTES.has(value[0]) && QUOTES.has(value.at(-1)!)) return [value[0], value.at(-1)!];
  const normalized = (style ?? "").trim().toUpperCase();
  return normalized === "SMART" ? ["“", "”"] : normalized === "STRAIGHT" || normalized === "MIXED" ? ['"', '"'] : ["", ""];
}
export function withOuterQuotes(text: string, open: string, close: string) {
  const value = (text ?? "").trim();
  if (!value || (!open && !close)) return value;
  open ||= close; close ||= open;
  const hasOpen = QUOTES.has(value[0]), hasClose = QUOTES.has(value.at(-1)!);
  return hasOpen && hasClose ? value : hasOpen ? value + close : hasClose ? open + value : `${open}${value}${close}`;
}

/** The quotation rewritten to the source's wording: changes in brackets, omissions as ellipses. */
export function correctedQuote(quote: string, excerpt: string) {
  const authored = (quote ?? "").trim();
  let source = (excerpt ?? "").trim();
  if (!authored) return source;
  if (!source) return authored;
  // A source's own quotation marks around the passage are not part of the authored quotation.
  const quoted = tokens(authored), core = stripTrailingPunctuation(quoted);
  if (!DOUBLE_QUOTES.has(quoted[0])) source = source.replace(/^["“”«»„\s]+/u, "");
  if (!(core.length && DOUBLE_QUOTES.has(core.at(-1)!))) source = source.replace(/["“”«»„\s]+$/u, "")
    .replace(/["“”«»„](?=(?:\s*(?:\.\.\.|[.,;:!?…]))+\s*$)/u, "");
  return editorialQuote(authored, source);
}
