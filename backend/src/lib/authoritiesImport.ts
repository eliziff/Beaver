import { ApplicationError, type ApplicationScope } from "./applicationError";
import {
  authoritySeedFromReceipts,
  createAuthoritiesDraft,
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
import type { Citation, ExtractResponse, ResolveResponse } from "legal-citations";

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
  const notes = ranges.filter(({ unit }) => unit.footnote_id !== null)
    .map(({ unit, start, end }) => ({ number: unit.footnote_id, start, end, sequence: 0 }));
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
    readingOrder: order,
    aliasGroups: cases.map(({ index }, position) => ({ index, keys: closures[position] })),
  })) as ResolveResponse;
  const byIndex = new Map(result.citations.map((citation) => [citation.index, citation]));
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
  for (const group of result.authorities) {
    const full = group.map((index) => byIndex.get(index))
      .filter((citation): citation is Citation => citation?.form === "full");
    const representative = full.find((citation) => citation.key) ?? full[0];
    if (!representative) continue;
    // A document-local review identity keeps unkeyed sources visible without
    // asserting a bibliographic identity or merging separate engine groups.
    const key = representative.key ?? `scan:${documentHash}:${representative.index}`;
    group.forEach((index) => authorityOf.set(index, key));
    if (authorities[key]) continue;
    authorities[key] = { id: key, key, kind: kindOf(representative), citation: representative.span.text,
      name: representative.shortName ?? null, displayName: null, excluded: false,
      evidenceIds: [], locators: [], sourceIdentity: null,
      source: { kind: "unresolved" }, scanOnly: true };
    authorityOrder.push(key);
  }
  let cursor = 0;
  const reviewUnits = ranges.map(({ unit, start, end }) => {
    const occurrenceIds: string[] = [];
    const sourceTextSha256 = sha256(unit.text);
    while (cursor < result.citations.length && result.citations[cursor].span.start < start) cursor++;
    while (cursor < result.citations.length && result.citations[cursor].span.start < end) {
      const citation = result.citations[cursor++];
      if (citation.form === "unknown") continue;
      const localOrdinal = occurrenceIds.length;
      const id = `${unit.key}:${localOrdinal}`;
      const authorityId = authorityOf.get(citation.index) ?? null;
      const local = (span: Span) => ({ start: Math.max(start, span.start) - start,
        end: Math.min(end, span.end) - start });
      const core = local(citation.span);
      const full = local(citation.fullSpan);
      const noteReference = citation.form === "ibid" || citation.form === "supra";
      if (noteReference) full.start = core.start;
      const styled = { start: !noteReference && citation.style && citation.style.start >= start
        ? citation.style.start - start : core.start, end: core.end };
      const reference = citation.form !== "full";
      const pinpoints = citation.pinpoints ?? [];
      occurrenceIds.push(id);
      occurrences[id] = { id, unitId: unit.key, ...full,
        text: unit.text.slice(full.start, full.end),
        ...occurrenceSpans(unit.text, styled, core, pinpoints.map(({ span }) => local(span))),
        kind: reference ? "reference" : kindOf(citation), citation: citation.span.text, authorityId,
        reference: authorityId && (citation.form === "ibid" || citation.form === "supra")
          ? { kind: citation.form, targetAuthorityId: authorityId } : null,
        pinpoints: pinpoints.map(({ kind, span }) => ({ kind, text: span.text })),
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
