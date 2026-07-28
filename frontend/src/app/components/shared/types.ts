// Shared TypeScript types for Beaver AI legal assistant

export interface Folder {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LibraryFolder {
  id: string;
  user_id: string;
  library_kind: "file" | "template";
  name: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
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
  updated_at: string;
  documents?: Document[];
  folders?: Folder[];
  document_count?: number;
  chat_count?: number;
  review_count?: number;
}

export type PdfParseStatus =
  | "queued"
  | "parsing"
  | "ready"
  | "degraded"
  | "failed";

export interface PdfParseState {
  schema_version: "mike.pdf_parse.v1";
  job_id: string;
  document_id: string;
  version_id: string;
  status: PdfParseStatus;
  source_path: string;
  source_sha256: string;
  parser_version: string;
  parser_config_version: string;
  parser_config: {
    mode: "local" | "codex";
    ocr_provider: "tesseract" | null;
    ocr_identity?: string;
    ocr_language?: string;
    ocr_dpi?: number;
    ocr_psm?: number;
    model: string | null;
    effort?: string | null;
    prompt_version: string | null;
    response_schema_sha256?: string | null;
    repairable_diagnostics_sha256?: string | null;
    repairable_diagnostics?: string[];
    context_radius?: number | null;
    max_attempts?: number | null;
    max_live_calls?: number | null;
    max_scope_pages?: number | null;
    text_fidelity_root: string | null;
    text_fidelity_native: false;
  };
  repair_contract?: {
    schema_version: "legalpdf.codex.repair-identity.v1";
    prompt_version: string;
    response_schema_sha256: string;
    repairable_diagnostics_sha256: string;
    repairable_diagnostics: string[];
    context_radius: number;
    max_attempts: number;
    max_live_calls: number;
    max_scope_pages: number;
  };
  cache_key: string;
  artifact_manifest: string;
  attempts: number;
  queued_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  interrupted_at?: string;
  engine_status?: string;
  cache_hit?: boolean;
  page_count?: number;
  counts?: Record<string, number>;
  diagnostic_count?: number;
  diagnostic_summary?: {
    by_severity: Record<string, number>;
    by_code: Record<string, number>;
  };
  structural_repair_available?: boolean;
  error?: string;
  flat_text_fallback_available: true;
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
  structure_tree: StructureNode[] | null;
  status: "pending" | "processing" | "ready" | "error";
  created_at: string | null;
  updated_at?: string | null;
  current_version_id?: string | null;
  /** Version number of the document row pointed to by current_version_id. */
  active_version_number?: number | null;
  /** Returned immediately by local PDF uploads; later state is read on demand. */
  pdf_parse?: PdfParseState | null;
}

export interface StructureNode {
  id: string;
  title: string;
  level: number;
  page_number: number | null;
  children: StructureNode[];
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
  /** Per-document monotonic Vn for the edit's target version. */
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

export type AssistantEvent =
  | { type: "reasoning"; text: string; isStreaming?: boolean }
  | { type: "error"; message: string }
  | {
      type: "tool_call_start";
      name: string;
      isStreaming?: boolean;
    }
  | {
      type: "mcp_tool_call";
      connector_id: string;
      connector_name: string;
      tool_name: string;
      openai_tool_name: string;
      status: "ok" | "error";
      error?: string;
      isStreaming?: boolean;
    }
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
  | { type: "thinking"; isStreaming?: boolean }
  | {
      type: "doc_read";
      filename: string;
      document_id?: string;
      isStreaming?: boolean;
    }
  | {
      type: "doc_find";
      filename: string;
      query: string;
      total_matches: number;
      isStreaming?: boolean;
    }
  | {
      type: "doc_created";
      filename: string;
      download_url: string;
      /** Set when the generated doc is persisted as a first-class document. */
      document_id?: string;
      version_id?: string;
      version_number?: number | null;
      isStreaming?: boolean;
    }
  | { type: "doc_download"; filename: string; download_url: string }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
      type: "doc_edited";
      filename: string;
      document_id: string;
      version_id: string;
      /** Per-document monotonic Vn written at emit time. */
      version_number?: number | null;
      download_url: string;
      annotations: EditAnnotation[];
      error?: string;
      isStreaming?: boolean;
    }
  | {
      type: "courtlistener_search_case_law";
      query: string;
      result_count?: number;
      error?: string;
      isStreaming?: boolean;
    }
  | {
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
      isStreaming?: boolean;
    }
  | {
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
      isStreaming?: boolean;
    }
  | {
      type: "courtlistener_read_case";
      cluster_id: number | null;
      case_name?: string | null;
      citation?: string | null;
      opinion_count?: number;
      error?: string;
      isStreaming?: boolean;
    }
  | {
      type: "courtlistener_verify_citations";
      citation_count?: number;
      match_count?: number;
      error?: string;
      isStreaming?: boolean;
    }
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
  | AutomationRunEvent
  | { type: "content"; text: string; isStreaming?: boolean };

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
  /** Set when streaming failed; rendered as a red error block. */
  error?: string;
}

export interface CitationQuote {
  page?: number;
  quote: string;
}

export type DocumentCitationQuote = {
  page?: number | string;
  quote: string;
  /**
   * Spreadsheet citations are located by cell, not page: `sheet` is the
   * worksheet name and `cell` is an A1 address or range (e.g. "B7", "B7:C9").
   */
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
  version_number?: number | null;
  filename: string;
  quotes: DocumentCitationQuote[];
};

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

export type A2AJCitation = {
  type: "citation_data";
  kind: "a2aj";
  ref: number;
  citation?: string | null;
  name?: string | null;
  dataset?: string | null;
  url?: string | null;
  quotes: { quote: string }[];
};

export type PublicLegalCitation = {
  type: "citation_data";
  kind: "public_legal";
  ref: number;
  provider: "tna" | "govuk-et" | "govinfo" | "journal";
  identifier: string;
  title?: string | null;
  url?: string | null;
  quotes: { quote: string }[];
};

/**
 * A citation emitted by the assistant. Document citations have doc/page
 * anchors. Case citations anchor to a CourtListener cluster and include a
 * quoted opinion passage.
 */
export type Citation =
  | DocumentCitation
  | CaseCitation
  | A2AJCitation
  | PublicLegalCitation;

const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";

export function isSpreadsheetFilename(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext === "xlsx" || ext === "xlsm" || ext === "xls";
}

export function isDocxFilename(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext === "docx" || ext === "doc";
}

/**
 * Human-readable cell locator for a spreadsheet citation, e.g. "Sheet1!B7".
 * Falls back to whichever of `sheet`/`cell` is present.
 */
function formatCellLocator(sheet?: string, cell?: string): string {
  if (sheet && cell) return `${sheet}!${cell}`;
  return cell ?? sheet ?? "";
}

/**
 * Reader-friendly cell locator, e.g. "Sheet1, cell B7" (or "cells B7:C9" for a
 * range). Unlike `formatCellLocator`, this avoids the Excel `!` notation, which
 * reads poorly in prose. Used for the single-quote detail shown to the reader;
 * the machine-style `Sheet1!B7` form is kept where locators are joined together.
 */
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

export function getDocumentCitationQuotes(
  a: Citation,
): DocumentCitationQuote[] {
  if (
    a.kind === "case" ||
    a.kind === "a2aj" ||
    a.kind === "public_legal"
  )
    return [];
  return a.quotes.filter((entry) => entry.quote.trim().length > 0);
}

/**
 * Expand a citation into one or more (page, quote) entries suitable for
 * highlighting in the PDF viewer. A single-page citation yields one entry; a
 * cross-page citation with page "N-M" and a `[[PAGE_BREAK]]` split yields two.
 */
export function expandCitationToEntries(
  a: Citation,
): CitationQuote[] {
  if (
    a.kind === "case" ||
    a.kind === "a2aj" ||
    a.kind === "public_legal"
  )
    return [];
  return getDocumentCitationQuotes(a).flatMap(expandDocumentQuoteEntry);
}

/**
 * Format the page(s) of a citation for display, e.g. "Page 3" or "Page 41-42".
 * Spreadsheets have no meaningful page locator, so this returns "" for them —
 * callers join with `.filter(Boolean)` so the locator is simply omitted.
 */
export function formatCitationPage(a: Citation): string {
  if (a.kind === "case") {
    return a.citation || a.case_name || `Case ${a.cluster_id}`;
  }
  if (a.kind === "a2aj") return a.citation || a.name || "A2AJ source";
  if (a.kind === "public_legal") {
    return a.title || a.identifier || "Public legal source";
  }
  const quotes = getDocumentCitationQuotes(a);
  // Spreadsheets are located by cell, e.g. "Sheet1!B7" (or several).
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

/** Locator label for a single quote — "Page 3" for docs, "Sheet1, cell B7" for cells. */
export function formatCitationQuotePage(
  a: Citation,
  page: number | string | undefined,
  quote?: DocumentCitationQuote,
): string {
  if (a.kind === "public_legal") return "Source";
  if (
    a.kind !== "case" &&
    a.kind !== "a2aj" &&
    isSpreadsheetFilename(a.filename)
  ) {
    return formatCellLocatorReadable(quote?.sheet, quote?.cell);
  }
  return page == null ? "" : `Page ${page}`;
}

/**
 * Reader-friendly version of a single raw quote: replaces [[PAGE_BREAK]] with
 * "...". Spreadsheet quotes now carry plain cell values, so no stripping.
 */
export function cleanCitationQuoteText(rawQuote: string): string {
  return rawQuote.replaceAll(PAGE_BREAK_SENTINEL, "...");
}

/** Produce a reader-friendly version of the quote (replaces [[PAGE_BREAK]] with "..."). */
export function displayCitationQuote(a: Citation): string {
  if (a.kind === "case" || a.kind === "a2aj" || a.kind === "public_legal") {
    return a.quotes
      .map((q) => q.quote.replaceAll(PAGE_BREAK_SENTINEL, "..."))
      .join(" / ");
  }
  return getDocumentCitationQuotes(a)
    .map((q) => cleanCitationQuoteText(q.quote))
    .filter(Boolean)
    .join(" / ");
}

// Tabular Review

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
  /** Per-review email list. Used so standalone (project_id null) reviews can be shared directly. */
  shared_with?: string[];
  /** Server-set: true when the requesting user is the review's creator. */
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

// Workflows

export interface WorkflowOpenSourceSubmission {
  id: string;
  status: "pending" | "approved" | "rejected";
  submitted_at: string;
  updated_at: string;
  reviewed_at?: string | null;
}

export interface OpenSourceWorkflowResponse
  extends WorkflowOpenSourceSubmission {
  mode: "created" | "updated";
}

export type OpenSourceWorkflowContributorMode = "named" | "anonymous";

export interface WorkflowContributor {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
}

export interface Workflow {
  id: string;
  user_id: string | null;
  metadata: {
    title: string;
    description: string | null;
    type: "assistant" | "tabular";
    contributors: WorkflowContributor[];
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
  open_source_submission?: WorkflowOpenSourceSubmission | null;
}

// API helpers

export interface ChatDetailOut {
  chat: Chat;
  messages: Message[];
}

export interface TabularReviewDetailOut {
  review: TabularReview;
  cells: TabularCell[];
  documents: Document[];
}
