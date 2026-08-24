import { readFile } from "node:fs/promises";
import { sha256 } from "./hash";
import {
  structureNative,
  type NativeDocument,
  type PdfStructureLookup,
} from "./structureNative";
import {
  immutableReceiptPath,
  writeImmutableReceipt,
} from "./documentProjection";
import { RESOURCE_LOCATOR_KINDS } from "./resourceReferences";

export type PdfLocatorKind = (typeof RESOURCE_LOCATOR_KINDS)[number];

export type PdfLookupInput = {
  locatorKind: PdfLocatorKind;
  locator: string;
  endLocator?: string;
  contextBlocks?: number;
  page?: number;
  occurrence?: number;
};

const EVIDENCE_SCHEMA = "mike.pdf_evidence.v1";
const EVIDENCE_HANDLE = /^mike-evidence:v1:([0-9a-f]{64})$/u;
const LEGAL_PDF_RESULT_SCHEMA = "legalpdf.document-result.v1";

type PdfEvidenceReceipt = {
  schema_version: typeof EVIDENCE_SCHEMA;
  handle: string;
  source: {
    document_id: string;
    version_id: string;
    source_sha256: string;
    parser_version: string;
    cache_key: string;
  };
  lookup: PdfLookupInput;
  evidence: {
    payload_sha256: string;
    page_numbers: number[];
    page_text_sha256: string;
  };
};

function evidenceHandle(receipt: Omit<PdfEvidenceReceipt, "handle">) {
  return `mike-evidence:v1:${sha256(JSON.stringify(receipt))}`;
}

function evidencePath(handle: string) {
  const digest = handle.match(EVIDENCE_HANDLE)?.[1];
  if (!digest) throw new Error("Invalid PDF evidence handle");
  return immutableReceiptPath("pdf-evidence", digest);
}

function evidenceViewPath(
  documentId: string,
  versionId: string,
  handle: string,
) {
  return `/single-documents/${encodeURIComponent(
    documentId,
  )}/evidence-view?version_id=${encodeURIComponent(
    versionId,
  )}&evidence=${encodeURIComponent(handle)}`;
}

function evidenceReceipt(value: unknown): PdfEvidenceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid PDF evidence receipt");
  }
  const receipt = value as Partial<PdfEvidenceReceipt>;
  const source = receipt.source;
  const lookup = receipt.lookup;
  const evidence = receipt.evidence;
  if (
    receipt.schema_version !== EVIDENCE_SCHEMA ||
    typeof receipt.handle !== "string" ||
    !EVIDENCE_HANDLE.test(receipt.handle) ||
    !source ||
    typeof source.document_id !== "string" ||
    typeof source.version_id !== "string" ||
    typeof source.source_sha256 !== "string" ||
    typeof source.parser_version !== "string" ||
    typeof source.cache_key !== "string" || !/^[a-f0-9]{64}$/u.test(source.cache_key) ||
    !lookup ||
    !RESOURCE_LOCATOR_KINDS.includes(lookup.locatorKind) ||
    typeof lookup.locator !== "string" ||
    !evidence ||
    typeof evidence.payload_sha256 !== "string" ||
    !Array.isArray(evidence.page_numbers) ||
    !evidence.page_numbers.every(
      (number) => Number.isInteger(number) && number > 0,
    ) ||
    typeof evidence.page_text_sha256 !== "string"
  ) {
    throw new Error("Invalid PDF evidence receipt");
  }
  const parsed = receipt as PdfEvidenceReceipt;
  const { handle, ...identity } = parsed;
  if (handle !== evidenceHandle(identity)) {
    throw new Error("Invalid PDF evidence receipt");
  }
  return parsed;
}

export async function readPdfEvidenceReceipt(handle: string) {
  const receipt = evidenceReceipt(
    JSON.parse(await readFile(evidencePath(handle), "utf8")),
  );
  if (receipt.handle !== handle) {
    throw new Error("PDF evidence receipt handle does not match its content");
  }
  return receipt;
}

function queryPdf(document: NativeDocument, input: PdfLookupInput) {
  return structureNative().queryPdfDocument(
    document,
    input.locatorKind,
    input.locator,
    input.endLocator,
    input.contextBlocks,
    input.page,
    input.occurrence,
  );
}

async function finishLookup(
  input: PdfLookupInput,
  lookup: PdfStructureLookup,
  options: {
    persistEvidence?: boolean;
    cacheKey: string;
    documentId: string;
    versionId: string;
    sourceSha256: string;
    parserVersion: string;
  },
) {
  if (lookup.status !== "found") {
    return lookup;
  }
  const { units, pages: boundPages } = lookup;
  const boundPageNumbers = boundPages.map(({ page_number }) => page_number);
  const receiptIdentity: Omit<PdfEvidenceReceipt, "handle"> = {
    schema_version: EVIDENCE_SCHEMA,
    source: {
      document_id: options.documentId,
      version_id: options.versionId,
      source_sha256: options.sourceSha256,
      parser_version: options.parserVersion,
      cache_key: options.cacheKey,
    },
    lookup: { ...input },
    evidence: {
      payload_sha256: lookup.payload_sha256,
      page_numbers: boundPageNumbers,
      page_text_sha256: lookup.page_text_sha256,
    },
  };
  const handle = evidenceHandle(receiptIdentity);
  const receipt = { ...receiptIdentity, handle };
  const pageNumbers = [...new Set(units.flatMap((unit) => unit.page_numbers))]
    .sort((left, right) => left - right);
  const viewPath = evidenceViewPath(options.documentId, options.versionId, handle);

  if (options.persistEvidence !== false) {
    await writeImmutableReceipt(evidencePath(handle), receipt);
  }

  return {
    ...lookup,
    source: {
      handle: `mike-source:sha256:${options.sourceSha256}`,
      document_id: options.documentId,
      version_id: options.versionId,
      source_sha256: options.sourceSha256,
      parser_version: options.parserVersion,
      cache_key: options.cacheKey,
      schema_version: LEGAL_PDF_RESULT_SCHEMA,
    },
    evidence: {
      handle,
      ...receipt.evidence,
    },
    link: {
      type: "pdf-evidence",
      evidence_view_path: viewPath,
      href: pageNumbers[0] ? `${viewPath}#page=${pageNumbers[0]}` : viewPath,
      page_numbers: pageNumbers,
    },
  };
}

export async function lookupPdfStructure(
  document: NativeDocument,
  input: PdfLookupInput,
  options: {
    persistEvidence?: boolean;
    cacheKey: string;
    documentId: string;
    versionId: string;
    sourceSha256: string;
    parserVersion: string;
  },
) {
  return finishLookup(
    input,
    queryPdf(document, input),
    options,
  );
}

async function verifiedPdfEvidence(
  document: NativeDocument,
  receipt: PdfEvidenceReceipt,
) {
  const result = queryPdf(document, receipt.lookup);
  const lookup = await finishLookup(receipt.lookup, result, {
    persistEvidence: false,
    cacheKey: receipt.source.cache_key,
    documentId: receipt.source.document_id,
    versionId: receipt.source.version_id,
    sourceSha256: receipt.source.source_sha256,
    parserVersion: receipt.source.parser_version,
  });
  if (
    lookup.status !== "found" &&
    "error" in lookup &&
    lookup.error === "PDF source bytes no longer match their version"
  ) {
    throw new Error("PDF evidence source bytes no longer match their version");
  }
  if (lookup.status !== "found") {
    throw new Error(
      "PDF evidence no longer matches the authoritative source artifacts",
    );
  }
  if (lookup.evidence.handle !== receipt.handle) {
    throw new Error(
      "PDF evidence no longer matches the authoritative source artifacts",
    );
  }
  return lookup;
}

export async function rehydratePdfEvidence(
  document: NativeDocument,
  receipt: PdfEvidenceReceipt,
) {
  return verifiedPdfEvidence(document, receipt);
}

export async function verifyPdfEvidence(
  document: NativeDocument,
  receipt: PdfEvidenceReceipt,
) {
  const verified = await verifiedPdfEvidence(document, receipt);
  return {
    documentId: verified.source.document_id,
    versionId: verified.source.version_id,
  };
}
