import { readFile } from "node:fs/promises";
import { sha256 } from "./hash";
import { readLegalPdfSourceDoc } from "./legalPdfSourceDoc";
import {
  configuredLegalPdfProfile,
  LEGAL_PDF_RESULT_SCHEMA,
  runLegalPdfDocument,
} from "./legalPdfProcess";
import {
  inspectPdf,
  immutableReceiptPath,
  localDataPath,
  projectionDirectory,
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

type CanonicalKind = "page" | "paragraph" | "footnote" | "section";

export type PdfLookupUnit = {
  id: string;
  kind: CanonicalKind;
  locator: string;
  text: string;
  page_numbers: number[];
  confidence: number | null;
  confidence_basis: string;
  provenance: string;
  proposition?: {
    sentence: string;
    passage_since_prior_note: string;
  };
  note?: {
    label: string;
    occurrence: number | null;
    restart_sequence: number | null;
    reference_page: number | null;
    body_pages: number[];
    warnings: string[];
  };
};

const SCHEMA_VERSION = "mike.pdf_lookup.v1";
const MAX_CONTEXT_BLOCKS = 2;
const EVIDENCE_SCHEMA = "mike.pdf_evidence.v1";
const EVIDENCE_HANDLE = /^mike-evidence:v1:([0-9a-f]{64})$/u;
const CACHE_DIRECTORY = projectionDirectory("legalpdf-cache", sha256("legalpdf-cache-v1"));

export type PdfEvidenceReceipt = {
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
    artifact_ids: string[];
    context_artifact_ids: string[];
    text_sha256: string;
    payload_sha256: string;
    page_numbers: number[];
    page_text_sha256: string;
  };
};

type EvidenceHandleIdentity = {
  document_id: string;
  version_id: string;
  source_sha256: string;
  cache_key: string;
  kind: CanonicalKind;
  artifact_ids: string[];
  text_sha256: string;
  context_artifact_ids: string[];
  payload_sha256: string;
};

function evidenceHandle(
  identity: EvidenceHandleIdentity,
  pageBinding: { page_numbers: number[]; page_text_sha256: string },
) {
  return `mike-evidence:v1:${sha256(
    JSON.stringify({ ...identity, ...pageBinding }),
  )}`;
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
    typeof source.cache_key !== "string" ||
    !lookup ||
    !RESOURCE_LOCATOR_KINDS.includes(lookup.locatorKind) ||
    typeof lookup.locator !== "string" ||
    !evidence ||
    !Array.isArray(evidence.artifact_ids) ||
    !evidence.artifact_ids.every((id) => typeof id === "string") ||
    !Array.isArray(evidence.context_artifact_ids) ||
    !evidence.context_artifact_ids.every((id) => typeof id === "string") ||
    typeof evidence.text_sha256 !== "string" ||
    typeof evidence.payload_sha256 !== "string" ||
    !Array.isArray(evidence.page_numbers) ||
    !evidence.page_numbers.every(
      (number) => Number.isInteger(number) && number > 0,
    ) ||
    typeof evidence.page_text_sha256 !== "string"
  ) {
    throw new Error("Invalid PDF evidence receipt");
  }
  return receipt as PdfEvidenceReceipt;
}

async function persistEvidenceReceipt(receipt: PdfEvidenceReceipt) {
  const filename = evidencePath(receipt.handle);
  const assertSameEvidence = async () => {
    const existing = evidenceReceipt(
      JSON.parse(await readFile(filename, "utf8")),
    );
    if (
      existing.handle !== receipt.handle ||
      JSON.stringify(existing.source) !== JSON.stringify(receipt.source) ||
      JSON.stringify(existing.evidence) !== JSON.stringify(receipt.evidence)
    ) {
      throw new Error("Conflicting PDF evidence receipt");
    }
  };
  try {
    await assertSameEvidence();
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await writeImmutableReceipt(filename, receipt);
  } catch (error) {
    if (!/Conflicting immutable projection receipt/u.test(String(error))) {
      throw error;
    }
  }
  await assertSameEvidence();
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

function sameValues<T>(left: T[], right: T[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

type NormalizedPage = { number: number; text: string };

type EngineLookup = {
  schema_version: "legalpdf.structure-lookup.v1";
  requested: {
    locator_kind: PdfLocatorKind;
    locator: string;
    end_locator: string | null;
    context_blocks: number;
    page: number | null;
    occurrence: number | null;
  };
  units: PdfLookupUnit[];
  before: PdfLookupUnit[];
  after: PdfLookupUnit[];
  matches: string[];
  pages: { page_number: number; text: string }[];
  status: "found" | "not_found" | "ambiguous" | "invalid" | "unavailable";
  exact: boolean;
  error?: string;
};

function validInput(input: PdfLookupInput) {
  return RESOURCE_LOCATOR_KINDS.includes(input.locatorKind) &&
    Boolean(input.locator.trim()) &&
    input.locator.length <= 200 &&
    (input.endLocator?.length ?? 0) <= 200 &&
    Number.isInteger(input.contextBlocks ?? 0) &&
    (input.contextBlocks ?? 0) >= 0 &&
    (input.contextBlocks ?? 0) <= MAX_CONTEXT_BLOCKS &&
    (input.page === undefined ||
      (Number.isInteger(input.page) && input.page > 0)) &&
    (input.occurrence === undefined ||
      (Number.isInteger(input.occurrence) && input.occurrence > 0));
}

function contractInput(input: PdfLookupInput) {
  return {
    locator_kind: input.locatorKind,
    locator: input.locator,
    end_locator: input.endLocator,
    context_blocks: input.contextBlocks,
    page: input.page,
    occurrence: input.occurrence,
  };
}

function baseResult(input: PdfLookupInput) {
  return {
    schema_version: SCHEMA_VERSION,
    requested: {
      locator_kind: input.locatorKind,
      locator: input.locator,
      end_locator: input.endLocator || null,
      context_blocks: input.contextBlocks ?? 0,
      page: input.page ?? null,
      occurrence: input.occurrence ?? null,
    },
    units: [] as PdfLookupUnit[],
    before: [] as PdfLookupUnit[],
    after: [] as PdfLookupUnit[],
    matches: [] as string[],
  };
}

async function loadSource(sourcePath: string, cacheKey: string) {
  const source = localDataPath(sourcePath);
  if (!cacheKey || cacheKey.length > 512) throw new Error("Invalid PDF cache key");
  const inspected = await inspectPdf(source);
  return {
    source,
    sourceSha256: inspected.sourceSha256,
    cacheKey,
    profile: configuredLegalPdfProfile(),
  };
}

export async function readPdfSourceDoc(sourcePath: string, cacheKey: string) {
  const loaded = await loadSource(sourcePath, cacheKey);
  return readLegalPdfSourceDoc(loaded.source, {
    cacheDir: CACHE_DIRECTORY,
    ...loaded.profile,
    expectedCacheKey: loaded.cacheKey,
    expectedSourceSha256: loaded.sourceSha256,
  });
}

function checkedLookup(value: EngineLookup) {
  if (value.schema_version !== "legalpdf.structure-lookup.v1" ||
      !["found", "not_found", "ambiguous", "invalid", "unavailable"].includes(value.status) ||
      !Array.isArray(value.units) || !Array.isArray(value.before) ||
      !Array.isArray(value.after) || !Array.isArray(value.matches) ||
      !Array.isArray(value.pages)) {
    throw new Error("Legal PDF engine returned an invalid structure lookup");
  }
  return value;
}

// Keep evidence's canonical JSON field order stable while the engine owns values.
function evidenceUnit(unit: PdfLookupUnit): PdfLookupUnit {
  return {
    id: unit.id,
    kind: unit.kind,
    locator: unit.locator,
    text: unit.text,
    page_numbers: unit.page_numbers,
    confidence: unit.confidence,
    confidence_basis: unit.confidence_basis,
    provenance: unit.provenance,
    ...(unit.proposition ? { proposition: {
      sentence: unit.proposition.sentence,
      passage_since_prior_note: unit.proposition.passage_since_prior_note,
    } } : {}),
    ...(unit.note ? { note: {
      label: unit.note.label,
      occurrence: unit.note.occurrence,
      restart_sequence: unit.note.restart_sequence,
      reference_page: unit.note.reference_page,
      body_pages: unit.note.body_pages,
      warnings: unit.note.warnings,
    } } : {}),
  };
}

type LookupSource = {
  state: {
    document_id: string;
    version_id: string;
    source_sha256: string;
    parser_version: string;
    cache_key: string;
  };
};

async function finishLookup(
  loaded: LookupSource,
  input: PdfLookupInput,
  result: EngineLookup,
  options?: { persistEvidence?: boolean; capturePages?: (pages: NormalizedPage[]) => void },
) {
  const base = baseResult(input);
  const lookup = checkedLookup(result);
  const pages = lookup.pages.map(({ page_number: number, text }) => ({ number, text }));
  options?.capturePages?.(pages);
  if (lookup.status !== "found") {
    return {
      ...base,
      status: lookup.status,
      exact: lookup.exact,
      matches: lookup.matches,
      ...(lookup.error ? { error: lookup.error } : {}),
    };
  }

  const { state } = loaded;
  const units = lookup.units.map(evidenceUnit);
  const before = lookup.before.map(evidenceUnit);
  const after = lookup.after.map(evidenceUnit);
  const textSha256 = sha256(units.map((unit) => unit.text).join("\u001e"));
  const artifactIds = units.map((unit) => unit.id);
  const contextArtifactIds = [...before, ...after].map((unit) => unit.id);
  const payloadSha256 = sha256(JSON.stringify({ units, before, after }));
  const relevantPageNumbers = new Set(
    [...before, ...units, ...after].flatMap((unit) => unit.page_numbers));
  const boundPages = pages.filter(({ number }) => relevantPageNumbers.has(number));
  const boundPageNumbers = boundPages.map(({ number }) => number);
  const boundPageTextSha256 = sha256(JSON.stringify(
    boundPages.map(({ number, text }) => ({ page_number: number, text })),
  ));
  const handle = evidenceHandle({
    document_id: state.document_id,
    version_id: state.version_id,
    source_sha256: state.source_sha256,
    cache_key: state.cache_key,
    kind: input.locatorKind === "page" || input.locatorKind === "paragraph" ||
      input.locatorKind === "footnote" ? input.locatorKind : "section",
    artifact_ids: artifactIds,
    text_sha256: textSha256,
    context_artifact_ids: contextArtifactIds,
    payload_sha256: payloadSha256,
  }, {
    page_numbers: boundPageNumbers,
    page_text_sha256: boundPageTextSha256,
  });
  const pageNumbers = [...new Set(units.flatMap((unit) => unit.page_numbers))]
    .sort((left, right) => left - right);
  const viewPath = evidenceViewPath(state.document_id, state.version_id, handle);

  if (options?.persistEvidence !== false) {
    await persistEvidenceReceipt({
      schema_version: EVIDENCE_SCHEMA,
      handle,
      source: {
        document_id: state.document_id,
        version_id: state.version_id,
        source_sha256: state.source_sha256,
        parser_version: state.parser_version,
        cache_key: state.cache_key,
      },
      lookup: { ...input },
      evidence: {
        artifact_ids: artifactIds,
        context_artifact_ids: contextArtifactIds,
        text_sha256: textSha256,
        payload_sha256: payloadSha256,
        page_numbers: boundPageNumbers,
        page_text_sha256: boundPageTextSha256,
      },
    });
  }

  return {
    ...base,
    status: "found" as const,
    exact: true,
    units,
    before,
    after,
    matches: artifactIds,
    source: {
      handle: `mike-source:sha256:${state.source_sha256}`,
      document_id: state.document_id,
      version_id: state.version_id,
      source_sha256: state.source_sha256,
      parser_version: state.parser_version,
      cache_key: state.cache_key,
      schema_version: LEGAL_PDF_RESULT_SCHEMA,
    },
    evidence: {
      handle,
      artifact_ids: artifactIds,
      context_artifact_ids: contextArtifactIds,
      text_sha256: textSha256,
      payload_sha256: payloadSha256,
      page_numbers: boundPageNumbers,
      page_text_sha256: boundPageTextSha256,
    },
    link: {
      type: "pdf-evidence",
      evidence_view_path: viewPath,
      href: pageNumbers[0] ? `${viewPath}#page=${pageNumbers[0]}` : viewPath,
      page_numbers: pageNumbers,
      artifact_ids: artifactIds,
    },
  };
}

function unavailable(input: PdfLookupInput, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    ...baseResult(input),
    status: "unavailable" as const,
    exact: false,
    error: code ? "PDF lookup source or artifact is unavailable" : "PDF lookup failed",
  };
}

export async function lookupPdfStructure(
  sourcePath: string,
  input: PdfLookupInput,
  options?: {
    persistEvidence?: boolean;
    capturePages?: (pages: NormalizedPage[]) => void;
    cacheKey?: string;
    documentId?: string;
    versionId?: string;
    pages?: number[];
  },
) {
  if (!validInput(input)) {
    return {
      ...baseResult(input),
      status: "invalid" as const,
      exact: false,
      error: "Invalid or unbounded PDF locator",
    };
  }
  try {
    if (!options?.cacheKey || !options.documentId || !options.versionId)
      throw new Error("PDF lookup requires a cache and document identity");
    const source = await loadSource(sourcePath, options.cacheKey);
    const response = await runLegalPdfDocument<EngineLookup>({
      operation: "structure_lookup",
      source_pdf: source.source,
      cache_dir: CACHE_DIRECTORY,
      ...source.profile,
      ...(options.pages ? { pages: options.pages } : {}),
      query: contractInput(input),
    }, { maxBuffer: 64 * 1024 * 1024 });
    if (response.source.sha256 !== source.sourceSha256 ||
        response.source.cache_key !== source.cacheKey) {
      throw new Error("Legal PDF cache identity changed");
    }
    const cacheKey = response.source.cache_key;
    if (!cacheKey) throw new Error("Legal PDF lookup returned no cache key");
    return await finishLookup({ state: {
      document_id: options.documentId,
      version_id: options.versionId,
      source_sha256: response.source.sha256,
      parser_version: response.source.parser_version,
      cache_key: cacheKey,
    } }, input, response.result, options);
  } catch (error) {
    return unavailable(input, error);
  }
}

async function verifiedPdfEvidence(
  sourcePath: string,
  handle: string,
) {
  const receipt = await readPdfEvidenceReceipt(handle);
  let pageRows: NormalizedPage[] = [];
  const lookup = await lookupPdfStructure(sourcePath, receipt.lookup, {
    persistEvidence: false,
    cacheKey: receipt.source.cache_key,
    documentId: receipt.source.document_id,
    versionId: receipt.source.version_id,
    ...(receipt.lookup.locatorKind === "page"
      ? { pages: receipt.evidence.page_numbers }
      : {}),
    capturePages: (rows) => {
      pageRows = rows;
    },
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
  const expectedHandle = lookup.evidence.handle;
  if (
    expectedHandle !== handle ||
    lookup.source.document_id !== receipt.source.document_id ||
    lookup.source.version_id !== receipt.source.version_id ||
    lookup.source.source_sha256 !== receipt.source.source_sha256 ||
    lookup.source.parser_version !== receipt.source.parser_version ||
    lookup.source.cache_key !== receipt.source.cache_key ||
    lookup.evidence.text_sha256 !== receipt.evidence.text_sha256 ||
    lookup.evidence.payload_sha256 !== receipt.evidence.payload_sha256 ||
    !sameValues(
      lookup.evidence.artifact_ids,
      receipt.evidence.artifact_ids,
    ) ||
    !sameValues(
      lookup.evidence.context_artifact_ids,
      receipt.evidence.context_artifact_ids,
    ) ||
    lookup.evidence.page_text_sha256 !==
      receipt.evidence.page_text_sha256 ||
    !sameValues(
      lookup.evidence.page_numbers,
      receipt.evidence.page_numbers,
    )
  ) {
    throw new Error(
      "PDF evidence no longer matches the authoritative source artifacts",
    );
  }
  return { lookup, pageRows, receipt };
}

export async function rehydratePdfEvidence(
  sourcePath: string,
  handle: string,
) {
  return (await verifiedPdfEvidence(sourcePath, handle)).lookup;
}

export async function verifyPdfLinkEvidence(
  sourcePath: string,
  handle: string,
) {
  const verified = await verifiedPdfEvidence(sourcePath, handle);
  return {
    documentId: verified.lookup.source.document_id,
    versionId: verified.lookup.source.version_id,
  };
}

function evidenceBlockText(units: PdfLookupUnit[]) {
  const seenUnits = new Set<string>();
  const seenText = new Set<string>();
  return units
    .filter((unit) => {
      const key = `${unit.kind}:${unit.id}`;
      if (seenUnits.has(key)) return false;
      seenUnits.add(key);
      return true;
    })
    .flatMap((unit) => [
      unit.text.trim(),
      unit.proposition?.sentence.trim() ?? "",
      unit.proposition?.passage_since_prior_note.trim() ?? "",
    ])
    .filter((text) => {
      const key = text.replace(/\s+/gu, " ").toLowerCase();
      if (!key || seenText.has(key)) return false;
      seenText.add(key);
      return true;
    })
    .join("\n\n");
}

function evidenceSources(
  units: PdfLookupUnit[],
  viewPath: string,
  documentText: string,
) {
  const seen = new Set<string>();
  return units.flatMap((unit) => {
    const key = `${unit.kind}:${unit.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const pageNumbers = [...new Set(unit.page_numbers)].sort(
      (left, right) => left - right,
    );
    return [{
      key,
      label: unit.locator,
      href: pageNumbers[0]
        ? `${viewPath}#page=${pageNumbers[0]}`
        : viewPath,
      blockText: evidenceBlockText([unit]),
      documentText,
      pageScoped: pageNumbers.length === 1,
      pageNumbers,
    }];
  });
}

function buildLinkEvidence(
  handle: string,
  verified: Awaited<ReturnType<typeof verifiedPdfEvidence>>,
  rows: NormalizedPage[],
) {
  const { lookup, receipt } = verified;
  const byNumber = new Map(rows.map((row) => [row.number, row]));
  const boundPages = receipt.evidence.page_numbers
    .map((number) => byNumber.get(number))
    .filter((page): page is NormalizedPage => Boolean(page));
  const documentText = boundPages.map(({ text }) => text).join("\n");
  const viewPath = evidenceViewPath(
    lookup.source.document_id,
    lookup.source.version_id,
    handle,
  );
  const pages = boundPages.map(({ number, text }) => {
    const href = `${viewPath}#page=${number}`;
    return {
      pageNumber: number,
      href,
      label: `[page ${number}]`,
      blockText: text,
      evidence: {
        url: href,
        blockText: text,
        documentText,
        pageScoped: true as const,
      },
    };
  });
  if (!pages.length) {
    throw new Error("PDF evidence has no exact page text for linking");
  }
  const selectedPageNumbers = [
    ...new Set(lookup.link.page_numbers),
  ].sort((left, right) => left - right);
  const sources = evidenceSources(
    [...lookup.before, ...lookup.units, ...lookup.after],
    viewPath,
    documentText,
  );
  return {
    handle,
    documentId: lookup.source.document_id,
    versionId: lookup.source.version_id,
    pageNumbers: selectedPageNumbers,
    sources,
    pages,
  };
}

export async function rehydratePdfLinkEvidence(
  sourcePath: string,
  handle: string,
) {
  const verified = await verifiedPdfEvidence(sourcePath, handle);
  return buildLinkEvidence(handle, verified, verified.pageRows);
}

export type PdfLinkEvidence = Awaited<ReturnType<typeof rehydratePdfLinkEvidence>>;
