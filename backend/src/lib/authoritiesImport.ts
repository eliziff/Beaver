import { ApplicationError, type ApplicationScope } from "./applicationError";
import {
  authoritySeedFromReceipts,
  createAuthoritiesDraft,
  reduceAuthoritiesDraft,
  type AuthoritiesFreshReview,
  type AuthoritiesImport,
  type AuthorityIdentity,
  type AuthorityKind,
  type AuthorityOccurrence,
} from "./authoritiesDomain";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { documentProjectionService } from "./documentProjectionService";
import type { DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { structureNative, type NativeAuthorityTextUnit } from "./structureNative";
import type { WorkProductInput } from "./workProduct";
import { buildCanliiCaseUrlFromCitation } from "./canliiUrls";

type DocumentInput = Extract<WorkProductInput, { kind: "document" }>;
type ProjectionReader = Pick<typeof documentProjectionService, "read">;
type AuthoritiesNative = Pick<ReturnType<typeof structureNative>,
  "docxAuthorityTextUnits" | "pdfAuthorityTextUnits" | "citationOccurrencesInText" |
  "citationLookupKey">;

export type GroundedReceiptSeed = {
  authorityKey: string;
  receipts: readonly LegalEvidenceReceipt[];
};

export type AuthoritiesImportSource = { kind: "manual" } | DocumentInput |
  { kind: "receipts"; seeds: readonly GroundedReceiptSeed[] };

function scanReview(
  imported: AuthoritiesImport,
  bindings: Record<string, WorkProductInput>,
  units: NativeAuthorityTextUnit[],
  native: AuthoritiesNative,
): AuthoritiesFreshReview {
  const occurrences: Record<string, AuthorityOccurrence> = {};
  const authorities: Record<string, AuthorityIdentity> = {};
  const authorityOrder: string[] = [];
  const reviewUnits = units.map((unit) => {
    const occurrenceIds: string[] = [];
    const sourceTextSha256 = sha256(unit.text);
    native.citationOccurrencesInText(unit.text).forEach((match, localOrdinal) => {
      const key = native.citationLookupKey(match.coreCitation.text);
      if (!key) return;
      const kind: AuthorityKind = match.kind === "statute" ? "legislation"
        : match.kind === "journal" ? "commentary" : match.kind;
      const observedName = match.reasons.includes("same_text_style")
        ? match.shortForm?.trim() || null : null;
      if (!authorities[key]) {
        authorities[key] = { id: key, key, kind, citation: match.coreCitation.text,
          name: observedName, displayName: null, excluded: false,
          evidenceIds: [], locators: [], sourceIdentity: null,
          source: { kind: "unresolved" } };
        authorityOrder.push(key);
      } else if (!authorities[key].name && observedName) {
        authorities[key].name = observedName;
      }
      const id = `${unit.key}:${localOrdinal}`;
      occurrenceIds.push(id);
      occurrences[id] = { id, unitId: unit.key, start: match.start, end: match.end,
        text: match.text, kind, citation: match.coreCitation.text, authorityId: key,
        reference: null, pinpoints: match.pinpoints.map(({ kind, text }) => ({ kind, text })),
        evidenceIds: [],
        sourceTextSha256, localOrdinal, reviewed: false };
    });
    return { id: unit.key, kind: unit.kind, ordinal: unit.ordinal,
      footnoteId: unit.footnote_id, pageNumbers: unit.page_numbers, text: unit.text,
      footnoteRefs: unit.footnote_refs, occurrenceIds };
  });
  return { import: imported, bindings, units: reviewUnits, occurrences,
    authorities, authorityOrder };
}

async function documentDraft(
  scope: ApplicationScope,
  binding: DocumentInput,
  documents: DocumentStore,
  projection: ProjectionReader,
  native: AuthoritiesNative,
) {
  const requestedVersion = binding.version === "latest" ? null : binding.version.versionId;
  const [source, history] = await Promise.all([
    documents.projectionSource(scope, binding.documentId, requestedVersion),
    documents.versions(scope, binding.documentId),
  ]);
  if (!source || !history) throw new ApplicationError(404, "Document not found");
  const version = history.versions.find(({ id }) => id === source.versionId);
  if (!version) throw new ApplicationError(404, "Document version not found");
  const pinnedHash = binding.version === "latest" ? source.sourceSha256 : binding.version.sha256;
  if (source.sourceSha256 !== pinnedHash || version.source_sha256 !== source.sourceSha256) {
    throw new ApplicationError(409, "Document version hash does not match its source");
  }
  const fileType = source.fileType.trim().toLowerCase();
  if (fileType !== "docx" && fileType !== "pdf") {
    throw new ApplicationError(409, "Authorities sources must be PDF or Word documents");
  }
  const imported: AuthoritiesImport = { kind: "document", bindingRole: "source",
    filename: version.filename, fileType, snapshot: { documentId: source.documentId,
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
    type: "refresh", review: scanReview(imported, bindings, units, native),
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
  let draft = reduceAuthoritiesDraft(createAuthoritiesDraft(imported, bindings), {
    type: "refresh", review: scanReview(imported, bindings, units, native),
  });
  for (const authority of Object.values(draft.authorities)) {
    const pageUrl = authority.kind === "case"
      ? buildCanliiCaseUrlFromCitation([authority.citation]) : null;
    if (pageUrl) draft = reduceAuthoritiesDraft(draft, {
      type: "begin-canlii-handoff", authorityId: authority.id, pageUrl,
    });
  }
  return draft;
}

export type AuthoritiesImporter = ReturnType<typeof createAuthoritiesImporter>;
