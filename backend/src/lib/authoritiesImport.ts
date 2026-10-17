import { ApplicationError, type ApplicationScope } from "./applicationError";
import {
  authoritySeedFromReceipts,
  createAuthoritiesDraft,
  isObservedSourceUrl,
  reduceAuthoritiesDraft,
  type AuthoritiesFreshReview,
  type AuthoritiesCover,
  type AuthoritiesDocumentSnapshot,
  type AuthoritiesImport,
  type AuthorityCitationLedger,
  type AuthoritiesSourceMode,
  type AuthoritiesBuildSettings,
  type AuthorityIdentity,
  type AuthorityKind,
  type AuthorityOccurrence,
} from "./authoritiesDomain";
import { sourceDocumentFields } from "mike/shared/court-record-source-fields.mjs";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { documentProjectionService } from "./documentProjectionService";
import { validateAuthoritiesPdf } from "./authoritiesPdf";
import type { DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { structureNative, type NativeAuthorityReferenceOccurrence, type NativeAuthorityTextUnit,
  type NativeCitationOccurrence, type NativeReferencePart } from "./structureNative";
import type { WorkProductInput } from "./workProduct";
import { citationAliasKeysBatch } from "./caselawCitator";
import { a2ajLegalSourceProvider } from "./legalSources/a2aj";
import { buildCanliiLawUrl } from "mike/shared/runtime/canliiLawUrls.mjs";
import { mapBounded } from "./mapBounded";
import { registerWorkExtents } from "mike/shared/work-extents.mjs";
import type { Citation, ExtractResponse, ResolveResponse, SourcePart } from "legal-citations";

type DocumentInput = Extract<WorkProductInput, { kind: "document" }>;
type SupraLinking = NonNullable<AuthoritiesBuildSettings["supraLinking"]>;
type ProjectionReader = Pick<typeof documentProjectionService, "read"> &
  Partial<Pick<typeof documentProjectionService, "preparePdf">>;
type AuthoritiesNative = Pick<ReturnType<typeof structureNative>,
  "docxAuthorityTextUnits" | "pdfAuthorityTextUnits"> &
  Partial<Pick<ReturnType<typeof structureNative>, "pdfDocumentSummary">>;

export type GroundedReceiptSeed = {
  authorityKey: string;
  receipts: readonly LegalEvidenceReceipt[];
};

export type AuthoritiesImportSource = { kind: "manual" } | DocumentInput |
  { kind: "receipts"; seeds: readonly GroundedReceiptSeed[] };

type Span = { start: number; end: number };

async function readImportUnits(fileType: "docx" | "pdf", read: () => Promise<NativeAuthorityTextUnit[]>,
  readBytes?: () => Buffer | Promise<Buffer>) {
  try { return await read(); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (fileType === "docx" && /^(?:DOCX (?:is empty|has no)|ZIP error:|XML (?:error:|has ))/u.test(message))
      throw new ApplicationError(400, "Word document is invalid or corrupt. Choose a readable .docx file.");
    if (fileType === "pdf" && /^PDF is (?:password-protected|invalid or corrupt)/u.test(message))
      throw new ApplicationError(400, message);
    if (fileType === "pdf" && readBytes && message === "PDF structural parser failed")
      await validateAuthoritiesPdf(await readBytes());
    throw error;
  }
}
function occurrenceSpans(unitText: string, authority: Span, core: Span,
  pinpoints: Span[], phrase: Span | undefined, offset = 0) {
  const span = ({ start, end }: Span) => ({
    start: offset + start, end: offset + end,
    text: unitText.slice(offset + start, offset + end),
  });
  const ordered = [...pinpoints].sort((left, right) => left.start - right.start);
  const pinpoint = ordered.length ? { start: ordered[0].start, end: ordered.at(-1)!.end } : null;
  return { authoritySpan: span(authority), coreSpan: span(core), pinpointSpan: pinpoint && span(pinpoint),
    // The pinpoints as written, with the words that introduce them: "at para 105".
    ...(pinpoint && phrase && phrase.start <= pinpoint.start && phrase.end >= pinpoint.end &&
      { pinpointPhrase: span(phrase) }) };
}

/** Format an already parsed range; never infer ranges from gaps between tokens. A single
 *  pinpoint names its locator as the engine reads it: "110ff" locates para 110. Each keeps
 *  where its unit writes it, the parsed text starting at `offset` in that unit. */
export function pinpointValues<Kind extends string>(pinpoints: ReadonlyArray<{ kind: Kind; text: string;
  start: number; end: number; first?: string; last?: string | null }>, offset = 0) {
  return pinpoints.map(({ kind, text, start, end, first, last }) => ({ kind,
    text: last ? text.replace(/\s*(?:[-\u2013\u2014]|to)\s*/gu, "-") : first ?? text,
    ...first ? { first } : {}, ...last ? { last } : {}, start: offset + start, end: offset + end }));
}
export const nativeOccurrenceSpans = (match: NativeCitationOccurrence, text: string, offset = 0) =>
  occurrenceSpans(text, match.styledCitation, match.coreCitation, match.pinpoints, match.pinpointPhrase, offset);
/** Keep the written short name with the reference marker and its pinpoints separate. */
export const nativeReferenceSpans = (reference: NativeAuthorityReferenceOccurrence, text: string, offset = 0) =>
  occurrenceSpans(text, { start: reference.start, end: reference.token.end }, reference.token,
    reference.pinpoints, reference.pinpointPhrase, offset);

/** A federal, Ontario or B.C. statute's CanLII page, as the citation engine reads it: its language, jurisdiction and id. */
const canliiStatute = (url: string | null | undefined, native: ReturnType<typeof structureNative>) => {
  const page = url ? native.citationEngineCall("canliiLawPage", JSON.stringify({ url })) as
    { language: "en" | "fr"; jurisdiction: string; kind: string; id: string } | null : null;
  return page && Object.hasOwn(STATUTE_DATASET, page.jurisdiction) && ["stat", "astat"].includes(page.kind) ? page : null;
};
const STATUTE_DATASET = { ca: "LEGISLATION-FED", on: "LEGISLATION-ON",
  bc: "LEGISLATION-BC" } as const;
const sourceName = (value: string) => value.normalize("NFKC").toLowerCase()
  .replace(/[^a-z0-9 ]/gu, "").replace(/\s+/gu, " ").trim();
const slugKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/gu, "");
const statuteCore = (citation: Citation) => {
  const { series, year, chapter } = citation.fields;
  return series && year && chapter ? slugKey(`${series}-${year}-c-${chapter}`) : null;
};

/** A2AJ verifies a source's name and canonical statute citation before its URL enters the registry. */
async function enrichStatuteSources(parts: SourcePart[], citations: Citation[],
  native: ReturnType<typeof structureNative>) {
  const candidates = parts.flatMap((part, partIndex) => {
    const full = citations.filter((citation) => citation.form === "full" &&
      citation.authority === "statute" && part.start <= citation.span.start &&
      citation.span.end <= part.end);
    if (full.length !== 1 || !statuteCore(full[0])) return [];
    const citation = full[0];
    const name = citation.shortName?.trim();
    if (!name || !sourceName(part.text).includes(sourceName(name))) return [];
    const output = native.citationEngineCall("url", JSON.stringify({ citation,
      anchor: true })) as { urls: Array<{ index: number; url: string | null }> };
    const url = output.urls.find((item) => item.index === citation.index)?.url;
    const page = canliiStatute(url, native);
    if (!page) return [];
    const core = statuteCore(citation)!;
    if (!slugKey(page.id).startsWith(core) && !core.startsWith(slugKey(page.id))) return [];
    return [{ partIndex, part, citation, url: url!, language: page.language,
      dataset: STATUTE_DATASET[page.jurisdiction as keyof typeof STATUTE_DATASET],
      jurisdiction: page.jurisdiction, name, core }];
  });
  if (!candidates.length) return parts;
  const queries = [...new Map(candidates.map(({ dataset, name, language }) =>
    [`${dataset}:${language}:${sourceName(name)}`, { dataset, name, language }])).values()];
  const hits = new Map((await mapBounded(queries, async ({ dataset, name, language }) => {
    try {
      return [
        `${dataset}:${language}:${sourceName(name)}`,
        await a2ajLegalSourceProvider.search!({ text: name, kinds: ["legislation"],
          searchType: "name", collection: dataset, language, limit: 50, ordered: false }),
      ] as const;
    } catch { return [`${dataset}:${language}:${sourceName(name)}`, []] as const; }
  })).map(([key, results]) => [key, results]));
  return parts.map((part, index) => {
    const candidate = candidates.find(({ partIndex }) => partIndex === index);
    if (!candidate) return part;
    const matches = (hits.get(`${candidate.dataset}:${candidate.language}:${sourceName(candidate.name)}`) ?? [])
      .filter((hit) => hit.collection?.toUpperCase() === candidate.dataset && hit.title &&
        sourceName(candidate.part.text).includes(sourceName(hit.title)))
      .flatMap((hit) => {
        const parsed = native.citationEngineCall("extract", JSON.stringify({
          text: hit.citation ?? "", options: { resolve: false },
        })) as ExtractResponse;
        const statutes = parsed.citations.filter((citation) => citation.form === "full" &&
          citation.authority === "statute");
        if (statutes.length !== 1 || statuteCore(statutes[0]) !== candidate.core) return [];
        const base = buildCanliiLawUrl({ dataset: hit.collection ?? "",
          citation: hit.citation ?? null, language: candidate.language });
        const route = canliiStatute(base, native);
        if (!route || route.language !== candidate.language ||
          route.jurisdiction !== candidate.jurisdiction) return [];
        const fragment = new URL(candidate.url).hash;
        return [base!.split("#")[0] + fragment];
      });
    const urls = [...new Set(matches)];
    return urls.length === 1 && urls[0] !== candidate.url
      ? { ...part, resolvedUrl: urls[0] } : part;
  });
}

/** `supraLinking`: the citation engine's splitting tier its references are resolved at (the draft setting). */
async function scanReview(
  imported: AuthoritiesImport,
  bindings: Record<string, WorkProductInput>,
  units: NativeAuthorityTextUnit[],
  supraLinking: SupraLinking = "safe",
): Promise<AuthoritiesFreshReview> {
  const occurrences: Record<string, AuthorityOccurrence> = {};
  const authorities: Record<string, AuthorityIdentity> = {};
  const authorityOrder: string[] = [];
  let offset = 0;
  let ranges = units.map((unit) => {
    const start = offset;
    offset += unit.text.length + 2;
    return { unit, start, end: start + unit.text.length };
  });
  const text = units.map(({ text }) => text).join("\n\n");
  const native = structureNative();
  const unknownNote = 0xffff_ffff;
  const orderedUnits = native.documentReadingOrder(JSON.stringify(units.map((unit) => ({
    kind: unit.kind, footnote_id: unit.footnote_id, footnote_refs: unit.footnote_refs,
    item_offsets: [0],
  })))).map(([unit]) => ranges[unit]);
  // Where each note's marker stands in the text it annotates.
  const anchors = new Map(ranges.flatMap(({ unit, start }) =>
    unit.footnote_refs.map(([id, offset]) => [id, start + offset] as const)));
  const notes = orderedUnits.filter(({ unit }) => unit.footnote_id !== null)
    .map(({ unit, start, end }) => ({ number: unit.note_number === null
      ? unknownNote : unit.note_number ?? unit.footnote_id!, start, end,
    sequence: unit.note_number === null ? unknownNote : unit.restart_sequence ?? 0,
    ...(anchors.has(unit.footnote_id!) ? { anchor: anchors.get(unit.footnote_id!) } : {}) }));
  // A Canadian brief is read with McGill's and COAL's forms; without the Bluebook or a US jurisdiction the engine
  // reads no extended United States forms (a registration or account number reads as one of its codes).
  const extracted = native.citationEngineCall("extract", JSON.stringify({ text, offsetUnit: "utf16",
    options: { resolve: false, notes, styles: ["mcgill", "coal"], earlyReferences: true, splitTier: supraLinking },
  })) as ExtractResponse;
  // The brief's own court file number (its cover's) is never one of its authorities, though an
  // order made under it that the brief names ("Re Ash Ltd, Order of Madam Justice Fen dated …,
  // Court File No. 1601-06131") is.
  const fileNumber = (value: unknown) => typeof value === "string" ? value.replace(/\D/gu, "") : "";
  const ownFile = fileNumber(importedCover(units).courtFileNumber);
  const namedOrder = (citation: Citation) => !!citation.style?.text.trim() &&
    ["Order of", "Endorsement of"].some((words) => citation.fullSpan.text.includes(words));
  if (ownFile) extracted.citations = extracted.citations.filter((citation) =>
    citation.format !== "docket" || namedOrder(citation) || fileNumber(citation.fields.docket) !== ownFile);
  // A web address written with no title of a work before it points the reader to a site; it
  // names no authority a book could hold.
  extracted.citations = extracted.citations.filter((citation) =>
    citation.form !== "full" || citation.authority !== "webpage" || !!citation.style?.text.trim());
  // PDF layout units can end in the middle of a citation. Join only those body
  // boundaries, retaining the engine's exact text and global UTF-16 addresses.
  if (imported.kind === "document" && imported.fileType === "pdf") {
    const joins = new Set<number>();
    for (const citation of extracted.citations) {
      if (citation.form === "unknown") continue;
      const spans = [citation.fullSpan, citation.span, ...(citation.style ? [citation.style] : []),
        ...(citation.pinpoints ?? []).map(({ span }) => span)];
      const start = Math.min(...spans.map(({ start }) => start)), end = Math.max(...spans.map(({ end }) => end));
      const first = ranges.findIndex((range) => range.end > start);
      for (let index = first; index >= 0 && index + 1 < ranges.length && ranges[index + 1].start < end; index++) {
        if (ranges[index].unit.kind === "body" && ranges[index + 1].unit.kind === "body") joins.add(index);
      }
    }
    if (joins.size) {
      const merged: typeof ranges = [];
      ranges.forEach((range, index) => {
        const prior = merged.at(-1);
        if (!prior || !joins.has(index - 1)) { merged.push({ ...range }); return; }
        const leftSource = prior.unit.source, rightSource = range.unit.source;
        if ((leftSource || rightSource) && (!leftSource || !rightSource ||
            leftSource.documentId !== rightSource.documentId || leftSource.textSha256 !== rightSource.textSha256)) {
          throw new Error("Cannot join authority units from different source representations");
        }
        const source = leftSource && rightSource ? { ...leftSource,
          nodeIds: [...new Set([...leftSource.nodeIds, ...rightSource.nodeIds])],
          lineIds: [...new Set([...leftSource.lineIds, ...rightSource.lineIds])],
          ranges: [...leftSource.ranges, ...rightSource.ranges],
          mappings: [...leftSource.mappings, ...rightSource.mappings.map((mapping) => ({ ...mapping,
            start: mapping.start + range.start - prior.start, end: mapping.end + range.start - prior.start }))],
        } : undefined;
        prior.unit = { ...prior.unit, ...(source && { source }), text: `${prior.unit.text}\n\n${range.unit.text}`,
          page_numbers: [...new Set([...prior.unit.page_numbers, ...range.unit.page_numbers])].sort((left, right) => left - right),
          footnote_refs: [...prior.unit.footnote_refs, ...range.unit.footnote_refs.map(([id, offset]) =>
            [id, range.start - prior.start + offset] as [number, number])] };
        prior.end = range.end;
      });
      ranges = merged;
    }
  }
  const cases = extracted.citations.filter(({ form, authority, key }) =>
    form === "full" && key && (authority === "case" || authority === "unknown"));
  const closures = citationAliasKeysBatch(cases.map(({ span }) => span.text));
  const parsed = ranges.map(({ unit }) => ({ unit, items: [] as Array<{ index: number; start: number }> }));
  let unitIndex = 0;
  for (const citation of [...extracted.citations].sort((left, right) =>
    left.span.start - right.span.start || left.index - right.index)) {
    while (unitIndex + 1 < ranges.length && citation.span.start >= ranges[unitIndex].end) unitIndex++;
    parsed[unitIndex].items.push({ index: citation.index, start: citation.span.start - ranges[unitIndex].start });
  }
  const order = native.documentReadingOrder(JSON.stringify(parsed.map(({ unit, items }) => ({
    kind: unit.kind, footnote_id: unit.footnote_id, footnote_refs: unit.footnote_refs,
    item_offsets: items.map(({ start }) => start),
  })))).map(([unit, item]) => parsed[unit].items[item].index);
  // The note parts that cite: only these can be an authority (a prose note is never one).
  const references = native.citationEngineCall("noteReferences", JSON.stringify({ parts: extracted.sourceParts,
    citations: extracted.citations, offsetUnit: "utf16" })) as NativeReferencePart[];
  const enriched = await enrichStatuteSources(references.map(({ part }) => part), extracted.citations, native);
  // Every part reaches the resolver, prose included, so an ibid after a prose note continues from it (and stands for
  // no authority) rather than from the last part that cites.
  const indexOf = new Map(extracted.sourceParts.map((part, index) => [`${part.start}:${part.end}`, index]));
  const partIndex = (part: SourcePart) => indexOf.get(`${part.start}:${part.end}`) ?? -1;
  const enrichedAt = new Map(references.map((source, at) => [partIndex(source.part), enriched[at]]));
  const sourceParts = extracted.sourceParts.map((part, index) => enrichedAt.get(index) ?? part);
  // How far the cited works run (Beaver's works pack), so a pinpoint past a work's end refuses a reference's link.
  registerWorkExtents(native);
  // Every reference's association, the one each consumer reads (the verifier's workbook and quotation check, Sources):
  // the document's text, so a reference can be read by the words before its note's marker, at the setting's tier.
  const result = native.citationEngineCall("resolve", JSON.stringify({ citations: extracted.citations, notes,
    readingOrder: order, sourceParts, text, offsetUnit: "utf16",
    supraHintMode: "aggressive", splitTier: supraLinking,
    aliasGroups: cases.map(({ index }, position) => ({ index, keys: closures[position] })),
  })) as ResolveResponse;
  const byIndex = new Map(result.citations.map((citation) => [citation.index, citation]));
  const byResolution = new Map(result.resolutions.map((resolution) => [resolution.index, resolution]));
  const authorityOf = new Map<number, string>();
  const documentHash = sha256(text);
  const kindOf = (authority: Citation["authority"]): AuthorityKind => {
    switch (authority) {
      case "case": return "case";
      case "statute": case "regulation": case "constitution": case "court_rule":
      case "treaty": case "bill": return "legislation";
      case "journal": case "book": case "book_chapter": case "webpage": return "commentary";
      default: return "other";
    }
  };
  const origins = new Set(result.resolutions.flatMap(({ sourcePart }) => sourcePart == null ? [] : [sourcePart]));
  const originParts = references.flatMap((source) => origins.has(partIndex(source.part)) &&
    source.references.every(({ form }) => form !== "citation")
    ? [{ ...source, index: partIndex(source.part), reference: source.references[0] }] : []);
  const sourceGroups = new Map<number, string>();
  const unkeyed = new Map<string, string>();
  // The link each citation writes ("online: <…>", a URL in its text), by citation.
  const linkOf = new Map(references.flatMap(({ references: found }) => found.flatMap((reference) =>
    reference.citation != null && reference.link ? [[reference.citation, reference.link] as const] : [])));
  // Each authority's representative citation, its name, its citation as written and the authority
  // it is subsequent history of, as the engine reads them.
  const readings = native.citationEngineCall("authorities", JSON.stringify({ citations: result.citations,
    authorities: result.authorities })) as Array<{ representative?: number; name?: string; citation?: string; historyOf?: number }>;
  const groupKeys: string[] = [];
  for (const [position, group] of result.authorities.entries()) {
    const reading = readings[position];
    const full = group.map((index) => byIndex.get(index))
      .filter((citation): citation is Citation => citation?.form === "full");
    const sourceUrl = sourceParts.find((part) => part.resolvedUrl &&
      full.length === 1 && part.start <= full[0].span.start &&
      full[0].span.end <= part.end)?.resolvedUrl;
    const referenceUrl = group.map((index) => byResolution.get(index)?.url)
      .find(isObservedSourceUrl);
    const url = sourceUrl ??
      full.map((citation) => withScheme(linkOf.get(citation.index) ?? citation.fields.url)).find(isObservedSourceUrl) ??
      (full.length && referenceUrl ? referenceUrl.split("#")[0] : referenceUrl);
    const origin = group.map(index => byResolution.get(index)?.sourcePart).find(index => index != null);
    const source = !full.length ? originParts.find(({ index }) => index === origin) : undefined;
    const representative = (reading?.representative === undefined ? undefined : byIndex.get(reading.representative)) ??
      (source ? group.map((index) => byIndex.get(index)).find(Boolean) : undefined);
    if (!representative) continue;
    // A document-local review identity keeps unkeyed sources visible without
    // asserting a bibliographic identity; a citation written alike, style and all, names one.
    // An order cited by its judge, date and number ("Order of Mr. Justice Butler dated August 13,
    // 2015, No. S-154746") is that order whatever matter is written before it.
    const selfNamed = representative.format === "docket" && representative.span.text.includes("Order of");
    const written = full.length ? `${selfNamed ? "" : representative.style?.text ?? ""} ${representative.span.text}`
      .replace(/\s+/gu, " ").trim() : null;
    // A recognizer may misread a letter of the name ("Re Pacifio …" for "Re Pacific …"): an order cited
    // by the same file number under a name a letter or two apart is the same order.
    const misread = written && representative.format === "docket" ? [...unkeyed].find(([other]) =>
      other.endsWith(` ${representative.span.text.replace(/\s+/gu, " ").trim()}`) && withinTwoEdits(other, written))?.[1] : undefined;
    const key = full.length && representative.key || written && (unkeyed.get(written) ?? misread) ||
      `scan:${documentHash}:${source ? `source:${source.index}` : representative.index}`;
    if (written) unkeyed.set(written, key);
    group.forEach((index) => authorityOf.set(index, key));
    groupKeys[position] = key;
    if (authorities[key]) continue;
    const sourceLink = withScheme(source?.reference.link ?? url);
    const explicitUrl = isObservedSourceUrl(sourceLink) ? sourceLink : null;
    if (source) sourceGroups.set(source.index, key);
    const observedText = source?.reference.text ?? (full.length ? reading.citation! : representative.fullSpan.text);
    authorities[key] = { id: key, key, kind: kindOf((source?.reference ?? representative).authority),
      ...(full.length && full.every(citation => citation.authority === "case" &&
          ["database", "docket"].includes(citation.format ?? ""))
        ? { citationFormat: representative.format as "database" | "docket" } : {}),
      // A citation or name a PDF's line or page break runs through is one line ("RSC ⏎⏎ 1985").
      citation: oneLine(observedText),
      name: source ? null : reading?.name ?? null,
      // A decision's other names in the brief: its short forms, and the case the sentence a note
      // hangs from names. They tell whether the case a source holds at its citation is the one meant.
      ...(() => {
        if (kindOf(representative.authority) !== "case") return {};
        const shortNames = [...new Set(full.flatMap((citation) => citation.explicitShortName?.trim()
          ? [oneLine(citation.explicitShortName)] : []))];
        const mentionedAs = full.map((citation) =>
          (citation.fields as { anchorMention?: { text: string } }).anchorMention?.text).find((value) => value?.trim());
        return { ...shortNames.length && { shortNames }, ...mentionedAs && { mentionedAs: oneLine(mentionedAs) } };
      })(),
      displayName: null, excluded: false,
      evidenceIds: [], locators: [], sourceIdentity: null,
      source: { kind: "unresolved" }, scanOnly: true,
      ...(explicitUrl ? { sourceUrl: explicitUrl } : {}) };
    authorityOrder.push(key);
  }
  // A decision the engine reads as another's subsequent history ("…, 2010 ABQB 242, aff'd 2010
  // ABCA 191") records which authority it follows, and is known by its case's name unless the brief
  // gives it one of its own.
  for (const [position, reading] of readings.entries()) {
    const child = groupKeys[position], parent = reading.historyOf === undefined ? undefined : groupKeys[reading.historyOf];
    if (!child || !parent || child === parent || authorities[child].historyOf) continue;
    authorities[child].historyOf = parent;
    authorities[child].name ??= reading.name ?? authorities[parent].name;
  }
  const sourceOccurrences = originParts.flatMap(({ index, reference: { start, end } }) => {
    const authorityId = sourceGroups.get(index);
    return authorityId ? [{ start, end, core: { start, end }, authorityId,
      citation: authorities[authorityId].citation, kind: authorities[authorityId].kind }] : [];
  });
  const reviewItems = [
    ...result.citations.map((citation) => ({ start: citation.span.start, citation, source: null })),
    ...sourceOccurrences.map((source) => ({ start: source.start, citation: null, source })),
  ].sort((left, right) => left.start - right.start);
  let cursor = 0;
  // Each citation's occurrence, and where each occurrence starts in the text.
  const occurrenceOf = new Map<number, string>(), startOf = new Map<string, number>();
  const reviewUnits = ranges.map(({ unit, start, end }) => {
    const occurrenceIds: string[] = [];
    const sourceTextSha256 = sha256(unit.text);
    while (cursor < reviewItems.length && reviewItems[cursor].start < start) cursor++;
    while (cursor < reviewItems.length && reviewItems[cursor].start < end) {
      const { citation, source } = reviewItems[cursor++];
      if (source) {
        const localOrdinal = occurrenceIds.length;
        const id = `${unit.key}:${localOrdinal}`;
        const local = (range: Span) => ({ start: range.start - start, end: range.end - start });
        const full = local(source);
        occurrenceIds.push(id);
        startOf.set(id, start + full.start);
        occurrences[id] = { id, unitId: unit.key, ...full,
          text: unit.text.slice(full.start, full.end),
          ...occurrenceSpans(unit.text, full, local(source.core), [], undefined),
          kind: source.kind, citation: source.citation, authorityId: source.authorityId,
          reference: null, pinpoints: [], evidenceIds: [], sourceTextSha256, localOrdinal,
          reviewed: false };
        continue;
      }
      if (!citation) continue;
      if (citation.form === "unknown") continue;
      const localOrdinal = occurrenceIds.length;
      const id = `${unit.key}:${localOrdinal}`;
      const authorityId = authorityOf.get(citation.index) ?? null;
      const local = (span: Span) => ({ start: Math.max(start, span.start) - start,
        end: Math.min(end, span.end) - start });
      const reference = citation.form !== "full";
      const pinpoints = (citation.pinpoints ?? []).filter(({ span }) =>
        start <= span.start && span.end <= end);
      const marker = citation.fields.inlineReference?.span;
      const core = local(marker ?? citation.span);
      const full = local(citation.fullSpan);
      const styled = { start: citation.style &&
        citation.style.start >= Math.max(start, citation.fullSpan.start) &&
        citation.style.start <= citation.span.start
        ? citation.style.start - start : core.start, end: core.end };
      occurrenceIds.push(id);
      occurrenceOf.set(citation.index, id);
      startOf.set(id, start + full.start);
      occurrences[id] = { id, unitId: unit.key, ...full,
        text: unit.text.slice(full.start, full.end),
        ...occurrenceSpans(unit.text, styled, core, pinpoints.map(({ span }) => local(span)),
          citation.fields.pinCite ? local(citation.fields.pinCite) : undefined),
        kind: reference ? "reference" : kindOf(citation.authority), citation: citation.span.text,
        ...(citation.key ? { key: citation.key } : {}), authorityId,
        reference: authorityId && (citation.form === "short" || citation.form === "ibid" || citation.form === "supra")
          ? { kind: citation.form, targetAuthorityId: authorityId } : null,
        referenceKind: citation.form === "short" || citation.form === "ibid" || citation.form === "supra"
          ? citation.form : undefined,
        pinpoints: pinpointValues(pinpoints.map(({ kind, span, first, last }) =>
          ({ kind, text: span.text, first, last, ...local(span) }))),
        evidenceIds: [], sourceTextSha256, localOrdinal, reviewed: reference && Boolean(authorityId) };
    }
    return { id: unit.key, kind: unit.kind, ordinal: unit.ordinal,
      ...(unit.source && { source: unit.source }),
      footnoteId: unit.footnote_id, ...(unit.note_number !== undefined && { noteNumber: unit.note_number }),
      ...(unit.note_mark && { noteMark: unit.note_mark }), ...(unit.restart_sequence && { restartSequence: unit.restart_sequence }),
      ...(unit.links?.length && { authorLinks: unit.links }),
      pageNumbers: unit.page_numbers, text: unit.text, footnoteRefs: unit.footnote_refs, occurrenceIds };
  });
  // Where the engine resolved each reference, as its citations of the authority: the one its chain ends at (its
  // origin) and the one it names directly, each the first of the authority's in the part the engine gives.
  for (const resolution of result.resolutions) {
    const id = occurrenceOf.get(resolution.index), reference = id ? occurrences[id].reference : null;
    if (!reference) continue;
    const inPart = (index: number | null | undefined) => {
      const part = index == null ? undefined : sourceParts[index];
      return part && Object.keys(occurrences).filter((other) => other !== id
        && occurrences[other].authorityId === reference.targetAuthorityId
        && part.start <= startOf.get(other)! && startOf.get(other)! < part.end)
        .sort((left, right) => startOf.get(left)! - startOf.get(right)!)[0];
    };
    const antecedent = resolution.antecedent == null ? undefined : occurrenceOf.get(resolution.antecedent);
    const origin = inPart(resolution.sourcePart)
      ?? (antecedent && occurrences[antecedent].authorityId === reference.targetAuthorityId ? antecedent : undefined);
    const named = inPart(resolution.targetPart);
    if (origin) reference.originId = origin;
    if (named) reference.namedId = named;
  }
  // The parser can return overlapping full spans even when their citation cores
  // are distinct. Keep both editable mentions by trimming only shared context.
  for (const unit of reviewUnits) {
    const kept: string[] = [];
    for (const id of unit.occurrenceIds) {
      const current = occurrences[id];
      const previous = kept.length ? occurrences[kept[kept.length - 1]] : null;
      if (previous && current.start < previous.end) {
        const previousCoreEnd = Math.max(previous.coreSpan.end,
          previous.pinpointPhrase?.end ?? previous.pinpointSpan?.end ?? 0);
        if (previousCoreEnd > current.coreSpan.start) {
          delete occurrences[id];
          continue;
        }
        const boundary = Math.max(previousCoreEnd, current.start);
        if (boundary < previous.end) {
          previous.end = boundary;
          previous.text = unit.text.slice(previous.start, boundary);
          if (previous.authoritySpan.end > boundary) {
            previous.authoritySpan.end = boundary;
            previous.authoritySpan.text = unit.text.slice(previous.authoritySpan.start, boundary);
          }
        }
        if (current.start < previous.end) {
          current.start = previous.end;
          current.text = unit.text.slice(current.start, current.end);
          if (current.authoritySpan.start < current.start) {
            current.authoritySpan.start = current.start;
            current.authoritySpan.text = unit.text.slice(current.start, current.authoritySpan.end);
          }
        }
      }
      kept.push(id);
    }
    unit.occurrenceIds = kept;
  }
  return { import: imported, bindings, cover: importedCover(units), units: reviewUnits,
    occurrences, authorities, authorityOrder };
}

function importedCover(units: NativeAuthorityTextUnit[]): AuthoritiesCover {
  const body = units.filter(({ kind }) => kind === "body");
  const firstPage = body.filter(({ page_numbers }) => page_numbers.includes(1));
  const opening = (firstPage.length ? firstPage : body.slice(0, 80))
    .map(({ text }) => text).join("\n");
  const fields = sourceDocumentFields(opening ? [opening] : [])?.cover;
  // The parties its BETWEEN block names, and whose brief it is: a brief "of the Applicant" is answered by a book of
  // authorities of the same party, a role named as a role and any other party as the brief names it.
  const { partyGroups, filedBy } = structureNative().filingCover(opening, fields?.recordTitle || null);
  const contact = { name: fields?.counselName ?? "", address: fields?.counselAddress ?? "",
    phone: fields?.counselPhone ?? "", fax: fields?.counselFax ?? "", email: fields?.counselEmail ?? "" };
  return { courtFileNumber: fields?.courtFileNumber ?? "",
    partyGroups,
    applicationUnder: fields?.applicationUnder ?? "",
    title: filedBy ? `Book of Authorities of ${filedBy.article ? "the " : ""}${filedBy.party}` : "",
    ...(fields?.registry && { judicialCentre: fields.registry }),
    ...(Object.values(contact).some(Boolean) && { contact }) };
}

/** How a brief is imported, as every host imports one: the host supplies its bytes, where it keeps them (`binding`,
 *  and `reference`, the stored document a host's projection reads), and the snapshot it is bound to. */
export type AuthoritiesDocumentImport = {
  filename: string; fileType: "docx" | "pdf"; bytes: Buffer; binding: WorkProductInput;
  reference: { documentId: string; versionId: string };
  snapshot: AuthoritiesDocumentSnapshot | null;
  sourceMode?: AuthoritiesSourceMode; supraLinking?: SupraLinking;
  /** The citations Beaver wrote into a brief it drafted, read in place of a scan where they still fit. */
  ledger?: Omit<AuthorityCitationLedger, "document">;
};

/** A brief's draft: its citations read from its text. A brief's own text is what it says, however it reads. Only its
 *  scanned pages (a picture of a page, its text layer invisible or absent) are recognized, where the runtime has a
 *  recognizer, and a scan's layer that reads better than its recognition stands. */
async function importAuthoritiesDocument(input: AuthoritiesDocumentImport,
  projection: ProjectionReader = documentProjectionService, native: AuthoritiesNative = structureNative()) {
  const sourceSha256 = sha256(input.bytes);
  const imported: AuthoritiesImport = { kind: "document", bindingRole: "source",
    filename: input.filename, fileType: input.fileType, snapshot: input.snapshot };
  const bindings = { source: input.binding };
  let initial = createAuthoritiesDraft(imported, bindings);
  if (input.sourceMode || input.supraLinking) initial = reduceAuthoritiesDraft(initial, { type: "set-settings",
    settings: { ...input.sourceMode && { sourceMode: input.sourceMode },
      ...input.supraLinking && { supraLinking: input.supraLinking } } });
  if (input.ledger && input.snapshot) {
    try {
      return reduceAuthoritiesDraft(initial, { type: "ingest-ledger", ledger: { ...input.ledger, document: input.snapshot } });
    } catch { /* Untrusted or stale provenance falls back to the Rust scan. */ }
  }
  const reference = { ...input.reference, sourceSha256, fileType: input.fileType, readBytes: () => input.bytes };
  const readPdf = async () => {
    const prepare = projection.preparePdf;
    if (!prepare) return projection.read(reference);
    const read = async (options: Parameters<typeof prepare>[0]) => {
      const prepared = await prepare(options);
      return projection.read({ ...reference, pdfProfile: { cacheKey: prepared.cacheKey,
        profile: prepared.profile, status: prepared.status } });
    };
    const own = await read({ ...reference, bytes: input.bytes, ocrProvider: null });
    // A scanned page whose own text layer reads well needs no recognition: only the pages the engine
    // still names as needing it are recognized, and with none the brief is read as it is.
    const summary = native.pdfDocumentSummary?.(own);
    const scanned = (summary?.scannedPages ?? []).filter((index) => summary?.pagesNeedingOcr.includes(index));
    if (!scanned.length) return own;
    try {
      return await read({ ...reference, bytes: input.bytes, ocrProvider: "kraken-lite",
        pages: scanned.map((index) => index + 1) });
    } catch { return own; }
  };
  const units = await readImportUnits(input.fileType, async () => {
    if (input.fileType === "docx") return native.docxAuthorityTextUnits(input.bytes);
    return native.pdfAuthorityTextUnits(await readPdf());
  }, () => input.bytes);
  return reduceAuthoritiesDraft(initial, {
    type: "refresh", review: await scanReview(imported, bindings, units, input.supraLinking),
  });
}

async function documentDraft(
  scope: ApplicationScope,
  binding: DocumentInput,
  documents: DocumentStore,
  projection: ProjectionReader,
  native: AuthoritiesNative,
  options: Pick<AuthoritiesDocumentImport, "sourceMode" | "supraLinking"> = {},
) {
  const latest = binding.version === "latest";
  const requestedVersion = binding.version === "latest" ? null : binding.version.versionId;
  const [source, current, history] = await Promise.all([
    documents.projectionSource(scope, binding.documentId, requestedVersion),
    latest ? documents.metadata(scope, binding.documentId) : null,
    latest ? null : documents.versions(scope, binding.documentId),
  ]);
  if (!source) throw new ApplicationError(404, "Document not found");
  const filename = current?.current_version_id === source.versionId
    ? current.filename : history?.versions.find(({ id }) => id === source.versionId)?.filename;
  if (typeof filename !== "string") {
    throw new ApplicationError(404, "Document version not found");
  }
  if (binding.version !== "latest" && source.sourceSha256 !== binding.version.sha256) {
    throw new ApplicationError(409, "Document version hash does not match its source");
  }
  const fileType = source.fileType.trim().toLowerCase();
  if (fileType !== "docx" && fileType !== "pdf") {
    throw new ApplicationError(409, "Authorities sources must be PDF or Word documents");
  }
  const bytes = await source.readBytes();
  if (sha256(bytes) !== source.sourceSha256)
    throw new ApplicationError(409, "Document bytes do not match their version");
  return importAuthoritiesDocument({ ...options, filename, fileType, bytes, binding,
    reference: { documentId: source.documentId, versionId: source.versionId },
    snapshot: { documentId: source.documentId, versionId: source.versionId, sha256: source.sourceSha256 },
    ledger: source.provenance?.actor === "assistant" ? source.provenance.generation?.authorityLedger : undefined,
  }, projection, native);
}

function receiptDraft(seeds: readonly GroundedReceiptSeed[]) {
  if (!seeds.length || seeds.some(({ authorityKey, receipts }) =>
    !authorityKey || !receipts.length)) {
    throw new ApplicationError(400, "Grounded receipt seeds are required");
  }
  let draft = createAuthoritiesDraft({ kind: "manual" });
  for (const { authorityKey, receipts } of seeds) {
    draft = reduceAuthoritiesDraft(draft, {
      type: "add-seed", seed: authoritySeedFromReceipts(authorityKey, receipts),
    });
  }
  return draft;
}

export function createAuthoritiesImporter(
  documents: DocumentStore,
  projection: ProjectionReader = documentProjectionService,
  native?: AuthoritiesNative,
) {
  return Object.freeze({
    async draft(scope: ApplicationScope, source: AuthoritiesImportSource,
      options: Pick<AuthoritiesDocumentImport, "sourceMode" | "supraLinking"> = {}) {
      return source.kind === "manual" ? createAuthoritiesDraft(source)
        : source.kind === "document"
        ? documentDraft(scope, source, documents, projection,
          native ?? structureNative(), options)
        : receiptDraft(source.seeds);
    },
  });
}

const oneLine = (value: string) => value.replace(/\s+/gu, " ").trim();

/** Whether two strings of some length differ by at most two letters added, dropped or changed. */
function withinTwoEdits(left: string, right: string) {
  if (Math.min(left.length, right.length) < 12 || Math.abs(left.length - right.length) > 2) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, at) => at);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) current.push(Math.min(previous[column] + 1,
      current[column - 1] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)));
    if (Math.min(...current) > 2) return false;
    previous = current;
  }
  return previous[right.length] <= 2;
}

/** Stateless local-runtime import; the browser remains the draft/file owner. */
/** A link written without its scheme ("online: <example.org/report>") is the web address it names. */
export const withScheme = (link: unknown) => typeof link === "string" && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]|$)/iu.test(link)
  ? `https://${link}` : link;

/** A brief the standalone runtime is handed: the page keeps the file, known here by its hash. */
export async function importStandaloneAuthoritiesFile(input: {
  filename: string; fileType: "docx" | "pdf"; bytes: Buffer; modified: number;
  sourceMode?: AuthoritiesSourceMode; supraLinking?: SupraLinking;
}, projection: ProjectionReader = documentProjectionService,
native: AuthoritiesNative = structureNative()) {
  const sourceSha256 = sha256(input.bytes);
  return importAuthoritiesDocument({ filename: input.filename, fileType: input.fileType, bytes: input.bytes,
    binding: { kind: "local-file", handleId: "standalone",
      lastSeen: { name: input.filename, size: input.bytes.length, modified: input.modified, sha256: sourceSha256 } },
    reference: { documentId: `standalone-${sourceSha256}`, versionId: sourceSha256 }, snapshot: null,
    sourceMode: input.sourceMode, supraLinking: input.supraLinking }, projection, native);
}

export type AuthoritiesImporter = ReturnType<typeof createAuthoritiesImporter>;
