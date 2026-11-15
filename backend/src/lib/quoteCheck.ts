import { mapBounded } from "./mapBounded";
import type { AuthoritiesDraft, AuthorityOccurrence } from "./authoritiesDomain";
import { sourceLocator } from "./authoritiesDiscrepancy";
import { legalSourceOperations } from "./legalSourceApplication";
import { canonicalJsonSha256 } from "./hash";
import { structureNative } from "./structureNative";
import { reject } from "./applicationError";
import { unitCitationParts, type CitationPart } from "./quoteCitationSplit";
import type { QuoteContext } from "./authoritiesQuotations";
import type { LegalSourceReference, LegalSourceLocator } from "./legalSources";
import type { NativeDocument } from "./structureNative";
import type { QuoteComparison } from "mike/shared/engine-types/QuoteComparison";
import type { QuoteLocation } from "mike/shared/engine-types/QuoteLocation";

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

/** The draft's quotations to check, each with the citation parts it is checked against, as the engine reads them
 *  (propositionQuotations, the quote and proposition model): a quotation in the text belongs to the next note only
 *  where it is in that note's passage (with `context` "sentence", the sentence its marker ends or stands in). With
 *  `textOnly`, the quotations are the text's alone, none a note holds. */
export function splitQuoteChecks(draft: AuthoritiesDraft, links: QuoteLink[],
  splitUnits: ReadonlyArray<{ parts: CitationPart[] }>, context: QuoteContext = "passage", textOnly = false) {
  // Each unit's citations, and the parts its text splits into, as the engine reads a quotation's sources from them.
  const cited = draft.units.map((unit) => unit.occurrenceIds.map((key) => draft.occurrences[key])
    .filter((item): item is AuthorityOccurrence => !!item));
  const read = structureNative().propositionQuotations(draft.units, draft.units.map((_, index) => ({
    occurrences: cited[index].map(({ start, authoritySpan }) => ({ start,
      cited: authoritySpan ? [authoritySpan.start, authoritySpan.end] as [number, number] : null })),
    parts: (splitUnits[index]?.parts ?? []).map(({ start, end }) => [start, end] as [number, number]) })), context, textOnly);
  const rows = read.map(({ unit: at, start, end, text: quote, candidates: found }) => {
    const unit = draft.units[at], id = canonicalJsonSha256([unit.id, start, end, quote]);
    const candidates = found.map(({ unit: from, part: index, occurrences }) => {
      const sourceUnit = draft.units[from], part = splitUnits[from]!.parts[index];
      const first = occurrences.length ? cited[from][occurrences[0]] : undefined;
      return { id: first?.id ?? `part:${sourceUnit.id}:${part.start}`,
        citation: first?.citation || part.reference,
        kind: first?.kind ?? (part.fields.kind === "statute" ? "legislation" :
          part.fields.kind === "case" ? "case" : "commentary"),
        pinpoints: first?.pinpoints ?? [], text: part.text,
        unitId: sourceUnit.id, start: part.start, end: part.end };
    });
    const explicit = links.find((link) => link.quoteId === id);
    if (explicit && !draft.occurrences[explicit.occurrenceId] && !candidates.some(({ id }) => id === explicit.occurrenceId))
      reject(400, "A quote link names an unknown citation occurrence.");
    return { id, unitId: unit.id, start, end, quote,
      context: unit.text, pageNumbers: unit.pageNumbers,
      candidates,
      occurrenceId: explicit?.occurrenceId ?? (candidates.length === 1 ? candidates[0].id : null),
      linkMethod: explicit ? "explicit" as const : "mechanical" as const };
  });
  if (links.some((link) => !rows.some(({ id }) => id === link.quoteId)))
    reject(400, "A quote link names an unknown quotation.");
  return rows;
}

/** One cited source's check of a quotation: whether it holds the quotation as written ("verified") or with
 *  differences or not at all ("mismatch"), where, and what differs; or "no-source" where no source text could be
 *  obtained for its citation, as the Python app's "No source text found for this citation.": none is held on this
 *  computer, published by a provider the app asks, or attached, or the quotation is followed by no citation. A
 *  provider that fails to answer leaves its source's quotations "no-source", its error in the detail: the rest of
 *  the check goes on. */
export type QuoteCheck = { candidateId: string | null; status: "verified" | "mismatch" | "no-source";
  detail: string;
  receipt: null | { source: LegalSourceReference; sourceSha256: string; passageSha256: string;
    locator: LegalSourceLocator | null; text: string; errors: string[];
    comparison: QuoteComparison | null; match: QuoteLocation; link: string | null } };
/** A quotation and the checks of the sources its note cites, each on its own. */
export type QuoteResult = ReturnType<typeof splitQuoteChecks>[number] & { checks: QuoteCheck[] };
/** PDFs the user attached, read, by authority. */
export type AttachedQuoteSources = ReadonlyMap<string, { document: NativeDocument; source: LegalSourceReference }>;
const STATUSES = ["verified", "mismatch", "no-source"] as const;
const NO_SOURCE_TEXT = "No source text found for this citation.";
const memo = <T, K>(cache: Map<K, T>, key: K, load: () => T) => {
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key)!;
};

export type CitedSource = { missing: true; detail?: string }
  | { missing?: undefined; source: LegalSourceReference; document: NativeDocument };
/** The whole source a citation names, as its provider has it (A2AJ for a Canadian decision or statute, the
 *  journals database for an article), each resolved and read once; `missing` where no provider the app asks holds
 *  one source for it. An article is found by the title its citation part carries. A provider that cannot answer
 *  leaves this source missing, its error the detail (the Python app's no-source state), never the whole check. */
export function citedSourceReader(sources = legalSourceOperations, signal?: AbortSignal) {
  const resolutions = new Map<string, ReturnType<typeof sources.resolve>>();
  const documents = new Map<string, ReturnType<typeof sources.readPassage>>();
  const cited = (authority: { kind: string; citation: string }, part: string) => {
    const kind = authority.kind === "commentary" ? "journal" : authority.kind;
    return [kind, (kind === "journal" && part ? part : authority.citation).trim()] as const;
  };
  const read = async (authority: { kind: string; citation: string }, part = ""): Promise<CitedSource> => {
    const [kind, text] = cited(authority, part);
    if ((kind !== "case" && kind !== "legislation" && kind !== "journal") || !text) return { missing: true };
    try {
      const resolved = await memo(resolutions, JSON.stringify([kind, text]), () => sources.resolve({ text, kind, signal }));
      if (resolved.status !== "found") return { missing: true };
      const read = await memo(documents, JSON.stringify(resolved.value), () => sources.readPassage({ source: resolved.value, signal }));
      const document = read.status === "found" ? read.values[0]?.documentArtifact : undefined;
      return document ? { source: resolved.value, document } : { missing: true };
    } catch (error) {
      signal?.throwIfAborted();
      return { missing: true, detail: `No source text: the source could not be looked up (${
        (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/u, "")}).` };
    }
  };
  /** The source this reader resolved for a citation already, read; undefined where it has not resolved it. */
  const kept = async (authority: { kind: string; citation: string }, part = ""): Promise<CitedSource | undefined> =>
    resolutions.has(JSON.stringify(cited(authority, part))) ? read(authority, part) : undefined;
  return Object.assign(read, { kept });
}
/** The reader each quote check read its sources with, by the check: what it read is not read again. */
export const checkedSources = new WeakMap<object, ReturnType<typeof citedSourceReader>>();

export async function checkQuotes(draft: AuthoritiesDraft, links: QuoteLink[] = [],
  signal?: AbortSignal, progress?: (completed: number, total: number, row: QuoteResult,
    citationUnits: Array<{ unitId: string; parts: CitationPart[] }>) => void,
  sources = legalSourceOperations, window?: { offset: number; limit: number },
  attached: AttachedQuoteSources = new Map(),
  /** firstCitationOnly: check a quotation only against the citation linked to it, else its note's first.
   *  quoteContext: "sentence" checks only the quotations in the sentence a note's marker ends or stands in.
   *  textOnly: checks the text's quotations alone, none a note holds.
   *  compare: false leaves out each receipt's comparison and errors, for a caller that reads only where the quotation is.
   *  keepSourceReadings: each source's readings are kept for the quotations checked in it later, a quicker check for the
   *  memory they hold (some 250 MiB for the Criminal Code). */
  options: { firstCitationOnly?: boolean; quoteContext?: QuoteContext; textOnly?: boolean; compare?: boolean;
    keepSourceReadings?: boolean } = {}) {
  // Each unit's parts: a note's as the import split it, a body unit's as the splitter gives it (unitCitationParts).
  const citationUnits = await unitCitationParts(draft.units, signal);
  const unitReceipts = citationUnits.map(({ parts }, index) => ({ unitId: draft.units[index].id, parts }));
  const all = splitQuoteChecks(draft, links, citationUnits, options.quoteContext, options.textOnly);
  const rows = window ? all.slice(window.offset, window.offset + window.limit) : all;
  // Quotations from one authority share its resolution, and each source is read once.
  const read = citedSourceReader(sources, signal);
  const engine = structureNative();
  /** The whole source a citation names: a PDF the user attached for it, else its provider's text. */
  async function sourceFor(authorityId: string | null, authority: { kind: string; citation: string },
    part: string): Promise<CitedSource> {
    const pdf = authorityId ? attached.get(authorityId) : undefined;
    return pdf ?? read(authority, part);
  }
  type Row = ReturnType<typeof splitQuoteChecks>[number];
  /** A quotation's source, read, waiting to be located in it. */
  type Pending = { row: Row; candidateId: string; pinpoints: AuthorityOccurrence["pinpoints"];
    source: LegalSourceReference; document: NativeDocument; check?: QuoteCheck };
  async function readFor(row: Row, candidateId: string): Promise<Pending | QuoteCheck> {
    const occurrence = draft.occurrences[candidateId];
    const candidate = row.candidates.find(({ id }) => id === candidateId);
    const authority = occurrence?.authorityId ? draft.authorities[occurrence.authorityId] : candidate;
    if (!authority) return { candidateId, status: "no-source", detail: NO_SOURCE_TEXT, receipt: null };
    // A supra or ibid names its article by the part that first cites it, as Sources found it, not by its own words.
    const origin = occurrence?.reference && Object.values(draft.occurrences).find((item) =>
      item.authorityId === occurrence.authorityId && !item.reference);
    const part = origin ? citationUnits[draft.units.findIndex(({ id }) => id === origin.unitId)]?.parts.find((item) =>
      origin.start >= item.start && origin.start < item.end)?.text ?? "" : candidate?.text ?? "";
    const found = await sourceFor(occurrence?.authorityId ?? null, authority, part);
    if (found.missing) return { candidateId, status: "no-source", receipt: null, detail: found.detail ?? NO_SOURCE_TEXT };
    return { row, candidateId, pinpoints: occurrence?.pinpoints ?? candidate?.pinpoints ?? [], source: found.source,
      document: found.document };
  }
  // Each source the quotation's note cites is checked on its own, as the ALR Quote Verifier checks each citation part
  // of a note; a citation the user linked is the one checked, and with firstCitationOnly the note's first citation is.
  // Every source is read first; then each source's quotations are located in it in one engine call.
  const prepared = await mapBounded(rows, async (row) => {
    signal?.throwIfAborted();
    const tried = row.linkMethod === "explicit" && row.occurrenceId ? [row.occurrenceId]
      : row.candidates.slice(0, options.firstCitationOnly ? 1 : undefined).map(({ id }) => id);
    const reads: Array<Pending | QuoteCheck> = [];
    for (const id of tried) reads.push(await readFor(row, id));
    return reads;
  });
  const bySource = new Map<NativeDocument, Pending[]>();
  for (const reads of prepared) for (const item of reads) if ("document" in item) {
    const list = bySource.get(item.document);
    if (list) list.push(item); else bySource.set(item.document, [item]);
  }
  let completed = 0;
  const quotes: Array<QuoteResult | undefined> = rows.map(() => undefined);
  /** Each quotation whose sources are all checked, in order, as soon as they are. */
  const emit = () => {
    for (let index = completed; index < rows.length; index = completed) {
      const checks = prepared[index].map((item) => "document" in item ? item.check : item);
      if (checks.some((check) => !check)) return;
      if (!checks.length) checks.push({ candidateId: null, status: "no-source", receipt: null,
        detail: "No citation follows this quotation." });
      const quote: QuoteResult = { ...rows[index], checks: checks as QuoteCheck[] };
      quotes[index] = quote;
      // Counted whether or not anyone listens: an optional call skips its arguments, and the loop with them.
      completed += 1;
      progress?.(completed, rows.length, quote, unitReceipts);
    }
  };
  emit();
  // The sources are located in at once, each on one of the engine's threads, which links each quotation found at its
  // words (legal-structure quote_link); each one's receipts are made here as it is done.
  await Promise.all([...bySource].map(async ([document, items]) => {
    signal?.throwIfAborted();
    // The source's text, read where a quotation was not found in a passage of it.
    let documentText: string | undefined;
    const revision = engine.documentRevision(document), hashes = new Map<string, string>();
    const located = await engine.quoteLocateDocument(document, items[0].source,
      items.map(({ row, pinpoints }) => ({ quote: row.quote, pinpoints, id: row.id })),
      options.compare !== false, options.keepSourceReadings);
    items.forEach((item, index) => {
      const { match, comparison, errors, link } = located[index];
      const text = match.text || (documentText ??= engine.documentText(document));
      const cited = item.pinpoints.length === 1 ? sourceLocator(item.pinpoints[0]) : null;
      // Locator-only callers keep their exact-match outcome; a comparison accepts only computed, supported wording.
      const verified = options.compare === false ? match.perfect
        : comparison !== null && errors !== undefined && errors.length === 0;
      item.check = { candidateId: item.candidateId, status: match.location !== "unmatched" && verified ? "verified" : "mismatch",
        detail: match.location === "unmatched" ? "The quotation was not found in the source text."
          : match.location.startsWith("alternate") ? `Found at ${match.pinpoint || "another place in the source"}, not at the cited pinpoint.`
            : cited ? "Compared with the cited passage." : "Compared with the available source text; no unique pinpoint supplied.",
        receipt: { source: item.source, sourceSha256: revision, passageSha256: memo(hashes, text, () => canonicalJsonSha256(text)),
          locator: cited, text, errors: errors ?? [], comparison, match, link } };
    });
    emit();
  }));
  const result = { mode: links.length ? "assisted" : "mechanical", quotes: quotes as QuoteResult[], total: all.length,
    citationUnits: unitReceipts,
    counts: quoteCheckCounts(quotes as QuoteResult[]) };
  checkedSources.set(result, read);
  return result;
}

/** How many source checks found each outcome. */
export function quoteCheckCounts(quotes: QuoteResult[]) {
  return Object.fromEntries(STATUSES.map((status) => [status,
    quotes.reduce((sum, quote) => sum + quote.checks.filter((item) => item.status === status).length, 0)]));
}
