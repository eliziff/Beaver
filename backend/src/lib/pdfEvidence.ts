import { readFile } from "node:fs/promises";
import { sha256 } from "./hash";
import { structureNative, type NativeDocument, type NativePdfLookupRequest,
  type PdfStructureLookup } from "./structureNative";
import { immutableReceiptPath, writeImmutableReceipt } from "./contentStore";
import { cachedPdf, openDocument, type PdfPreparationProgress } from "./sourceDocument";
import type { PdfProfileSelection } from "./documentStore";
import { RESOURCE_LOCATOR_KINDS } from "mike/shared/runtime/resourceReferences.mjs";

/** A PDF looked up by its locators, and the immutable receipt of what was found, by which the evidence is read again
 *  (rehydrated) or checked against the source it was found in. */

export type PdfLocatorKind = (typeof RESOURCE_LOCATOR_KINDS)[number];

export type PdfLookupInput = NativePdfLookupRequest & { locator_kind: PdfLocatorKind };

const EVIDENCE_SCHEMA = "mike.pdf_evidence.v1";
const EVIDENCE_HANDLE = /^mike-evidence:v1:([0-9a-f]{64})$/u;
const LEGAL_PDF_RESULT_SCHEMA = "legalpdf.document-result.v1";

type ReceiptSource = {
  document_id: string;
  version_id: string;
  source_sha256: string;
  parser_version: string;
  cache_key: string;
};

type PdfEvidenceReceipt = {
  schema_version: typeof EVIDENCE_SCHEMA;
  handle: string;
  source: ReceiptSource;
  lookup: PdfLookupInput;
  evidence: { payload_sha256: string; page_numbers: number[]; page_text_sha256: string };
};

/** A failure to find or trust a piece of PDF evidence, its message fit to show whoever asked for it. */
export class PdfEvidenceError extends Error {}

function evidenceHandle(receipt: Omit<PdfEvidenceReceipt, "handle">) {
  return `mike-evidence:v1:${sha256(JSON.stringify(receipt))}`;
}

function evidencePath(handle: string) {
  const digest = handle.match(EVIDENCE_HANDLE)?.[1];
  if (!digest) throw new PdfEvidenceError("Invalid PDF evidence handle");
  return immutableReceiptPath("pdf-evidence", digest);
}

function evidenceViewPath(documentId: string, versionId: string, handle: string) {
  return `/single-documents/${encodeURIComponent(documentId)}/evidence-view` +
    `?version_id=${encodeURIComponent(versionId)}&evidence=${encodeURIComponent(handle)}`;
}

/** A receipt is addressed by its content's hash: one whose content hashes to its handle is the one written. */
async function readPdfEvidenceReceipt(handle: string) {
  const receipt = JSON.parse(await readFile(evidencePath(handle), "utf8")) as PdfEvidenceReceipt;
  const { handle: stored, ...identity } = receipt;
  if (stored !== handle || evidenceHandle(identity) !== handle) {
    throw new PdfEvidenceError("PDF evidence receipt handle does not match its content");
  }
  return receipt;
}

type LookupSource = {
  persistEvidence?: boolean;
  cacheKey: string;
  documentId: string;
  versionId: string;
  sourceSha256: string;
  parserVersion: string;
};

async function finishLookup(input: PdfLookupInput, lookup: PdfStructureLookup,
  options: LookupSource) {
  if (lookup.status !== "found") {
    return lookup;
  }
  const source: ReceiptSource = {
    document_id: options.documentId,
    version_id: options.versionId,
    source_sha256: options.sourceSha256,
    parser_version: options.parserVersion,
    cache_key: options.cacheKey,
  };
  const receiptIdentity: Omit<PdfEvidenceReceipt, "handle"> = {
    schema_version: EVIDENCE_SCHEMA,
    source,
    lookup: { ...input },
    evidence: {
      payload_sha256: lookup.payload_sha256,
      page_numbers: lookup.pages.map(({ page_number }) => page_number),
      page_text_sha256: lookup.page_text_sha256,
    },
  };
  const handle = evidenceHandle(receiptIdentity);
  const receipt = { ...receiptIdentity, handle };
  const pageNumbers = [...new Set(lookup.units.flatMap((unit) => unit.pages))]
    .sort((left, right) => left - right);
  const viewPath = evidenceViewPath(options.documentId, options.versionId, handle);

  if (options.persistEvidence !== false) {
    await writeImmutableReceipt(evidencePath(handle), receipt);
  }

  return {
    ...lookup,
    source: { ...source, handle: `mike-source:sha256:${options.sourceSha256}`,
      schema_version: LEGAL_PDF_RESULT_SCHEMA },
    evidence: { handle, ...receipt.evidence },
    link: {
      type: "pdf-evidence",
      evidence_view_path: viewPath,
      href: pageNumbers[0] ? `${viewPath}#page=${pageNumbers[0]}` : viewPath,
      page_numbers: pageNumbers,
    },
  };
}

type EvidenceSource = { documentId: string; versionId: string; sourceSha256: string };

/** A lookup in a PDF by a locator, from its prepared reading where it has one; a unit found is evidence, its receipt
 *  written unless `persistEvidence` is false. */
export async function lookupPdf(readBytes: () => Buffer | Promise<Buffer>, input: PdfLookupInput,
  options: EvidenceSource & { persistEvidence?: boolean; pdfProfile?: PdfProfileSelection; pages?: number[];
    signal?: AbortSignal; progress?: (value: PdfPreparationProgress) => void | Promise<void> }) {
  const document = await openDocument({ ...options, readBytes }, options);
  const native = structureNative(), summary = native.pdfDocumentSummary(document);
  return finishLookup(input, native.queryPdfDocument(document, input), {
    persistEvidence: options.persistEvidence, cacheKey: summary.cacheKey, documentId: options.documentId,
    versionId: options.versionId, sourceSha256: summary.sha256, parserVersion: summary.parserVersion,
  });
}

/** The reading a receipt was found in: the PDF reading cached under its cache key, of the version expected. */
async function evidenceDocument(handle: string, expected: EvidenceSource) {
  const receipt = await readPdfEvidenceReceipt(handle);
  if (receipt.source.document_id !== expected.documentId ||
      receipt.source.version_id !== expected.versionId ||
      receipt.source.source_sha256 !== expected.sourceSha256)
    throw new PdfEvidenceError("PDF evidence does not belong to this resource.");
  const document = await cachedPdf(expected, receipt.source.cache_key);
  if (!document) throw new PdfEvidenceError("PDF evidence artifact is no longer available");
  return { document, receipt };
}

/** The evidence a receipt names, found again in the reading it was found in. */
export async function rehydratePdfEvidence(handle: string, expected: EvidenceSource) {
  const { document, receipt } = await evidenceDocument(handle, expected);
  return rehydrate(document, receipt);
}

/** Whether a receipt's evidence is still what its source's bytes say. */
export async function verifyPdfEvidence(bytes: Buffer, handle: string, expected: EvidenceSource) {
  if (sha256(bytes) !== expected.sourceSha256)
    throw new PdfEvidenceError("PDF evidence source bytes no longer match their version");
  const { document, receipt } = await evidenceDocument(handle, expected);
  const verified = await rehydrate(document, receipt);
  return { documentId: verified.source.document_id, versionId: verified.source.version_id };
}

async function rehydrate(document: NativeDocument, receipt: PdfEvidenceReceipt) {
  const lookup = await finishLookup(receipt.lookup, structureNative().queryPdfDocument(document, receipt.lookup), {
    persistEvidence: false,
    cacheKey: receipt.source.cache_key,
    documentId: receipt.source.document_id,
    versionId: receipt.source.version_id,
    sourceSha256: receipt.source.source_sha256,
    parserVersion: receipt.source.parser_version,
  });
  const mismatch = "PDF evidence no longer matches the authoritative source artifacts";
  if (lookup.status !== "found") {
    throw new PdfEvidenceError(
      "error" in lookup && lookup.error === "PDF source bytes no longer match their version"
        ? "PDF evidence source bytes no longer match their version" : mismatch);
  }
  if (lookup.evidence.handle !== receipt.handle) throw new PdfEvidenceError(mismatch);
  return lookup;
}
