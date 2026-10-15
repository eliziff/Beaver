import { mapBounded } from "./mapBounded";
import type { AuthoritiesDraft, AuthorityOccurrence } from "./authoritiesDomain";
import { sourceLocator } from "./authoritiesDiscrepancy";
import { legalSourceOperations } from "./legalSourceApplication";
import { canonicalJsonSha256 } from "./hash";
import { structureNative } from "./structureNative";
import { reject } from "./applicationError";
import { splitQuoteCitationUnits, type QuoteCitationUnit } from "./quoteCitationSplit";
import { footnotePropositions, type QuoteContext } from "./authoritiesQuotations";
import type { LegalSourceReference, LegalSourceLocator } from "./legalSources";
import type { NativeDocument, NativeQuoteComparison, NativeQuoteLocation } from "./structureNative";
import { buildLegalSourcePinpoint, legalSourceLocatorAnchor, planLegalSourcePinpoints } from "./legalSourceLinks";

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

/** Uses the same native quotation and authority scans as document ingestion. A quotation in the text belongs to the
 *  next note only where it is in that note's passage: with `context` "sentence", the sentence its marker ends or
 *  stands in. With `textOnly`, the quotations are the text's alone, none a note holds. */
export function splitQuoteChecks(draft: AuthoritiesDraft, links: QuoteLink[],
  splitUnits: QuoteCitationUnit[], context: QuoteContext = "passage", textOnly = false) {
  const passages = footnotePropositions(draft.units, context);
  const bodyOffsets = new Map<string, number>();
  const anchors: Array<[number, number]> = [];
  let position = 0;
  for (const unit of draft.units.filter(({ kind }) => kind === "body").sort((a, b) => a.ordinal - b.ordinal)) {
    bodyOffsets.set(unit.id, position);
    anchors.push(...unit.footnoteRefs.map(([id, offset]) => [id, position + offset] as [number, number]));
    position += unit.text.length + 1;
  }
  anchors.sort((a, b) => a[1] - b[1]);
  const rows = draft.units.filter(({ kind }) => !textOnly || kind === "body").flatMap((unit) => structureNative().markedQuoteSpans(unit.text)
    // A cited work's quoted title ("Name, “Title” (2024) 16:1 J 61") is part of its citation, not a quotation.
    .filter((quote) => !unit.occurrenceIds.some((key) => {
      const span = draft.occurrences[key]?.authoritySpan;
      return span && span.start <= quote.start && quote.end <= span.end;
    }))
    .flatMap((quote) => {
      const id = canonicalJsonSha256([unit.id, quote.start, quote.end, quote.text]);
      const bodyOffset = bodyOffsets.get(unit.id);
      const globalEnd = (bodyOffset ?? 0) + quote.end;
      // A quotation belongs to the note that ends the passage it is in: the next note after it.
      const anchor = bodyOffset === undefined ? undefined : anchors.find(([, at]) => at >= globalEnd);
      const passage = anchor && passages.get(anchor[0]);
      if (passage && (globalEnd - quote.end + quote.start < passage.start || globalEnd > passage.end)) return [];
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
      return [{ id, unitId: unit.id, start: quote.start, end: quote.end, quote: quote.text,
        context: unit.text, pageNumbers: unit.pageNumbers,
        candidates,
        occurrenceId: explicit?.occurrenceId ?? (candidates.length === 1 ? candidates[0].id : null),
        linkMethod: explicit ? "explicit" as const : "mechanical" as const }];
    }));
  if (links.some((link) => !rows.some(({ id }) => id === link.quoteId)))
    reject(400, "A quote link names an unknown quotation.");
  return rows;
}

/** Where a quotation is in the source read for it: the cited paragraph, page or provision first, then anywhere else,
 *  then the document as a whole (the engine's locate_quotes_in, ported from the ALR Quote Verifier). */
export type QuoteLocation = NativeQuoteLocation;
/** One cited source's check of a quotation: whether it holds the quotation as written ("verified") or with
 *  differences ("mismatch"), where, and what differs; or why it could not be read. */
export type QuoteCheck = { candidateId: string | null; status: "verified" | "mismatch" | "unavailable" | "unresolved";
  detail: string;
  receipt: null | { source: LegalSourceReference; sourceSha256: string; passageSha256: string;
    locator: LegalSourceLocator | null; text: string; errors: string[];
    comparison: NativeQuoteComparison | null; match: QuoteLocation; link: string | null } };
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
  /** firstCitationOnly: check a quotation only against the citation linked to it, else its note's first.
   *  quoteContext: "sentence" checks only the quotations in the sentence a note's marker ends or stands in.
   *  textOnly: checks the text's quotations alone, none a note holds.
   *  compare: false leaves out each receipt's comparison and errors, for a caller that reads only where the quotation is. */
  options: { firstCitationOnly?: boolean; quoteContext?: QuoteContext; textOnly?: boolean; compare?: boolean } = {}) {
  const citationUnits = await splitQuoteCitationUnits(draft.units.map(({ text }) => text), signal);
  const unitReceipts = citationUnits.map((split, index) => ({ unitId: draft.units[index].id, ...split }));
  const all = splitQuoteChecks(draft, links, citationUnits, options.quoteContext, options.textOnly);
  const rows = window ? all.slice(window.offset, window.offset + window.limit) : all;
  // Quotations from one authority share its resolution, and each source is read once.
  const read = citedSourceReader(sources, signal);
  const engine = structureNative();
  /** The whole source a citation names: a PDF the user attached for it, else its provider's text. */
  async function sourceFor(authorityId: string | null, authority: { kind: string; citation: string },
    part: string): Promise<CitedSource & { judgment?: boolean }> {
    const pdf = authorityId ? attached.get(authorityId) : undefined;
    return pdf ? { ...pdf, judgment: true } : read(authority, part);
  }
  type Row = ReturnType<typeof splitQuoteChecks>[number];
  /** A quotation's source, read, waiting to be located in it. */
  type Pending = { row: Row; candidateId: string; pinpoints: AuthorityOccurrence["pinpoints"];
    source: LegalSourceReference; document: NativeDocument; judgment: boolean; check?: QuoteCheck };
  const unavailable = (candidateId: string): QuoteCheck => ({ candidateId, status: "unavailable",
    detail: "Source retrieval failed; this quotation has not been verified.", receipt: null });
  async function readFor(row: Row, candidateId: string): Promise<Pending | QuoteCheck> {
    const occurrence = draft.occurrences[candidateId];
    const candidate = row.candidates.find(({ id }) => id === candidateId);
    const authority = occurrence?.authorityId ? draft.authorities[occurrence.authorityId] : candidate;
    if (!authority) return { candidateId, status: "unresolved", detail: "The citation names no source to read.", receipt: null };
    try {
      const found = await sourceFor(occurrence?.authorityId ?? null, authority, candidate?.text ?? "");
      if (found.missing) return { candidateId, status: found.missing, receipt: null,
        detail: "The citation did not resolve to one available source." };
      return { row, candidateId, pinpoints: occurrence?.pinpoints ?? candidate?.pinpoints ?? [], source: found.source,
        document: found.document, judgment: !!found.judgment };
    } catch {
      signal?.throwIfAborted();
      return unavailable(candidateId);
    }
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
      if (!checks.length) checks.push({ candidateId: null, status: "unresolved", receipt: null,
        detail: "No citation follows this quotation." });
      const quote: QuoteResult = { ...rows[index], checks: checks as QuoteCheck[] };
      quotes[index] = quote;
      progress?.(++completed, rows.length, quote, unitReceipts);
    }
  };
  emit();
  // The sources are located in at once, each on one of the engine's threads; each one's receipts are made here as it
  // is done.
  await Promise.all([...bySource].map(async ([document, items]) => {
    signal?.throwIfAborted();
    try {
      // The source's text, read where a quotation was not found in a passage of it.
      let documentText: string | undefined;
      const text = () => documentText ??= engine.documentText(document), revision = engine.documentRevision(document);
      const located = await engine.quoteLocateDocument(document, quoteBlocks(document, items[0].judgment),
        items.map(({ row, pinpoints }) => ({ quote: row.quote, scopes: quoteScopes(pinpoints), id: row.id })),
        options.compare !== false);
      // Each found quotation's link, its text fragments planned off this thread.
      const passages = items.map((item, index) => {
        try { return linkedPassage(item, located[index].match); } catch (error) { return error as Error; }
      });
      await planLegalSourcePinpoints(document, passages.flatMap((passage) => passage && !(passage instanceof Error)
        ? [passage] : [])).catch(() => signal?.throwIfAborted());
      const hashes = new Map<string, string>();
      items.forEach((item, index) => {
        try {
          const passage = passages[index];
          if (passage instanceof Error) throw passage;
          item.check = checked(item, located[index], passage, text, revision, hashes);
        } catch {
          signal?.throwIfAborted();
          item.check = unavailable(item.candidateId);
        }
      });
    } catch {
      signal?.throwIfAborted();
      for (const item of items) item.check ??= unavailable(item.candidateId);
    }
    emit();
  }));
  /** The passage a found quotation's link opens: the block that holds the quoted words, with the block's own anchor
   *  beside the fragment where the source's page has one (CanLII's #par12 or #sec4, Decisia's #par12). */
  function linkedPassage({ row, source, document }: Pending, match: NativeQuoteLocation) {
    if (!source.url || !match.text) return null;
    const [, kind, value] = /^(par|page |sec)(.+)$/u.exec(match.labels[0] ?? "") ?? [];
    const blockKind = kind === "par" ? "paragraph" : kind === "sec" ? "section" : "page";
    const anchor = blockKind !== "page" ? legalSourceLocatorAnchor(source.url, blockKind, match.labels[0]) : undefined;
    return { url: source.url, blockText: match.text, quotes: [match.fragment || row.quote],
      anchor: anchor ?? (kind ? engine.readDocumentRange(document, blockKind, value, value, 0)?.selected[0]?.anchor : undefined) };
  }
  /** A located quotation's check: its receipt, with a link that opens the source at the quoted words. */
  function checked({ candidateId, pinpoints, source, document }: Pending,
    { match, comparison, errors }: Awaited<ReturnType<typeof engine.quoteLocateDocument>>[number],
    passage: ReturnType<typeof linkedPassage>, documentText: () => string, revision: string,
    hashes: Map<string, string>): QuoteCheck {
    const text = match.text || documentText();
    const cited = pinpoints.length === 1 ? sourceLocator(pinpoints[0]) : null;
    const link = passage ? buildLegalSourcePinpoint({ url: passage.url, anchor: passage.anchor,
      blockText: passage.blockText, documentText: document }, passage.quotes)?.target ?? null : null;
    // Locator-only callers keep their exact-match outcome; a comparison accepts only computed, supported wording.
    const verified = options.compare === false ? match.perfect
      : comparison !== null && errors !== undefined && errors.length === 0;
    return { candidateId, status: match.location !== "unmatched" && verified ? "verified" : "mismatch",
      detail: match.location === "unmatched" ? "The quotation was not found in the source text."
        : match.location.startsWith("alternate") ? `Found at ${match.pinpoint || "another place in the source"}, not at the cited pinpoint.`
          : cited ? "Compared with the cited passage." : "Compared with the available source text; no unique pinpoint supplied.",
      receipt: { source, sourceSha256: revision,
        passageSha256: memo(hashes, text, () => canonicalJsonSha256(text)), locator: cited, text,
        errors: errors ?? [],
        comparison, match, link } };
  }
  return { mode: links.length ? "assisted" : "mechanical", quotes: quotes as QuoteResult[], total: all.length,
    citationUnits: unitReceipts,
    counts: quoteCheckCounts(quotes as QuoteResult[]) };
}

/** How many source checks found each outcome. */
export function quoteCheckCounts(quotes: QuoteResult[]) {
  return Object.fromEntries(STATUSES.map((status) => [status,
    quotes.reduce((sum, quote) => sum + quote.checks.filter((item) => item.status === status).length, 0)]));
}

const QUOTES = new Set(['"', "“", "”", "«", "»", "„", "'", "‘", "’", "‚"]);

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

type QuoteBlock = { kind: "paragraph" | "page" | "section"; label: string; start: number; end: number };
type QuoteScopes = { paragraphs: Array<[number, number]>; pages: Array<[number, number]>; sections: string[] };

/** A source's paragraphs, pages and provisions, named "par12", "page 333" and "sec4"; a judgment's
 *  PDF by the paragraph numbers it prints. */
export function quoteBlocks(native: NativeDocument, judgment = false): QuoteBlock[] {
  const engine = structureNative();
  if (judgment) {
    const paragraphs = engine.documentCaseOutline(native).filter((entry) => entry.kind === "paragraph").flatMap((entry): QuoteBlock[] => {
      const number = /^\[?(\d{1,4})\]?\.?$/u.exec(entry.label.trim())?.[1];
      return number ? [{ kind: "paragraph", label: `par${number}`, start: entry.start, end: entry.end }] : [];
    });
    if (paragraphs.length) return paragraphs;
  }
  return engine.documentAnchors(native).flatMap((anchor): QuoteBlock[] => {
    if (anchor.kind !== "paragraph" && anchor.kind !== "page" && anchor.kind !== "section") return [];
    // Native labels may carry their kind ("page333", "para 12", "s. 4").
    const prefix = { paragraph: /^(?:paras?\.?|par|¶)\s*(?=\d)/iu, page: /^(?:pages?|pp?\.?)\s*(?=\d)/iu,
      section: /^(?:sections?|ss?\.|sec)\s*(?=\d)/iu }[anchor.kind];
    let value = anchor.label.trim().replace(prefix, "").replace(/^\[(.*)\]$/u, "$1");
    // A named provision has no number: "secSchedule".
    if (anchor.kind === "section") value = value.replace(/^sec(?=[A-Z])/u, "");
    const label = anchor.kind === "paragraph" ? `par${value}` : anchor.kind === "page" ? `page ${value}` : `sec${value}`;
    return [{ kind: anchor.kind, label, start: anchor.start, end: anchor.end }];
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

/** Up to `limit` locations, then how many more. */
export function pinpointSummary(pinpoints: string[], limit = 2) {
  const values = pinpoints.map((value) => value.trim()).filter(Boolean);
  return values.slice(0, limit).join(", ") + (values.length > limit ? ` [+${values.length - limit} more instances]` : "");
}
