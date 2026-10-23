import { existsSync } from "node:fs";
import { defaultNativeAddon, nativeAddonFile } from "mike/shared/nativeAddonFile.mjs";
import { structureEngineAddon, type StructureEngineTransport } from "mike/shared/structure-engine.mjs";
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

/** A passage saying what a cited decision stands for: a citing decision's prose, or a journal author's sentence
 *  whose footnote cites it. */
export type CitatorPassage = {
  sourceKind: "case" | "commentary"; journalName: string | null; text: string; excerptKind: "prose" | "mixed";
  citingCitation: string | null; citingName: string | null; citingCourt: string | null; citingLevel: number | null;
  citingDate: string | null; language?: "en" | "fr"; paragraph: number | null; pageLabel: string | null;
  spanSha256: string; sourceArticleId: string | null; citingUrl: string | null;
};
export type CitatorNoteUpEntry = {
  citation: string | null; name: string | null; court: string | null; date: string | null; language: "en" | "fr";
  url: string | null; paragraph: number | null; occurrences: number; distinctParagraphs: number;
  courtLevel: number | null; citedAs: string; pinpoints: string | null; excerpt: string;
};
export type CitatorNoteUp = {
  /** Every citing decision matched, not just the page returned. */
  total: number; entries: CitatorNoteUpEntry[];
  provider: { citingInCorpus: number; citingReported: string[] } | null;
  totalCiters: number; judicialDiscussion: CitatorPassage[];
  /** null where no journal commentary is built. */
  journalAnalysis: CitatorPassage[] | null;
  excerptsConsidered: number; excerptsRejected: { authorityList: number; insufficient: number };
};

export type A2AJStoreLookup = { citation: string; docType?: "cases" | "laws"; language?: "en" | "fr";
  dataset?: string; sourceUrl?: string };
export type A2AJStoreDocument = { docType: "cases" | "laws"; dataset: string; citation: string;
  alternateCitation: string | null; name: string | null; date: string | null; url: string | null;
  publisherUrl: string | null; language: "en" | "fr"; upstreamLicense: string | null;
  native: NativeDocument; searchNative: NativeDocument };

export type NativeCitationTextSpan = { text: string; start: number; end: number };
/** The citation engine's `noteReferences`: each split part that cites, with what it cites. */
export type NativeReferencePart = { part: import("legal-citations").SourcePart;
  references: Array<NativeCitationTextSpan & { form: "citation" | "bare" | "link";
    authority: import("legal-citations").Citation["authority"]; link?: string; citation?: number }> };

/** `label` as printed ("726.1", "(2)", "PART XXIII"); `title` a marginal note or heading; `text` the
 *  entry's own words; `start`/`end` (string indices) span it and everything under it. */
export type NativeStatuteOutlineEntry = { kind: "preamble" | "part" | "division" | "heading" | "schedule" | "section" |
  "article" | "subsection" | "paragraph" | "subparagraph" | "clause"; level: number; label: string;
  title?: string; text: string; start: number; end: number };

/** A judgment's outline entry: `label` as printed ("[12]", "IV.", "(a)", "•"); `level` a heading's
 *  depth or an item's depth in its list (from 1); `start`/`end` (string indices) span it. */
export type NativeCaseOutlineEntry = { kind: "heading" | "paragraph" | "item" | "text"; level: number;
  label: string; text: string; start: number; end: number;
  /** A front-matter line's part: the provider's title line, a party's role, the caption's short lines. */
  role?: "title" | "party" | "caption" | "labelled" | "counsel" };

/** `start` is in the document's query text; `pageIndex` is a PDF's zero-based page. */
export type NativeOutlineEntry = { kind: "heading" | "section"; level: number; title: string;
  start: number; pageIndex?: number };

export type NativeCitationOccurrence = NativeCitationTextSpan & {
  styledCitation: NativeCitationTextSpan;
  coreCitation: NativeCitationTextSpan;
  format?: import("legal-citations").Citation["format"];
  pinpoints: Array<NativeCitationTextSpan & {
    kind: import("legal-citations").PinpointKind;
    first?: string; last?: string;
  }>;
  /** The pinpoints as written, with the words that introduce them: "at para 105". */
  pinpointPhrase?: NativeCitationTextSpan;
  kind: "case" | "statute" | "journal" | "book" | "parliamentary" | "other";
  shortForm?: string;
  explicitShortForm?: string;
  reasons: string[];
};

export type NativeAuthorityReferenceOccurrence = NativeCitationTextSpan & {
  token: NativeCitationTextSpan;
  pinpoints: Array<NativeCitationTextSpan & {
    kind: import("legal-citations").PinpointKind;
    first?: string; last?: string;
  }>;
  /** The pinpoints as written, with the words that introduce them: "at para 105". */
  pinpointPhrase?: NativeCitationTextSpan;
  kind: "short" | "ibid" | "supra";
  noteNumber?: number;
};

/** Footnote offsets use JavaScript UTF-16 code units. */
export type NativeAuthorityTextUnit = {
  source?: import("mike/shared/authorities-contract.d.ts").AuthorityUnitSource;
  key: string;
  kind: "body" | "footnote";
  ordinal: number;
  footnote_id: number | null;
  note_number?: number | null;
  /** The mark a Word footnote prints in place of a number (customMarkFollows), as written. */
  note_mark?: string | null;
  /** A Word footnote's hyperlinks (a hyperlink's relationship target or a HYPERLINK field's): offsets and address. */
  links?: Array<[start: number, end: number, url: string]>;
  restart_sequence?: number;
  page_numbers: number[];
  text: string;
  footnote_refs: Array<[footnoteId: number, offset: number]>;
  /** A Word body paragraph's place: the indices of the elements that lead to it from the body. */
  path?: number[];
};

type Rect = [number, number, number, number];
type PassageStatus = "found" | "not_found" | "ambiguous" | "invalid" | "unavailable";

export type NativePdfPassageTarget = {
  physicalPages?: number[];
  id: string;
  locatorKind: "paragraph" | "section" | "article" | "rule" | "page";
  locator: string;
  /** The Act a statute locator is of, where its PDF prints several Acts. */
  instrument?: string;
  exactQuotes?: string[];
  quoteSelections?: Array<{ text: string; start: number; end: number }>;
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
    /** The cited paragraph numbers are printed on the passage, not only counted. */
    printed?: boolean;
    pages: Array<{
      pageNumber: number; width: number; height: number;
      source: "native" | "unavailable"; passageRects: Rect[]; text?: string;
    }>;
    quotes: Array<{
      text: string; status: PassageStatus; pageNumber?: number; rects: Rect[];
      fragments?: Array<{ pageNumber: number; rects: Rect[] }>;
    }>;
  }>;
};

export type NativePdfTextPage = { pageNumber: number; width: number; height: number;
  lines: Array<{ id: string; text?: string; rect: Rect; words: Array<{ text: string; rect: Rect }> }> };

type NativePdfPassagePages = Omit<NativePdfPassageGeometry, "schemaVersion" | "targets"> & {
  schemaVersion: "legalpdf.passage-pages.v1";
  targets: Array<{ id: string; status: PassageStatus; printed?: boolean; pages: Array<{
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
  /** Whether a document belongs to the engine now running: a WebAssembly engine started afresh
   *  (recycle) has lost the documents it made. */
  documentLive?(document: NativeDocument): boolean;
  memoryBytes?(): number;
  recycle?(): void;
  offThread<M extends "groundedProseErrors" | "passageLink" | "citedPassageLink" | "sourceLinks">(method: M,
    ...args: Parameters<StructureAddon[M]>): Promise<ReturnType<StructureAddon[M]>>;
  nativeBuildFeatures(): string;
  /** A passage's link on a source's page with the fragments planned against the document (legal-structure). */
  passageLink(document: NativeDocument, request: { url: string; anchor?: string; blockText: string; quotes: string[];
    preferIndependentHtmlBlocks?: boolean; verifiedPdf?: { url: string; pdfOnly?: boolean } | null })
    : { target: string; plan: NativeTextFragmentPlan | null } | null;
  /** The link citing a passage by its anchor, with its paragraph's or provision's fragments where they plan whole. */
  citedPassageLink(document: NativeDocument, url: string, pinpoints: readonly string[]): string | null;
  /** Every link a passage of an A2AJ document can take (publisher, CanLII, Law Web) and the one routed best:
   *  the publisher's where its page prints an anchor for the pinpoint, else CanLII's (legal-structure source_links). */
  sourceLinks(document: NativeDocument, request: { url?: string; dataset: string; citation: string;
    alternateCitation?: string | null; language?: string; docType?: string;
    locator?: { kind: string; label: string } | null; blockText: string; quotes: string[];
    /** A passage cited without a quotation is linked at the citation's pinpoints (`par12`, `sec6(1)(c)`). */
    pinpoints?: string[]; verifiedPdf?: { url: string; pdfOnly?: boolean } | null })
    : { publisher: { target: string; plan: NativeTextFragmentPlan | null } | null;
        canlii: { target: string; plan: NativeTextFragmentPlan | null } | null; lawWeb: string | null; best: string | null };
  /** The passage on A2AJ Law Web's reader of the document; null where it cannot be planned whole there. */
  lawWebLink(document: NativeDocument, citation: string, docType: string, blockText: string, quotes: string[]): string | null;
  canliiA2ajLawUrl(dataset: string, citation: string, language: string): string | null;
  deriveDocumentStructure(request: unknown): Promise<NativeDocument>;
  deriveDocxDocument(bytes: Buffer, id: string, drafting?: boolean): Promise<NativeDocument>;
  docxText(bytes: Buffer, drafting?: boolean, limit?: number): Promise<string>;
  docxAuthorityTextUnits(bytes: Buffer): Promise<NativeAuthorityTextUnit[]>;
  fixDocxSupraCrossReferences(bytes: Buffer): Promise<{
    bytes: Buffer; detected: number; converted: number; already_linked: number;
    review_required: number; bookmarks_added: number;
    reasons: { restarted_numbering: boolean; unsafe_or_split_fields: number };
  }>;
  derivePdfDocument(bytes: Buffer, request: unknown, signal?: AbortSignal): Promise<NativeDocument>;
  /** `progress(recognized, total)` follows text recognition as pages finish. */
  preparePdfDocument(bytes: Buffer, request: unknown, signal?: AbortSignal,
    progress?: (recognized: number, total: number) => void): Promise<PdfPreparationSummary>;
  restorePdfDocument(request: unknown): Promise<NativeDocument | null>;
  pdfDocumentSummary(document: NativeDocument): PdfPreparationSummary;
  pdfRecognizedText(document: NativeDocument, pages?: number[]): NativePdfTextPage[] | null;
  pdfPageLabels(document: NativeDocument): Array<string | null>;
  /** Every page's text in page order, empty where a page has no exact text. */
  pdfPageTexts(document: NativeDocument): string[];
  pdfAuthorityTextUnits(document: NativeDocument): NativeAuthorityTextUnit[];
  pdfPassageGeometryPages(document: NativeDocument,
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
    offset: number | undefined, limit: number, startChar?: number): NativeDocumentTextWindow;
  documentFingerprint(document: NativeDocument): {
    resultSha256: string; components: Record<string, string>;
  };
  citationLookupKey(text: string): string;
  citationEngineCall(method: string, request: string): unknown;
  /** citationEngineCall, run off the JavaScript thread. */
  citationEngineCallAsync(method: string, request: string): Promise<unknown>;
  documentReadingOrder(request: string): Array<[number, number]>;
  citationLookupKeys(texts: string[]): string[];
  providerCitationsInText(text: string): Array<{
    text: string; start: number; end: number;
    family: "neutral" | "reporter" | "canlii" | "database" | "statute";
    key?: string;
    jurisdiction?: string;
    year?: string; court?: string; number?: string;
    volume?: string; reporter?: string; page?: string;
  }>;
  /** The CanLII page of the first decision the citations name by a neutral or CanLII citation with its court written,
   *  of `court` where given and routed; null where none. */
  canliiCaseUrl(citations: readonly string[], language: "en" | "fr", court: string | null): string | null;
  /** The CanLII page of the first statute or regulation the text cites; null where none. */
  canliiLawUrl(text: string): string | null;
  /** Whether the engine's registry routes a court code to CanLII. */
  canliiCourtRoute(court: string): boolean;
  citationOccurrencesInText(text: string): NativeCitationOccurrence[];
  authorityReferencesInText(text: string): NativeAuthorityReferenceOccurrence[];
  caselawCitationLookupKey(text: string): string;
  hasCitationInText(text: string): boolean;
  groundedProseErrors(text: string, citedEvidenceIds: readonly string[],
    visibleEvidence: unknown): string[];
  quoteRepairSuggestion(claim: string, spans: string[]): string | null;
  markedQuoteSpans(text: string): Array<{ text: string; start: number; end: number }>;
  /** A text's citable units as UTF-16 [start, end) spans: every line, and with sentences every sentence of a line. */
  textUnits(text: string, sentences: boolean): Array<[number, number]>;
  /** Each quotation located through the source structure the engine holds (each quotation with
   *  the paragraphs, pages and provisions its citation names) and compared with the source's words there, with
   *  groundedProseErrors of it against the passage it was found in (the whole text where not), named by its id;
   *  with compare false, located only. */
  quoteLocateDocument(document: NativeDocument,
    /** A provider's text; a PDF, read by the locators it prints; a statute's PDF, its provisions as its print reads them. */
    source: "text" | "pdf" | "legislation",
    quotes: Array<{ quote: string; scopes: { paragraphs: Array<[number, number]>; pages: Array<[number, number]>; sections: string[] };
      id?: string }>, compare?: boolean):
    Promise<Array<{ match: NativeQuoteLocation; comparison: NativeQuoteComparison | null; errors?: string[] }>>;
  /** Where a quotation's words are in a source passage, the passage it is compared with, and what differs. */
  quoteComparison(authored: string, source: string): NativeQuoteComparison;
  /** The source's words as the author quoted them: the author's changes bracketed, omissions an ellipsis. */
  editorialQuote(authored: string, source: string): string;
  /** The searches of a journal index's names for the articles a citation quotes the titles of (FTS5 queries). */
  journalTitleSearches(citation: string): Array<{ title: string; query: string }>;
  /** The article whose found name is closest to the title searched for it, when close enough. */
  journalTitleChoice(hits: Array<{ title: string; name: string; articleId: number }>): number | null;
  /** The source passage an authored quotation's words closely align with, where it occurs once. */
  verbatimRepair(authored: string, source: string): string | null;
  /** The one document the local A2AJ store at `store` holds under a citation's key, with its provisions' document and
   *  its full text's; null where the store, or the document, is missing. */
  a2ajDocument(store: string, lookup: A2AJStoreLookup): Promise<A2AJStoreDocument | null>;
  /** One provision of a statute the store holds, as an excerpt of the document `excerpt` describes: null where the
   *  store lacks the statute, `native` null where it lacks the provision. */
  a2ajSection(store: string, lookup: A2AJStoreLookup, section: string, excerpt: { citation: string;
    url: string | null; alternateCitation: string | null; dataset: string; name: string | null }):
    Promise<{ native: NativeDocument | null } | null>;
  /** Each citation's exact aliases and authored forms in the store's inventory; its own key alone where there is
   *  no store. */
  a2ajAliasGroups(store: string, citations: string[]): Array<{ keys: string[]; forms: string[]; ambiguous: boolean }>;
  /** The citation of the one decision the store holds under a style of cause, in a year, of one of `courts` (any
   *  where none): a decision cited by an identifier A2AJ does not carry. Null where none answers, or several. */
  a2ajNamedCase(store: string, named: { name: string; year: string; courts: string[] }): string | null;
  /** Each style of cause compared as its words: the key of the store's names and of CanLII's titles. */
  a2ajNameKeys(names: string[]): string[];
  /** The decisions citing a decision and what they and journal authors say it stands for, from the graph beside
   *  the A2AJ store at `store` (which gives the decision's keys); null where no graph is built. */
  citatorNoteUp(store: string, request: { citation: string; citedParagraph?: number; size?: number;
    courtScope?: "all" | "scc" | "appellate" | "trial" | "tribunal"; courtCode?: string; sort?: "newest" | "most_discussed" }):
    CitatorNoteUp | null;
  /** How much each citation is cited, by the graph beside the store at `store`; null where none is built. */
  citatorMetrics(store: string, citations: string[]):
    Array<{ citingCases: number; distinctCitingParagraphs: number; occurrences: number } | null> | null;
  readDocumentRange(document: NativeDocument, kind: NativeDocumentBlock["kind"], from: string,
    to: string, contextBlocks: number): {
      selected: NativeDocumentBlock[];
      before: NativeDocumentBlock[];
      after: NativeDocumentBlock[];
    } | null;
  smallestContainingDocumentBlock(document: NativeDocument, start: number,
    end: number): NativeDocumentBlock | null;
  documentHasOrigin(document: NativeDocument, origin: NativeDocumentBlock["origin"]): boolean;
  /** Reflected levels are one-based; source roots have level 1. */
  documentAnchors(document: NativeDocument, end?: number): Array<{ level: number } & Pick<NativeDocumentBlock,
    "kind" | "label" | "start" | "end" | "ranges" | "nodeId" | "printedLabel" | "parentLabel" | "rowSpan" | "columnSpan">>;
  legalSourceViewer(document: NativeDocument, primaryKind: "paragraph" | "section",
    limit?: number): {
      slices: Array<{
        start: number; end: number; text: string; depth: number;
        anchors: Array<Pick<NativeDocumentBlock,
          "kind" | "label" | "start" | "end" | "ranges" | "nodeId" | "printedLabel" | "parentLabel">>;
        primary: Pick<NativeDocumentBlock,
          "kind" | "label" | "start" | "end" | "ranges" | "nodeId" | "printedLabel" | "parentLabel"> | null;
        /** The slice is a heading the structure reads. */
        heading?: boolean;
      }>;
      truncated: boolean;
      documentRevision: string;
    };
  documentTableCells(document: NativeDocument): SpreadsheetCellSpan[];
  /** The document's headings and top-level sections in order; a section sits under the heading before it. */
  documentOutline(document: NativeDocument, legislation?: boolean): NativeOutlineEntry[];
  /** A statute's outline read from its text: parts, headings and provisions in order, each with
   *  its level, printed label, marginal note or heading, own text, and the span of its subtree. */
  statuteOutline(text: string, articles?: boolean): NativeStatuteOutlineEntry[];
  /** A judgment's outline read from its text: its headings by level, numbered paragraphs, the lists
   *  within them, and the matter around its reasons, in order. */
  caseOutline(text: string): NativeCaseOutlineEntry[];
  /** caseOutline read from a document's own text, its offsets the document's. */
  documentCaseOutline(document: NativeDocument): NativeCaseOutlineEntry[];
  /** Where a statute's text holds each cited provision, part ("16(3)(a)") or range ("49-51"), by its outline: each span
   *  (UTF-16) with everything under it, in the text's order; a label it does not hold has none. */
  statuteProvisionSpans(text: string, labels: string[]): Array<[number, number]>;
  /** How current a statute's print says it is, from its first pages ("Current to September 21, 2026"). */
  statuteCurrency(pages: string[]): string | null;
  /** A filing's cover from its opening page's text: the parties its BETWEEN block names in their roles, and whose
   *  document it is, from `title` (its record title) where given, else its DOCUMENT line. */
  filingCover(opening: string, title: string | null): {
    partyGroups: Array<{ role: string; parties: string[] }>;
    filedBy?: { party: string; article: boolean };
  };
  lookupStructureBlock(document: NativeDocument, locator: string | { nodeId: string },
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
  graphScope(document: NativeDocument, seed: { locator: string; nodeId?: never } | { nodeId: string; locator?: never }, follow: "none" | "out" | "in" | "both",
    depth: number, includeDescendants: boolean, includeUnits: boolean): {
      seed: NativeDocumentBlock;
      nodes: Array<NativeDocumentBlock & { units?: NativeDocumentBlock[] }>;
      depth: number;
      omissions: NativeGraphScopeOmission[];
    } | null;
  queryPdfDocument(document: NativeDocument, locatorKind: string, locator: string,
    endLocator?: string, contextBlocks?: number, page?: number,
    occurrence?: number): PdfStructureLookup;
  pdfLookupUnitSpans(document: NativeDocument, ids: string[]): Record<string, Array<{ start: number; end: number }>>;
};

declare const nativeDocument: unique symbol;
export type NativeDocument = { readonly [nativeDocument]: never };

type NativeDocumentTextWindow = {
  status: "ready" | "invalid_line" | "invalid_character" | "split_character" |
    "invalid_range";
  rows: Array<{
    lineNumber: number;
    startChar: number;
    endChar: number;
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
  embeddedPageLabels: (string | null)[];
  sha256: string;
  parserVersion: string;
  cacheKey: string;
  pageCount: number;
  projectionPageCount: number;
  status: string;
  pagesNeedingOcr: number[];
  ocrRoutedPages: number[];
  /** Pages that are a picture of their text (a scan, an image of a page): only these may be recognized on import. */
  scannedPages?: number[];
};

export type NativeGraphScopeOmission = {
  edgeIndex: number;
  edge: {
    sourceStart: number; sourceEnd: number; sourceLabel: string | null;
    raw: string; rawLabel: string; normalizedLocator: string;
    targetLabel: string | null; targetStart: number | null; targetEnd: number | null;
    status: "resolved" | "external" | "unresolved" | "abstained";
    selfLoop: boolean;
    reason?: "external_instrument" | "document_abstained" | "no_containing_section" |
      "ambiguous_label" | "depth_not_numbered" | "no_such_provision";
  };
  sourceNodeId?: string; targetNodeId?: string;
  missingEndpoints: Array<"source" | "target">;
};

export type NativeDocumentBlock = {
  nodeId?: string;
  printedLabel: boolean;
  ranges: Array<{ start: number; end: number }>;
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

/** The engine's reading of where a quotation is in its source (legal-structure quote_location.rs). */
export type NativeQuoteCorrection = { region: string; fragment: string; corrected: string };
export type NativeQuoteLocation = NativeQuoteCorrection & { location: string; score: number; labels: string[]; pinpoint: string;
  text: string; perfect: boolean; shortInLong: boolean;
  cited: (NativeQuoteCorrection & { score: number; labels: string[]; pinpoint: string }) | null };
export type NativeQuoteComparison = { matches: Array<{ start: number; end: number; text: string }>; candidate: string | null;
  candidateOnly: boolean; editorial: string | null;
  changes: Array<{ kind: "replace" | "delete" | "insert"; authored: string; source: string }> };

let addon: StructureAddon | undefined;

export function structureNative() {
  if (addon) return addon;
  const root = structureAddonRoot();
  const filename = process.env.LEGAL_STRUCTURE_NATIVE?.trim() ||
    defaultNativeAddon(root);
  if (!existsSync(filename)) {
    throw new Error(`Missing legal structure native module: ${filename}`);
  }
  const module = { exports: {} } as NodeModule;
  process.dlopen(module, nativeAddonFile(filename, root));
  // The native addon is one call; the page's runtime supplies its WebAssembly engine already wrapped.
  const loaded = module.exports as StructureAddon | StructureEngineTransport;
  addon = "callAsync" in loaded ? structureEngineAddon(loaded, {
    toBuffer: (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  }) as unknown as StructureAddon : loaded as StructureAddon;
  return addon;
}

/** Whether a document kept from an earlier call can still be read. */
export const nativeDocumentLive = (document: NativeDocument) => structureNative().documentLive?.(document) ?? true;

/** Words as PDF quote matching compares them: case, width and apostrophe forms folded. */
export const normalizedWords = (text: string) =>
  (text.normalize("NFKC").toLowerCase()
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [])
    .map((word) => word.replace(/’/g, "'"));

function unionRects(rects: Rect[]) {
  return rects.slice(1).reduce<Rect>((box, rect) => [
    Math.min(box[0], rect[0]), Math.min(box[1], rect[1]),
    Math.max(box[2], rect[2]), Math.max(box[3], rect[3]),
  ], rects[0]);
}

function exactQuote(target: NativePdfPassagePages["targets"][number], selection: string |
  { text: string; start: number; end: number }) {
  const context = typeof selection === "string" ? null : selection;
  const text = context ? context.text.slice(context.start, context.end) : selection as string;
  if (target.status !== "found") return { text, status: target.status, rects: [] };
  const needle = normalizedWords(context?.text ?? text);
  if (needle.length < 2) return { text, status: "invalid" as const, rects: [] };
  const before = context ? normalizedWords(context.text.slice(0, context.start)) : [];
  const selected = normalizedWords(text);
  if (!selected.length || context && [
    ...before, ...selected, ...normalizedWords(context.text.slice(context.end)),
  ].join("\0") !== needle.join("\0")) return { text, status: "invalid" as const, rects: [] };
  const words = target.pages.flatMap(page => page.source !== "native" ? [] :
    page.lines.flatMap(line => line.words.flatMap(word => normalizedWords(word.text)
      .map(value => ({ value, pageNumber: page.pageNumber, line: line.id, rect: word.rect })))));
  const hits = words.flatMap((_, start) => needle.every((word, offset) => {
    const current = words[start + offset], prior = words[start + offset - 1];
    return current?.value === word && (!offset || current.pageNumber <= prior.pageNumber + 1);
  }) ? [words.slice(start, start + needle.length)] : []);
  if (hits.length !== 1) return {
    text, status: (hits.length ? "ambiguous" : "not_found") as PassageStatus, rects: [],
  };
  const pages = new Map<number, Map<string, Rect[]>>();
  for (const word of hits[0].slice(before.length, before.length + selected.length)) {
    const lines = pages.get(word.pageNumber) ?? new Map<string, Rect[]>();
    lines.set(word.line, [...(lines.get(word.line) ?? []), word.rect]); pages.set(word.pageNumber, lines);
  }
  const fragments = [...pages].map(([pageNumber, lines]) => ({ pageNumber,
    rects: [...lines.values()].map(unionRects) }));
  // One quotation can span pages; keep it one editable mark with several fragments.
  return { text, status: "found" as const, ...fragments[0], fragments };

}

/** The paragraphs a range names, read as the review reads an ibid's pinpoint, or undefined for a
 *  single paragraph. A range runs forward over fewer than 100 paragraphs, as the engine's own range
 *  lookup requires. */
function paragraphRange(locator: string): [number, number] | undefined {
  const pinpoints = structureNative().authorityReferencesInText(`Ibid at paras ${locator}`)
    .flatMap(({ pinpoints }) => pinpoints);
  const first = Number(pinpoints[0]?.first), last = Number(pinpoints[0]?.last);
  return pinpoints.length === 1 && pinpoints[0].kind === "paragraph" && Number.isSafeInteger(first) &&
    Number.isSafeInteger(last) && first < last && last - first < 100 ? [first, last] : undefined;
}

export async function pdfPassageGeometry(
  document: NativeDocument, bytes: Buffer, targets: NativePdfPassageTarget[],
): Promise<NativePdfPassageGeometry> {
  if (!targets.length || targets.length > 100 || !bytes.length || bytes.length > 100 * 1024 * 1024 ||
    targets.some((target) => (target.exactQuotes?.length ?? 0) + (target.quoteSelections?.length ?? 0) > 20 ||
    target.exactQuotes?.some((quote) => quote.length > 4_000) ||
    target.quoteSelections?.some(({ text, start, end }) => text.length > 4_000 ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length))) {
    throw new Error("Invalid PDF passage geometry request");
  }
  const native = structureNative();
  const summary = native.pdfDocumentSummary(document);
  if (createHash("sha256").update(bytes).digest("hex") !== summary.sha256) {
    throw new Error("PDF source changed after preparation");
  }
  const pages = async (list: NativePdfPassageTarget[]) => {
    const result = await native.pdfPassageGeometryPages(document,
      list.map(({ exactQuotes: _, quoteSelections: __, ...target }) => target));
    if (result.sourceSha256 !== summary.sha256 || result.parserVersion !== summary.parserVersion) {
      throw new Error("PDF passage geometry source identity changed");
    }
    return result;
  };
  // A paragraph range is the passage from its first paragraph to its last, its end read as the
  // citation engine reads a pinpoint: "142-54" runs to 154.
  const ranges = targets.map(({ locatorKind, locator }) =>
    locatorKind === "paragraph" ? paragraphRange(locator) : undefined);
  const raw = await pages(targets.map((target, index) =>
    ranges[index] ? { ...target, locator: ranges[index].join("-") } : target));
  return { ...raw, schemaVersion: "legalpdf.passage-geometry.v1",
    targets: raw.targets.map((target, index) => {
      const request = targets[index];
      const status = target.status === "found" && (!target.pages.length || target.pages.every((page) =>
        page.source === "unavailable" || (request.locatorKind !== "page" && !page.lines.length)))
        ? "unavailable" : target.status;
      const resolved = { ...target, status };
      return { id: target.id, locatorKind: request.locatorKind, locator: request.locator, status,
        ...(request.locatorKind === "paragraph" ? { printed: target.printed === true } : {}),
        pages: target.pages.map((page) => ({
        pageNumber: page.pageNumber, width: page.width, height: page.height, source: page.source,
        text: page.lines.flatMap(line => line.words.map(word => word.text)).join(" ").slice(0, 2_000),
        passageRects: request.locatorKind === "page" || !page.lines.length
          ? [] : page.lines.map((line) => line.rect),
        })),
        quotes: [...(request.exactQuotes ?? []), ...(request.quoteSelections ?? [])]
          .map((quote) => exactQuote(resolved, quote)),
      };
    }) };
}
