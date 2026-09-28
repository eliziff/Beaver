import { ApplicationError, type ApplicationScope } from "./applicationError";
import {
  authoritySeedFromReceipts,
  createAuthoritiesDraft,
  isObservedSourceUrl,
  reduceAuthoritiesDraft,
  type AuthoritiesFreshReview,
  type AuthoritiesCover,
  type AuthoritiesImport,
  type AuthoritiesSourceMode,
  type AuthorityIdentity,
  type AuthorityKind,
  type AuthorityOccurrence,
} from "./authoritiesDomain";
import { sourceDocumentFields } from "mike/shared/court-record-source-fields.mjs";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { documentProjectionService } from "./documentProjectionService";
import type { DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { structureNative,
  type NativeAuthorityTextUnit, type NativeCitationOccurrence } from "./structureNative";
import type { WorkProductInput } from "./workProduct";
import { citationAliasKeysBatch } from "./caselawCitator";
import type { Citation, ExtractResponse, ResolveResponse, SourceFields } from "legal-citations";

type DocumentInput = Extract<WorkProductInput, { kind: "document" }>;
type ProjectionReader = Pick<typeof documentProjectionService, "read">;
type AuthoritiesNative = Pick<ReturnType<typeof structureNative>,
  "docxAuthorityTextUnits" | "pdfAuthorityTextUnits">;

export type GroundedReceiptSeed = {
  authorityKey: string;
  receipts: readonly LegalEvidenceReceipt[];
};

export type AuthoritiesImportSource = { kind: "manual" } | DocumentInput |
  { kind: "receipts"; seeds: readonly GroundedReceiptSeed[] };

type Span = { start: number; end: number };
function occurrenceSpans(unitText: string, authority: Span, core: Span,
  pinpoints: Span[], offset = 0) {
  const span = ({ start, end }: Span) => ({
    start: offset + start, end: offset + end,
    text: unitText.slice(offset + start, offset + end),
  });
  const ordered = [...pinpoints].sort((left, right) => left.start - right.start);
  return { authoritySpan: span(authority), coreSpan: span(core),
    pinpointSpan: ordered.length ? span({ start: ordered[0].start,
      end: ordered.at(-1)!.end }) : null };
}

/** Format an already parsed range; never infer ranges from gaps between tokens. */
export function pinpointValues<Kind extends string>(
  pinpoints: ReadonlyArray<{ kind: Kind; text: string; last?: string | null }>) {
  return pinpoints.map(({ kind, text, last }) => ({ kind,
    text: last ? text.replace(/\s*(?:[-\u2013\u2014]|to)\s*/gu, "-") : text }));
}
export const nativeOccurrenceSpans = (match: NativeCitationOccurrence, text: string, offset = 0) =>
  occurrenceSpans(text, match.styledCitation, match.coreCitation, match.pinpoints, offset);

function scanReview(
  imported: AuthoritiesImport,
  bindings: Record<string, WorkProductInput>,
  units: NativeAuthorityTextUnit[],
): AuthoritiesFreshReview {
  const occurrences: Record<string, AuthorityOccurrence> = {};
  const authorities: Record<string, AuthorityIdentity> = {};
  const authorityOrder: string[] = [];
  let offset = 0;
  const ranges = units.map((unit) => {
    const start = offset;
    offset += unit.text.length + 2;
    return { unit, start, end: start + unit.text.length };
  });
  const text = units.map(({ text }) => text).join("\n\n");
  const native = structureNative();
  const unknownNote = 0xffff_ffff;
  const notes = ranges.filter(({ unit }) => unit.footnote_id !== null)
    .map(({ unit, start, end }) => ({ number: unit.note_number === null
      ? unknownNote : unit.note_number ?? unit.footnote_id!, start, end,
    sequence: unit.note_number === null ? unknownNote : unit.restart_sequence ?? 0 }));
  const extracted = native.citationEngineCall("extract", JSON.stringify({ text, offsetUnit: "utf16",
    options: { resolve: false, notes },
  })) as ExtractResponse;
  const cases = extracted.citations.filter(({ form, authority, key }) =>
    form === "full" && key && (authority === "case" || authority === "unknown"));
  const closures = citationAliasKeysBatch(cases.map(({ span }) => span.text));
  const parsed = ranges.map(({ unit }) => ({ unit, items: [] as Array<{ index: number; start: number }> }));
  let unitIndex = 0;
  for (const citation of extracted.citations) {
    while (unitIndex + 1 < ranges.length && citation.span.start >= ranges[unitIndex].end) unitIndex++;
    parsed[unitIndex].items.push({ index: citation.index, start: citation.span.start - ranges[unitIndex].start });
  }
  const order = native.documentReadingOrder(JSON.stringify(parsed.map(({ unit, items }) => ({
    kind: unit.kind, footnote_id: unit.footnote_id, footnote_refs: unit.footnote_refs,
    item_offsets: items.map(({ start }) => start),
  })))).map(([unit, item]) => parsed[unit].items[item].index);
  const result = native.citationEngineCall("resolve", JSON.stringify({ citations: extracted.citations, notes,
    readingOrder: order, sourceParts: extracted.sourceParts,
    supraHintMode: "aggressive", supraLinkingMode: "safe",
    aliasGroups: cases.map(({ index }, position) => ({ index, keys: closures[position] })),
  })) as ResolveResponse;
  const byIndex = new Map(result.citations.map((citation) => [citation.index, citation]));
  const byResolution = new Map(result.resolutions.map((resolution) => [resolution.index, resolution]));
  const authorityOf = new Map<number, string>();
  const documentHash = sha256(text);
  const kindOf = (citation: Citation): AuthorityKind => {
    switch (citation.authority) {
      case "case": return "case";
      case "statute": case "regulation": case "constitution": case "court_rule":
      case "treaty": case "bill": return "legislation";
      case "journal": case "book": case "book_chapter": case "webpage": return "commentary";
      default: return "other";
    }
  };
  const urlParts = result.resolutions.some(({ url }) => url) ? extracted.sourceParts
    .filter((part) => part.anchors.filter((anchor) => anchor === "url").length === 1 &&
      !result.citations.some((citation) =>
      citation.span.start < part.end && part.start < citation.span.end))
    .map((part) => ({ part, fields: native.citationEngineCall("sourceFields",
      JSON.stringify({ part })) as SourceFields }))
    .filter(({ fields }) => isObservedSourceUrl(fields.link_candidate) &&
      !fields.reasons.includes("embedded_second_source")) : [];
  const sourceGroups = new Map<string, string>();
  for (const group of result.authorities) {
    const full = group.map((index) => byIndex.get(index))
      .filter((citation): citation is Citation => citation?.form === "full");
    const url = full.map((citation) => citation.fields.url).find(isObservedSourceUrl) ??
      (full.length ? null : group.map((index) => byResolution.get(index)?.url).find(Boolean));
    const source = !full.length && url ? urlParts.find(({ fields }) =>
      fields.link_candidate.split("#")[0] === url.split("#")[0]) : undefined;
    const representative = full.find((citation) => citation.key) ?? full[0] ??
      (url ? group.map((index) => byIndex.get(index)).find(Boolean) : undefined);
    if (!representative) continue;
    // A document-local review identity keeps unkeyed sources visible without
    // asserting a bibliographic identity or merging separate engine groups.
    const key = full.length && representative.key || `scan:${documentHash}:${representative.index}`;
    group.forEach((index) => authorityOf.set(index, key));
    if (authorities[key]) continue;
    const sourceLink = source?.fields.link_candidate ?? url;
    const explicitUrl = isObservedSourceUrl(sourceLink) ? sourceLink : null;
    if (explicitUrl) sourceGroups.set(explicitUrl.split("#")[0], key);
    const sourceKind: AuthorityKind = source?.fields.kind === "case" ? "case"
      : source?.fields.kind === "statute" ? "legislation"
      : ["journal", "book", "essay_collection"].includes(source?.fields.kind ?? "")
      ? "commentary" : "other";
    const observedText = source?.fields.citation_with_style || source?.part.text.trim() ||
      (url ? representative.fullSpan.text : representative.span.text);
    authorities[key] = { id: key, key, kind: source ? sourceKind : kindOf(representative),
      citation: observedText, name: source ? observedText : representative.shortName ?? null,
      displayName: null, excluded: false,
      evidenceIds: [], locators: [], sourceIdentity: null,
      source: { kind: "unresolved" }, scanOnly: true,
      ...(explicitUrl ? { sourceUrl: explicitUrl } : {}) };
    authorityOrder.push(key);
  }
  const sourceOccurrences = urlParts.flatMap(({ part, fields }) => {
    const authorityId = sourceGroups.get(fields.link_candidate.split("#")[0]);
    const coreOffset = part.text.indexOf(fields.link_candidate);
    if (!authorityId || coreOffset < 0) return [];
    const core = { start: part.start + coreOffset,
      end: part.start + coreOffset + fields.link_candidate.length };
    const styledOffset = part.text.indexOf(fields.citation_with_style);
    const styled = styledOffset >= 0 ? { start: part.start + styledOffset,
      end: part.start + styledOffset + fields.citation_with_style.length } : core;
    const extent = styled.start <= core.start && core.end <= styled.end ? styled : core;
    return [{ start: extent.start, end: extent.end, core, authorityId,
      citation: authorities[authorityId].citation, kind: authorities[authorityId].kind }];
  });
  const reviewItems = [
    ...result.citations.map((citation) => ({ start: citation.span.start, citation, source: null })),
    ...sourceOccurrences.map((source) => ({ start: source.start, citation: null, source })),
  ].sort((left, right) => left.start - right.start);
  let cursor = 0;
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
        occurrences[id] = { id, unitId: unit.key, ...full,
          text: unit.text.slice(full.start, full.end),
          ...occurrenceSpans(unit.text, full, local(source.core), []),
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
      const core = local(citation.span);
      const full = local(citation.fullSpan);
      const styled = { start: citation.style && citation.style.start >= start
        ? citation.style.start - start : core.start, end: core.end };
      const reference = citation.form !== "full";
      const pinpoints = citation.pinpoints ?? [];
      occurrenceIds.push(id);
      occurrences[id] = { id, unitId: unit.key, ...full,
        text: unit.text.slice(full.start, full.end),
        ...occurrenceSpans(unit.text, styled, core, pinpoints.map(({ span }) => local(span))),
        kind: reference ? "reference" : kindOf(citation), citation: citation.span.text, authorityId,
        reference: authorityId && (citation.form === "short" || citation.form === "ibid" || citation.form === "supra")
          ? { kind: citation.form, targetAuthorityId: authorityId } : null,
        referenceKind: citation.form === "short" || citation.form === "ibid" || citation.form === "supra"
          ? citation.form : undefined,
        pinpoints: pinpointValues(pinpoints.map(({ kind, span, last }) => ({ kind, text: span.text, last }))),
        evidenceIds: [], sourceTextSha256, localOrdinal, reviewed: reference && Boolean(authorityId) };
    }
    return { id: unit.key, kind: unit.kind, ordinal: unit.ordinal,
      footnoteId: unit.footnote_id, pageNumbers: unit.page_numbers, text: unit.text,
      footnoteRefs: unit.footnote_refs, occurrenceIds };
  });
  return { import: imported, bindings, cover: importedCover(units), units: reviewUnits,
    occurrences, authorities, authorityOrder };
}

const COVER_ROLE = /^(applicants?|respondents?|appellants?|plaintiffs?|defendants?|petitioners?|interven(?:er|or)s?|moving part(?:y|ies)|responding part(?:y|ies))\s*:?$/iu;
/** The parties named in a filing's BETWEEN block, in the order and roles the cover prints them. */
function coverParties(opening: string): AuthoritiesCover["partyGroups"] {
  const lines = opening.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line) => /^between\s*:?$/iu.test(line));
  if (start < 0) return [];
  const groups: AuthoritiesCover["partyGroups"] = [];
  let names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (COVER_ROLE.test(line)) {
      const word = line.replace(/\s*:$/u, "").toLowerCase();
      const role = word.startsWith("interven") ? "Intervener" : word.replace(/s$|ies$/u, (end) => end === "ies" ? "y" : "")
        .replace(/^\w|\s\w/gu, (ch) => ch.toUpperCase());
      if (names.length) groups.push({ role, parties: names });
      names = [];
    } else if (/^(and|-\s*and\s*-|v\.?)$/iu.test(line)) continue;
    else if (/^[A-Z][A-Z\s]+$/u.test(line) && line.length > 12 && !names.length && groups.length) break;
    else names.push(line);
  }
  return groups;
}

function importedCover(units: NativeAuthorityTextUnit[]): AuthoritiesCover {
  const body = units.filter(({ kind }) => kind === "body");
  const firstPage = body.filter(({ page_numbers }) => page_numbers.includes(1));
  const opening = (firstPage.length ? firstPage : body.slice(0, 80))
    .map(({ text }) => text).join("\n");
  const fields = sourceDocumentFields(opening ? [opening] : []);
  return { courtFileNumber: fields?.cover.courtFileNumber ?? "",
    partyGroups: coverParties(opening),
    applicationUnder: fields?.cover.applicationUnder ?? "", title: "" };
}

async function documentDraft(
  scope: ApplicationScope,
  binding: DocumentInput,
  documents: DocumentStore,
  projection: ProjectionReader,
  native: AuthoritiesNative,
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
  const imported: AuthoritiesImport = { kind: "document", bindingRole: "source",
    filename, fileType, snapshot: { documentId: source.documentId,
      versionId: source.versionId, sha256: source.sourceSha256 } };
  const bindings = { source: binding };
  const storedLedger = source.provenance?.actor === "assistant"
    ? source.provenance.generation?.authorityLedger : undefined;
  if (storedLedger) {
    try {
      return reduceAuthoritiesDraft(createAuthoritiesDraft(imported, bindings), {
        type: "ingest-ledger", ledger: { ...storedLedger, document: imported.snapshot! },
      });
    } catch { /* Untrusted or stale provenance falls back to the Rust scan. */ }
  }
  let units: NativeAuthorityTextUnit[];
  if (fileType === "docx") {
    const bytes = await source.readBytes();
    if (sha256(bytes) !== source.sourceSha256) {
      throw new ApplicationError(409, "Document bytes do not match their version");
    }
    units = await native.docxAuthorityTextUnits(bytes);
  } else {
    units = native.pdfAuthorityTextUnits(await projection.read(source));
  }
  return reduceAuthoritiesDraft(createAuthoritiesDraft(imported, bindings), {
    type: "refresh", review: scanReview(imported, bindings, units),
  });
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
    async draft(scope: ApplicationScope, source: AuthoritiesImportSource) {
      return source.kind === "manual" ? createAuthoritiesDraft(source)
        : source.kind === "document"
        ? documentDraft(scope, source, documents, projection,
          native ?? structureNative())
        : receiptDraft(source.seeds);
    },
  });
}

/** Stateless local-runtime import; the browser remains the draft/file owner. */
export async function importStandaloneAuthoritiesFile(input: {
  filename: string; fileType: "docx" | "pdf"; bytes: Buffer; modified: number;
  sourceMode?: AuthoritiesSourceMode;
}, projection: ProjectionReader = documentProjectionService,
native: AuthoritiesNative = structureNative()) {
  const sourceSha256 = sha256(input.bytes);
  const binding: WorkProductInput = { kind: "local-file", handleId: "standalone",
    lastSeen: { name: input.filename, size: input.bytes.length,
      modified: input.modified, sha256: sourceSha256 } };
  let units: NativeAuthorityTextUnit[];
  if (input.fileType === "docx") units = await native.docxAuthorityTextUnits(input.bytes);
  else units = native.pdfAuthorityTextUnits(await projection.read({
    documentId: `standalone-${sourceSha256}`, versionId: sourceSha256,
    sourceSha256, fileType: input.fileType, readBytes: () => input.bytes,
  }));
  const imported: AuthoritiesImport = { kind: "document", bindingRole: "source",
    filename: input.filename, fileType: input.fileType, snapshot: null };
  const bindings = { source: binding };
  let initial = createAuthoritiesDraft(imported, bindings);
  if (input.sourceMode) initial = reduceAuthoritiesDraft(initial, { type: "set-settings",
    settings: { sourceMode: input.sourceMode } });
  return reduceAuthoritiesDraft(initial, {
    type: "refresh", review: scanReview(imported, bindings, units),
  });
}

export type AuthoritiesImporter = ReturnType<typeof createAuthoritiesImporter>;
