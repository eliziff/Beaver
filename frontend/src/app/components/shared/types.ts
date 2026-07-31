export interface Folder {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface LibraryFolder extends Omit<Folder, "project_id"> {
  library_kind: "file" | "template";
}
interface WorkMetadata {
  jurisdiction: string | null;
  areas_of_law: string[];
  document_types: string[];
  description: string | null;
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
  metadata?: WorkMetadata;
  notes?: string | null;
  shared_with: string[];
  created_at: string;
  updated_at: string;
  documents?: Document[];
  folders?: Folder[];
  document_count?: number;
  chat_count?: number;
  review_count?: number;
}
export interface Document {
  id: string;
  user_id?: string;
  project_id: string | null;
  folder_id?: string | null;
  library_kind?: "file" | "template";
  library_folder_id?: string | null;
  filename: string;
  owner_email?: string | null;
  owner_display_name?: string | null;
  file_type: string | null; // pdf | docx | doc | xlsx | xlsm | xls | pptx | ppt
  storage_path: string | null;
  pdf_storage_path: string | null;
  size_bytes: number | null;
  page_count: number | null;
  structure_tree: unknown[] | null;
  status: "pending" | "processing" | "ready" | "error";
  /**
   * Structural PDF parse lifecycle, denormalized from the durable parse
   * job (local lane). null / absent = no parse lane (non-PDF versions,
   * cloud lane). The original PDF remains authoritative and the compact
   * structural source can be rebuilt from it.
   */
  parse_state?: {
    status: "queued" | "parsing" | "ready" | "degraded" | "failed";
    error: string | null;
    attempts: number;
    queued_at: string;
    updated_at: string;
    completed_at: string | null;
    engine_status: string | null;
    page_count: number | null;
    diagnostic_count: number | null;
    structural_repair_available: boolean;
  } | null;
  created_at: string | null;
  updated_at?: string | null;
  current_version_id?: string | null;
  active_version_number?: number | null;
  metadata?: WorkMetadata;
  notes?: string | null;
}
export interface Chat {
  id: string;
  project_id: string | null;
  user_id: string;
  transcript_version?: number;
  creator_display_name?: string | null;
  title: string | null;
  created_at: string;
  deleted_at?: string | null;
}
export interface EditAnnotation {
  type?: "edit_data";
  kind?: "edit";
  edit_id: string;
  document_id: string;
  version_id: string;
  version_number?: number | null;
  change_id: string;
  del_w_id?: string;
  ins_w_id?: string;
  deleted_text: string;
  inserted_text: string;
  context_before?: string;
  context_after?: string;
  reason?: string;
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
  | "toa_submit_library_document"
  | "toa_job_status"
  | "library_fix_docx_supras"
  | "library_link_docx_citations";
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
type Streamable<T> = T & { isStreaming?: boolean };
export type AssistantEvent =
  | Streamable<{ type: "reasoning"; text: string }>
  | { type: "error"; message: string }
  | Streamable<{
      type: "tool_call_start";
      name: string;
      label?: string;
    }>
  | Streamable<{
      type: "mcp_tool_call";
      connector_id: string;
      connector_name: string;
      tool_name: string;
      openai_tool_name: string;
      status: "ok" | "error";
      error?: string;
    }>
  | {
      type: "ask_inputs";
      items: (
        | {
            id: string;
            kind: "choice";
            question: string;
            options: {
              value: string;
            }[];
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
    }
  | {
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
    }
  | Streamable<{ type: "thinking" }>
  | Streamable<{
      type: "doc_read";
      filename: string;
      document_id?: string;
    }>
  | Streamable<{
      type: "doc_find";
      filename: string;
      query: string;
      total_matches: number;
    }>
  | Streamable<{
      type: "doc_created";
      filename: string;
      download_url: string;
      document_id?: string;
      version_id?: string;
      version_number?: number | null;
    }>
  | { type: "doc_download"; filename: string; download_url: string }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | Streamable<{
      type: "doc_edited";
      filename: string;
      document_id: string;
      version_id: string;
      version_number?: number | null;
      download_url: string;
      annotations: EditAnnotation[];
      error?: string;
    }>
  | Streamable<{
      type: "courtlistener_search_case_law";
      query: string;
      result_count?: number;
      error?: string;
    }>
  | Streamable<{
      type: "courtlistener_get_cases";
      cluster_ids: number[];
      case_count?: number;
      opinion_count?: number;
      cases?: {
        cluster_id: number;
        case_name: string | null;
        citation: string | null;
        dateFiled?: string | null;
        url?: string | null;
      }[];
      error?: string;
    }>
  | Streamable<{
      type: "courtlistener_find_in_case";
      cluster_id: number | null;
      query: string;
      total_matches?: number;
      case_name?: string | null;
      citation?: string | null;
      searches?: {
        cluster_id: number | null;
        query: string;
        total_matches?: number;
        case_name?: string | null;
        citation?: string | null;
        error?: string;
      }[];
      error?: string;
    }>
  | Streamable<{
      type: "courtlistener_read_case";
      cluster_id: number | null;
      case_name?: string | null;
      citation?: string | null;
      opinion_count?: number;
      error?: string;
    }>
  | Streamable<{
      type: "courtlistener_verify_citations";
      citation_count?: number;
      match_count?: number;
      error?: string;
    }>
  | {
      type: "case_citation";
      cluster_id: number | null;
      case_name: string | null;
      citation: string | null;
      url: string;
      pdfUrl?: string | null;
      dateFiled?: string | null;
      case?: Extract<AssistantEvent, { type: "case_opinions" }>["case"];
    }
  | {
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
          html?: string | null;
        }[];
      };
    }
  | Streamable<{
      type: "legal_evidence_receipt";
      schema_version: 4 | 5 | 6;
      mode:
        | "citation_structure"
        | "compose_check"
        | "evidence_first"
        | "holistic_check"
        | "tiered_check";
      status: "passed" | "failed";
      verification: {
        reference: "verified";
        answerability: "sufficient" | "insufficient" | "not_run";
        holistic:
          | "supported"
          | "partially_supported"
          | "unsupported"
          | "not_run";
        semantic: "model_checked" | "failed" | "not_run";
        coverage: "complete" | "incomplete" | "not_run";
        authority: "not_run";
      };
      claims: {
        text: string;
        evidence_ids: string[];
        text_sha256: string;
        context_status: "preserved" | "changed" | "ambiguous" | "not_run";
        evidence_status:
          | "supported"
          | "contradicted"
          | "insufficient"
          | "not_run";
      }[];
      evidence: unknown[];
      failure: string | null;
    }>
  | AutomationRunEvent
  | Streamable<{ type: "content"; text: string }>;
export type CaseCitationQuote = {
  opinionId: number | null;
  type: string | null;
  author: string | null;
  quote: string;
};
export interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  files?: { filename: string; document_id?: string }[];
  workflow?: { id: string; title: string };
  model?: string;
  reasoningEffort?: string;
  citations?: Citation[];
  citationStatus?: "started" | "partial" | "final";
  events?: AssistantEvent[];
  error?: string;
}
export interface CitationQuote {
  page?: number;
  quote: string;
}
type DocumentCitationQuote = {  page?: number | string;  quote: string;
  sheet?: string;
  cell?: string;
};
export type DocumentCitation = {
  type: "citation_data";
  kind?: "document";
  ref: number;
  doc_id: string;
  document_id: string;
  version_id?: string | null;
  version_number?: number | null;  filename: string;  quotes: DocumentCitationQuote[];};
export type CaseCitation = {
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
type A2AJCitation = {
  type: "citation_data";
  kind: "a2aj";
  ref: number;
  citation?: string | null;
  name?: string | null;
  dataset?: string | null;
  url?: string | null;
  quotes: { quote: string }[];
};
type PublicLegalCitation = {
  type: "citation_data";
  kind: "public_legal";
  ref: number;
  provider: "tna" | "govuk-et" | "govinfo" | "journal";
  identifier: string;
  title?: string | null;
  url?: string | null;
  quotes: { quote: string }[];
};
export type Citation =
  | DocumentCitation
  | CaseCitation
  | A2AJCitation
  | PublicLegalCitation;
const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";
export const isSpreadsheetFilename = (filename: string) =>
  /\.(xlsx|xlsm|xls)$/i.test(filename);
export const isDocxFilename = (filename: string) =>
  /\.(docx|doc)$/i.test(filename);
function formatCellLocator(sheet?: string, cell?: string): string {
  if (sheet && cell) return `${sheet}!${cell}`;
  return cell ?? sheet ?? "";
}
function formatCellLocatorReadable(sheet?: string, cell?: string): string {
  if (!cell) return sheet ?? "";
  const cellWord = cell.includes(":") ? "cells" : "cell";
  const cellPart = `${cellWord} ${cell}`;
  return sheet ? `${sheet}, ${cellPart}` : cellPart;
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
  if (!Number.isFinite(pageNum)) return [];
  return [{ page: pageNum, quote: entry.quote }];
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
  return "";}
export function formatCitationQuotePage(
  a: Citation,
  page: number | string | undefined,  quote?: DocumentCitationQuote,
): string {
  if (a.kind === "public_legal") return "Source";
  if (isDocumentCitation(a) && isSpreadsheetFilename(a.filename)) {
    return formatCellLocatorReadable(quote?.sheet, quote?.cell);
  }
  return page == null ? "" : `Page ${page}`;}
export function cleanCitationQuoteText(rawQuote: string): string {  return rawQuote.replaceAll(PAGE_BREAK_SENTINEL, "...");
}
export function displayCitationQuote(a: Citation): string {  if (a.kind === "case" || a.kind === "a2aj" || a.kind === "public_legal") {    return a.quotes      .map((q) => q.quote.replaceAll(PAGE_BREAK_SENTINEL, "..."))      .join(" / ");  }
  return getDocumentCitationQuotes(a)    .map((q) => cleanCitationQuoteText(q.quote))    .filter(Boolean)
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
  document_ids?: string[] | null;
  workflow_id: string | null;
  practice?: string | null;
  shared_with?: string[];
  is_owner?: boolean;
  created_at: string;
  updated_at: string;
  document_count?: number;
}
export interface TabularCell {
  id: string;
  review_id: string;
  document_id: string;
  column_index: number;
  content: {
    summary: string;
    flag?: "green" | "grey" | "yellow" | "red";
    reasoning?: string;
  } | null;
  status: "pending" | "generating" | "done" | "error";
  created_at: string;
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
  created_at: string;
  shared_by_name?: string | null;
  allow_edit?: boolean;
  is_owner?: boolean;
}
