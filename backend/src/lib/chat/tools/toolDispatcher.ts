import {
  getCourtlistenerOpinionDocumentText,
  getCourtlistenerCases,
  lookupCourtlistenerOpinionLocator,
  searchCourtlistenerCaseLaw,
  verifyCourtlistenerCitations,
} from "../../courtlistener";
import {
  COURTLISTENER_TOOL_NAMES,
  type CaseCitationEvent,
  type CourtlistenerToolEvent,
} from "./courtlistenerTools";
import { A2AJ_TOOL_NAMES } from "./a2ajTools";
import { PUBLIC_LEGAL_SOURCE_TOOL_NAMES } from "./publicLegalSourceTools";
import {
  fetchA2AJDocument,
  lookupA2AJLocator,
  searchA2AJ,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "../../a2aj";
import {
  createPublicLegalSourceState,
  executePublicLegalSourceTool,
  type PublicLegalSourceState,
} from "../publicLegalSourceState";
import { executeMcpToolCall, type McpToolEvent } from "../../mcpConnectors";
import { createServerSupabase } from "../../supabase";
import {
  type DocStore,
  type DocIndex,
  type TabularCellStore,
  type WorkflowStore,
  type ToolCall,
  type AskInputItem,
  type AskInputOption,
  type AskInputsEvent,
  devLog,
  resolveDocLabel,
} from "../types";
import { type EditInput } from "../../docxTrackedChanges";
import { resolveDocxEvidenceCitations } from "../../docxEvidenceCitations";
import { appUrl } from "../../appRoutes";
import {
  citationReminder,
  generateDocx,
  generateExcel,
  generatePpt,
  getTurnReadIdentity,
  duplicateReadDocumentResult,
  clearTurnReadsForDocument,
  readDocumentContent,
  findInDocumentContent,
  findTextMatches,
  runEditDocument,
  safeGeneratedFilename,
  type DocEditedResult,
  type TurnEditState,
  type TurnReadState,
  type DocCreatedResult,
  type TextMatch,
} from "./documentOps";

type CourtlistenerCaseRecord = {
  clusterId: number;
  caseName: string | null;
  citations: string[];
  url: string | null;
  pdfUrl: string | null;
  dateFiled: string | null;
  opinions?: unknown[];
};

type CourtlistenerCaseInput = {
  clusterId?: number | null;
  caseName?: string | null;
  citation?: string | null;
  citations?: string[];
  url?: string | null;
  pdfUrl?: string | null;
  dateFiled?: string | null;
  opinions?: unknown[];
};

export type CourtlistenerTurnState = {
  casesByClusterId: Map<number, CourtlistenerCaseRecord>;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanAskInputString(value: unknown, fallback = ""): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

export function normalizeAskInputsEvent(
  args: Record<string, unknown>,
): AskInputsEvent {
  const rawItems = Array.isArray(args.items) ? args.items : [];
  const seenIds = new Set<string>();
  const items = rawItems
    .map((item, index): AskInputItem | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const id =
        cleanAskInputString(row.id) ||
        `${row.kind === "documents" ? "documents" : "choice"}-${index + 1}`;
      const responsePrefix = cleanAskInputString(row.response_prefix);

      if (row.kind === "documents") {
        const rawDocumentTypes = Array.isArray(row.document_types)
          ? row.document_types
          : [];
        const documentTypes = rawDocumentTypes
          .filter((type): type is string => typeof type === "string")
          .map((type) => type.trim())
          .filter(Boolean)
          .map((type) => type.slice(0, 300))
          .slice(0, 8);
        return {
          id: id.slice(0, 80),
          kind: "documents",
          document_types: documentTypes,
          ...(responsePrefix
            ? { response_prefix: responsePrefix.slice(0, 200) }
            : {}),
        };
      }

      const question = cleanAskInputString(
        row.question,
        "Please choose an option.",
      );
      const rawOptions = Array.isArray(row.options) ? row.options : [];
      const options = rawOptions
        .map((option): AskInputOption | null => {
          if (!option || typeof option !== "object") return null;
          const optionRow = option as Record<string, unknown>;
          const value =
            cleanAskInputString(optionRow.value) ||
            cleanAskInputString(optionRow.label);
          if (!value) return null;
          return {
            value: value.slice(0, 500),
          };
        })
        .filter((option): option is AskInputOption => !!option)
        .slice(0, 8);
      const normalizedOptions =
        options.length > 0 ? options : [{ value: "Continue" }];
      const otherLabel = cleanAskInputString(row.other_label, "Other");
      return {
        id: id.slice(0, 80),
        kind: "choice",
        question: question.slice(0, 500),
        options: normalizedOptions,
        allow_other: row.allow_other !== false,
        other_label: otherLabel.slice(0, 80),
        ...(responsePrefix
          ? { response_prefix: responsePrefix.slice(0, 200) }
          : {}),
      };
    })
    .filter((item): item is AskInputItem => {
      if (!item || seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    })
    .slice(0, 12);

  return { type: "ask_inputs", items };
}

function upsertCourtlistenerCases(
  state: CourtlistenerTurnState,
  inputs: CourtlistenerCaseInput[],
): CourtlistenerCaseRecord[] {
  const records: CourtlistenerCaseRecord[] = [];
  for (const input of inputs) {
    if (
      typeof input.clusterId !== "number" ||
      !Number.isFinite(input.clusterId)
    ) {
      continue;
    }
    const clusterId = Math.floor(input.clusterId);
    const current = state.casesByClusterId.get(clusterId) ?? {
      clusterId,
      caseName: null,
      citations: [],
      url: null,
      pdfUrl: null,
      dateFiled: null,
    };
    const nextCitations = [
      ...current.citations,
      ...(input.citation ? [input.citation] : []),
      ...(input.citations ?? []),
    ]
      .map(nonEmpty)
      .filter((value): value is string => !!value);
    const record: CourtlistenerCaseRecord = {
      ...current,
      caseName: current.caseName ?? nonEmpty(input.caseName),
      citations: Array.from(new Set(nextCitations)),
      url: current.url ?? nonEmpty(input.url),
      pdfUrl: current.pdfUrl ?? nonEmpty(input.pdfUrl),
      dateFiled: current.dateFiled ?? nonEmpty(input.dateFiled),
      opinions: current.opinions ?? input.opinions,
    };
    state.casesByClusterId.set(clusterId, record);
    records.push(record);
  }
  return records;
}

function caseCitationEventFromRecord(
  record: CourtlistenerCaseRecord,
): CaseCitationEvent | null {
  if (!record.url) return null;
  return {
    type: "case_citation",
    cluster_id: record.clusterId,
    case_name: record.caseName,
    citation: record.citations[0] ?? null,
    url: record.url,
    pdfUrl: record.pdfUrl,
    dateFiled: record.dateFiled,
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function numberField(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

function stringArrayField(
  record: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function courtlistenerCaseInputFromFetchedCase(
  fallbackClusterId: number,
  fetchedCase: unknown,
): CourtlistenerCaseInput {
  const record = recordFromUnknown(fetchedCase);
  const clusterId =
    numberField(record, "clusterId") ??
    numberField(record, "id") ??
    fallbackClusterId;
  return {
    clusterId,
    caseName: stringField(record, "caseName"),
    citations: stringArrayField(record, "citations"),
    url: stringField(record, "url"),
    pdfUrl: stringField(record, "pdfUrl"),
    dateFiled: stringField(record, "dateFiled"),
    opinions: Array.isArray(record?.opinions) ? record.opinions : undefined,
  };
}

function courtlistenerOpinionCount(fetchedCase: unknown): number {
  const record = recordFromUnknown(fetchedCase);
  return Array.isArray(record?.opinions) ? record.opinions.length : 0;
}

function courtlistenerOpinionMetadata(raw: unknown) {
  const opinion = recordFromUnknown(raw);
  if (!opinion) return null;
  const text =
    stringField(opinion, "text") ??
    (stringField(opinion, "html")
      ? stripCaseOpinionHtml(stringField(opinion, "html")!)
      : null);
  return {
    opinion_id: numberField(opinion, "opinionId") ?? numberField(opinion, "id"),
    type: stringField(opinion, "type"),
    author: stringField(opinion, "author"),
    per_curiam: stringField(opinion, "per_curiam"),
    joined_by_str: stringField(opinion, "joined_by_str"),
    url: stringField(opinion, "url"),
    char_count: text?.length ?? 0,
  };
}

function courtlistenerFetchedCaseMetadata(
  record: CourtlistenerCaseRecord,
  opinionCount: number,
) {
  return {
    cluster_id: record.clusterId,
    case_name: record.caseName,
    citation: record.citations[0] ?? null,
    citations: record.citations,
    dateFiled: record.dateFiled,
    url: record.url,
    pdfUrl: record.pdfUrl,
    opinion_count: opinionCount,
    opinions: (record.opinions ?? [])
      .map(courtlistenerOpinionMetadata)
      .filter((opinion): opinion is NonNullable<typeof opinion> => !!opinion),
  };
}

function stripCaseOpinionHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

type CachedCaseOpinionText = {
  opinion_id: number | null;
  type: string | null;
  author: string | null;
  url: string | null;
  text: string;
  source: Record<string, unknown>;
};

function cachedCaseOpinionTexts(
  record: CourtlistenerCaseRecord,
): CachedCaseOpinionText[] {
  return (record.opinions ?? [])
    .map((raw) => {
      const opinion = recordFromUnknown(raw);
      if (!opinion) return null;
      const text =
        getCourtlistenerOpinionDocumentText(opinion) ||
        stringField(opinion, "text") ||
        (stringField(opinion, "html")
          ? stripCaseOpinionHtml(stringField(opinion, "html")!)
          : null);
      if (!text) return null;
      return {
        opinion_id:
          numberField(opinion, "opinionId") ?? numberField(opinion, "id"),
        type: stringField(opinion, "type"),
        author: stringField(opinion, "author"),
        url: stringField(opinion, "url"),
        text,
        source: opinion,
      };
    })
    .filter((opinion): opinion is CachedCaseOpinionText => !!opinion);
}

function requestedCourtlistenerOpinionIds(args: Record<string, unknown>) {
  const rawIds = Array.isArray(args.opinionIds)
    ? args.opinionIds
    : Array.isArray(args.opinion_ids)
      ? args.opinion_ids
      : typeof args.opinionId === "number"
        ? [args.opinionId]
        : typeof args.opinion_id === "number"
          ? [args.opinion_id]
          : [];
  return Array.from(
    new Set(
      rawIds
        .filter((value): value is number => typeof value === "number")
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.floor(value)),
    ),
  );
}

type FindInCaseArgs = {
  clusterId: number | null;
  query: string;
  maxResults: number;
  contextChars: number;
};

function parseFindInCaseArgs(args: Record<string, unknown>): FindInCaseArgs {
  return {
    clusterId:
      typeof args.clusterId === "number" && Number.isFinite(args.clusterId)
        ? Math.floor(args.clusterId)
        : typeof args.cluster_id === "number" &&
            Number.isFinite(args.cluster_id)
          ? Math.floor(args.cluster_id)
          : null,
    query: typeof args.query === "string" ? args.query : "",
    maxResults:
      typeof args.max_results === "number"
        ? Math.max(0, Math.floor(args.max_results))
        : 20,
    contextChars:
      typeof args.context_chars === "number"
        ? Math.max(0, Math.floor(args.context_chars))
        : 160,
  };
}

function findInCaseSearchSummary(
  event: Extract<
    CourtlistenerToolEvent,
    { type: "courtlistener_find_in_case" }
  >,
) {
  return {
    cluster_id: event.cluster_id,
    query: event.query,
    total_matches: event.total_matches,
    case_name: event.case_name,
    citation: event.citation,
    error: event.error,
  };
}

function cachedCaseNotFetchedResult(clusterId: number | null) {
  return {
    ok: false,
    cluster_id: clusterId,
    error:
      "Case has not been fetched in this turn. Call courtlistener_get_cases first.",
  };
}

export function readTabularCells(
  tabularStore: TabularCellStore,
  colIndices?: number[],
  rowIndices?: number[],
) {
  const columns = colIndices?.length
    ? tabularStore.columns.filter((_, index) => colIndices.includes(index))
    : tabularStore.columns;
  const documents = rowIndices?.length
    ? tabularStore.documents.filter((_, index) => rowIndices.includes(index))
    : tabularStore.documents;
  const label = `${columns.length} ${columns.length === 1 ? "column" : "columns"} × ${documents.length} ${documents.length === 1 ? "row" : "rows"}`;
  const lines: string[] = [];

  for (const column of columns) {
    const columnPosition = tabularStore.columns.findIndex(
      (candidate) => candidate.index === column.index,
    );
    for (const document of documents) {
      const rowPosition = tabularStore.documents.findIndex(
        (candidate) => candidate.id === document.id,
      );
      const cell = tabularStore.cells.get(`${column.index}:${document.id}`);
      lines.push(
        `[COL:${columnPosition} "${column.name}" | ROW:${rowPosition} "${document.filename}"]`,
      );
      if (cell?.summary) {
        lines.push(`Summary: ${cell.summary}`);
        if (cell.flag) lines.push(`Flag: ${cell.flag}`);
        if (cell.reasoning) lines.push(`Reasoning: ${cell.reasoning}`);
      } else {
        lines.push("(not yet generated)");
      }
      lines.push("");
    }
  }

  return {
    label,
    content:
      `${tabularStore.app_url ? `Review app_url: ${tabularStore.app_url}\n\n` : ""}${
        lines.join("\n") || "No cells found."
      }`,
  };
}

export async function runToolCalls(
  toolCalls: ToolCall[],
  docStore: DocStore,
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  write: (s: string) => void,
  workflowStore?: WorkflowStore,
  tabularStore?: TabularCellStore,
  docIndex?: DocIndex,
  turnEditState?: TurnEditState,
  turnReadState?: TurnReadState,
  projectId?: string | null,
  courtlistenerState?: CourtlistenerTurnState,
  apiKeys?: import("../../llm").UserApiKeys,
  publicLegalState?: PublicLegalSourceState,
): Promise<{
  toolResults: unknown[];
  docsRead: { filename: string; document_id?: string }[];
  docsFound: { filename: string; query: string; total_matches: number }[];
  docsCreated: DocCreatedResult[];
  workflowsApplied: { workflow_id: string; title: string }[];
  docsEdited: DocEditedResult[];
  askInputsEvents: AskInputsEvent[];
  courtlistenerEvents: CourtlistenerToolEvent[];
  caseCitationEvents: CaseCitationEvent[];
  mcpEvents: McpToolEvent[];
  a2ajLookups: A2AJLocatorLookup[];
  a2ajDocuments: A2AJDocument[];
}> {
  const toolResults: unknown[] = [];
  const docsRead: { filename: string; document_id?: string }[] = [];
  const docsFound: {
    filename: string;
    query: string;
    total_matches: number;
  }[] = [];
  const docsCreated: DocCreatedResult[] = [];
  const workflowsApplied: { workflow_id: string; title: string }[] = [];
  const docsEdited: DocEditedResult[] = [];
  const askInputsEvents: AskInputsEvent[] = [];
  const courtlistenerEvents: CourtlistenerToolEvent[] = [];
  const caseCitationEvents: CaseCitationEvent[] = [];
  const mcpEvents: McpToolEvent[] = [];
  const a2ajLookups: A2AJLocatorLookup[] = [];
  const a2ajDocuments: A2AJDocument[] = [];
  const courtState: CourtlistenerTurnState = courtlistenerState ?? {
    casesByClusterId: new Map(),
  };
  const publicState = publicLegalState ?? createPublicLegalSourceState();
  const groupedFindInCaseSearches = toolCalls
    .filter((tc) => tc.function.name === COURTLISTENER_TOOL_NAMES.findInCase)
    .map((tc) => {
      let rawArgs: Record<string, unknown> = {};
      try {
        rawArgs = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* ignore */
      }
      const parsed = parseFindInCaseArgs(rawArgs);
      return {
        cluster_id: parsed.clusterId,
        query: parsed.query,
        total_matches: 0,
      };
    });
  const shouldGroupFindInCase = groupedFindInCaseSearches.length > 1;
  let groupedFindInCaseStarted = false;
  const groupedFindInCaseEvents: Extract<
    CourtlistenerToolEvent,
    { type: "courtlistener_find_in_case" }
  >[] = [];

  const registerGeneratedDocument = (
    tc: ToolCall,
    result: Record<string, unknown>,
    previewFilename: string,
    fileType: string,
  ) => {
    let newDocLabel: string | null = null;
    if ("filename" in result && "download_url" in result) {
      const dlFilename = result.filename as string;
      const dlUrl = result.download_url as string;
      const documentId = (result as { document_id?: string }).document_id;
      const versionId = (result as { version_id?: string }).version_id;
      const versionNumber =
        (result as { version_number?: number }).version_number ?? null;
      const storagePath = (result as { storage_path?: string }).storage_path;

      if (documentId && storagePath && docIndex) {
        const existingLabels = new Set(Object.keys(docIndex));
        let i = 0;
        while (existingLabels.has(`doc-${i}`)) i++;
        newDocLabel = `doc-${i}`;
        docIndex[newDocLabel] = {
          document_id: documentId,
          filename: dlFilename,
        };
        docStore.set(newDocLabel, {
          storage_path: storagePath,
          file_type: fileType,
          filename: dlFilename,
        });
      }

      write(
        `data: ${JSON.stringify({
          type: "doc_created",
          filename: dlFilename,
          download_url: dlUrl,
          document_id: documentId,
          version_id: versionId,
          version_number: versionNumber,
        })}\n\n`,
      );
      docsCreated.push({
        filename: dlFilename,
        download_url: dlUrl,
        document_id: documentId,
        version_id: versionId,
        version_number: versionNumber,
      });
    } else {
      write(
        `data: ${JSON.stringify({ type: "doc_created", filename: previewFilename, download_url: "" })}\n\n`,
      );
    }

    const { download_url, storage_path, ...safeToolResult } = result;
    const toolResultPayload = newDocLabel
      ? {
          ...safeToolResult,
          doc_id: newDocLabel,
          next_required_action: [
            `Before writing your final response, call read_document with doc_id "${newDocLabel}".`,
            `Base your description on the generated document's actual returned text, not on memory of what you intended to generate.`,
            `Do not include download links, URLs, or markdown links to the document in your prose response; the document card is shown automatically by the UI.`,
            `Give a concise description of the generated document and, if you make factual claims about its contents, cite it with [N] markers and a final <CITATIONS> block using doc_id "${newDocLabel}", not any source/template document.`,
          ].join(" "),
        }
      : safeToolResult;
    toolResults.push({
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify(toolResultPayload),
    });
  };

  for (const tc of toolCalls) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      /* ignore */
    }

    if (tc.function.name.startsWith("mcp_")) {
      write(
        `data: ${JSON.stringify({
          type: "mcp_tool_start",
          name: tc.function.name,
        })}\n\n`,
      );
      const { content, event } = await executeMcpToolCall(
        userId,
        tc.function.name,
        args,
        db,
      );
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content,
      });
      mcpEvents.push(event);
      write(
        `data: ${JSON.stringify({
          type: "mcp_tool_result",
          name: tc.function.name,
          connector_name: event.connector_name,
          tool_name: event.tool_name,
          status: event.status,
          error: event.error,
        })}\n\n`,
      );
      continue;
    }

    if (tc.function.name === "ask_inputs") {
      const event = normalizeAskInputsEvent(args);
      if (event.items.length > 0) askInputsEvents.push(event);
      continue;
    }

    if (tc.function.name === "read_document") {
      const rawDocId = args.doc_id as string;
      const docId = resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
      const readMode = args.mode === "drafting" ? "drafting" : "text";
      const readIdentity = await getTurnReadIdentity({
        docLabel: docId,
        docStore,
        docIndex,
        db,
      });
      const readKey = readIdentity ? `${readIdentity.key}:${readMode}` : null;
      if (readIdentity && readKey && turnReadState?.has(readKey)) {
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: duplicateReadDocumentResult(readIdentity),
        });
        continue;
      }
      const content = await readDocumentContent(
        docId,
        docStore,
        write,
        docIndex,
        db,
        { mode: readMode },
      );
      const filename = docStore.get(docId)?.filename;
      const documentId = docIndex?.[docId]?.document_id;
      let readSucceeded = true;
      if (readMode === "drafting") {
        try {
          readSucceeded = JSON.parse(content)?.ok === true;
        } catch {
          readSucceeded = false;
        }
      }
      if (readSucceeded && readIdentity && readKey && turnReadState) {
        turnReadState.set(readKey, readIdentity);
      }
      if (readSucceeded && filename) {
        docsRead.push({ filename, document_id: documentId });
      }
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content:
          filename && readMode === "text"
            ? `${citationReminder(docId, filename)}\n\n${content}`
            : content,
      });
    } else if (tc.function.name === "find_in_document") {
      const rawDocId = args.doc_id as string;
      const docId = resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
      const query = (args.query as string) ?? "";
      const maxResults =
        typeof args.max_results === "number" ? args.max_results : undefined;
      const contextChars =
        typeof args.context_chars === "number" ? args.context_chars : undefined;
      const content = await findInDocumentContent({
        docLabel: docId,
        query,
        maxResults,
        contextChars,
        docStore,
        write,
        docIndex,
        db,
      });
      const filename = docStore.get(docId)?.filename;
      if (filename) {
        let totalMatches = 0;
        try {
          const parsed = JSON.parse(content) as {
            total_matches?: number;
          };
          totalMatches = parsed.total_matches ?? 0;
        } catch {
          /* ignore — still record the find attempt */
        }
        docsFound.push({
          filename,
          query,
          total_matches: totalMatches,
        });
      }
      toolResults.push({ role: "tool", tool_call_id: tc.id, content });
    } else if (tc.function.name === "list_documents") {
      const list = Array.from(docStore.entries()).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        file_type: info.file_type,
        app_url: appUrl({
          kind: "library-document",
          projectId,
        }),
      }));
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(list),
      });
    } else if (tc.function.name === "fetch_documents") {
      const rawDocIds = (args.doc_ids as string[]) ?? [];
      const docIds = rawDocIds.map(
        (id) => resolveDocLabel(id, docStore, docIndex) ?? id,
      );
      const parts: string[] = [];
      for (const docId of docIds) {
        const readIdentity = await getTurnReadIdentity({
          docLabel: docId,
          docStore,
          docIndex,
          db,
        });
        const readKey = readIdentity ? `${readIdentity.key}:text` : null;
        if (readIdentity && readKey && turnReadState?.has(readKey)) {
          const filename = docStore.get(docId)?.filename ?? docId;
          parts.push(
            `--- ${filename} (${docId}) ---\n${duplicateReadDocumentResult(
              readIdentity,
            )}`,
          );
          continue;
        }
        const content = await readDocumentContent(
          docId,
          docStore,
          write,
          docIndex,
          db,
        );
        const filename = docStore.get(docId)?.filename ?? docId;
        if (readIdentity && readKey && turnReadState) {
          turnReadState.set(readKey, readIdentity);
        }
        parts.push(
          `--- ${filename} (${docId}) ---\n${citationReminder(docId, filename)}\n\n${content}`,
        );
        if (docStore.get(docId)) {
          const documentId = docIndex?.[docId]?.document_id;
          docsRead.push({ filename, document_id: documentId });
        }
      }
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: parts.join("\n\n"),
      });
    } else if (tc.function.name === "list_workflows") {
      const list = workflowStore
        ? Array.from(workflowStore.entries()).map(([id, w]) => ({
            id,
            title: w.title,
            app_url: appUrl({
              kind: "workflow",
              id,
              workflowType: "assistant",
            }),
          }))
        : [];
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(list),
      });
    } else if (tc.function.name === "read_workflow") {
      const wfId = args.workflow_id as string;
      const wf = workflowStore?.get(wfId);
      if (wf) {
        write(
          `data: ${JSON.stringify({ type: "workflow_applied", workflow_id: wfId, title: wf.title })}\n\n`,
        );
        workflowsApplied.push({ workflow_id: wfId, title: wf.title });
      }
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: wf ? wf.skill_md : `Workflow '${wfId}' not found.`,
      });
    } else if (tc.function.name === "read_table_cells" && tabularStore) {
      const colIndices = args.col_indices as number[] | undefined;
      const rowIndices = args.row_indices as number[] | undefined;
      const selected = readTabularCells(
        tabularStore,
        colIndices,
        rowIndices,
      );

      write(
        `data: ${JSON.stringify({ type: "doc_read_start", filename: selected.label })}\n\n`,
      );

      write(
        `data: ${JSON.stringify({ type: "doc_read", filename: selected.label })}\n\n`,
      );
      docsRead.push({ filename: selected.label });
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: selected.content,
      });
    } else if (
      tc.function.name === PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch ||
      tc.function.name === PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup
    ) {
      const payload = await executePublicLegalSourceTool(
        tc.function.name,
        args,
        publicState,
      );
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(
          payload ?? { ok: false, error: "Public legal tool unavailable." },
        ),
      });
    } else if (tc.function.name === A2AJ_TOOL_NAMES.search) {
      try {
        const result = await searchA2AJ({
          query: typeof args.query === "string" ? args.query : "",
          docType: args.doc_type === "laws" ? "laws" : "cases",
          searchType: args.search_type === "name" ? "name" : "full_text",
          language: args.search_language === "fr" ? "fr" : "en",
          size: typeof args.size === "number" ? args.size : undefined,
          dataset: typeof args.dataset === "string" ? args.dataset : undefined,
          startDate:
            typeof args.start_date === "string" ? args.start_date : undefined,
          endDate:
            typeof args.end_date === "string" ? args.end_date : undefined,
          sortResults:
            args.sort_results === "newest_first" ||
            args.sort_results === "oldest_first"
              ? args.sort_results
              : "default",
        });
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: true,
            source: "A2AJ",
            result_count: result.length,
            results: result,
            next_required_action:
              "Use a2aj_fetch with a returned citation before relying on source text in the final answer.",
          }),
        });
      } catch (err) {
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: false,
            source: "A2AJ",
            error: err instanceof Error ? err.message : "A2AJ search failed.",
          }),
        });
      }
    } else if (tc.function.name === A2AJ_TOOL_NAMES.fetch) {
      try {
        const document = await fetchA2AJDocument({
          citation: typeof args.citation === "string" ? args.citation : "",
          docType: args.doc_type === "laws" ? "laws" : "cases",
          language: args.output_language === "fr" ? "fr" : "en",
          section: typeof args.section === "string" ? args.section : undefined,
        });
        if (document?.url) a2ajDocuments.push(document);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(
            document
              ? {
                  ok: true,
                  source: "A2AJ",
                  ...document,
                  // `truncated`/`total_chars` ride along in the spread. When
                  // the text was cut, say so in words as well: the model must
                  // not treat a 50,000-character slice of the Criminal Code as
                  // the whole Act.
                  ...(document.truncated
                    ? {
                        next_required_action: `Only the first ${document.text.length} of ${document.total_chars} characters are shown. Use a2aj_lookup for a specific paragraph or section, or a2aj_fetch with "section", before relying on any part of this document you cannot see.`,
                      }
                    : {}),
                }
              : {
                  ok: false,
                  source: "A2AJ",
                  error: "A2AJ did not find an exact matching document.",
                },
          ),
        });
      } catch (err) {
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: false,
            source: "A2AJ",
            error: err instanceof Error ? err.message : "A2AJ fetch failed.",
          }),
        });
      }
    } else if (tc.function.name === A2AJ_TOOL_NAMES.lookup) {
      try {
        const lookup = await lookupA2AJLocator({
          citation: typeof args.citation === "string" ? args.citation : "",
          docType: args.doc_type === "laws" ? "laws" : "cases",
          language: args.output_language === "fr" ? "fr" : "en",
          kind:
            args.locator_type === "page"
              ? "page"
              : args.locator_type === "section"
                ? "section"
                : "paragraph",
          locator: typeof args.locator === "string" ? args.locator : "",
          contextBlocks:
            typeof args.context_blocks === "number"
              ? args.context_blocks
              : undefined,
        });
        if (lookup?.status === "found" && lookup.block) {
          a2ajLookups.push(lookup);
        }
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(
            lookup
              ? {
                  ok: lookup.status === "found",
                  source: "A2AJ",
                  ...lookup,
                  url: undefined,
                }
              : {
                  ok: false,
                  source: "A2AJ",
                  error: "A2AJ did not find an exact matching document.",
                },
          ),
        });
      } catch (err) {
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: false,
            source: "A2AJ",
            error: err instanceof Error ? err.message : "A2AJ lookup failed.",
          }),
        });
      }
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.searchCaseLaw) {
      const query = typeof args.query === "string" ? args.query : "";
      write(
        `data: ${JSON.stringify({ type: "courtlistener_search_case_law_start", query })}\n\n`,
      );
      try {
        const result = await searchCourtlistenerCaseLaw({
          query: query || undefined,
          court: typeof args.court === "string" ? args.court : undefined,
          filedAfter:
            typeof args.filedAfter === "string" ? args.filedAfter : undefined,
          filedBefore:
            typeof args.filedBefore === "string" ? args.filedBefore : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          apiToken: apiKeys?.courtlistener,
        });
        const resultCount =
          result &&
          typeof result === "object" &&
          Array.isArray((result as { results?: unknown }).results)
            ? (result as { results: unknown[] }).results.length
            : 0;
        const error =
          result &&
          typeof result === "object" &&
          typeof (result as { error?: unknown }).error === "string"
            ? (result as { error: string }).error
            : undefined;
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_search_case_law",
          query,
          result_count: resultCount,
          ...(error ? { error } : {}),
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_search_case_law",
          query,
          result_count: 0,
          error:
            err instanceof Error ? err.message : "CourtListener search failed.",
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            error:
              err instanceof Error
                ? err.message
                : "CourtListener search failed.",
          }),
        });
      }
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.getCases) {
      const rawClusterIds = Array.isArray(args.clusterIds)
        ? args.clusterIds
        : Array.isArray(args.cluster_ids)
          ? args.cluster_ids
          : typeof args.clusterId === "number"
            ? [args.clusterId]
            : [];
      const clusterIds = Array.from(
        new Set(
          rawClusterIds
            .filter((value): value is number => typeof value === "number")
            .filter((value) => Number.isFinite(value) && value > 0)
            .map((value) => Math.floor(value)),
        ),
      );
      write(
        `data: ${JSON.stringify({ type: "courtlistener_get_cases_start", cluster_ids: clusterIds })}\n\n`,
      );
      try {
        const result = await getCourtlistenerCases({
          clusterIds,
          db,
          apiToken: apiKeys?.courtlistener,
        });
        const fetchedCases =
          result &&
          typeof result === "object" &&
          Array.isArray((result as { cases?: unknown }).cases)
            ? (result as { cases: unknown[] }).cases
            : [];
        fetchedCases.forEach((fetchedCase, index) => {
          const clusterId =
            courtlistenerCaseInputFromFetchedCase(
              clusterIds[index] ?? 0,
              fetchedCase,
            ).clusterId ?? 0;
          if (clusterId) {
            write(
              `data: ${JSON.stringify({ type: "case_opinions", cluster_id: clusterId, case: fetchedCase })}\n\n`,
            );
          }
        });
        const caseRecords = upsertCourtlistenerCases(
          courtState,
          fetchedCases.map((fetchedCase, index) =>
            courtlistenerCaseInputFromFetchedCase(
              clusterIds[index] ?? 0,
              fetchedCase,
            ),
          ),
        );
        const opinionCount = fetchedCases.reduce<number>(
          (sum, fetchedCase) => sum + courtlistenerOpinionCount(fetchedCase),
          0,
        );
        const caseOpinionCountByClusterId = new Map<number, number>();
        fetchedCases.forEach((fetchedCase, index) => {
          const clusterId =
            courtlistenerCaseInputFromFetchedCase(
              clusterIds[index] ?? 0,
              fetchedCase,
            ).clusterId ?? 0;
          if (clusterId) {
            caseOpinionCountByClusterId.set(
              clusterId,
              courtlistenerOpinionCount(fetchedCase),
            );
          }
        });
        const errors = fetchedCases
          .map((fetchedCase) =>
            stringField(recordFromUnknown(fetchedCase), "error"),
          )
          .filter((error): error is string => !!error);
        const resultError =
          result &&
          typeof result === "object" &&
          typeof (result as { error?: unknown }).error === "string"
            ? (result as { error: string }).error
            : undefined;
        const hasMultipleOpinionCase = caseRecords.some(
          (record) =>
            (caseOpinionCountByClusterId.get(record.clusterId) ?? 0) > 1,
        );
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_get_cases",
          cluster_ids: clusterIds,
          case_count: fetchedCases.length,
          opinion_count: opinionCount,
          cases: caseRecords.map((record) => ({
            cluster_id: record.clusterId,
            case_name: record.caseName,
            citation: record.citations[0] ?? null,
            dateFiled: record.dateFiled,
            url: record.url,
          })),
          ...(resultError || errors.length
            ? { error: resultError ?? errors.join("; ") }
            : {}),
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: !resultError && errors.length === 0,
            cluster_ids: clusterIds,
            case_count: fetchedCases.length,
            opinion_count: opinionCount,
            cases: caseRecords.map((record) =>
              courtlistenerFetchedCaseMetadata(
                record,
                caseOpinionCountByClusterId.get(record.clusterId) ?? 0,
              ),
            ),
            ...(resultError || errors.length
              ? { error: resultError ?? errors.join("; ") }
              : {}),
            next_required_action: hasMultipleOpinionCase
              ? "Opinion text is cached server-side only. Use courtlistener_find_in_case with short 1-3 word keyword probes for relevant passages. At least one fetched case has multiple opinions; if snippets are insufficient, choose the needed opinion_id(s) from the text-free opinion metadata and call courtlistener_read_case with only those IDs. Do not read all opinions unless the question requires it."
              : "Opinion text is cached server-side only. Use courtlistener_find_in_case with short 1-3 word keyword probes for relevant passages, or courtlistener_read_case if snippets are insufficient.",
          }),
        });
      } catch (err) {
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_get_cases",
          cluster_ids: clusterIds,
          case_count: 0,
          opinion_count: 0,
          error:
            err instanceof Error
              ? err.message
              : "CourtListener case fetch failed.",
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            error:
              err instanceof Error
                ? err.message
                : "CourtListener case fetch failed.",
          }),
        });
      }
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.findInCase) {
      const { clusterId, query, maxResults, contextChars } =
        parseFindInCaseArgs(args);
      if (shouldGroupFindInCase) {
        if (!groupedFindInCaseStarted) {
          write(
            `data: ${JSON.stringify({
              type: "courtlistener_find_in_case_start",
              cluster_id: null,
              query: "",
              searches: groupedFindInCaseSearches,
            })}\n\n`,
          );
          groupedFindInCaseStarted = true;
        }
      } else {
        write(
          `data: ${JSON.stringify({ type: "courtlistener_find_in_case_start", cluster_id: clusterId, query })}\n\n`,
        );
      }

      const record =
        typeof clusterId === "number"
          ? courtState.casesByClusterId.get(clusterId)
          : undefined;
      if (!record) {
        const payload = cachedCaseNotFetchedResult(clusterId);
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_find_in_case",
          cluster_id: clusterId,
          query,
          total_matches: 0,
          error: payload.error,
        };
        if (shouldGroupFindInCase) {
          groupedFindInCaseEvents.push(event);
        } else {
          write(`data: ${JSON.stringify(event)}\n\n`);
          courtlistenerEvents.push(event);
        }
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(payload),
        });
        continue;
      }

      const opinions = cachedCaseOpinionTexts(record);
      const hits: Array<
        TextMatch & {
          opinion_id: number | null;
          type: string | null;
          author: string | null;
          url: string | null;
        }
      > = [];
      let totalMatches = 0;
      for (const opinion of opinions) {
        const remaining = Math.max(0, maxResults - hits.length);
        const result = findTextMatches({
          text: opinion.text,
          query,
          maxResults: remaining,
          contextChars,
          startIndex: hits.length,
        });
        totalMatches += result.totalMatches;
        hits.push(
          ...result.hits.map((hit) => ({
            ...hit,
            opinion_id: opinion.opinion_id,
            type: opinion.type,
            author: opinion.author,
            url: opinion.url,
          })),
        );
      }

      const event: CourtlistenerToolEvent = {
        type: "courtlistener_find_in_case",
        cluster_id: record.clusterId,
        query,
        total_matches: totalMatches,
        case_name: record.caseName,
        citation: record.citations[0] ?? null,
      };
      if (shouldGroupFindInCase) {
        groupedFindInCaseEvents.push(event);
      } else {
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
      }
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify({
          ok: true,
          cluster_id: record.clusterId,
          case_name: record.caseName,
          citation: record.citations[0] ?? null,
          query,
          total_matches: totalMatches,
          returned: hits.length,
          truncated: totalMatches > hits.length,
          hits,
        }),
      });
    } else if (
      tc.function.name === COURTLISTENER_TOOL_NAMES.lookupCaseLocator
    ) {
      const clusterId =
        typeof args.clusterId === "number" && Number.isFinite(args.clusterId)
          ? Math.floor(args.clusterId)
          : typeof args.cluster_id === "number" &&
              Number.isFinite(args.cluster_id)
            ? Math.floor(args.cluster_id)
            : null;
      const locatorType =
        args.locator_type === "page"
          ? "page"
          : args.locator_type === "section"
            ? "section"
            : "paragraph";
      const locator = typeof args.locator === "string" ? args.locator : "";
      const contextBlocks =
        typeof args.context_blocks === "number" ? args.context_blocks : 0;
      const record =
        typeof clusterId === "number"
          ? courtState.casesByClusterId.get(clusterId)
          : undefined;
      if (!record) {
        const payload = cachedCaseNotFetchedResult(clusterId);
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_lookup_case_locator",
          cluster_id: clusterId,
          locator_type: locatorType,
          locator,
          status: "unavailable",
          error: payload.error,
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(payload),
        });
        continue;
      }

      const requestedOpinionIds = requestedCourtlistenerOpinionIds(args);
      const candidates = (record.opinions ?? []).filter((raw) => {
        if (!requestedOpinionIds.length) return true;
        const opinion = recordFromUnknown(raw);
        const opinionId =
          numberField(opinion, "opinionId") ?? numberField(opinion, "id");
        return opinionId !== null && requestedOpinionIds.includes(opinionId);
      });
      const found = candidates.flatMap((raw) => {
        const opinion = recordFromUnknown(raw);
        if (!opinion) return [];
        const lookup = lookupCourtlistenerOpinionLocator(
          opinion,
          locatorType,
          locator,
          contextBlocks,
        );
        return lookup?.status === "found" && lookup.block
          ? [
              {
                opinion_id:
                  numberField(opinion, "opinionId") ??
                  numberField(opinion, "id"),
                lookup,
              },
            ]
          : [];
      });
      const status =
        found.length === 1
          ? "found"
          : found.length > 1
            ? "ambiguous"
            : "not_found";
      const event: CourtlistenerToolEvent = {
        type: "courtlistener_lookup_case_locator",
        cluster_id: record.clusterId,
        locator_type: locatorType,
        locator,
        status,
        ...(found.length > 1
          ? {
              error: "The locator occurs in multiple opinions; pass opinionId.",
            }
          : {}),
      };
      write(`data: ${JSON.stringify(event)}\n\n`);
      courtlistenerEvents.push(event);
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(
          found.length === 1
            ? {
                ok: true,
                cluster_id: record.clusterId,
                case_name: record.caseName,
                citation: record.citations[0] ?? null,
                opinion_id: found[0].opinion_id,
                requested: { kind: locatorType, locator },
                ...found[0].lookup,
                block: found[0].lookup.block
                  ? { ...found[0].lookup.block, anchor: undefined }
                  : null,
              }
            : {
                ok: false,
                cluster_id: record.clusterId,
                status,
                error:
                  found.length > 1
                    ? "The locator occurs in multiple opinions; pass opinionId."
                    : "The requested locator was not found in the cached opinions.",
              },
        ),
      });
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.readCase) {
      const clusterId =
        typeof args.clusterId === "number" && Number.isFinite(args.clusterId)
          ? Math.floor(args.clusterId)
          : typeof args.cluster_id === "number" &&
              Number.isFinite(args.cluster_id)
            ? Math.floor(args.cluster_id)
            : null;
      write(
        `data: ${JSON.stringify({ type: "courtlistener_read_case_start", cluster_id: clusterId })}\n\n`,
      );

      const record =
        typeof clusterId === "number"
          ? courtState.casesByClusterId.get(clusterId)
          : undefined;
      if (!record) {
        const payload = cachedCaseNotFetchedResult(clusterId);
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_read_case",
          cluster_id: clusterId,
          opinion_count: 0,
          error: payload.error,
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(payload),
        });
        continue;
      }

      const opinions = cachedCaseOpinionTexts(record);
      const requestedOpinionIds = requestedCourtlistenerOpinionIds(args);
      const selectedOpinions =
        requestedOpinionIds.length > 0
          ? opinions.filter(
              (opinion) =>
                typeof opinion.opinion_id === "number" &&
                requestedOpinionIds.includes(opinion.opinion_id),
            )
          : opinions.length === 1
            ? opinions
            : [];
      if (!selectedOpinions.length) {
        const multipleOpinions = opinions.length > 1;
        const payload = {
          ok: false,
          cluster_id: record.clusterId,
          case_name: record.caseName,
          citations: record.citations,
          url: record.url,
          dateFiled: record.dateFiled,
          opinion_count: opinions.length,
          opinions: (record.opinions ?? [])
            .map(courtlistenerOpinionMetadata)
            .filter(
              (opinion): opinion is NonNullable<typeof opinion> => !!opinion,
            ),
          error: multipleOpinions
            ? "Multiple opinions are available. Call courtlistener_read_case again with the opinionId or opinionIds needed."
            : "No matching opinion_id was found for this fetched case.",
        };
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_read_case",
          cluster_id: record.clusterId,
          case_name: record.caseName,
          citation: record.citations[0] ?? null,
          opinion_count: 0,
          error: payload.error,
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(payload),
        });
        continue;
      }

      const event: CourtlistenerToolEvent = {
        type: "courtlistener_read_case",
        cluster_id: record.clusterId,
        case_name: record.caseName,
        citation: record.citations[0] ?? null,
        opinion_count: selectedOpinions.length,
      };
      write(`data: ${JSON.stringify(event)}\n\n`);
      courtlistenerEvents.push(event);
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify({
          ok: true,
          cluster_id: record.clusterId,
          case_name: record.caseName,
          citations: record.citations,
          url: record.url,
          dateFiled: record.dateFiled,
          opinion_count: opinions.length,
          returned_opinion_count: selectedOpinions.length,
          opinions: selectedOpinions,
        }),
      });
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.verifyCitations) {
      const citations = Array.isArray(args.citations)
        ? args.citations.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const citationCount = citations.length;
      write(
        `data: ${JSON.stringify({ type: "courtlistener_verify_citations_start", citation_count: citationCount })}\n\n`,
      );
      try {
        const result = (await verifyCourtlistenerCitations({
          citations,
          db,
          apiToken: apiKeys?.courtlistener,
        })) as {
          citationLinks?: {
            clusterId?: number | null;
            citation?: string | null;
            caseName?: string | null;
            dateFiled?: string | null;
            pdfUrl?: string | null;
            url?: string | null;
            markdown?: string;
          }[];
          results?: unknown[];
          error?: string;
          source?: string;
          [key: string]: unknown;
        };
        if (Array.isArray(result.citationLinks)) {
          const caseRecords = upsertCourtlistenerCases(
            courtState,
            result.citationLinks.map((link) => ({
              clusterId: link.clusterId,
              caseName: link.caseName,
              citation: link.citation,
              url: link.url,
              pdfUrl: link.pdfUrl,
              dateFiled: link.dateFiled,
            })),
          );
          const recordsByClusterId = new Map(
            caseRecords.map((record) => [record.clusterId, record]),
          );
          result.citationLinks = result.citationLinks.map((link) => {
            if (!link.url) return link;
            const href =
              typeof link.clusterId === "number"
                ? `us-case-${link.clusterId}`
                : link.url;
            const label = [link.caseName, link.citation]
              .filter(Boolean)
              .join(", ");
            const record =
              typeof link.clusterId === "number"
                ? recordsByClusterId.get(link.clusterId)
                : undefined;
            if (record) {
              const event = caseCitationEventFromRecord(record);
              if (event) {
                caseCitationEvents.push(event);
                write(`data: ${JSON.stringify(event)}\n\n`);
              }
            }
            return {
              ...link,
              markdown: `[${label || link.url}](${href})`,
            };
          });
        }
        const rows =
          result &&
          typeof result === "object" &&
          Array.isArray((result as { results?: unknown }).results)
            ? (result as { results: unknown[] }).results
            : [];
        const matchCount = rows.reduce<number>((count, row) => {
          if (!row || typeof row !== "object") return count;
          const clusters = (row as { clusters?: unknown }).clusters;
          return count + (Array.isArray(clusters) ? clusters.length : 0);
        }, 0);
        const error =
          result &&
          typeof result === "object" &&
          typeof (result as { error?: unknown }).error === "string"
            ? (result as { error: string }).error
            : undefined;
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_verify_citations",
          citation_count: citationCount,
          match_count: matchCount,
          ...(error ? { error } : {}),
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_verify_citations",
          citation_count: citationCount,
          match_count: 0,
          error:
            err instanceof Error
              ? err.message
              : "CourtListener citation lookup failed.",
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            error:
              err instanceof Error
                ? err.message
                : "CourtListener citation lookup failed.",
          }),
        });
      }
    } else if (tc.function.name === "edit_document" && docIndex) {
      const rawDocId = args.doc_id as string;
      const editsRaw = args.edits as unknown[] | undefined;
      const docId = resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
      const docInfo = docStore.get(docId);
      const indexed = docIndex?.[docId];

      const emitEditError = (
        filename: string,
        documentId: string,
        error: string,
      ) => {
        // Surface the failure as a failed "Edited" block in the UI
        // (start → done-with-error) so it matches the shape the
        // success/late-failure paths already use.
        write(
          `data: ${JSON.stringify({
            type: "doc_edited_start",
            filename,
          })}\n\n`,
        );
        write(
          `data: ${JSON.stringify({
            type: "doc_edited",
            filename,
            document_id: documentId,
            version_id: "",
            download_url: "",
            annotations: [],
            error,
          })}\n\n`,
        );
      };

      if (!docInfo || !indexed) {
        const err = `Document '${docId}' not found in this chat's attachments.`;
        emitEditError(docId, indexed?.document_id ?? "", err);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: err }),
        });
      } else if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
        const err = "edits array is required and must not be empty.";
        emitEditError(docInfo.filename, indexed.document_id, err);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: err }),
        });
      } else if (docInfo.file_type !== "docx") {
        const err = "edit_document only supports .docx files.";
        emitEditError(docInfo.filename, indexed.document_id, err);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: err }),
        });
      } else {
        write(
          `data: ${JSON.stringify({
            type: "doc_edited_start",
            filename: docInfo.filename,
          })}\n\n`,
        );
        const edits: EditInput[] = (editsRaw as Record<string, unknown>[]).map(
          (e) => ({
            find: String(e.find ?? ""),
            replace: String(e.replace ?? ""),
            context_before: String(e.context_before ?? ""),
            context_after: String(e.context_after ?? ""),
            reason: e.reason ? String(e.reason) : undefined,
          }),
        );
        const reuseVersion = turnEditState?.get(indexed.document_id);
        const result = await runEditDocument({
          documentId: indexed.document_id,
          userId,
          edits,
          db,
          reuseVersion,
        });

        if (result.ok) {
          turnEditState?.set(indexed.document_id, {
            versionId: result.version_id,
            versionNumber: result.version_number,
            storagePath: result.storage_path,
          });
          clearTurnReadsForDocument(turnReadState, indexed.document_id);
          // Keep the chat-local doc label pointed at the latest
          // edited version so any follow-up read_document call in
          // the same assistant turn reads and cites the same bytes.
          if (docIndex[docId]) {
            docIndex[docId] = {
              ...docIndex[docId],
              version_id: result.version_id,
              version_number: result.version_number,
            };
          }
          const currentDocStore = docStore.get(docId);
          if (currentDocStore) {
            docStore.set(docId, {
              ...currentDocStore,
              storage_path: result.storage_path,
            });
          }
          const payload: DocEditedResult = {
            filename: docInfo.filename,
            document_id: indexed.document_id,
            version_id: result.version_id,
            version_number: result.version_number,
            download_url: result.download_url,
            annotations: result.annotations,
          };
          docsEdited.push(payload);
          write(
            `data: ${JSON.stringify({
              type: "doc_edited",
              ...payload,
            })}\n\n`,
          );
          toolResults.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: true,
              doc_id: docId,
              document_id: indexed.document_id,
              version_id: result.version_id,
              version_number: result.version_number,
              applied: result.annotations.length,
              errors: result.errors,
              next_required_action: [
                `The edited document remains available as doc_id "${docId}".`,
                `Before making factual claims about the edited document's final contents, call read_document with doc_id "${docId}" and base the response on that returned text.`,
                `Do not include download links or URLs in your prose response; the edited document card is shown automatically by the UI.`,
                `If you describe specific content from the edited document, cite it with [N] markers and a final <CITATIONS> block using doc_id "${docId}".`,
              ].join(" "),
            }),
          });
        } else {
          write(
            `data: ${JSON.stringify({
              type: "doc_edited",
              filename: docInfo.filename,
              document_id: indexed.document_id,
              version_id: "",
              download_url: "",
              annotations: [],
              error: result.error,
            })}\n\n`,
          );
          toolResults.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: false,
              error: result.error,
            }),
          });
        }
      }
    } else if (tc.function.name === "generate_docx") {
      const title = args.title as string;
      const landscape = !!args.landscape;
      devLog(
        `[generate_docx] title="${title}" landscape=${landscape} args.landscape=${args.landscape}`,
      );
      const previewFilename = safeGeneratedFilename(title, "docx");
      write(
        `data: ${JSON.stringify({ type: "doc_created_start", filename: previewFilename })}\n\n`,
      );
      let evidence: Awaited<ReturnType<typeof resolveDocxEvidenceCitations>>;
      try {
        evidence = await resolveDocxEvidenceCitations(userId, args.sources);
      } catch {
        registerGeneratedDocument(
          tc,
          { error: "DOCX evidence could not be verified." },
          previewFilename,
          "docx",
        );
        continue;
      }
      const result = await generateDocx(
        title,
        {
          markdown: typeof args.markdown === "string" ? args.markdown : "",
          fields: args.fields,
          citations: evidence.citations,
        },
        userId,
        db,
        { landscape, projectId: projectId ?? null },
      );
      registerGeneratedDocument(
        tc,
        result as Record<string, unknown>,
        previewFilename,
        "docx",
      );
    } else if (tc.function.name === "generate_excel") {
      const title = args.title as string;
      devLog(`[generate_excel] title="${title}"`);
      const previewFilename = safeGeneratedFilename(title, "xlsx");
      write(
        `data: ${JSON.stringify({ type: "doc_created_start", filename: previewFilename })}\n\n`,
      );
      const result = await generateExcel(
        title,
        args.sheets as unknown[],
        userId,
        db,
        { projectId: projectId ?? null },
      );
      registerGeneratedDocument(
        tc,
        result as Record<string, unknown>,
        previewFilename,
        "xlsx",
      );
    } else if (tc.function.name === "generate_ppt") {
      const title = args.title as string;
      devLog(`[generate_ppt] title="${title}"`);
      const previewFilename = safeGeneratedFilename(title, "pptx");
      write(
        `data: ${JSON.stringify({ type: "doc_created_start", filename: previewFilename })}\n\n`,
      );
      const result = await generatePpt(
        title,
        args.slides as unknown[],
        userId,
        db,
        { projectId: projectId ?? null },
      );
      registerGeneratedDocument(
        tc,
        result as Record<string, unknown>,
        previewFilename,
        "pptx",
      );
    }
  }

  if (shouldGroupFindInCase && groupedFindInCaseEvents.length > 0) {
    const errors = groupedFindInCaseEvents
      .map((event) => event.error)
      .filter((error): error is string => !!error);
    const groupEvent: CourtlistenerToolEvent = {
      type: "courtlistener_find_in_case",
      cluster_id: null,
      query: "",
      total_matches: groupedFindInCaseEvents.reduce(
        (sum, event) => sum + event.total_matches,
        0,
      ),
      searches: groupedFindInCaseEvents.map(findInCaseSearchSummary),
      ...(errors.length ? { error: errors.join("; ") } : {}),
    };
    write(`data: ${JSON.stringify(groupEvent)}\n\n`);
    courtlistenerEvents.push(groupEvent);
  }

  return {
    toolResults,
    docsRead,
    docsFound,
    docsCreated,
    workflowsApplied,
    docsEdited,
    askInputsEvents,
    courtlistenerEvents,
    caseCitationEvents,
    mcpEvents,
    a2ajLookups,
    a2ajDocuments,
  };
}
