import type { AuthoritiesDraft, AuthorityOccurrence } from "./authoritiesDomain";
import { quoteTextComparison, sourceLocator } from "./authoritiesDiscrepancy";
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
              citation: first?.citation || part.fields.bare_citation || part.text,
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
  const quotes: QuoteResult[] = [];
  for (const row of rows) {
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
        const resolved = kind === "other" || kind === "reference" ? null : await sources.resolve({
          text: authority.citation, kind, signal });
        if (resolved?.status === "found") {
          const pinpoints = occurrence?.pinpoints ?? candidate?.pinpoints ?? [];
          const locator = pinpoints.length === 1 ? sourceLocator(pinpoints[0]) : null;
          const read = await sources.readPassage({ source: resolved.value,
            ...(locator ? { locator } : {}), signal });
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
    quotes.push({ ...row, status, detail, receipt });
    progress?.(quotes.length, rows.length, quotes.at(-1)!, unitReceipts);
  }
  return { mode: links.length ? "assisted" : "mechanical", quotes, total: all.length,
    citationUnits: unitReceipts,
    counts: Object.fromEntries(["verified", "mismatch", "ambiguous", "unresolved", "unavailable"]
      .map((status) => [status, quotes.filter((row) => row.status === status).length])) };
}
