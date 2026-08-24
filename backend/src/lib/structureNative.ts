import { existsSync } from "node:fs";
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
    document: NativeDocument): NativeTextFragmentPlan;
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
