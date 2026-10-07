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
import type { NativeDocument } from "./structureNative";
import { buildLegalSourcePinpoint, legalSourceLocatorAnchor } from "./legalSourceLinks";

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
    // A cited work's quoted title ("Name, “Title” (2024) 16:1 J 61") is part of its citation, not a quotation.
    .filter((quote) => !unit.occurrenceIds.some((key) => {
      const span = draft.occurrences[key]?.authoritySpan;
      return span && span.start <= quote.start && quote.end <= span.end;
    }))
    .map((quote) => {
      const id = canonicalJsonSha256([unit.id, quote.start, quote.end, quote.text]);
      const bodyOffset = bodyOffsets.get(unit.id);
      const globalEnd = (bodyOffset ?? 0) + quote.end;
      // A quotation belongs to the note that ends the passage it is in: the next note after it.
      const anchor = bodyOffset === undefined ? undefined : anchors.find(([, at]) => at >= globalEnd);
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

/** Where a quotation is in the source read for it (see locateQuote). */
export type QuoteLocation = ReturnType<typeof locateQuote>;
/** One cited source's check of a quotation: whether it holds the quotation as written ("verified") or with
 *  differences ("mismatch"), where, and what differs; or why it could not be read. */
export type QuoteCheck = { candidateId: string | null; status: "verified" | "mismatch" | "unavailable" | "unresolved";
  detail: string;
  receipt: null | { source: LegalSourceReference; sourceSha256: string; passageSha256: string;
    locator: LegalSourceLocator | null; text: string; errors: string[];
    comparison: ReturnType<typeof quoteTextComparison>; match: QuoteLocation; link: string | null } };
/** A quotation and the checks of the sources its note cites, each on its own. */
export type QuoteResult = ReturnType<typeof splitQuoteChecks>[number] & { checks: QuoteCheck[] };
/** PDFs the user attached, read, by authority. */
export type AttachedQuoteSources = ReadonlyMap<string, { document: NativeDocument; source: LegalSourceReference }>;
const STATUSES = ["verified", "mismatch", "unresolved", "unavailable"] as const;
const memo = <T, K>(cache: Map<K, T>, key: K, load: () => T) => {
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key)!;
};

export type CitedSource = { missing: "unresolved" | "unavailable" }
  | { missing?: undefined; source: LegalSourceReference; document: NativeDocument };
/** The whole source a citation names, as its provider has it (A2AJ for a Canadian decision or statute, the
 *  journals database for an article), each resolved and read once. An article is found by the title its
 *  citation part carries. */
export function citedSourceReader(sources = legalSourceOperations, signal?: AbortSignal) {
  const resolutions = new Map<string, ReturnType<typeof sources.resolve>>();
  const documents = new Map<string, ReturnType<typeof sources.readPassage>>();
  return async (authority: { kind: string; citation: string }, part = ""): Promise<CitedSource> => {
    const kind = authority.kind === "commentary" ? "journal" : authority.kind;
    if (kind !== "case" && kind !== "legislation" && kind !== "journal") return { missing: "unresolved" as const };
    const text = kind === "journal" && part ? part : authority.citation;
    const resolved = await memo(resolutions, JSON.stringify([kind, text]), () => sources.resolve({ text, kind, signal }));
    if (resolved.status !== "found") return { missing: "unavailable" as const };
    const read = await memo(documents, JSON.stringify(resolved.value), () => sources.readPassage({ source: resolved.value, signal }));
    const document = read.status === "found" ? read.values[0]?.documentArtifact : undefined;
    return document ? { source: resolved.value, document } : { missing: "unavailable" as const };
  };
}

export async function checkQuotes(draft: AuthoritiesDraft, links: QuoteLink[] = [],
  signal?: AbortSignal, progress?: (completed: number, total: number, row: QuoteResult,
    citationUnits: Array<QuoteCitationUnit & { unitId: string }>) => void,
  sources = legalSourceOperations, window?: { offset: number; limit: number },
  attached: AttachedQuoteSources = new Map(),
  /** firstCitationOnly: check a quotation only against the citation linked to it, else its note's first. */
  options: { firstCitationOnly?: boolean } = {}) {
  const citationUnits = await splitQuoteCitationUnits(draft.units.map(({ text }) => text), signal);
  const unitReceipts = citationUnits.map((split, index) => ({ unitId: draft.units[index].id, ...split }));
  const all = splitQuoteChecks(draft, links, citationUnits);
  const rows = window ? all.slice(window.offset, window.offset + window.limit) : all;
  // Quotations from one authority share its resolution, and each source is read once.
  const read = citedSourceReader(sources, signal);
  const blocks = new Map<NativeDocument, ReturnType<typeof quoteBlocks>>();
  /** The whole source a citation names: a PDF the user attached for it, else its provider's text. */
  async function sourceFor(authorityId: string | null, authority: { kind: string; citation: string },
    part: string): Promise<CitedSource & { judgment?: boolean }> {
    const pdf = authorityId ? attached.get(authorityId) : undefined;
    return pdf ? { ...pdf, judgment: true } : read(authority, part);
  }
  async function check(row: ReturnType<typeof splitQuoteChecks>[number], candidateId: string): Promise<QuoteCheck> {
    const occurrence = draft.occurrences[candidateId];
    const candidate = row.candidates.find(({ id }) => id === candidateId);
    const authority = occurrence?.authorityId ? draft.authorities[occurrence.authorityId] : candidate;
    if (!authority) return { candidateId, status: "unresolved", detail: "The citation names no source to read.", receipt: null };
    try {
      const found = await sourceFor(occurrence?.authorityId ?? null, authority, candidate?.text ?? "");
      if (found.missing) return { candidateId, status: found.missing, receipt: null,
        detail: "The citation did not resolve to one available source." };
      const pinpoints = occurrence?.pinpoints ?? candidate?.pinpoints ?? [];
      const document = structureNative().documentText(found.document);
      const match = locateQuote(memo(blocks, found.document, () => quoteBlocks(found.document, found.judgment)),
        document, row.quote, quoteScopes(pinpoints));
      const text = match.text || document;
      const cited = pinpoints.length === 1 ? sourceLocator(pinpoints[0]) : null;
      // A link that opens the source at the quoted words, in the block that holds them, with the block's own
      // anchor beside the fragment where the source's page has one (CanLII's #par12 or #sec4, Decisia's #par12).
      const [, kind, value] = /^(par|page |sec)(.+)$/u.exec(match.labels[0] ?? "") ?? [];
      const blockKind = kind === "par" ? "paragraph" : kind === "sec" ? "section" : "page";
      const block = kind ? structureNative().readDocumentRange(found.document, blockKind, value, value, 0)?.selected[0] : undefined;
      const anchor = blockKind !== "page" && found.source.url
        ? legalSourceLocatorAnchor(found.source.url, blockKind, match.labels[0]) : undefined;
      const link = found.source.url && match.text ? buildLegalSourcePinpoint({ url: found.source.url,
        anchor: anchor ?? block?.anchor, blockText: match.text, documentText: found.document },
        [match.fragment || row.quote])?.target ?? null : null;
      return { candidateId, status: match.perfect ? "verified" : "mismatch",
        detail: match.location === "unmatched" ? "The quotation was not found in the source text."
          : match.location.startsWith("alternate") ? `Found at ${match.pinpoint || "another place in the source"}, not at the cited pinpoint.`
            : cited ? "Compared with the cited passage." : "Compared with the available source text; no unique pinpoint supplied.",
        receipt: { source: found.source, sourceSha256: structureNative().documentRevision(found.document),
          passageSha256: canonicalJsonSha256(text), locator: cited, text,
          errors: structureNative().groundedProseErrors(`“${row.quote}”`, [row.id], [{ evidenceId: row.id, text, labels: [] }]),
          comparison: quoteTextComparison(row.quote, match.region || text), match, link } };
    } catch {
      signal?.throwIfAborted();
      return { candidateId, status: "unavailable", detail: "Source retrieval failed; this quotation has not been verified.", receipt: null };
    }
  }
  let completed = 0;
  const quotes = await mapBounded(rows, async (row): Promise<QuoteResult> => {
    signal?.throwIfAborted();
    // Each source the quotation's note cites is checked on its own, as the ALR Quote Verifier checks each
    // citation part of a note; a citation the user linked is the one checked, and with firstCitationOnly
    // the note's first citation is.
    const tried = row.linkMethod === "explicit" && row.occurrenceId ? [row.occurrenceId]
      : row.candidates.slice(0, options.firstCitationOnly ? 1 : undefined).map(({ id }) => id);
    const checks: QuoteCheck[] = [];
    for (const id of tried) checks.push(await check(row, id));
    if (!checks.length) checks.push({ candidateId: null, status: "unresolved", receipt: null,
      detail: "No citation follows this quotation." });
    const quote: QuoteResult = { ...row, checks };
    progress?.(++completed, rows.length, quote, unitReceipts);
    return quote;
  });
  return { mode: links.length ? "assisted" : "mechanical", quotes, total: all.length,
    citationUnits: unitReceipts,
    counts: quoteCheckCounts(quotes) };
}

/** How many source checks found each outcome. */
export function quoteCheckCounts(quotes: QuoteResult[]) {
  return Object.fromEntries(STATUSES.map((status) => [status,
    quotes.reduce((sum, quote) => sum + quote.checks.filter((item) => item.status === status).length, 0)]));
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

// Where a quotation is in its source: the cited paragraph, page or provision first, then anywhere
// else, then the document as a whole. Ported from ALR-Quote-Verifier alr_quote_verifier.py
// (_apply_quote_checks, _page_pinpoint) and verifier_core/a2aj_pinpoint_scope.py (cited_scopes,
// resolve_quote).
const MIN_MATCH = 0.6, STRONG_MATCH = 0.98;
type QuoteBlock = { kind: "paragraph" | "page" | "section"; label: string; start: number; end: number; text: string };
type QuoteScopes = { paragraphs: Array<[number, number]>; pages: Array<[number, number]>; sections: string[] };

/** A source's paragraphs, pages and provisions, named "par12", "page 333" and "sec4"; a judgment's
 *  PDF by the paragraph numbers it prints. */
export function quoteBlocks(native: NativeDocument, judgment = false): QuoteBlock[] {
  const engine = structureNative(), text = engine.documentText(native);
  if (judgment) {
    const paragraphs = engine.caseOutline(text).filter((entry) => entry.kind === "paragraph").flatMap((entry): QuoteBlock[] => {
      const number = /^\[?(\d{1,4})\]?\.?$/u.exec(entry.label.trim())?.[1];
      return number ? [{ kind: "paragraph", label: `par${number}`, start: entry.start, end: entry.end,
        text: text.slice(entry.start, entry.end) }] : [];
    });
    if (paragraphs.length) return paragraphs;
  }
  return engine.documentAnchors(native).flatMap((anchor): QuoteBlock[] => {
    if (anchor.kind !== "paragraph" && anchor.kind !== "page" && anchor.kind !== "section") return [];
    // Native labels may carry their kind ("page333", "para 12", "s. 4").
    const prefix = { paragraph: /^(?:paras?\.?|par|¶)\s*(?=\d)/iu, page: /^(?:pages?|pp?\.?)\s*(?=\d)/iu,
      section: /^(?:sections?|ss?\.|sec)\s*(?=\d)/iu }[anchor.kind];
    const value = anchor.label.trim().replace(prefix, "").replace(/^\[(.*)\]$/u, "$1");
    const label = anchor.kind === "paragraph" ? `par${value}` : anchor.kind === "page" ? `page ${value}` : `sec${value}`;
    return [{ kind: anchor.kind, label, start: anchor.start, end: anchor.end, text: text.slice(anchor.start, anchor.end) }];
  });
}

/** The paragraphs, pages and provisions a citation's pinpoints name. */
export function quoteScopes(pinpoints: AuthorityOccurrence["pinpoints"]): QuoteScopes {
  const scopes: QuoteScopes = { paragraphs: [], pages: [], sections: [] };
  for (const pinpoint of pinpoints) {
    const locator = sourceLocator(pinpoint);
    if (!locator) continue;
    if (locator.kind === "section") { scopes.sections.push(`sec${locator.value.replace(/\s+/gu, "")}`); continue; }
    const first = Number(locator.value), last = Number(locator.endValue ?? locator.value);
    if (Number.isInteger(first) && Number.isInteger(last))
      (locator.kind === "paragraph" ? scopes.paragraphs : scopes.pages).push([first, Math.max(first, last)]);
  }
  return scopes;
}

const inRanges = (value: number, ranges: Array<[number, number]>) => ranges.some(([a, b]) => a <= value && value <= b);
const hasScopes = (scopes: QuoteScopes) => !!(scopes.paragraphs.length || scopes.pages.length || scopes.sections.length);
const blockNumber = (block: QuoteBlock) => Number(block.kind === "paragraph" ? block.label.slice(3) : block.label.split(" ").at(-1));
function sectionAncestors(label: string) {
  const out = [label];
  for (let current = label; /\([^)]+\)$/u.test(current);) { current = current.replace(/\([^)]+\)$/u, ""); out.push(current); }
  return out;
}
function citedSelection(blocks: QuoteBlock[], scopes: QuoteScopes) {
  const selected = new Map<QuoteBlock, boolean>();
  for (const block of blocks) {
    if (block.kind === "paragraph" && inRanges(blockNumber(block), scopes.paragraphs)) selected.set(block, true);
    if (block.kind === "page" && inRanges(blockNumber(block), scopes.pages)) selected.set(block, true);
  }
  const sections = new Map(blocks.filter((block) => block.kind === "section").map((block) => [block.label.toLowerCase(), block]));
  for (const section of scopes.sections) for (const candidate of sectionAncestors(section)) {
    const block = sections.get(candidate.toLowerCase());
    if (block) { selected.set(block, (selected.get(block) ?? false) || candidate.toLowerCase() === section.toLowerCase()); break; }
  }
  return selected;
}
const wordCount = (quote: string, text: string) => {
  const needle = quoteWords(quote), words = quoteWords(text);
  let count = 0;
  for (let i = 0; needle.length && i + needle.length <= words.length; i++) if (needle.every((word, j) => words[i + j] === word)) count++;
  return count;
};
function specificLabels(matches: Array<[number, QuoteBlock]>) {
  const labels: string[] = [];
  for (const [score, block] of matches) {
    if (labels.includes(block.label)) continue;
    if (block.kind === "section" && matches.some(([other, candidate]) => candidate.kind === "section" && other >= score &&
      candidate.label.toLowerCase().startsWith(`${block.label.toLowerCase()}(`))) continue;
    labels.push(block.label);
  }
  return labels;
}
const plausibleIn = (quote: string, text: string) => plausibleContentOverlap(quote, quoteRegion(quote, text, 400) || text);
function scored(quote: string, blocks: QuoteBlock[]) {
  return blocks.map((block): [number, QuoteBlock] => [quoteMatchScore(quote, block.text), block])
    .filter(([score, block]) => score >= MIN_MATCH && plausibleIn(quote, block.text))
    .sort((a, b) => b[0] - a[0] || a[1].start - b[1].start);
}
function rangeBlocks(blocks: QuoteBlock[], scopes: QuoteScopes) {
  const combined: QuoteBlock[] = [];
  for (const [kind, ranges] of [["paragraph", scopes.paragraphs], ["page", scopes.pages]] as const) for (const [start, end] of ranges) {
    if (end <= start) continue;
    const members = blocks.filter((block) => block.kind === kind && start <= blockNumber(block) && blockNumber(block) <= end)
      .sort((a, b) => blockNumber(a) - blockNumber(b));
    if (members.map(blockNumber).join() !== Array.from({ length: end - start + 1 }, (_, i) => start + i).join()) continue;
    combined.push({ kind, label: kind === "paragraph" ? `par${start}–${end}` : `pages ${start}–${end}`, start: members[0].start,
      end: members.at(-1)!.end, text: members.map((block) => block.text).join("\n") });
  }
  return combined;
}
/** A whole-document alignment can anchor on words far from the passage; the best region scores it too. */
const documentScore = (quote: string, text: string) => {
  const whole = quoteMatchScore(quote, text);
  return whole >= STRONG_MATCH ? whole : Math.max(whole, quoteMatchScore(quote, quoteRegion(quote, text, 400) || ""));
};
/** Up to `limit` locations, then how many more. */
export function pinpointSummary(pinpoints: string[], limit = 2) {
  const values = pinpoints.map((value) => value.trim()).filter(Boolean);
  return values.slice(0, limit).join(", ") + (values.length > limit ? ` [+${values.length - limit} more instances]` : "");
}

type Resolution = { location: string; score: number; labels: string[]; text: string;
  cited?: { score: number; labels: string[]; text: string } | null };
function resolveQuote(blocks: QuoteBlock[], text: string, quote: string, scopes: QuoteScopes): Resolution {
  const selection = hasScopes(scopes) ? citedSelection(blocks, scopes) : new Map<QuoteBlock, boolean>();
  const scoped = [...selection.keys()], combined = rangeBlocks(blocks, scopes);
  const scopedMatches = scored(quote, [...scoped, ...combined]);
  let strong = scopedMatches.filter(([score]) => score >= STRONG_MATCH);
  const located = (matches: Array<[number, QuoteBlock]>) => {
    const best = matches[0][1];
    return { location: combined.includes(best) || selection.get(best) ? "cited" : "cited_parent", score: matches[0][0],
      labels: specificLabels(matches), text: best.text };
  };
  if (strong.length) {
    const ranges = strong.filter(([, block]) => combined.includes(block)), specific = strong.filter(([, block]) => !combined.includes(block));
    if (ranges.length && specific.length) strong = specific.some(([, block]) => wordCount(quote, block.text)) ||
      specific[0][0] >= ranges[0][0] ? specific : ranges;
    return located(strong);
  }
  const scopedSet = new Set(scoped);
  const alternates = scored(quote, blocks).filter(([, block]) => !scopedSet.has(block));
  let matches = alternates.filter(([score]) => score >= STRONG_MATCH);
  if (!matches.length && scopedMatches.length) return located(scopedMatches.slice(0, 1));
  const targetKindAvailable = (scopes.paragraphs.length && blocks.some((block) => block.kind === "paragraph")) ||
    (scopes.pages.length && blocks.some((block) => block.kind === "page")) ||
    (scopes.sections.length && blocks.some((block) => block.kind === "section"));
  if (!matches.length) {
    const collapsed = alternates.filter(([score, block]) => block.kind !== "section" || !alternates.some(([other, candidate]) =>
      other >= score && candidate.label.toLowerCase().startsWith(`${block.label.toLowerCase()}(`)));
    if (collapsed.length && (collapsed.length === 1 || collapsed[0][0] - collapsed[1][0] >= 0.1)) matches = collapsed.slice(0, 1);
  }
  if (matches.length) {
    let labels: string[] = [];
    if (quoteWords(quote).length < 3) {
      const exact = matches.filter(([, block]) => wordCount(quote, block.text));
      if (wordCount(quote, text) === 1 && exact.length) { matches = exact; labels = specificLabels(matches); }
    } else labels = specificLabels(matches);
    const location = scoped.length || targetKindAvailable ? "alternate" : hasScopes(scopes) ? "scope_unavailable" : "uncited";
    // Where the cited passage holds the quotation in part, that partial match is kept beside the one found elsewhere.
    const cited = location === "alternate" && scopedMatches.length ? { score: scopedMatches[0][0],
      labels: specificLabels(scopedMatches.slice(0, 1)), text: scopedMatches[0][1].text } : null;
    return { location, score: matches[0][0], labels, text: matches[0][1].text, cited };
  }
  const score = documentScore(quote, text);
  if (score >= MIN_MATCH) return { location: scoped.length || targetKindAvailable ? "alternate_document"
    : hasScopes(scopes) ? "scope_unavailable_document" : "uncited_document", score, labels: [] as string[], text };
  return { location: "unmatched", score, labels: [] as string[], text: "" };
}

/** Page labels where the quotation's words run, over a page break too. */
function pagePinpoint(blocks: QuoteBlock[], quote: string) {
  const pages = blocks.filter((block) => block.kind === "page");
  const hits = pages.filter((block) => quoteMatchScore(quote, block.text) >= STRONG_MATCH).map((block) => block.label);
  if (hits.length) return pinpointSummary(hits);
  for (let i = 0; i + 1 < pages.length; i++)
    if (quoteWords(quote).length && quoteMatchScore(quote, `${pages[i].text} ${pages[i + 1].text}`) >= STRONG_MATCH)
      return `pages ${pages[i].label.split(" ").at(-1)}–${pages[i + 1].label.split(" ").at(-1)}`;
  return "";
}

/** Where a quotation is in a source: `location` ("cited", "cited_parent", "alternate", "uncited", their
 *  "_document" forms where no block holds it, "scope_unavailable" where the source lacks the cited kind
 *  of block, or "unmatched"), its score, the blocks that hold it, the source's own words for it and the
 *  quotation corrected to them. `perfect`: found word for word where the citation sends a reader. */
export function locateQuote(blocks: QuoteBlock[], text: string, quote: string, scopes: QuoteScopes) {
  let resolution: Resolution = blocks.length ? resolveQuote(blocks, text, quote, scopes)
    : { location: "uncited_document", score: documentScore(quote, text), labels: [] as string[], text };
  if (quoteWords(quote).length < 3 && resolution.location.startsWith("alternate") && !resolution.labels.length)
    resolution = { location: "unmatched", score: 0, labels: [], text: "" };
  const unmatched = { location: "unmatched", score: resolution.score, labels: [] as string[], pinpoint: "", text: "",
    region: "", fragment: "", corrected: "", perfect: false, cited: null,
    /** A short quotation in a long source is only ever searched for word for word. */
    shortInLong: quoteWords(quote).length < 3 && text.length > LONG_SOURCE_CHARS };
  if (resolution.score < MIN_MATCH) return unmatched;
  const matchText = resolution.text || text, { region, fragment, corrected } = correction(quote, matchText);
  if (resolution.score < STRONG_MATCH && !plausibleContentOverlap(quote, region || matchText)) return unmatched;
  if (isOnlyBracketedQuote(corrected)) return unmatched;
  const labeled = resolution.labels.length > 0 && !resolution.location.startsWith("scope_unavailable");
  const limited = resolution.location.startsWith("scope_unavailable") || resolution.location === "cited_parent";
  /** Found elsewhere, the quotation's partial match in the cited passage. */
  const partial = resolution.cited;
  const cited = partial ? { score: partial.score, labels: partial.labels, pinpoint: pinpointSummary(partial.labels),
    ...correction(quote, partial.text) } : null;
  return { location: resolution.location, score: resolution.score, labels: labeled ? resolution.labels : [],
    pinpoint: labeled ? pinpointSummary(resolution.labels) : pagePinpoint(blocks, quote),
    text: resolution.text, region, fragment, corrected, shortInLong: false, cited,
    perfect: resolution.score >= STRONG_MATCH && quoteExactKey(corrected) === quoteExactKey(quote) && !limited };
}

/** The source's own words for a quotation, in the text it was found in, and the quotation corrected to them. */
function correction(quote: string, matchText: string) {
  const region = quoteRegion(quote, matchText, 400);
  let source = region || (matchText.length > LONG_SOURCE_CHARS ? quote : matchText);
  const fragment = region ? sourceSideQuoteFragment(region, quote) : "";
  if (fragment && quoteMatchScore(quote, fragment) >= MIN_MATCH) source = fragment;
  return { region, fragment, corrected: correctedQuote(quote, source) };
}
