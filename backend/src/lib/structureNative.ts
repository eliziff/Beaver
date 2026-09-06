import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { SpreadsheetCellSpan } from "./spreadsheet";

export type NativeTextFragmentPlan = {
  directives: string[];
  sourceWordIntervals: Array<{
    quoteIndex: number;
    start: number;
    end: number;
    firstWord: number;
    lastWord: number;
  }>;
  paintQuotes: string[];
  /** All required source words have a directive; live browser paint is verified separately. */
  sourceSafeComplete: boolean;
  paintedWords: number;
};

type CitatorExcerptClassification = {
  kind: "prose" | "mixed" | "authority_list" | "insufficient";
  citeTokens: number; citeRuns: number; citeCharCoverage: number;
  functionWords: number; proseWindow: string | null; rule: string;
};

export type NativeCitationTextSpan = { text: string; start: number; end: number };

export type NativeCitationOccurrence = NativeCitationTextSpan & {
  styledCitation: NativeCitationTextSpan;
  coreCitation: NativeCitationTextSpan;
  pinpoints: Array<NativeCitationTextSpan & {
    kind: "paragraph" | "section" | "page";
  }>;
  kind: "case" | "statute" | "journal" | "other";
  shortForm?: string;
  explicitShortForm?: string;
  reasons: string[];
};

export type NativeAuthorityReferenceOccurrence = NativeCitationTextSpan & {
  token: NativeCitationTextSpan;
  pinpoints: Array<NativeCitationTextSpan & {
    kind: "paragraph" | "section" | "page";
  }>;
  kind: "ibid" | "supra";
  noteNumber?: number;
};

/** Footnote offsets use JavaScript UTF-16 code units. */
export type NativeAuthorityTextUnit = {
  key: string;
  kind: "body" | "footnote";
  ordinal: number;
  footnote_id: number | null;
  page_numbers: number[];
  text: string;
  footnote_refs: Array<[footnoteId: number, offset: number]>;
};

type Rect = [number, number, number, number];
type PassageStatus = "found" | "not_found" | "ambiguous" | "invalid" | "unavailable";

export type NativePdfPassageTarget = {
  id: string;
  locatorKind: "paragraph" | "section" | "page";
  locator: string;
  exactQuotes?: string[];
};

export type NativePdfPassageGeometry = {
  schemaVersion: "legalpdf.passage-geometry.v1";
  sourceSha256: string;
  parserVersion: string;
  coordinateSpace: "visible_crop_box";
  coordinateOrigin: "top_left";
  rotationApplied: true;
  targets: Array<{
    id: string;
    locatorKind: NativePdfPassageTarget["locatorKind"];
    locator: string;
    status: PassageStatus;
    pages: Array<{
      pageNumber: number; width: number; height: number;
      source: "native" | "unavailable"; passageRects: Rect[];
    }>;
    quotes: Array<{
      text: string; status: PassageStatus; pageNumber?: number; rects: Rect[];
    }>;
  }>;
};

type NativePdfPassagePages = Omit<NativePdfPassageGeometry, "schemaVersion" | "targets"> & {
  schemaVersion: "legalpdf.passage-pages.v1";
  targets: Array<{ id: string; status: PassageStatus; pages: Array<{
    pageNumber: number; width: number; height: number; source: "native" | "unavailable";
    lines: Array<{ id: string; rect: Rect; words: Array<{ text: string; rect: Rect }> }>;
  }> }>;
};

type PdfStructureLookupBase = {
  schema_version: "legalpdf.structure-lookup.v1";
  requested: {
    locator_kind: string;
    locator: string;
    end_locator: string | null;
    context_blocks: number;
    page: number | null;
    occurrence: number | null;
  };
  units: Array<{
    id: string;
    kind: "page" | "paragraph" | "footnote" | "section";
    locator: string;
    text: string;
    page_numbers: number[];
    confidence: number | null;
    confidence_basis: string;
    provenance: string;
    proposition?: { sentence: string; passage_since_prior_note: string };
    note?: { label: string; occurrence: number; restart_sequence: number;
      reference_page: number | null; body_pages: number[]; warnings: string[] };
  }>;
  before: PdfStructureLookup["units"];
  after: PdfStructureLookup["units"];
  matches: string[];
  pages: Array<{ page_number: number; text: string }>;
  error?: string;
};

export type PdfStructureLookup = PdfStructureLookupBase & (
  | { status: "found"; exact: true; payload_sha256: string; page_text_sha256: string }
  | { status: "not_found" | "ambiguous" | "invalid" | "unavailable"; exact: false }
);

function structureAddonRoot() {
  return path.resolve(__dirname, "../../../native/legal-structure-node");
}

type StructureAddon = {
  nativeBuildFeatures(): string;
  deriveDocumentStructure(request: unknown): Promise<NativeDocument>;
  deriveDocxDocument(bytes: Buffer, id: string, drafting?: boolean): Promise<NativeDocument>;
  docxText(bytes: Buffer, drafting?: boolean, limit?: number): Promise<string>;
  docxAuthorityTextUnits(bytes: Buffer): Promise<NativeAuthorityTextUnit[]>;
  fixDocxSupraCrossReferences(bytes: Buffer): Promise<{
    bytes: Buffer; detected: number; converted: number; already_linked: number;
    review_required: number; bookmarks_added: number;
    reasons: { restarted_numbering: boolean; unsafe_or_split_fields: number };
  }>;
  hasDocxSupraReferences(bytes: Buffer): Promise<boolean>;
  derivePdfDocument(bytes: Buffer, request: unknown): Promise<NativeDocument>;
  preparePdfDocument(bytes: Buffer, request: unknown): Promise<PdfPreparationSummary>;
  restorePdfDocument(request: unknown): Promise<NativeDocument | null>;
  pdfDocumentSummary(document: NativeDocument): PdfPreparationSummary;
  pdfAuthorityTextUnits(document: NativeDocument): NativeAuthorityTextUnit[];
  pdfPassageGeometryPages(document: NativeDocument, bytes: Buffer,
    targets: Array<Omit<NativePdfPassageTarget, "exactQuotes">>): Promise<NativePdfPassagePages>;
  docxStructureLint(document: NativeDocument): {
    paragraphs: number;
    checks: {
      cross_references: { references: number; resolved: number; skipped_external: number };
      attachments: { references: number; resolved: number };
      numbering: { anchors: number };
      defined_terms: { definitions: number };
    };
    findings: Array<{
      code: "cross_reference_missing" | "attachment_reference_missing" |
        "numbering_gap" | "numbering_duplicate" | "defined_term_duplicate" |
        "defined_term_unused";
      severity: "error" | "warning";
      subject: string; message: string; paragraph_index: number; excerpt: string;
    }>;
    notes: string[];
  };
  documentText(document: NativeDocument, limit?: number): string;
  documentTextBytes(document: NativeDocument): number;
  documentRevision(document: NativeDocument): string;
  readDocumentTextWindow(document: NativeDocument, offset: number,
    startChar: number, limit: number): NativeDocumentTextWindow;
  readDocumentTextRange(document: NativeDocument, start: number, end: number,
    offset: number | undefined, limit: number): NativeDocumentTextWindow;
  documentFingerprint(document: NativeDocument): {
    resultSha256: string; components: Record<string, string>;
  };
  citationLookupKey(text: string): string;
  citationLookupKeys(texts: string[]): string[];
  providerCitationsInText(text: string): Array<{
    text: string; start: number; end: number;
    family: "neutral" | "reporter" | "statute";
    jurisdiction?: "ca" | "uk" | "us";
    year?: string; court?: string; number?: string;
    volume?: string; reporter?: string; page?: string;
  }>;
  citationOccurrencesInText(text: string): NativeCitationOccurrence[];
  authorityReferencesInText(text: string): NativeAuthorityReferenceOccurrence[];
  caselawCitationLookupKey(text: string): string;
  hasCitationInText(text: string): boolean;
  classifyCitatorExcerpt(text: string): CitatorExcerptClassification;
  classifyCitatorExcerpts(texts: string[]): CitatorExcerptClassification[];
  groundedProseErrors(text: string, citedEvidenceIds: readonly string[],
    visibleEvidence: unknown): string[];
  quoteRepairSuggestion(claim: string, spans: string[]): string | null;
  markedQuoteSpans(text: string): Array<{ text: string; start: number; end: number }>;
  readDocumentRange(document: NativeDocument, kind: NativeDocumentBlock["kind"], from: string,
    to: string, contextBlocks: number): {
      selected: NativeDocumentBlock[];
      before: NativeDocumentBlock[];
      after: NativeDocumentBlock[];
    } | null;
  smallestContainingDocumentBlock(document: NativeDocument, start: number,
    end: number): NativeDocumentBlock | null;
  documentHasOrigin(document: NativeDocument, origin: NativeDocumentBlock["origin"]): boolean;
  documentAnchors(document: NativeDocument, end?: number): Array<Pick<NativeDocumentBlock,
    "kind" | "label" | "start" | "end" | "parentLabel" | "rowSpan" | "columnSpan">>;
  legalSourceViewer(document: NativeDocument, primaryKind: "paragraph" | "section",
    limit?: number): {
      slices: Array<{
        start: number; end: number; text: string; depth: number;
        anchors: Array<Pick<NativeDocumentBlock,
          "kind" | "label" | "start" | "end" | "parentLabel">>;
        primary: Pick<NativeDocumentBlock,
          "kind" | "label" | "start" | "end" | "parentLabel"> | null;
      }>;
      truncated: boolean;
      documentRevision: string;
    };
  documentTableCells(document: NativeDocument): SpreadsheetCellSpan[];
  textFragmentPlan(blockText: string, quotes: string[], pdf: boolean,
    publisherMayAnnotateLegalReference: boolean,
    splitHtmlSourceBlocks: boolean,
    document: NativeDocument): NativeTextFragmentPlan;
  textFragmentPlanStandalone(blockText: string, quotes: string[], pdf: boolean,
    publisherMayAnnotateLegalReference: boolean,
    splitHtmlSourceBlocks: boolean): NativeTextFragmentPlan;
  documentParagraphRangeDirective(document: NativeDocument, start: string,
    end: string): string | null;
  lookupStructureBlock(document: NativeDocument, locator: string,
    contextBlocks: number): {
      status: "found" | "not_found" | "unavailable" | "ambiguous";
      requestedLabel: string; matches: string[]; block: NativeDocumentBlock | null;
      before: NativeDocumentBlock[]; after: NativeDocumentBlock[];
    };
  resolveDocumentAddressSpans(document: NativeDocument, spec: string,
    follow: "none" | "out" | "in" | "both", depth: number):
    | { status: "found"; spans: Array<{ start: number; end: number }> }
    | { status: "invalid" | "no_pages" | "not_found" | "unavailable" |
        "ambiguous" | "not_addressable" };
  graphScope(document: NativeDocument, seed: string, follow: "none" | "out" | "in" | "both",
    depth: number, includeDescendants: boolean, includeUnits: boolean): {
      seed: NativeDocumentBlock;
      nodes: Array<NativeDocumentBlock & { units?: NativeDocumentBlock[] }>;
      depth: number;
    } | null;
  queryPdfDocument(document: NativeDocument, locatorKind: string, locator: string,
    endLocator?: string, contextBlocks?: number, page?: number,
    occurrence?: number): PdfStructureLookup;
  pdfLookupUnitSpans(document: NativeDocument, ids: string[]): Record<string, { start: number; end: number }>;
};

declare const nativeDocument: unique symbol;
export type NativeDocument = { readonly [nativeDocument]: never };

type NativeDocumentTextWindow = {
  status: "ready" | "invalid_line" | "invalid_character" | "split_character" |
    "invalid_range";
  rows: Array<{
    lineNumber: number;
    text: string;
    span: [number, number];
    truncatedStart: boolean;
    truncatedEnd: boolean;
  }>;
  nextOffset: number | null;
  nextStartChar: number | null;
  totalLines?: number;
  documentRevision: string;
  lineLength?: number;
  rangeStartLine?: number;
  rangeEndLine?: number;
};

export type PdfPreparationSummary = {
  sha256: string;
  parserVersion: string;
  cacheKey: string;
  pageCount: number;
  projectionPageCount: number;
  status: string;
  pagesNeedingOcr: number[];
  ocrRoutedPages: number[];
};

export type NativeDocumentBlock = {
  kind: "paragraph" | "page" | "section" | "footnote" | "table" | "row" | "cell";
  label: string;
  start: number;
  end: number;
  origin: "native" | "heuristic";
  text: string;
  anchor?: string;
  aliases?: string[];
  parentLabel?: string;
  rowSpan?: number;
  columnSpan?: number;
};

let addon: StructureAddon | undefined;

function addonFilename() {
  if (process.platform === "win32") return "legal_structure_node.dll";
  if (process.platform === "darwin") return "liblegal_structure_node.dylib";
  return "liblegal_structure_node.so";
}

export function structureNative() {
  if (addon) return addon;
  const root = structureAddonRoot();
  const filename = process.env.LEGAL_STRUCTURE_NATIVE?.trim() ||
    path.join(root, "target", "release", addonFilename());
  if (!existsSync(filename)) {
    throw new Error(`Missing legal structure native module: ${filename}`);
  }
  const module = { exports: {} } as NodeModule;
  process.dlopen(module, filename);
  addon = module.exports as StructureAddon;
  return addon;
}

const normalizedWords = (text: string) =>
  (text.normalize("NFKC").toLowerCase()
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [])
    .map((word) => word.replace(/['’]/g, ""));

function unionRects(rects: Rect[]) {
  return rects.slice(1).reduce<Rect>((box, rect) => [
    Math.min(box[0], rect[0]), Math.min(box[1], rect[1]),
    Math.max(box[2], rect[2]), Math.max(box[3], rect[3]),
  ], rects[0]);
}

function exactQuote(target: NativePdfPassagePages["targets"][number], text: string) {
  if (target.status !== "found") return { text, status: target.status, rects: [] };
  const needle = normalizedWords(text);
  if (needle.length < 2) return { text, status: "invalid" as const, rects: [] };
  const hits = target.pages.flatMap((page) => {
    if (page.source !== "native") return [];
    const words = page.lines.flatMap((line) => line.words.flatMap((word) =>
      normalizedWords(word.text).map((value) => ({ value, line: line.id, rect: word.rect }))));
    return words.flatMap((_, start) =>
      needle.every((word, offset) => words[start + offset]?.value === word)
        ? [{ pageNumber: page.pageNumber, words: words.slice(start, start + needle.length) }]
        : []);
  });
  if (hits.length !== 1) return {
    text, status: (hits.length ? "ambiguous" : "not_found") as PassageStatus, rects: [],
  };
  const lines = new Map<string, Rect[]>();
  hits[0].words.forEach((word) => lines.set(word.line, [...(lines.get(word.line) ?? []), word.rect]));
  return { text, status: "found" as const, pageNumber: hits[0].pageNumber,
    rects: [...lines.values()].map(unionRects) };
}

export async function pdfPassageGeometry(
  document: NativeDocument, bytes: Buffer, targets: NativePdfPassageTarget[],
): Promise<NativePdfPassageGeometry> {
  if (!targets.length || targets.length > 100 || !bytes.length || bytes.length > 100 * 1024 * 1024 ||
    targets.some((target) => (target.exactQuotes?.length ?? 0) > 20 ||
    target.exactQuotes?.some((quote) => quote.length > 4_000))) {
    throw new Error("Invalid PDF passage geometry request");
  }
  const native = structureNative();
  const summary = native.pdfDocumentSummary(document);
  if (createHash("sha256").update(bytes).digest("hex") !== summary.sha256) {
    throw new Error("PDF source changed after preparation");
  }
  const raw = await native.pdfPassageGeometryPages(document, bytes,
    targets.map(({ exactQuotes: _, ...target }) => target));
  if (raw.sourceSha256 !== summary.sha256 || raw.parserVersion !== summary.parserVersion) {
    throw new Error("PDF passage geometry source identity changed");
  }
  return { ...raw, schemaVersion: "legalpdf.passage-geometry.v1",
    targets: raw.targets.map((target, index) => {
      const request = targets[index];
      const status = target.status === "found" && (!target.pages.length || target.pages.every((page) =>
        page.source === "unavailable" || (request.locatorKind !== "page" && !page.lines.length)))
        ? "unavailable" : target.status;
      const resolved = { ...target, status };
      return { id: target.id, locatorKind: request.locatorKind, locator: request.locator, status,
        pages: target.pages.map((page) => ({
        pageNumber: page.pageNumber, width: page.width, height: page.height, source: page.source,
        passageRects: request.locatorKind === "page" || !page.lines.length
          ? [] : [unionRects(page.lines.map((line) => line.rect))],
        })),
        quotes: (request.exactQuotes ?? []).map((quote) => exactQuote(resolved, quote)),
      };
    }) };
}
