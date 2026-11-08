import { existsSync } from "node:fs";
import { defaultNativeAddon, nativeAddonFile } from "mike/shared/nativeAddonFile.mjs";
import { structureEngineAddon, type StructureEngineTransport } from "mike/shared/structure-engine.mjs";
import type { PdfPageBinding } from "mike/shared/pdf-page-binding.mjs";
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
      source: "native" | "unavailable"; passageRects: Rect[]; text: string;
    }>;
    quotes: Array<{
      text: string; status: PassageStatus; pageNumber?: number; rects: Rect[];
      fragments?: Array<{ pageNumber: number; rects: Rect[] }>;
    }>;
  }>;
};

/** A page of the extraction as the engine's layout holds it (`legal_layout::Page`), the fields read of it. */
export type NativePdfTextPage = { number: number; width: number; height: number;
  lines: Array<{ id: string; text: string; bbox: Rect; words: Array<{ text: string; bbox: Rect }> }> };

/** A lookup in a PDF by a locator (legal-pdf-support's `PdfLookupRequest`). */
export type NativePdfLookupRequest = {
  locator_kind: string;
  locator: string;
  end_locator?: string | null;
  context_blocks?: number;
  page?: number | null;
  occurrence?: number | null;
  /** The instrument a provision is of, where the PDF prints several. */
  instrument?: string;
};

/** A unit a PDF lookup returns: its node, and what no node holds: its text as the lookup reads it, how far its pages'
 *  text is trusted, a numbered paragraph's other printings, a note's count of its label's printings up to it and the
 *  page its first call stands on. */
export type NativePdfLookupUnit = {
  node: NativeNode;
  text: string;
  /** The pages (from 1) it stands on: its note's first call's, then its node's and its printings'. */
  pages: number[];
  /** The spans of the document's query text its node holds. */
  ranges: NativeSpan[];
  confidence: number | null;
  printings?: NativeNode[];
  occurrence?: number;
  reference_page?: number | null;
};

type PdfStructureLookupBase = {
  schema_version: "legalpdf.structure-lookup.v1";
  requested: NativePdfLookupRequest;
  /** The kind of unit asked for. */
  kind: "page" | "line" | "paragraph" | "footnote" | "section";
  units: NativePdfLookupUnit[];
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
  offThread<M extends "groundedProseErrors" | "passageLink" | "citedPassageLink" | "sourceLink">(method: M,
    ...args: Parameters<StructureAddon[M]>): Promise<ReturnType<StructureAddon[M]>>;
  nativeBuildFeatures(): string;
  /** A passage's link on a source's page with the fragments planned against the document (legal-structure). */
  passageLink(document: NativeDocument, request: { url: string; anchor?: string; blockText: string; quotes: string[];
    preferIndependentHtmlBlocks?: boolean; verifiedPdf?: { url: string; pdfOnly?: boolean } | null })
    : { target: string; plan: NativeTextFragmentPlan | null } | null;
  /** The link citing a passage by its anchor, with its paragraph's or provision's fragments where they plan whole. */
  citedPassageLink(document: NativeDocument, url: string, pinpoints: readonly string[]): string | null;
  /** The link a passage of an A2AJ document is routed to: the publisher's where its page prints an anchor for the
   *  pinpoint, else CanLII's, else A2AJ Law Web's (legal-structure source_link). */
  sourceLink(document: NativeDocument, request: { url?: string; dataset: string; citation: string;
    alternateCitation?: string | null; language?: string; docType?: string;
    locator?: { kind: string; label: string } | null; blockText: string; quotes: string[];
    /** A passage cited without a quotation is linked at the citation's pinpoints (`par12`, `sec6(1)(c)`). */
    pinpoints?: string[]; verifiedPdf?: { url: string; pdfOnly?: boolean } | null }): string | null;
  deriveDocumentStructure(request: unknown): Promise<NativeDocument>;
  deriveDocxDocument(bytes: Buffer, id: string, drafting?: boolean): Promise<NativeDocument>;
  docxText(bytes: Buffer, drafting?: boolean, limit?: number): Promise<string>;
  docxAuthorityTextUnits(bytes: Buffer): Promise<NativeAuthorityTextUnit[]>;
  fixDocxSupraCrossReferences(bytes: Buffer): Promise<{
    bytes: Buffer; detected: number; converted: number; already_linked: number;
    review_required: number; bookmarks_added: number; restarted_numbering: boolean; unsafe_or_split_fields: number;
  }>;
  derivePdfDocument(bytes: Buffer, request: unknown, signal?: AbortSignal): Promise<NativeDocument>;
  /** `progress(recognized, total)` follows text recognition as pages finish. */
  preparePdfDocument(bytes: Buffer, request: unknown, signal?: AbortSignal,
    progress?: (recognized: number, total: number) => void): Promise<PdfPreparationSummary>;
  restorePdfDocument(request: unknown): Promise<NativeDocument | null>;
  pdfDocumentSummary(document: NativeDocument): PdfPreparationSummary;
  pdfRecognizedText(document: NativeDocument, pages?: number[]): NativePdfTextPage[] | null;
  pdfPageLabels(document: NativeDocument): Array<string | null>;
  /** Each page's printed number: the structure's, anchored on the first pages of the reports `citations` cite. */
  pdfPageMap(document: NativeDocument, citations: string[]): PdfPageBinding[];
  /** The first pages of the reports `citations` cite. */
  reporterStartPages(citations: string[]): number[];
  /** Every page's text in page order, empty where a page has no exact text. */
  pdfPageTexts(document: NativeDocument): string[];
  /** The page (from 1) of each citation of a Word brief in a PDF saved from it (`pages`, each page's text), by its id:
   *  each unit's citations found among the pages' words in order, body and notes each onward from their last match. */
  briefOccurrencePages(pages: string[], units: Array<{ note: boolean; text: string;
    occurrences: Array<{ id: string; start: number; end: number; text: string }> }>): Record<string, number>;
  pdfAuthorityTextUnits(document: NativeDocument): NativeAuthorityTextUnit[];
  /** Each passage's pages, its lines' rectangles on each, and its quotations placed on them; a passage with no page it
   *  can be read on unavailable. */
  pdfPassageGeometryPages(document: NativeDocument, targets: NativePdfPassageTarget[]): Promise<NativePdfPassageGeometry>;
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
  /** A call of the citation engine's API (legal-citations `api::call_value`): its method and its request as it reads it. */
  citationEngineCall(method: string, request: unknown): unknown;
  /** citationEngineCall, run off the JavaScript thread. */
  citationEngineCallAsync(method: string, request: unknown): Promise<unknown>;
  documentReadingOrder(request: string): Array<[number, number]>;
  citationLookupKeys(texts: string[]): string[];
  /** What the lookup keys are made by: the key version and the alias table ("4:1a2b3c4d5e6f"). */
  citationKeyVersion(): string;
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
  /** The CanLII page, in `language` (English by default), of the first statute or regulation the text cites; null
   *  where none. `consolidated` where it is a statute in force as consolidated (an A2AJ legislation record). */
  canliiLawUrl(text: string, language?: string, consolidated?: boolean): string | null;
  /** Whether the engine's registry routes a court code to CanLII. */
  canliiCourtRoute(court: string): boolean;
  citationOccurrencesInText(text: string): NativeCitationOccurrence[];
  authorityReferencesInText(text: string): NativeAuthorityReferenceOccurrence[];
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
      id?: string }>, compare?: boolean,
    /** Keep what was read of the document for the quotations located in it after: quicker, for the memory it holds. */
    keep?: boolean):
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
  /** One provision of a statute the store holds, as an excerpt of the document `excerpt` describes, or that the store
   *  lacks the provision or the statute. */
  a2ajSection(store: string, lookup: A2AJStoreLookup, section: string, excerpt: { citation: string;
    url: string | null; alternateCitation: string | null; dataset: string; name: string | null }):
    Promise<{ status: "found"; native: NativeDocument } | { status: "missing_provision" | "missing_statute" }>;
  /** The document a record A2AJ's API answered with holds, read and derived as a store's row is; null for a record
   *  without a text or a citation. */
  a2ajRecord(record: unknown, language: "en" | "fr", docType: "cases" | "laws"): Promise<A2AJStoreDocument | null>;
  /** One provision of a statute, from the records A2AJ's API answered a lookup of it with, as an excerpt of the
   *  document `excerpt` describes; null where no record of the collection and address asked for holds its text. */
  a2ajRecordProvision(records: unknown[], lookup: { language: "en" | "fr"; docType: "cases" | "laws"; dataset?: string;
    sourceUrl?: string | null; section: string }, excerpt: { citation: string; url: string | null;
    alternateCitation: string | null; dataset: string; name: string | null }): Promise<NativeDocument | null>;
  /** A record A2AJ's API answered with, as a search lists it; null for one without a citation. */
  a2ajRecordListing(record: unknown, language: "en" | "fr"): { dataset: string; citation: string;
    alternateCitation: string | null; name: string | null; date: string | null; url: string | null;
    snippet: string | null } | null;
  /** The places, among records A2AJ's API answered with, of those answering a citation (by its key or one of
   *  `aliases`), of the collection and at the address asked for. */
  a2ajRecordMatches(records: unknown[], query: { citation: string; dataset?: string; sourceUrl?: string | null;
    aliases?: string[] }): number[];
  /** Each citation's exact aliases and authored forms in the store's inventory; its own key alone where there is
   *  no store. */
  a2ajAliasGroups(store: string, citations: string[]): Array<{ keys: string[]; forms: string[]; ambiguous: boolean }>;
  /** The citation of the one decision the store holds under a style of cause, in a year, of one of `courts` (any
   *  where none): a decision cited by an identifier A2AJ does not carry. Null where none answers, or several. */
  a2ajNamedCase(store: string, named: { name: string; year: string; courts: string[] }): string | null;
  /** Each style of cause compared as its words: the key of the store's names and of CanLII's titles. */
  a2ajNameKeys(names: string[]): string[];
  /** The store's documents answering a search, as a search lists them (never their text); null where there is no
   *  store or it has no full-text indexes. `match` is the query in FTS5's syntax; `operators` whether it uses FTS5's
   *  operators (a plain name search matches every word of `query` in any order). */
  a2ajSearch(store: string, search: { query: string; docType?: "cases" | "laws"; searchType?: "full_text" | "name";
    language?: "en" | "fr"; size?: number; dataset?: string; startDate?: string; endDate?: string;
    sortResults?: "default" | "newest_first" | "oldest_first"; match: string; operators: boolean }): Array<{ dataset: string; citation: string; alternateCitation: string | null; name: string | null;
    date: string | null; url: string | null; snippet: null }> | null;
  /** The id of the one document the store holds under a citation; null where none, or no store. */
  a2ajFind(store: string, lookup: A2AJStoreLookup): number | null;
  /** Every court and jurisdiction in the store, with how many documents each has and the file it was installed
   *  from where the installer recorded it; null where there is no store. */
  a2ajCourts(store: string): Array<{ docType: "cases" | "laws"; court: string; documents: number; sha256: string | null;
    size: number | null; revision: string | null }> | null;
  /** The store's documents with these ids, of a kind, each in the language asked for where it has text in it, else
   *  the other, derived as a2ajDocument derives one: what experiments sample the store by. */
  a2ajStoreDocuments(store: string, ids: number[], docType?: "cases" | "laws", language?: "en" | "fr"):
    Promise<Array<A2AJStoreDocument & { id: number }> | null>;
  /** The same documents' text and provisions as the store holds them, for experiments that read the text itself. */
  a2ajReads(store: string, ids: number[], docType?: "cases" | "laws", language?: "en" | "fr"):
    Array<Omit<A2AJStoreDocument, "native" | "searchNative"> & { id: number; text: string; provisions: Array<[string, string]> | null }> | null;
  /** The decisions citing a decision and what they and journal authors say it stands for, from the graph beside
   *  the A2AJ store at `store` (which gives the decision's keys); null where no graph is built. */
  citatorNoteUp(store: string, request: { citation: string; citedParagraph?: number; size?: number;
    courtScope?: "all" | "scc" | "appellate" | "trial" | "tribunal"; courtCode?: string; sort?: "newest" | "most_discussed" }):
    CitatorNoteUp | null;
  /** How much each citation is cited, by the graph beside the store at `store`; null where none is built. */
  citatorMetrics(store: string, citations: string[]):
    Array<{ citingCases: number; distinctCitingParagraphs: number; occurrences: number } | null> | null;
  readDocumentRange(document: NativeDocument, kind: "paragraph" | "page" | "section" | "footnote", from: string,
    to: string, contextBlocks: number): {
      selected: NativePassage[];
      before: NativePassage[];
      after: NativePassage[];
    } | null;
  smallestContainingDocumentBlock(document: NativeDocument, start: number,
    end: number): NativePassage | null;
  documentHasOrigin(document: NativeDocument, origin: NativeNode["source"]): boolean;
  /** The nodes the query serves, in its order, as readers take them; with `end`, those starting before it. Levels are
   *  one-based. */
  documentAnchors(document: NativeDocument, end?: number): NativeNodeReading[];
  legalSourceViewer(document: NativeDocument, primaryKind: "paragraph" | "section",
    limit?: number): {
      slices: Array<{
        start: number; end: number; text: string;
        anchors: NativeNodeReading[];
        primary: NativeNodeReading | null;
        /** The slice is a heading the structure reads. */
        heading?: boolean;
      }>;
      truncated: boolean;
      documentRevision: string;
    };
  documentTableCells(document: NativeDocument): SpreadsheetCellSpan[];
  /** The document's headings and top-level sections in order; a section sits under the heading before it. */
  documentOutline(document: NativeDocument): NativeOutlineEntry[];
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
      requestedLabel: string; matches: string[]; block: NativePassage | null;
      before: NativePassage[]; after: NativePassage[];
    };
  resolveDocumentAddressSpans(document: NativeDocument, spec: string,
    follow: "none" | "out" | "in" | "both", depth: number):
    | { status: "found"; spans: Array<{ start: number; end: number }> }
    | { status: "invalid" | "no_pages" | "not_found" | "unavailable" |
        "ambiguous" | "not_addressable" };
  graphScope(document: NativeDocument, seed: { locator: string; nodeId?: never } | { nodeId: string; locator?: never }, follow: "none" | "out" | "in" | "both",
    depth: number, includeDescendants: boolean, includeUnits: boolean): {
      seed: NativePassage;
      nodes: Array<NativePassage & { units?: NativePassage[] }>;
      depth: number;
      omissions: NativeGraphScopeOmission[];
    } | null;
  queryPdfDocument(document: NativeDocument, request: NativePdfLookupRequest): PdfStructureLookup;
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

type NativeSpan = { start: number; end: number };

/** A node of a document's structure as the engine writes it (legal-structure-model's StructureNode). */
export type NativeNode = {
  id: string;
  kind: "paragraph" | "prose" | "page" | "section" | "footnote" | "table" | "row" | "cell";
  /** As the document prints it: "12" of a paragraph, a page or a note; none for prose. */
  label?: string;
  range: NativeSpan;
  ranges?: NativeSpan[];
  rendered_range?: NativeSpan;
  rendered_ranges?: NativeSpan[];
  level?: number;
  parent_id: string | null;
  source: "native" | "heuristic";
  anchor?: string;
  aliases?: string[];
  marker_range?: NativeSpan;
  row_span?: number;
  column_span?: number;
  role?: string;
  extent?: NativeSpan[];
  page_indexes?: number[];
  /** Where a note is called. */
  calls?: NativeSpan[];
  /** What a reader knows of the node past its kind and place: a note's proposition ("sentence", "passage"). */
  properties?: Record<string, string>;
};

/** A node as a reader takes it (legal-structure-model's `NodeReading`), what the structure reads of it beside it: the
 *  spans of the document's query text it holds and their envelope, its link fragment ("par12"), and whether it prints
 *  its label where it stands. */
export type NativeNodeReading = { node: NativeNode; ranges: NativeSpan[]; span: NativeSpan; fragment?: string;
  prints_label: boolean };

/** A node the query found, as a reader takes it, with its text. */
export type NativePassage = NativeNodeReading & { text: string };

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
  return await native.pdfPassageGeometryPages(document, targets);
}
