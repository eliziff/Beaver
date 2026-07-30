import {
  COURTLISTENER_TOOL_NAMES,
  type CaseCitationEvent,
  type CourtlistenerToolEvent,
} from "./courtlistenerTools";
import { executeA2AJTool } from "./a2ajTools";
import {
  LEGAL_EVIDENCE_PLAN_TOOL_NAME,
  LEGAL_EVIDENCE_TOOL_NAME,
  planLegalEvidence,
  registerLegalEvidence,
  submitLegalEvidenceAnswer,
  type LegalEvidenceTurnState,
} from "../legalEvidenceExperiment";
import { PUBLIC_LEGAL_SOURCE_TOOL_NAMES } from "./publicLegalSourceTools";
import type { A2AJDocument, A2AJLocatorLookup } from "../../a2aj";
import {
  createPublicLegalSourceState,
  executePublicLegalSourceTool,
  type PublicLegalSourceState,
} from "../publicLegalSourceState";
import {
  executeCourtlistenerTool,
  type CourtlistenerCase,
  type CourtlistenerToolState,
} from "../courtlistenerToolRunner";
import type { McpToolEvent } from "../../mcpConnectors";
import { createServerSupabase } from "../../supabase";
import {
  type DocStore,
  type DocIndex,
  type TabularCellStore,
  type WorkflowStore,
  type ToolCall,
  type AskInputsEvent,
  devLog,
  resolveDocLabel,
} from "../types";
import { normalizeAskInputsEvent } from "../askInputs";
import { readTabularCells } from "../tabularCells";
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
  runEditDocument,
  safeGeneratedFilename,
  type DocEditedResult,
  type TurnEditState,
  type TurnReadState,
  type DocCreatedResult,
} from "./documentOps";

type CourtlistenerCaseRecord = CourtlistenerCase;

type CourtlistenerCaseInput = {
  clusterId?: number | null;
  caseName?: string | null;
  citation?: string | null;
  citations?: string[];
  url?: string | null;
  pdfUrl?: string | null;
  dateFiled?: string | null;
};

export type CourtlistenerTurnState = CourtlistenerToolState;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
      opinions: [],
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
      opinions: current.opinions,
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

export { readTabularCells };

export async function runToolCalls(
  toolCalls: ToolCall[],
  docStore: DocStore,
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  emit: (payload: unknown) => void,
  workflowStore?: WorkflowStore,
  tabularStore?: TabularCellStore,
  docIndex?: DocIndex,
  turnEditState?: TurnEditState,
  turnReadState?: TurnReadState,
  projectId?: string | null,
  courtlistenerState?: CourtlistenerTurnState,
  apiKeys?: import("../../llm").UserApiKeys,
  publicLegalState?: PublicLegalSourceState,
  legalEvidenceState?: LegalEvidenceTurnState,
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

      emit({
        type: "doc_created",
        filename: dlFilename,
        download_url: dlUrl,
        document_id: documentId,
        version_id: versionId,
        version_number: versionNumber,
      });
      docsCreated.push({
        filename: dlFilename,
        download_url: dlUrl,
        document_id: documentId,
        version_id: versionId,
        version_number: versionNumber,
      });
    } else {
      emit({
        type: "doc_created",
        filename: previewFilename,
        download_url: "",
      });
    }

    const { download_url, storage_path, ...safeToolResult } = result;
    const toolResultPayload = newDocLabel
      ? {
          ...safeToolResult,
          doc_id: newDocLabel,
          // Only what the prompt cannot already teach: this doc_id, and that
          // the rendered text — not your intent — is the source of truth.
          next_required_action: `Read doc_id "${newDocLabel}" before describing or citing it; describe what it actually renders, not what you intended.`,
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
    const a2aj = await executeA2AJTool(tc.function.name, args);

    if (tc.function.name === LEGAL_EVIDENCE_PLAN_TOOL_NAME) {
      const planned = legalEvidenceState
        ? planLegalEvidence(args, legalEvidenceState)
        : { ok: false, errors: ["Legal evidence state is unavailable"] };
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(planned),
      });
      continue;
    }

    if (tc.function.name === LEGAL_EVIDENCE_TOOL_NAME) {
      const submitted = legalEvidenceState
        ? submitLegalEvidenceAnswer(args, legalEvidenceState)
        : { ok: false, errors: ["Legal evidence state is unavailable"] };
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(submitted),
        terminal: submitted.terminal === true,
      });
      continue;
    }

    if (tc.function.name.startsWith("mcp_")) {
      emit({
        type: "mcp_tool_start",
        name: tc.function.name,
      });
      const { content, event } = await (
        await import("../../mcpConnectors")
      ).executeMcpToolCall(
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
      emit({
        type: "mcp_tool_result",
        name: tc.function.name,
        connector_name: event.connector_name,
        tool_name: event.tool_name,
        status: event.status,
        error: event.error,
      });
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
      const readMode =
        args.mode === "drafting"
          ? "drafting"
          : args.mode === "redline"
            ? "redline"
            : "text";
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
        emit,
        docIndex,
        db,
        { mode: readMode },
      );
      const filename = docStore.get(docId)?.filename;
      const documentId = docIndex?.[docId]?.document_id;
      let readSucceeded = true;
      if (readMode !== "text") {
        // drafting and redline results are JSON envelopes with an ok flag.
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
        emit,
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
          emit,
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
        emit({
          type: "workflow_applied",
          workflow_id: wfId,
          title: wf.title,
        });
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

      emit({ type: "doc_read_start", filename: selected.label });

      emit({ type: "doc_read", filename: selected.label });
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
    } else if (a2aj) {
      if (a2aj.document?.url) a2ajDocuments.push(a2aj.document);
      if (a2aj.lookup?.status === "found" && a2aj.lookup.block) {
        a2ajLookups.push(a2aj.lookup);
      }
      if (legalEvidenceState) {
        registerLegalEvidence(legalEvidenceState, a2aj.evidence, {
          document: a2aj.document,
          lookup: a2aj.lookup,
        });
      }
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(a2aj.payload),
      });
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.searchCaseLaw) {
      const query = typeof args.query === "string" ? args.query : "";
      emit({ type: "courtlistener_search_case_law_start", query });
      const payload = await executeCourtlistenerTool(
        { name: tc.function.name, input: args },
        courtState,
        { db, apiToken: apiKeys?.courtlistener },
      );
      const event: CourtlistenerToolEvent = {
        type: "courtlistener_search_case_law",
        query,
        result_count: Array.isArray(payload?.results)
          ? payload.results.length
          : 0,
        ...(typeof payload?.error === "string"
          ? { error: payload.error }
          : {}),
      };
      emit(event);
      courtlistenerEvents.push(event);
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(payload),
      });
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
      emit({ type: "courtlistener_get_cases_start", cluster_ids: clusterIds });
      const payload = await executeCourtlistenerTool(
        { name: tc.function.name, input: args },
        courtState,
        { db, apiToken: apiKeys?.courtlistener },
      );
      const caseRecords = clusterIds.flatMap((clusterId) => {
        const record = courtState.casesByClusterId.get(clusterId);
        return record ? [record] : [];
      });
      for (const record of caseRecords) {
        emit({
          type: "case_opinions",
          cluster_id: record.clusterId,
          case: {
            id: record.clusterId,
            caseName: record.caseName,
            dateFiled: record.dateFiled,
            citations: record.citations,
            url: record.url,
            pdfUrl: record.pdfUrl,
            opinions: record.opinions,
          },
        });
      }
      const event: CourtlistenerToolEvent = {
        type: "courtlistener_get_cases",
        cluster_ids: clusterIds,
        case_count: numberField(payload, "case_count") ?? caseRecords.length,
        opinion_count:
          numberField(payload, "opinion_count") ??
          caseRecords.reduce(
            (count, record) => count + record.opinions.length,
            0,
          ),
        cases: caseRecords.map((record) => ({
          cluster_id: record.clusterId,
          case_name: record.caseName,
          citation: record.citations[0] ?? null,
          dateFiled: record.dateFiled,
          url: record.url,
        })),
        ...(stringField(payload, "error")
          ? { error: stringField(payload, "error")! }
          : {}),
      };
      emit(event);
      courtlistenerEvents.push(event);
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(payload),
      });
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.findInCase) {
      const { clusterId, query } = parseFindInCaseArgs(args);
      if (shouldGroupFindInCase) {
        if (!groupedFindInCaseStarted) {
          emit({
            type: "courtlistener_find_in_case_start",
            cluster_id: null,
            query: "",
            searches: groupedFindInCaseSearches,
          });
          groupedFindInCaseStarted = true;
        }
      } else {
        emit({
          type: "courtlistener_find_in_case_start",
          cluster_id: clusterId,
          query,
        });
      }
      const payload = await executeCourtlistenerTool(
        { name: tc.function.name, input: args },
        courtState,
        { db, apiToken: apiKeys?.courtlistener },
      );
      const event: CourtlistenerToolEvent = {
        type: "courtlistener_find_in_case",
        cluster_id: numberField(payload, "cluster_id") ?? clusterId,
        query,
        total_matches: numberField(payload, "total_matches") ?? 0,
        case_name: stringField(payload, "case_name"),
        citation: stringField(payload, "citation"),
        ...(stringField(payload, "error")
          ? { error: stringField(payload, "error")! }
          : {}),
      };
      if (shouldGroupFindInCase) {
        groupedFindInCaseEvents.push(event);
      } else {
        emit(event);
        courtlistenerEvents.push(event);
      }
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(payload),
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
      const payload = await executeCourtlistenerTool(
        { name: tc.function.name, input: args },
        courtState,
        { db, apiToken: apiKeys?.courtlistener },
      );
      const event: CourtlistenerToolEvent = {
        type: "courtlistener_lookup_case_locator",
        cluster_id: numberField(payload, "cluster_id") ?? clusterId,
        locator_type: locatorType,
        locator,
        status:
          stringField(payload, "status") ??
          (payload?.ok === true ? "found" : "unavailable"),
        ...(stringField(payload, "error")
          ? { error: stringField(payload, "error")! }
          : {}),
      };
      emit(event);
      courtlistenerEvents.push(event);
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(payload),
      });
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.readCase) {
      const clusterId =
        typeof args.clusterId === "number" && Number.isFinite(args.clusterId)
          ? Math.floor(args.clusterId)
          : typeof args.cluster_id === "number" &&
              Number.isFinite(args.cluster_id)
            ? Math.floor(args.cluster_id)
            : null;
      emit({ type: "courtlistener_read_case_start", cluster_id: clusterId });
      const payload = await executeCourtlistenerTool(
        { name: tc.function.name, input: args },
        courtState,
        { db, apiToken: apiKeys?.courtlistener },
      );
      const event: CourtlistenerToolEvent = {
        type: "courtlistener_read_case",
        cluster_id: numberField(payload, "cluster_id") ?? clusterId,
        case_name: stringField(payload, "case_name"),
        citation: stringArrayField(payload, "citations")[0] ?? null,
        opinion_count:
          payload?.ok === true
            ? numberField(payload, "returned_opinion_count") ?? 0
            : 0,
        ...(stringField(payload, "error")
          ? { error: stringField(payload, "error")! }
          : {}),
      };
      emit(event);
      courtlistenerEvents.push(event);
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(payload),
      });
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.verifyCitations) {
      const citations = Array.isArray(args.citations)
        ? args.citations.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const citationCount = citations.length;
      emit({
        type: "courtlistener_verify_citations_start",
        citation_count: citationCount,
      });
      try {
        const result = (await executeCourtlistenerTool(
          { name: tc.function.name, input: args },
          courtState,
          { db, apiToken: apiKeys?.courtlistener },
        )) as {
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
                emit(event);
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
        emit(event);
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
        emit(event);
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
        emit({
          type: "doc_edited_start",
          filename,
        });
        emit({
          type: "doc_edited",
          filename,
          document_id: documentId,
          version_id: "",
          download_url: "",
          annotations: [],
          error,
        });
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
        emit({
          type: "doc_edited_start",
          filename: docInfo.filename,
        });
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
          emit({
            type: "doc_edited",
            ...payload,
          });
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
              next_required_action: `Read doc_id "${docId}" before making factual claims about the edited contents.`,
            }),
          });
        } else {
          emit({
            type: "doc_edited",
            filename: docInfo.filename,
            document_id: indexed.document_id,
            version_id: "",
            download_url: "",
            annotations: [],
            error: result.error,
          });
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
      emit({ type: "doc_created_start", filename: previewFilename });
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
      emit({ type: "doc_created_start", filename: previewFilename });
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
      emit({ type: "doc_created_start", filename: previewFilename });
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
    emit(groupEvent);
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
