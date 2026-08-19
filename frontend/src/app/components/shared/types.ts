export interface Folder {
  id: string;
  name: string;
  parent_folder_id: string | null;
}
export interface LibraryFolder extends Folder {
  library_kind: "file" | "template";
}
export interface Project {
  id: string;
  user_id: string;
  is_owner?: boolean;
  owner_display_name?: string | null;
  owner_email?: string | null;
  name: string;
  cm_number: string | null;
  practice: string | null;
  shared_with: string[];
  created_at: string;
  documents?: Document[];
  folders?: Folder[];
}
export interface Document {
  id: string;
  user_id?: string;
  project_id: string | null;
  folder_id?: string | null;
  library_kind?: "file" | "template";
  filename: string;
  owner_email?: string | null;
  owner_display_name?: string | null;
  file_type: string | null; // pdf | docx | doc | xlsx | xlsm | xls | pptx | ppt
  pdf_storage_path: string | null;
  size_bytes: number | null;
  page_count: number | null;
  parse_state?: {
    status: "queued" | "parsing" | "ready" | "degraded" | "failed" | "cancelled";
    phase?: "inspecting" | "extracting" | "ocr";
    pages?: number[];
    error?: string;
  } | null;
  created_at: string | null;
  updated_at?: string | null;
  current_version_id?: string | null;
  active_version_number?: number | null;
}
export interface Chat {
  id: string;
  project_id: string | null;
  user_id: string;
  transcript_version?: number;
  turn_in_progress?: boolean;
  creator_display_name?: string | null;
  title: string | null;
  created_at: string;
  deleted_at?: string | null;
}
export interface EditAnnotation {
  edit_id: string;
  document_id: string;
  version_id: string;
  version_number?: number | null;
  del_w_id?: string;
  ins_w_id?: string;
  deleted_text: string;
  inserted_text: string;
  context_before?: string;
  context_after?: string;
  reason?: string;
  diff: {
    kind: "equal" | "delete" | "insert";
    text: string;
  }[];
  status: "pending" | "accepted" | "rejected";
}
export type EditResolveStart = {
  editId: string;
  documentId: string;
  verb: "accept" | "reject";
};
export type EditResolved = {
  editId: string;
  documentId: string;
  status: "accepted" | "rejected";
  versionId: string | null;
  downloadUrl: string | null;
};
export type EditResolveError = {
  editId: string;
  documentId: string;
  versionId: string | null;
  message: string;
};
export interface EditResolveHandlers {
  onResolveStart?: (args: EditResolveStart) => void;
  onResolved?: (args: EditResolved) => void;
  onError?: (args: EditResolveError) => void;
}
export type AutomationToolName =
  | "create_table_of_authorities"
  | "fix_docx_supras";
export type AutomationRunEvent = {
  type: "automation_run";
  id: string;
  tool: AutomationToolName;
  status: string;
  stage: string;
  progress?: number;
  message?: string;
  counts?: { label: string; value: number }[];
  error?: string;
  outputs?: { name: string; url?: string }[];
  app_url?: string;
  job_id?: string;
  document_id?: string;
  version_id?: string;
  version_number?: number | null;
};
export type ToolActivitySource = {
  provider: string;
  jurisdiction: string;
  citation: string;
  name: string | null;
  dataset: string;
  url: string | null;
  clusterId?: number;
  locator?: string;
  quote?: string;
};
export type AskInputsEvent = {
  type: "ask_inputs";
  items: (
    | {
        id: string;
        kind: "choice";
        question: string;
        options: { value: string }[];
        allow_other: boolean;
        other_label: string;
        response_prefix?: string;
      }
    | {
        id: string;
        kind: "documents";
        document_types: string[];
        response_prefix?: string;
      }
  )[];
};
export type AskInputsResponseEvent = {
  type: "ask_inputs_response";
  responses: (
    | {
        id: string;
        kind: "choice";
        question: string;
        answer?: string;
        skipped?: boolean;
      }
    | {
        id: string;
        kind: "documents";
        filenames: string[];
        documents?: { document_id: string; filename: string }[];
        skipped?: boolean;
      }
  )[];
};
export type CaseOpinionsEvent = {
  type: "case_opinions";
  cluster_id: number;
  case: {
    id: number | null;
    caseName?: string | null;
    dateFiled?: string | null;
    citations?: string[];
    url?: string | null;
    pdfUrl?: string | null;
    opinions: {
      opinionId: number | null;
      apiUrl?: string | null;
      type: string | null;
      author: string | null;
      url: string | null;
      text?: string | null;
    }[];
  };
};
export type CaseCitationEvent = {
  type: "case_citation";
  cluster_id: number | null;
  case_name: string | null;
  citation: string | null;
  url: string;
  pdfUrl?: string | null;
  dateFiled?: string | null;
  case?: CaseOpinionsEvent["case"];
};
export type CaseCitationQuote = {
  opinionId: number | null;
  type: string | null;
  author: string | null;
  quote: string;
};
export interface Message {
  id?: string;
  role: "user";
  content: string;
  files?: { filename: string; document_id?: string }[];
  workflow?: { id: string; title: string };
  model?: string;
  reasoningEffort?: string;
  editMode?: "manual" | "auto";
  turnId?: string;
}
export interface CitationQuote {
  page?: number;
  quote: string;
}
type DocumentCitationQuote = {
  page?: number | string;
  quote: string;
  sheet?: string;
  cell?: string;
};
type CitationDisplay = {
  display_form?: "full" | "pinpoint" | "supra";
  source_class?: "case" | "legislation" | "commentary";
  external_url?: string | null;
  authority?: string;
  short_authority?: string;
  locator_separator?: " at " | ", ";
};
export type DocumentCitation = CitationDisplay & {
  type: "citation_data";
  kind?: "document";
  ref: number;
  document_id: string;
  version_id?: string | null;
  version_number?: number | null;
  filename: string;
  quotes: DocumentCitationQuote[];
  locator_kind?: "paragraph" | "page" | "section" | "footnote";
  locator?: string | null;
  pinpoint?: string | null;
};
type LegalCitationLocator = {
  locator_kind?: "paragraph" | "page" | "section" | "footnote";
  locator?: string | null;
  pinpoint?: string | null;
} & CitationDisplay;
export type CaseCitation = LegalCitationLocator & {
  type: "citation_data";
  kind: "case";
  ref: number;
  cluster_id: number;
  case_name?: string | null;
  citation?: string | null;
  url?: string | null;
  pdfUrl?: string | null;
  dateFiled?: string | null;
  quotes: CaseCitationQuote[];
};
type A2AJCitation = LegalCitationLocator & {
  type: "citation_data";
  kind: "a2aj";
  ref: number;
  citation?: string | null;
  name?: string | null;
  dataset?: string | null;
  url?: string | null;
  quotes: { quote: string }[];
};
type PublicLegalCitation = LegalCitationLocator & {
  type: "citation_data";
  kind: "public_legal";
  ref: number;
  provider: "tna" | "govuk-et" | "govinfo" | "journal";
  identifier: string;
  title?: string | null;
  citation?: string | null;
  url?: string | null;
  quotes: { quote: string }[];
};
export type TabularCitation = CitationDisplay & {
  type: "citation_data";
  kind: "tabular";
  ref: number;
  review_id: string;
  col_index: number;
  row_index: number;
  col_name: string;
  doc_name: string;
  quotes: { quote: string }[];
};
export type Citation =
  | DocumentCitation
  | CaseCitation
  | A2AJCitation
  | PublicLegalCitation
  | TabularCitation;
const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";
export const isSpreadsheetFilename = (filename: string) =>
  /\.(xlsx|xlsm|xls)$/i.test(filename);
export const isDocxFilename = (filename: string) =>
  /\.(docx|doc)$/i.test(filename);
function formatCellLocator(sheet?: string, cell?: string): string {
  if (sheet && cell) return `${sheet}!${cell}`;
  return cell ?? sheet ?? "";
}
function expandDocumentQuoteEntry(entry: DocumentCitationQuote): CitationQuote[] {
  const rangeMatch =
    typeof entry.page === "string"
      ? entry.page.match(/^(\d+)\s*-\s*(\d+)$/)
      : null;
  if (rangeMatch && entry.quote.includes(PAGE_BREAK_SENTINEL)) {
    const startPage = parseInt(rangeMatch[1], 10);
    const endPage = parseInt(rangeMatch[2], 10);
    const [before, after] = entry.quote.split(PAGE_BREAK_SENTINEL);
    return [
      { page: startPage, quote: before.trim() },
      { page: endPage, quote: after.trim() },
    ].filter((e) => e.quote.length > 0);
  }
  const pageNum =
    typeof entry.page === "number"
      ? entry.page
      : parseInt(String(entry.page), 10);
  return Number.isFinite(pageNum)
    ? [{ page: pageNum, quote: entry.quote }]
    : [{ quote: entry.quote }];
}
function isDocumentCitation(citation: Citation): citation is DocumentCitation {
  return citation.kind == null || citation.kind === "document";
}
export function getDocumentCitationQuotes(a: Citation): DocumentCitationQuote[] {
  return isDocumentCitation(a)
    ? a.quotes.filter((entry) => entry.quote.trim().length > 0)
    : [];
}
export function expandCitationToEntries(
  a: Citation,
): CitationQuote[] {
  return getDocumentCitationQuotes(a).flatMap(expandDocumentQuoteEntry);
}
export function formatCitationPage(a: Citation): string {
  if (a.kind === "case") {
    return a.citation || a.case_name || `Case ${a.cluster_id}`;
  }
  if (a.kind === "a2aj") return a.citation || a.name || "A2AJ source";
  if (a.kind === "public_legal") {
    return a.title || a.identifier || "Public legal source";
  }
  if (a.kind === "tabular") return `${a.col_name} · ${a.doc_name}`;
  const quotes = getDocumentCitationQuotes(a);
  if (isSpreadsheetFilename(a.filename)) {
    const cells = Array.from(
      new Set(
        quotes.map((q) => formatCellLocator(q.sheet, q.cell)).filter(Boolean),
      ),
    );
    return cells.join(", ");
  }
  const pages = Array.from(
    new Set(quotes.map((q) => String(q.page)).filter(Boolean)),
  );
  if (pages.length > 1) return `Pages ${pages.join(", ")}`;
  if (pages.length === 1) return `Page ${pages[0]}`;
  return "";
}
export function citationPinpoint(a: Citation): string {
  if (a.kind === "case" || a.kind === "a2aj" || a.kind === "public_legal") {
    return a.pinpoint?.trim() ?? "";
  }
  if (a.kind === "tabular") return a.col_name;
  if (a.pinpoint?.trim()) return a.pinpoint.trim();
  const quotes = getDocumentCitationQuotes(a);
  if (isSpreadsheetFilename(a.filename)) {
    return Array.from(
      new Set(
        quotes.map((q) => formatCellLocator(q.sheet, q.cell)).filter(Boolean),
      ),
    ).join(", ");
  }
  const pages = Array.from(
    new Set(
      quotes.flatMap((q) =>
        q.page === undefined || q.page === null ? [] : [String(q.page)],
      ),
    ),
  );
  if (pages.length === 1)
    return `p. ${pages[0].replace(/\s*-\s*/gu, "\u2013")}`;
  return pages.length > 1 ? `pp. ${pages.join(", ")}` : "";
}
function cleanCitationQuoteText(rawQuote: string): string {
  return rawQuote.replaceAll(PAGE_BREAK_SENTINEL, "...");
}
export function displayCitationQuote(a: Citation): string {
  if (a.kind === "case" || a.kind === "a2aj" || a.kind === "public_legal") {
    return a.quotes
      .map((q) => cleanCitationQuoteText(q.quote))
      .join(" / ");
  }
  return getDocumentCitationQuotes(a)
    .map((q) => cleanCitationQuoteText(q.quote))
    .filter(Boolean)
    .join(" / ");
}
export type ColumnFormat =
  | "text"
  | "bulleted_list"
  | "number"
  | "currency"
  | "yes_no"
  | "date"
  | "tag"
  | "percentage"
  | "monetary_amount";
export interface ColumnConfig {
  index: number;
  name: string;
  prompt: string;
  format?: ColumnFormat;
  tags?: string[];
}
export interface TabularReview {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  columns_config: ColumnConfig[] | null;
  shared_with?: string[];
  is_owner?: boolean;
  created_at: string;
  document_count?: number;
  project_name?: string | null;
}
export interface TabularCell {
  id: string;
  document_id: string;
  column_index: number;
  content: {
    summary: string;
    flag?: "green" | "grey" | "yellow" | "red";
    reasoning?: string;
  } | null;
  status: "pending" | "generating" | "done" | "error";
}
export interface Workflow {
  id: string;
  user_id: string | null;
  metadata: {
    title: string;
    description: string | null;
    type: "assistant" | "tabular";
    contributors: {
      name: string;
      organisation: string | null;
      role: string | null;
      linkedin: string | null;
    }[];
    language: string;
    version: string | null;
    practice: string | null;
    jurisdictions: string[] | null;
  };
  skill_md: string | null;
  columns_config: ColumnConfig[] | null;
  is_system: boolean;
  shared_by_name?: string | null;
  allow_edit?: boolean;
  is_owner?: boolean;
}
