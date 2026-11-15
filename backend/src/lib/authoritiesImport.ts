import { ApplicationError, type ApplicationScope } from "./applicationError";
import {
  authoritySeedFromReceipts,
  createAuthoritiesDraft,
  reduceAuthoritiesDraft,
  type AuthoritiesFreshReview,
  type AuthoritiesCover,
  type AuthoritiesDocumentSnapshot,
  type AuthoritiesImport,
  type AuthorityCitationLedger,
  type AuthoritiesSourceMode,
  type AuthoritiesBuildSettings,
} from "./authoritiesDomain";
import { sourceDocumentFields } from "mike/shared/court-record-source-fields.mjs";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { preparePdf } from "./sourceDocument";
import type { DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { pdfFailureKind, structureNative } from "./structureNative";
import type { AuthorityTextUnit } from "mike/shared/engine-types/AuthorityTextUnit";
import type { StatuteCandidate } from "mike/shared/engine-types/StatuteCandidate";
import type { WorkProductInput } from "./workProduct";
import { a2ajStorePath } from "./legalDataPath";
import { a2ajLegalSourceProvider } from "./legalSources/a2aj";
import { mapBounded } from "./mapBounded";
import { registerWorkExtents } from "mike/shared/work-extents.mjs";

type DocumentInput = Extract<WorkProductInput, { kind: "document" }>;
type SupraLinking = NonNullable<AuthoritiesBuildSettings["supraLinking"]>;

export type GroundedReceiptSeed = {
  authorityKey: string;
  receipts: readonly LegalEvidenceReceipt[];
};

export type AuthoritiesImportSource = { kind: "manual" } | DocumentInput |
  { kind: "receipts"; seeds: readonly GroundedReceiptSeed[] };

async function readImportUnits(fileType: "docx" | "pdf", read: () => Promise<AuthorityTextUnit[]>) {
  try { return await read(); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (fileType === "docx" && /^(?:DOCX (?:is empty|is corrupted|has no)|XML (?:error:|has ))/u.test(message))
      throw new ApplicationError(400, "Word document is invalid or corrupt. Choose a readable .docx file.");
    const kind = pdfFailureKind(error);
    if (fileType === "pdf" && (kind === "encrypted" || kind === "corrupt"))
      throw new ApplicationError(400, message);
    throw error;
  }
}

/** A2AJ verifies a source's name and canonical statute citation before its URL enters the registry: the CanLII pages,
 *  for each statute the engine's reading names a candidate, of the statutes A2AJ holds that its part names (the engine's
 *  statuteUrls). */
async function statutePages(statutes: StatuteCandidate[], native: ReturnType<typeof structureNative>) {
  type Hit = { collection?: string | null; title?: string | null; citation?: string | null };
  const urls = (candidate: StatuteCandidate, hits: readonly Hit[]) => native.statuteUrls(candidate,
    hits.map(({ collection, title, citation }) => ({ collection: collection ?? null, title: title ?? null, citation: citation ?? null })));
  // The statute A2AJ holds under the citation itself is checked first, a lookup by citation as finding its source later
  // makes (and keeps); its name is searched for only where that holds no statute that passes.
  const held = await mapBounded(statutes, async (candidate) => {
    const found = await a2ajLegalSourceProvider.document({ citation: candidate.citation, docType: "laws",
      language: candidate.language as "en" | "fr", dataset: candidate.dataset }).catch(() => null);
    return found ? urls(candidate, [{ collection: found.dataset, title: found.name, citation: found.citation }]) : [];
  });
  // One search for each dataset, language and name (the engine's comparison of names keys it: compared alike, searched once).
  const searchKey = ({ dataset, language, name }: (typeof statutes)[number]) =>
    `${dataset}:${language}:${native.statuteNameKey(name)}`;
  const queries = [...new Map(statutes.filter((_, at) => !held[at].length).map((candidate) =>
    [searchKey(candidate), candidate])).values()];
  const hits = new Map(await mapBounded(queries, async (candidate) => {
    try {
      return [searchKey(candidate), await a2ajLegalSourceProvider.search!({ text: candidate.name, kinds: ["legislation"],
        searchType: "name", collection: candidate.dataset, language: candidate.language as "en" | "fr", limit: 50 })] as const;
    } catch { return [searchKey(candidate), []] as const; }
  }));
  return statutes.map((candidate, at) => held[at].length ? held[at]
    : urls(candidate, hits.get(searchKey(candidate)) ?? []));
}

/** A brief's draft review, as the engine reads it (briefReading, briefReview): its citations (a PDF's body units a
 *  citation runs across joined), less its own court file number (its cover's), each statute's CanLII page checked
 *  against A2AJ, every reference resolved at the citation engine's splitting tier (`supraLinking`, the draft setting). */
async function scanReview(
  imported: AuthoritiesImport,
  bindings: Record<string, WorkProductInput>,
  units: AuthorityTextUnit[],
  supraLinking: SupraLinking = "safe",
): Promise<AuthoritiesFreshReview> {
  const native = structureNative();
  const cover = importedCover(units);
  const { reading, statutes } = native.briefReading(units, supraLinking,
    imported.kind === "document" && imported.fileType === "pdf", cover.courtFileNumber || null, a2ajStorePath());
  const pages = await statutePages(statutes, native);
  // How far the cited works run (Beaver's works pack), so a pinpoint past a work's end refuses a reference's link.
  registerWorkExtents(native);
  // The engine's review is the draft's own units, occurrences and authorities; the draft's decoder checks it on refresh.
  return { import: imported, bindings, cover, ...native.briefReview(reading, pages) as Omit<AuthoritiesFreshReview, "import" | "bindings" | "cover"> };
}

function importedCover(units: AuthorityTextUnit[]): AuthoritiesCover {
  const body = units.filter(({ kind }) => kind === "body");
  const firstPage = body.filter(({ pageNumbers }) => pageNumbers.includes(1));
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
async function importAuthoritiesDocument(input: AuthoritiesDocumentImport) {
  const native = structureNative(), sourceSha256 = sha256(input.bytes);
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
    const read = async (options: Parameters<typeof preparePdf>[0]) => (await preparePdf(options)).document;
    const own = await read({ ...reference, bytes: input.bytes, ocrProvider: null, doc: false });
    // A scanned page whose own text layer reads well needs no recognition: only the pages the engine
    // still names as needing it are recognized, and with none the brief is read as it is.
    const summary = native.pdfDocumentSummary(own);
    const scanned = (summary.scannedPages ?? []).filter((index) => summary.pagesNeedingOcr.includes(index));
    if (!scanned.length) return own;
    try {
      return await read({ ...reference, bytes: input.bytes, ocrProvider: "indra", doc: false,
        pages: scanned.map((index) => index + 1) });
    } catch { return own; }
  };
  const units = await readImportUnits(input.fileType, async () => {
    if (input.fileType === "docx") return native.docxAuthorityTextUnits(input.bytes);
    return native.pdfAuthorityTextUnits(await readPdf());
  });
  return reduceAuthoritiesDraft(initial, {
    type: "refresh", review: await scanReview(imported, bindings, units, input.supraLinking),
  });
}

async function documentDraft(
  scope: ApplicationScope,
  binding: DocumentInput,
  documents: DocumentStore,
  options: Pick<AuthoritiesDocumentImport, "sourceMode" | "supraLinking"> = {},
) {
  const { version } = binding, latest = version === "latest";
  const [source, current, history] = await Promise.all([
    documents.documentSource(scope, binding.documentId, latest ? null : version.versionId),
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
  return importAuthoritiesDocument({ ...options, filename, fileType, bytes: await source.readBytes(), binding,
    reference: { documentId: source.documentId, versionId: source.versionId },
    snapshot: { documentId: source.documentId, versionId: source.versionId, sha256: source.sourceSha256 },
    ledger: source.provenance?.actor === "assistant" ? source.provenance.generation?.authorityLedger : undefined,
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

export function createAuthoritiesImporter(documents: DocumentStore) {
  return Object.freeze({
    async draft(scope: ApplicationScope, source: AuthoritiesImportSource,
      options: Pick<AuthoritiesDocumentImport, "sourceMode" | "supraLinking"> = {}) {
      return source.kind === "manual" ? createAuthoritiesDraft(source)
        : source.kind === "document" ? documentDraft(scope, source, documents, options)
        : receiptDraft(source.seeds);
    },
  });
}


/** A brief the standalone runtime is handed: the page keeps the file, known here by its hash. */
export async function importStandaloneAuthoritiesFile(input: {
  filename: string; fileType: "docx" | "pdf"; bytes: Buffer; modified: number;
  sourceMode?: AuthoritiesSourceMode; supraLinking?: SupraLinking;
}) {
  const sourceSha256 = sha256(input.bytes);
  return importAuthoritiesDocument({ filename: input.filename, fileType: input.fileType, bytes: input.bytes,
    binding: { kind: "local-file", handleId: "standalone",
      lastSeen: { name: input.filename, size: input.bytes.length, modified: input.modified, sha256: sourceSha256 } },
    reference: { documentId: `standalone-${sourceSha256}`, versionId: sourceSha256 }, snapshot: null,
    sourceMode: input.sourceMode, supraLinking: input.supraLinking });
}

export type AuthoritiesImporter = ReturnType<typeof createAuthoritiesImporter>;
