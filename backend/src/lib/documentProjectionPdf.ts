import path from "node:path";
import { readFile } from "node:fs/promises";
import { documentProjectionService } from "./documentProjectionService";
import { sha256 } from "./hash";
import {
  compileLegalPdfSourceDoc,
} from "./legalPdfSourceDoc";
import {
  inspectPdf,
  immutableReceiptPath,
  localDataPath,
  openPdfProjection,
  pdfProjectionIdentity,
  relativeLocalDataPath,
  resolveLocalDataPath,
  writeImmutableReceipt,
} from "./documentProjection";
import { normalizeSourceDocLocator } from "./sourceDoc";
import { RESOURCE_LOCATOR_KINDS } from "./resourceReferences";

export type LocalPdfLocatorKind = (typeof RESOURCE_LOCATOR_KINDS)[number];

export type LocalPdfLookupInput = {
  locatorKind: LocalPdfLocatorKind;
  locator: string;
  endLocator?: string;
  contextBlocks?: number;
  page?: number;
  occurrence?: number;
};

type JsonObject = Record<string, unknown>;
type CanonicalKind = "page" | "paragraph" | "footnote" | "section";

export type LocalPdfLookupUnit = {
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
const MAX_UNITS = 20;
const MAX_CONTEXT_BLOCKS = 2;
const MAX_RETURN_CHARS = 60_000;
const EVIDENCE_SCHEMA = "mike.pdf_evidence.v1";
const EVIDENCE_HANDLE = /^mike-evidence:v1:([0-9a-f]{64})$/u;

export type LocalPdfEvidenceReceipt = {
  schema_version: typeof EVIDENCE_SCHEMA;
  handle: string;
  source: {
    document_id: string;
    version_id: string;
    source_path: string;
    source_sha256: string;
    parser_version: string;
    parser_config_version: string;
    cache_key: string;
  };
  lookup: LocalPdfLookupInput;
  evidence: {
    artifact_ids: string[];
    context_artifact_ids: string[];
    text_sha256: string;
    payload_sha256: string;
    page_numbers: number[];
    page_text_sha256: string;
  };
};

export type LocalPdfLinkEvidence = {
  handle: string;
  documentId: string;
  versionId: string;
  href: string;
  label: string;
  blockText: string;
  documentText: string;
  pageScoped: boolean;
  pageNumbers: number[];
  sources: {
    key: string;
    label: string;
    href: string;
    blockText: string;
    documentText: string;
    pageScoped: boolean;
    pageNumbers: number[];
  }[];
  pages: {
    pageNumber: number;
    href: string;
    label: string;
    blockText: string;
    evidence: {
      url: string;
      blockText: string;
      documentText: string;
      pageScoped: true;
    };
  }[];
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

function evidenceReceipt(value: unknown): LocalPdfEvidenceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid PDF evidence receipt");
  }
  const receipt = value as Partial<LocalPdfEvidenceReceipt>;
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
    typeof source.source_path !== "string" ||
    typeof source.source_sha256 !== "string" ||
    typeof source.parser_version !== "string" ||
    typeof source.parser_config_version !== "string" ||
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
  resolveLocalDataPath(source.source_path);
  return receipt as LocalPdfEvidenceReceipt;
}

async function persistEvidenceReceipt(receipt: LocalPdfEvidenceReceipt) {
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

export async function readLocalPdfEvidenceReceipt(handle: string) {
  const receipt = evidenceReceipt(
    JSON.parse(await readFile(evidencePath(handle), "utf8")),
  );
  if (receipt.handle !== handle) {
    throw new Error("PDF evidence receipt handle does not match its content");
  }
  return receipt;
}

function sameStrings(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameNumbers(left: number[], right: number[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function jsonLines(raw: string) {
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JsonObject);
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerValue(value: unknown) {
  const number = numberValue(value);
  return number === null ? null : Math.trunc(number);
}

function confidence(value: unknown) {
  const number = numberValue(value);
  return number === null ? null : Math.min(Math.max(number, 0), 1);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numberArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is number =>
            typeof item === "number" && Number.isInteger(item) && item > 0,
        )
        .map(Number)
    : [];
}

function canonicalKind(kind: LocalPdfLocatorKind): CanonicalKind {
  return kind === "page" || kind === "paragraph" || kind === "footnote"
    ? kind
    : "section";
}

function parseOrdinal(kind: "page" | "paragraph", raw: string) {
  const value = raw.trim().normalize("NFKC");
  const pattern =
    kind === "page"
      ? /^#?\s*\[?\s*(?:(?:pages?|pp?\.?)[\s:_=-]*)?0*(\d{1,6})\s*\]?$/iu
      : /^#?\s*(?:(?:paragraphs?|paras?|pars?|¶)\.?\s*)?(?:(?:paragraph|para|par)[\s:_=-]*)?0*(\d{1,6})$/iu;
  const match = value.match(pattern);
  return match ? Number(match[1]) : null;
}

function numericRange(kind: "page" | "paragraph", raw: string) {
  const prefix =
    kind === "page"
      ? /^(?:pages?|pp?\.?)[\s:_=-]*/iu
      : /^(?:paragraphs?|paras?|pars?)\.?[\s:_=-]*/iu;
  const match = raw
    .trim()
    .normalize("NFKC")
    .replace(/^#\s*/u, "")
    .replace(/^\[\s*/u, "")
    .replace(/\s*\]$/u, "")
    .replace(prefix, "")
    .match(/^(\d{1,6})\s*(?:-|–|—|\.\.|to)\s*(\d{1,6})$/iu);
  return match ? ([Number(match[1]), Number(match[2])] as const) : null;
}

function normalizeFootnote(raw: string) {
  return raw
    .trim()
    .normalize("NFKC")
    .replace(/^(?:footnotes?|notes?|fn)\s*[#.:_-]?\s*/iu, "")
    .toLocaleLowerCase();
}

function sectionLocatorKind(row: JsonObject): LocalPdfLocatorKind | null {
  const kind = stringValue(row.locator_kind);
  return RESOURCE_LOCATOR_KINDS.includes(kind as LocalPdfLocatorKind) &&
    canonicalKind(kind as LocalPdfLocatorKind) === "section"
    ? (kind as LocalPdfLocatorKind)
    : null;
}

function sectionAliasKey(value: string) {
  return (
    normalizeSourceDocLocator("section", value) ||
    value.trim().normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase()
  );
}

function sectionAliasKeys(row: JsonObject) {
  return new Set(
    [stringValue(row.locator), ...stringArray(row.aliases)]
      .filter(Boolean)
      .map(sectionAliasKey),
  );
}

function cleanParagraphText(value: unknown) {
  return stringValue(value)
    .replace(/\u27E6FN:[^\u27E7]+\u27E7/gu, "")
    .trim();
}

function pageNumber(row: JsonObject) {
  return integerValue(row.number) ?? (integerValue(row.index) ?? 0) + 1;
}

function pageLines(row: JsonObject) {
  return Array.isArray(row.lines)
    ? (row.lines as JsonObject[])
        .slice()
        .sort(
          (left, right) =>
            (integerValue(left.reading_order) ?? 0) -
            (integerValue(right.reading_order) ?? 0),
        )
        .map((line) => stringValue(line.text).trim())
        .filter(Boolean)
    : [];
}

function joinPageLines(lines: string[]) {
  const parts: string[] = [];
  for (const text of lines) {
    if (
      parts.length &&
      parts[parts.length - 1].endsWith("-") &&
      /^\p{Ll}/u.test(text)
    ) {
      parts[parts.length - 1] = parts[parts.length - 1].slice(0, -1);
    } else if (parts.length) {
      parts.push(" ");
    }
    parts.push(text);
  }
  return parts.join("");
}

type NormalizedPage = {
  number: number;
  text: string;
};

function normalizedPages(rows: JsonObject[]) {
  return rows
    .map((row) => ({
      number: pageNumber(row),
      text: joinPageLines(pageLines(row)),
    }))
    .filter(({ text }) => text)
    .sort((left, right) => left.number - right.number);
}

function relevantPages(
  pages: NormalizedPage[],
  units: LocalPdfLookupUnit[],
) {
  const numbers = new Set(units.flatMap((unit) => unit.page_numbers));
  return pages.filter(({ number }) => numbers.has(number));
}

function pageTextSha256(pages: NormalizedPage[]) {
  return sha256(
    JSON.stringify(
      pages.map(({ number, text }) => ({ page_number: number, text })),
    ),
  );
}

function pageText(row: JsonObject) {
  const page = pageNumber(row);
  const lines = pageLines(row);
  return lines.length ? `[page ${page}]\n${joinPageLines(lines)}` : "";
}

async function loadArtifactSource(sourcePath: string) {
  const source = localDataPath(sourcePath);
  const state = await documentProjectionService.pdfState(source, {
    validatePublication: false,
  });
  if (!state || !["ready", "degraded"].includes(state.status)) {
    return {
      available: false as const,
      error: state
        ? `Structural PDF parse is ${state.status}`
        : "No structural PDF parse exists",
      state,
    } as const;
  }
  if (
    !state.document_id ||
    !state.version_id ||
    !state.source_path ||
    !state.artifact_manifest ||
    !state.parser_version ||
    !state.parser_config_version ||
    resolveLocalDataPath(state.source_path) !== source
  ) {
    throw new Error(
      "PDF lookup parse state does not match the selected source",
    );
  }
  await inspectPdf(source, { expectedSha256: state.source_sha256 });
  const projection = await openPdfProjection(pdfProjectionIdentity({
    documentId: state.document_id,
    versionId: state.version_id,
    sourceSha256: state.source_sha256,
    compiler: { name: "legalpdf", version: state.parser_version },
    options: {
      parser_config_version: state.parser_config_version,
      parser_config: state.parser_config,
    },
  }));
  if (
    projection.key !== state.cache_key ||
    relativeLocalDataPath(path.join(projection.directory, "document.json")) !==
      state.artifact_manifest
  ) {
    throw new Error("PDF lookup projection does not match the selected source");
  }
  return {
    available: true as const,
    source,
    state,
    manifest: projection.manifest,
    readRows: projection.readRows,
  };
}

export async function readLocalPdfSourceDoc(
  sourcePath: string,
) {
  const loaded = await loadArtifactSource(sourcePath);
  if (!loaded.available) return null;
  const [pages, paragraphs, sections, footnotes] = await Promise.all([
    loaded.readRows("pages"),
    loaded.readRows("paragraphs"),
    loaded.readRows("sections"),
    loaded.readRows("footnotes"),
  ]);
  if (!pages || !paragraphs || !sections || !footnotes) return null;
  return compileLegalPdfSourceDoc(
    {
      manifest: loaded.manifest,
      pages,
      paragraphs,
      sections,
      footnotes,
    },
    { id: loaded.state.document_id },
  );
}

async function artifacts(
  sourcePath: string,
  kind: CanonicalKind,
) {
  const loaded = await loadArtifactSource(sourcePath);
  if (!loaded.available) return loaded;
  const { state, manifest, readRows } = loaded;
  const rows = await readRows(
    kind === "page"
      ? "pages"
      : kind === "paragraph"
        ? "paragraphs"
        : kind === "footnote"
          ? "footnotes"
          : "sections",
  );
  if (!rows) {
    return { error: `No exact ${kind} artifact is available`, state } as const;
  }
  const pages = kind === "page" ? rows : await readRows("pages");
  return {
    state,
    manifest,
    rows,
    pages: pages ?? [],
  };
}

function baseResult(input: LocalPdfLookupInput) {
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
    units: [] as LocalPdfLookupUnit[],
    before: [] as LocalPdfLookupUnit[],
    after: [] as LocalPdfLookupUnit[],
    matches: [] as string[],
  };
}

function pageMaps(rows: JsonObject[]) {
  return {
    byIndex: new Map(
      rows.map((row) => [
        integerValue(row.index),
        {
          number:
            integerValue(row.number) ?? (integerValue(row.index) ?? 0) + 1,
          confidence: confidence(row.text_quality),
        },
      ]),
    ),
  };
}

function paragraphUnit(
  row: JsonObject,
  index: number,
  pages: ReturnType<typeof pageMaps>["byIndex"],
): LocalPdfLookupUnit {
  const page = pages.get(integerValue(row.page_index));
  return {
    id: stringValue(row.id) || `paragraph-${index + 1}`,
    kind: "paragraph",
    locator: `paragraph ${index + 1}`,
    text: cleanParagraphText(row.text),
    page_numbers: page ? [page.number] : [],
    confidence: page?.confidence ?? null,
    confidence_basis: page ? "page_text_quality" : "unavailable",
    provenance: `legalpdf:${stringValue(row.region_type) || "unknown"}`,
  };
}

function pageUnit(row: JsonObject): LocalPdfLookupUnit {
  const number = integerValue(row.number) ?? (integerValue(row.index) ?? 0) + 1;
  return {
    id: stringValue(row.id) || `page-${number}`,
    kind: "page",
    locator: `[page ${number}]`,
    text: pageText(row),
    page_numbers: [number],
    confidence: confidence(row.text_quality),
    confidence_basis: "page_text_quality",
    provenance: stringValue(row.source) || "unknown",
  };
}

function footnoteUnit(row: JsonObject): LocalPdfLookupUnit {
  const referencePage = integerValue(row.reference_page);
  const bodyPages = numberArray(row.body_pages);
  return {
    id: stringValue(row.pair_id),
    kind: "footnote",
    locator: `footnote ${stringValue(row.label)}`,
    text: stringValue(row.body).trim(),
    page_numbers: [
      ...new Set([
        ...(referencePage && referencePage > 0 ? [referencePage] : []),
        ...bodyPages,
      ]),
    ],
    confidence: confidence(row.confidence),
    confidence_basis: "footnote_pairing",
    provenance: stringValue(row.provenance) || "unknown",
    proposition: {
      sentence: stringValue(row.sentence_proposition).trim(),
      passage_since_prior_note: stringValue(
        row.passage_since_prior_note,
      ).trim(),
    },
    note: {
      label: stringValue(row.label),
      occurrence: integerValue(row.occurrence),
      restart_sequence: integerValue(row.restart_sequence),
      reference_page: referencePage,
      body_pages: bodyPages,
      warnings: stringArray(row.warnings),
    },
  };
}

function sectionUnits(
  rows: JsonObject[],
  pages: ReturnType<typeof pageMaps>["byIndex"],
) {
  return rows.map((row, index) => {
    const pageIndexes = Array.isArray(row.page_indexes)
      ? row.page_indexes.filter(
          (value): value is number =>
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= 0,
        )
      : [];
    const pageNumbers = [
      ...new Set(
        pageIndexes
          .map((pageIndex) => pages.get(pageIndex)?.number)
          .filter((page): page is number => page !== undefined),
      ),
    ];
    const qualities = pageIndexes
      .map((pageIndex) => pages.get(pageIndex)?.confidence)
      .filter(
        (value): value is number => value !== null && value !== undefined,
      );
    return {
      id: stringValue(row.id) || `section-${index + 1}`,
      kind: "section" as const,
      locator: stringValue(row.locator).trim(),
      text: stringValue(row.text).trim(),
      page_numbers: pageNumbers,
      confidence: qualities.length ? Math.min(...qualities) : null,
      confidence_basis: qualities.length
        ? "minimum_page_text_quality"
        : "unavailable",
      provenance: stringValue(row.provenance) || "heading-region",
    };
  });
}

function range<T>(rows: T[], start: number, end: number) {
  if (start > end) return null;
  const selected = rows.slice(start, end + 1);
  return selected.length <= MAX_UNITS ? selected : null;
}

function exactFootnoteMatches(
  rows: JsonObject[],
  locator: string,
  input: LocalPdfLookupInput,
) {
  const query = normalizeFootnote(locator);
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      const id = normalizeFootnote(stringValue(row.pair_id));
      const label = normalizeFootnote(stringValue(row.label));
      const page = input.page;
      return (
        (id === query || label === query) &&
        (input.occurrence === undefined ||
          integerValue(row.occurrence) === input.occurrence) &&
        (page === undefined ||
          integerValue(row.reference_page) === page ||
          numberArray(row.body_pages).includes(page))
      );
    });
}

export async function lookupLocalPdfStructure(
  sourcePath: string,
  input: LocalPdfLookupInput,
  options?: {
    persistEvidence?: boolean;
    capturePageRows?: (rows: JsonObject[]) => void;
  },
) {
  const base = baseResult(input);
  if (
    !RESOURCE_LOCATOR_KINDS.includes(input.locatorKind) ||
    !input.locator.trim() ||
    input.locator.length > 200 ||
    (input.endLocator?.length ?? 0) > 200 ||
    !Number.isInteger(input.contextBlocks ?? 0) ||
    (input.contextBlocks ?? 0) < 0 ||
    (input.contextBlocks ?? 0) > MAX_CONTEXT_BLOCKS ||
    (input.page !== undefined &&
      (!Number.isInteger(input.page) || input.page < 1)) ||
    (input.occurrence !== undefined &&
      (!Number.isInteger(input.occurrence) || input.occurrence < 1))
  ) {
    return {
      ...base,
      status: "invalid" as const,
      exact: false,
      error: "Invalid or unbounded PDF locator",
    };
  }

  try {
    const kind = canonicalKind(input.locatorKind);
    const loaded = await artifacts(sourcePath, kind);
    if ("error" in loaded) {
      return {
        ...base,
        status: "unavailable" as const,
        exact: false,
        error: loaded.error,
      };
    }
    options?.capturePageRows?.(loaded.pages);
    const { state, manifest, rows, pages } = loaded;
    const pageInfo = pageMaps(pages).byIndex;
    let ordered: LocalPdfLookupUnit[] = [];
    let selected: LocalPdfLookupUnit[] | null = null;
    let selectedStart = -1;
    let selectedEnd = -1;
    let matches: string[] = [];

    if (kind === "page" || kind === "paragraph") {
      ordered = kind === "page"
        ? rows.map(pageUnit)
        : rows.map((row, index) => paragraphUnit(row, index, pageInfo));
      const inlineRange = numericRange(kind, input.locator);
      const startNumber = inlineRange?.[0] ?? parseOrdinal(kind, input.locator);
      const endNumber =
        input.endLocator !== undefined
          ? parseOrdinal(kind, input.endLocator)
          : (inlineRange?.[1] ?? startNumber);
      if (
        startNumber === null ||
        endNumber === null ||
        startNumber > endNumber
      ) {
        return {
          ...base,
          status: "invalid" as const,
          exact: false,
          error: "Invalid exact range",
        };
      }
      selectedStart = ordered.findIndex((unit) =>
        kind === "page"
          ? unit.page_numbers[0] === startNumber
          : unit.locator === `paragraph ${startNumber}`,
      );
      selectedEnd = ordered.findIndex((unit) =>
        kind === "page"
          ? unit.page_numbers[0] === endNumber
          : unit.locator === `paragraph ${endNumber}`,
      );
      selected =
        selectedStart >= 0 && selectedEnd >= selectedStart
          ? range(ordered, selectedStart, selectedEnd)
          : [];
    } else if (kind === "footnote") {
      ordered = rows.map(footnoteUnit);
      const startMatches = exactFootnoteMatches(rows, input.locator, input);
      const endMatches = input.endLocator
        ? exactFootnoteMatches(rows, input.endLocator, input)
        : startMatches;
      matches = [
        ...new Set(
          [...startMatches, ...endMatches].map(({ row }) =>
            stringValue(row.pair_id),
          ),
        ),
      ];
      if (startMatches.length > 1 || endMatches.length > 1) {
        return { ...base, status: "ambiguous" as const, exact: false, matches };
      }
      selectedStart = startMatches[0]?.index ?? -1;
      selectedEnd = endMatches[0]?.index ?? -1;
      selected =
        selectedStart >= 0 && selectedEnd >= selectedStart
          ? range(ordered, selectedStart, selectedEnd)
          : [];
    } else {
      if (input.endLocator) {
        return {
          ...base,
          status: "invalid" as const,
          exact: false,
          error: "Section ranges are not supported by this artifact contract",
        };
      }
      const requested = sectionAliasKey(input.locator);
      const candidates = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => {
          const explicitKind = sectionLocatorKind(row);
          return (
            (input.locatorKind === "section" ||
              explicitKind === input.locatorKind) &&
            sectionAliasKeys(row).has(requested)
          );
        });
      if (
        input.locatorKind !== "section" &&
        !rows.some(
          (row) => sectionLocatorKind(row) === input.locatorKind,
        )
      ) {
        return {
          ...base,
          status: "unavailable" as const,
          exact: false,
          error: `No exact ${input.locatorKind} identifiers exist in this PDF artifact`,
        };
      }
      if (candidates.length > 1) {
        return {
          ...base,
          status: "ambiguous" as const,
          exact: false,
          matches: candidates.map(({ row }) => stringValue(row.id)),
        };
      }
      ordered = sectionUnits(rows, pageInfo);
      selectedStart = candidates[0]?.index ?? -1;
      selectedEnd = selectedStart;
      selected = selectedStart >= 0 ? [ordered[selectedStart]] : [];
    }

    if (selected === null) {
      return {
        ...base,
        status: "invalid" as const,
        exact: false,
        error: `Exact ranges are limited to ${MAX_UNITS} units`,
      };
    }
    if (!selected.length) {
      return { ...base, status: "not_found" as const, exact: false, matches };
    }
    if (selected.some((unit) => !unit.text)) {
      return {
        ...base,
        status: "unavailable" as const,
        exact: false,
        error: "The requested structural unit has no exact text",
      };
    }

    const context = input.contextBlocks ?? 0;
    const before = ordered.slice(
      Math.max(0, selectedStart - context),
      selectedStart,
    );
    const after = ordered.slice(selectedEnd + 1, selectedEnd + 1 + context);
    if (
      [...before, ...selected, ...after].reduce(
        (total, unit) => total + unit.text.length,
        0,
      ) > MAX_RETURN_CHARS
    ) {
      return {
        ...base,
        status: "invalid" as const,
        exact: false,
        error: `Exact result exceeds ${MAX_RETURN_CHARS} characters; request a narrower range`,
      };
    }

    const textSha256 = sha256(selected.map((unit) => unit.text).join("\u001e"));
    const artifactIds = selected.map((unit) => unit.id);
    const contextArtifactIds = [...before, ...after].map((unit) => unit.id);
    const payloadSha256 = sha256(
      JSON.stringify({ units: selected, before, after }),
    );
    const allEvidenceUnits = [...before, ...selected, ...after];
    const normalizedPageRows = normalizedPages(loaded.pages);
    const boundPages = relevantPages(normalizedPageRows, allEvidenceUnits);
    const boundPageNumbers = boundPages.map(({ number }) => number);
    const boundPageTextSha256 = pageTextSha256(boundPages);
    const handleIdentity = {
      document_id: state.document_id,
      version_id: state.version_id,
      source_sha256: state.source_sha256,
      cache_key: state.cache_key,
      kind,
      artifact_ids: artifactIds,
      text_sha256: textSha256,
      context_artifact_ids: contextArtifactIds,
      payload_sha256: payloadSha256,
    };
    const handle = evidenceHandle(handleIdentity, {
      page_numbers: boundPageNumbers,
      page_text_sha256: boundPageTextSha256,
    });
    const pageNumbers = [
      ...new Set(selected.flatMap((unit) => unit.page_numbers)),
    ].sort((left, right) => left - right);
    const viewPath = evidenceViewPath(
      state.document_id,
      state.version_id,
      handle,
    );
    if (options?.persistEvidence !== false) {
      await persistEvidenceReceipt({
        schema_version: EVIDENCE_SCHEMA,
        handle,
        source: {
          document_id: state.document_id,
          version_id: state.version_id,
          source_path: state.source_path,
          source_sha256: state.source_sha256,
          parser_version: state.parser_version,
          parser_config_version: state.parser_config_version,
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
      units: selected,
      before,
      after,
      matches: artifactIds,
      source: {
        handle: `mike-source:sha256:${state.source_sha256}`,
        document_id: state.document_id,
        version_id: state.version_id,
        source_sha256: state.source_sha256,
        parser_version: state.parser_version,
        parser_config_version: state.parser_config_version,
        cache_key: state.cache_key,
        schema_version: manifest.schema_version,
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
        type: "local-library-pdf",
        evidence_view_path: viewPath,
        href: pageNumbers[0]
          ? `${viewPath}#page=${pageNumbers[0]}`
          : viewPath,
        page_numbers: pageNumbers,
        artifact_ids: artifactIds,
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ...base,
      status: "unavailable" as const,
      exact: false,
      error: code
        ? "PDF lookup source or artifact is unavailable"
        : error instanceof Error
          ? error.message
          : "PDF lookup failed",
    };
  }
}

async function verifiedLocalPdfEvidence(
  sourcePath: string,
  handle: string,
) {
  const receipt = await readLocalPdfEvidenceReceipt(handle);
  if (
    resolveLocalDataPath(receipt.source.source_path) !== path.resolve(sourcePath)
  ) {
    throw new Error("PDF evidence receipt does not belong to this source");
  }
  let pageRows: JsonObject[] = [];
  const lookup = await lookupLocalPdfStructure(sourcePath, receipt.lookup, {
    persistEvidence: false,
    capturePageRows: (rows) => {
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
    lookup.source.parser_config_version !==
      receipt.source.parser_config_version ||
    lookup.source.cache_key !== receipt.source.cache_key ||
    lookup.evidence.text_sha256 !== receipt.evidence.text_sha256 ||
    lookup.evidence.payload_sha256 !== receipt.evidence.payload_sha256 ||
    !sameStrings(
      lookup.evidence.artifact_ids,
      receipt.evidence.artifact_ids,
    ) ||
    !sameStrings(
      lookup.evidence.context_artifact_ids,
      receipt.evidence.context_artifact_ids,
    ) ||
    lookup.evidence.page_text_sha256 !==
      receipt.evidence.page_text_sha256 ||
    !sameNumbers(
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

export async function rehydrateLocalPdfEvidence(
  sourcePath: string,
  handle: string,
) {
  return (await verifiedLocalPdfEvidence(sourcePath, handle)).lookup;
}

export async function verifyLocalPdfLinkEvidence(
  sourcePath: string,
  handle: string,
) {
  const verified = await verifiedLocalPdfEvidence(sourcePath, handle);
  return {
    documentId: verified.lookup.source.document_id,
    versionId: verified.lookup.source.version_id,
  };
}

function evidenceBlockText(units: LocalPdfLookupUnit[]) {
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

function evidenceLabel(units: LocalPdfLookupUnit[], pages: NormalizedPage[]) {
  if (units.length === 1) return units[0].locator;
  if (units.length && units.every(({ kind }) => kind === "page")) {
    return `[pages ${units
      .flatMap(({ page_numbers }) => page_numbers)
      .join(", ")}]`;
  }
  return units.length
    ? `${units[0].locator}\u2013${units[units.length - 1].locator}`
    : pages.length === 1
      ? `[page ${pages[0].number}]`
      : `[pages ${pages.map(({ number }) => number).join(", ")}]`;
}

function evidenceSources(
  units: LocalPdfLookupUnit[],
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
  verified: Awaited<ReturnType<typeof verifiedLocalPdfEvidence>>,
  rows: NormalizedPage[],
): LocalPdfLinkEvidence {
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
    href: selectedPageNumbers[0]
      ? `${viewPath}#page=${selectedPageNumbers[0]}`
      : viewPath,
    label: evidenceLabel(lookup.units, boundPages),
    blockText: evidenceBlockText(lookup.units),
    documentText,
    pageScoped: selectedPageNumbers.length === 1,
    pageNumbers: selectedPageNumbers,
    sources,
    pages,
  };
}

export async function rehydrateLocalPdfLinkEvidence(
  sourcePath: string,
  handle: string,
): Promise<LocalPdfLinkEvidence> {
  const verified = await verifiedLocalPdfEvidence(sourcePath, handle);
  return buildLinkEvidence(handle, verified, normalizedPages(verified.pageRows));
}
