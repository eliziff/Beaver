import {
  COURTLISTENER_TOOL_NAMES,
  type CaseCitationEvent,
  type CourtlistenerToolEvent,
} from "./courtlistenerTools";
import { executeA2AJTool } from "./a2ajTools";
import {
  LEGAL_EVIDENCE_TOOL_NAME,
  createLibraryEvidence,
  registerLegalEvidence,
  submitLegalEvidenceAnswer,
  type LegalEvidenceTurnState,
} from "../legalEvidence";
import { PUBLIC_LEGAL_SOURCE_TOOL_NAMES } from "./publicLegalSourceTools";
import type { A2AJDocument, A2AJLocatorLookup } from "../../a2aj";
import {
  createPublicLegalSourceState,
  executePublicLegalSourceTool,
  type PublicLegalSourceState,
} from "../publicLegalSourceState";
import {
  courtlistenerStartEvent,
  isCourtlistenerTool,
  runCourtlistenerTool,
  type CourtlistenerToolState,
} from "../courtlistenerToolRunner";
import type { McpToolEvent } from "../../mcpConnectors";
import type {
  NormalizedToolCall,
  NormalizedToolResult,
} from "../../llm";
import { createServerSupabase } from "../../supabase";
import {
  type DocStore,
  type DocIndex,
  type TabularCellStore,
  type WorkflowStore,
  type AskInputsEvent,
  devLog,
  resolveDocLabel,
} from "../types";
import { normalizeAskInputsEvent } from "../askInputs";
import { readTabularCells } from "../tabularCells";
import { type EditInput, type EditMode } from "../../docxTrackedChanges";
import { resolveDocxEvidenceCitations } from "../../docxEvidenceCitations";
import {
  assignmentClosureCandidates,
  assignmentClosureReceipts,
} from "../../legalAssignmentClosure";
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

export type CourtlistenerTurnState = CourtlistenerToolState;

export type ToolCallOptions = {
  docStore: DocStore;
  userId: string;
  db: ReturnType<typeof createServerSupabase>;
  emit: (payload: unknown) => void;
  workflowStore?: WorkflowStore;
  tabularStore?: TabularCellStore;
  docIndex?: DocIndex;
  editState?: TurnEditState;
  readState?: TurnReadState;
  projectId?: string | null;
  courtlistener?: CourtlistenerTurnState;
  apiKeys?: import("../../llm").UserApiKeys;
  publicLegal?: PublicLegalSourceState;
  legalEvidence?: LegalEvidenceTurnState;
  editMode?: EditMode;
};

type CapturedDocumentSource = {
  text: string;
  projection: "canonical" | "drafting" | "redline";
};

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
  toolCalls: NormalizedToolCall[],
  {
    docStore,
    userId,
    db,
    emit,
    workflowStore,
    tabularStore,
    docIndex,
    editState: turnEditState,
    readState: turnReadState,
    projectId,
    courtlistener: courtlistenerState,
    apiKeys,
    publicLegal: publicLegalState,
    legalEvidence: legalEvidenceState,
    editMode = "manual",
  }: ToolCallOptions,
): Promise<{
  toolResults: NormalizedToolResult[];
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
  const toolResults: NormalizedToolResult[] = [];
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
  const reply = (
    call: NormalizedToolCall,
    content: unknown,
    terminal = false,
  ) => toolResults.push({
    tool_use_id: call.id,
    content: typeof content === "string" ? content : JSON.stringify(content),
    ...(terminal ? { terminal: true } : {}),
  });
  const rememberPassages = (
    identity: Awaited<ReturnType<typeof getTurnReadIdentity>>,
    key: string | null,
    passages: Array<CapturedDocumentSource & { at: number }>,
  ) => {
    if (!identity || !key || !turnReadState) return;
    const prior = turnReadState.get(key);
    const merged = [...(prior?.passages ?? [])];
    const candidates = passages.flatMap((passage) =>
      assignmentClosureCandidates({
        document: identity.filename,
        documentId: identity.documentId,
        versionId: identity.versionId,
        projection: passage.projection,
        text: passage.text,
        at: passage.at,
      }),
    );
    for (const passage of candidates) {
      if (
        !merged.some(
          (item) =>
            item.at === passage.at &&
            item.projection === passage.projection &&
            item.text === passage.text,
        )
      ) {
        merged.push({
          text: passage.text,
          at: passage.at,
          projection: passage.projection as CapturedDocumentSource["projection"],
        });
      }
    }
    turnReadState.set(key, { ...identity, passages: merged });
  };
  const registerDocumentEvidence = (
    identity: Awaited<ReturnType<typeof getTurnReadIdentity>>,
    source?: CapturedDocumentSource,
  ) => {
    if (!legalEvidenceState || !identity || !source?.text.trim()) return null;
    const receipt = createLibraryEvidence({
      documentId: identity.documentId ?? identity.docLabel,
      versionId: identity.versionId ?? identity.storagePath,
      filename: identity.filename,
      sourceText: source.text,
      spanText: source.text,
      start: 0,
      end: source.text.length,
    });
    registerLegalEvidence(legalEvidenceState, receipt);
    return receipt.evidence_id;
  };
  const sourceClosureForDraft = (draft: string) =>
    /\bassign/iu.test(draft)
      ? assignmentClosureReceipts(
          [...(turnReadState?.values() ?? [])].flatMap((entry) =>
            (entry.passages ?? []).map((passage) => ({
              document: entry.filename || entry.docLabel,
              documentId: entry.documentId,
              versionId: entry.versionId,
              projection: passage.projection,
              text: passage.text,
              at: passage.at,
            })),
          ),
          draft,
        )
      : [];
  const courtState: CourtlistenerTurnState = courtlistenerState ?? {
    casesByClusterId: new Map(),
  };
  const publicState = publicLegalState ?? createPublicLegalSourceState();
  const groupedFindInCaseSearches = toolCalls
    .filter((tc) => tc.name === COURTLISTENER_TOOL_NAMES.findInCase)
    .map((tc) => {
      const parsed = parseFindInCaseArgs(tc.input);
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
    tc: NormalizedToolCall,
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
    const hasSourceClosure =
      Array.isArray(safeToolResult.source_closure) &&
      safeToolResult.source_closure.length > 0;
    const toolResultPayload = newDocLabel
      ? {
          ...safeToolResult,
          doc_id: newDocLabel,
          // Only what the prompt cannot already teach: this doc_id, and that
          // the rendered text — not your intent — is the source of truth.
          next_required_action: hasSourceClosure
            ? `Review source_closure; if material, edit doc_id "${newDocLabel}", then read it before describing or citing it.`
            : `Read doc_id "${newDocLabel}" before describing or citing it; describe what it actually renders, not what you intended.`,
        }
      : safeToolResult;
    reply(tc, toolResultPayload);
  };

  for (const tc of toolCalls) {
    const args = tc.input;
    const a2aj = await executeA2AJTool(tc.name, args);

    if (tc.name === LEGAL_EVIDENCE_TOOL_NAME) {
      const submitted = legalEvidenceState
        ? submitLegalEvidenceAnswer(args, legalEvidenceState)
        : { ok: false, errors: ["Legal evidence state is unavailable"] };
      reply(tc, submitted, submitted.terminal === true);
      continue;
    }

    if (tc.name.startsWith("mcp_")) {
      emit({
        type: "mcp_tool_start",
        name: tc.name,
      });
      const { content, event } = await (
        await import("../../mcpConnectors")
      ).executeMcpToolCall(
        userId,
        tc.name,
        args,
        db,
      );
      reply(tc, content);
      mcpEvents.push(event);
      emit({
        type: "mcp_tool_result",
        name: tc.name,
        connector_name: event.connector_name,
        tool_name: event.tool_name,
        status: event.status,
        error: event.error,
      });
      continue;
    }

    if (tc.name === "ask_inputs") {
      const event = normalizeAskInputsEvent(args);
      if (event.items.length > 0) askInputsEvents.push(event);
      continue;
    }

    if (tc.name === "read_document") {
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
        reply(tc, duplicateReadDocumentResult(readIdentity));
        continue;
      }
      const captured: CapturedDocumentSource[] = [];
      const content = await readDocumentContent(
        docId,
        docStore,
        emit,
        docIndex,
        db,
        { mode: readMode, captureSource: (source) => captured.push(source) },
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
        rememberPassages(
          readIdentity,
          readKey,
          captured[0] ? [{ ...captured[0], at: 0 }] : [],
        );
      }
      const evidenceId = readSucceeded
        ? registerDocumentEvidence(readIdentity, captured[0])
        : null;
      if (readSucceeded && filename) {
        docsRead.push({ filename, document_id: documentId });
      }
      reply(tc, filename && readMode === "text"
        ? `${citationReminder(docId, filename)}\n\n${content}${
            evidenceId ? `\n\nCitation evidence_id: ${evidenceId}` : ""
          }`
        : content);
    } else if (tc.name === "find_in_document") {
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
            hits?: Array<{
              at?: number;
              excerpt?: string;
              paragraph_tail?: string;
            }>;
          };
          totalMatches = parsed.total_matches ?? 0;
          const identity = await getTurnReadIdentity({
            docLabel: docId,
            docStore,
            docIndex,
            db,
          });
          rememberPassages(
            identity,
            identity ? `${identity.key}:find` : null,
            (parsed.hits ?? []).flatMap((hit) =>
              typeof hit.at === "number" && typeof hit.excerpt === "string"
                ? [
                    {
                      at: hit.at,
                      projection: "canonical" as const,
                      text: hit.excerpt + (hit.paragraph_tail ?? ""),
                    },
                  ]
                : [],
            ),
          );
        } catch {
          /* ignore — still record the find attempt */
        }
        docsFound.push({
          filename,
          query,
          total_matches: totalMatches,
        });
      }
      reply(tc, content);
    } else if (tc.name === "list_documents") {
      const list = Array.from(docStore.entries()).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        file_type: info.file_type,
        app_url: appUrl({
          kind: "library-document",
          projectId,
        }),
      }));
      reply(tc, list);
    } else if (tc.name === "fetch_documents") {
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
        const captured: CapturedDocumentSource[] = [];
        const content = await readDocumentContent(
          docId,
          docStore,
          emit,
          docIndex,
          db,
          { captureSource: (source) => captured.push(source) },
        );
        const filename = docStore.get(docId)?.filename ?? docId;
        if (readIdentity && readKey && turnReadState) {
          rememberPassages(
            readIdentity,
            readKey,
            captured[0] ? [{ ...captured[0], at: 0 }] : [],
          );
        }
        const evidenceId = registerDocumentEvidence(readIdentity, captured[0]);
        parts.push(
          `--- ${filename} (${docId}) ---\n${citationReminder(docId, filename)}\n\n${content}${
            evidenceId ? `\n\nCitation evidence_id: ${evidenceId}` : ""
          }`,
        );
        if (docStore.get(docId)) {
          const documentId = docIndex?.[docId]?.document_id;
          docsRead.push({ filename, document_id: documentId });
        }
      }
      reply(tc, parts.join("\n\n"));
    } else if (tc.name === "list_workflows") {
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
      reply(tc, list);
    } else if (tc.name === "read_workflow") {
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
      reply(tc, wf ? wf.skill_md : `Workflow '${wfId}' not found.`);
    } else if (
      tc.name === "read_table_cells" &&
      tabularStore &&
      legalEvidenceState
    ) {
      const colIndices = args.col_indices as number[] | undefined;
      const rowIndices = args.row_indices as number[] | undefined;
      const selected = readTabularCells(
        tabularStore,
        legalEvidenceState,
        colIndices,
        rowIndices,
      );

      emit({ type: "doc_read_start", filename: selected.label });

      emit({ type: "doc_read", filename: selected.label });
      docsRead.push({ filename: selected.label });
      reply(tc, selected.content);
    } else if (
      tc.name === PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch ||
      tc.name === PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup
    ) {
      const publicLegalResult = await executePublicLegalSourceTool(
        tc.name,
        args,
        publicState,
      );
      if (legalEvidenceState) {
        for (const evidence of publicLegalResult?.evidences ?? []) {
          registerLegalEvidence(legalEvidenceState, evidence);
        }
      }
      reply(tc, publicLegalResult?.payload ?? {
        ok: false,
        error: "Public legal tool unavailable.",
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
      reply(tc, a2aj.payload);
    } else if (isCourtlistenerTool(tc.name)) {
      if (tc.name === COURTLISTENER_TOOL_NAMES.findInCase && shouldGroupFindInCase) {
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
        const start = courtlistenerStartEvent(tc);
        if (start) emit(start);
      }
      const executed = await runCourtlistenerTool(tc, courtState, {
        db,
        apiToken: apiKeys?.courtlistener,
        legalEvidenceState,
      });
      if (!executed) continue;
      for (const event of executed.caseOpinions) emit(event);
      for (const event of executed.caseCitations) {
        emit(event);
        caseCitationEvents.push(event);
      }
      if (tc.name === COURTLISTENER_TOOL_NAMES.findInCase && shouldGroupFindInCase) {
        groupedFindInCaseEvents.push(executed.event as Extract<
          CourtlistenerToolEvent,
          { type: "courtlistener_find_in_case" }
        >);
      } else {
        emit(executed.event);
        courtlistenerEvents.push(executed.event);
      }
      reply(tc, executed.result.content);
    } else if (tc.name === "edit_document" && docIndex) {
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
        reply(tc, { error: err });
      } else if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
        const err = "edits array is required and must not be empty.";
        emitEditError(docInfo.filename, indexed.document_id, err);
        reply(tc, { error: err });
      } else if (docInfo.file_type !== "docx") {
        const err = "edit_document only supports .docx files.";
        emitEditError(docInfo.filename, indexed.document_id, err);
        reply(tc, { error: err });
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
          editMode,
        });

        if (result.ok) {
          turnEditState?.set(indexed.document_id, {
            versionId: result.version_id,
            versionNumber: result.version_number,
            storagePath: result.storage_path,
          });
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
          const finalSources: CapturedDocumentSource[] = [];
          await readDocumentContent(
            docId,
            docStore,
            () => undefined,
            docIndex,
            db,
            {
              emitEvents: false,
              includeNotes: false,
              captureSource: (source) => finalSources.push(source),
            },
          );
          const sourceClosure = finalSources[0]
            ? sourceClosureForDraft(finalSources[0].text)
            : [];
          clearTurnReadsForDocument(turnReadState, indexed.document_id);
          const payload: DocEditedResult = {
            filename: docInfo.filename,
            document_id: indexed.document_id,
            version_id: result.version_id,
            version_number: result.version_number,
            download_url: result.download_url,
            edit_mode: result.edit_mode,
            annotations: result.annotations,
          };
          docsEdited.push(payload);
          emit({
            type: "doc_edited",
            ...payload,
          });
          reply(tc, {
            ok: true,
            doc_id: docId,
            document_id: indexed.document_id,
            version_id: result.version_id,
            version_number: result.version_number,
            applied: result.annotations.length,
            errors: result.errors,
            ...(sourceClosure.length ? { source_closure: sourceClosure } : {}),
            next_required_action: sourceClosure.length
              ? `Review source_closure; if material, edit doc_id "${docId}" again, then read it before making factual claims.`
              : `Read doc_id "${docId}" before making factual claims about the edited contents.`,
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
          reply(tc, { ok: false, error: result.error });
        }
      }
    } else if (tc.name === "generate_docx") {
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
      const generated = result as Record<string, unknown>;
      const sourceClosure =
        generated.error === undefined
          ? sourceClosureForDraft(
              typeof args.markdown === "string" ? args.markdown : "",
            )
          : [];
      registerGeneratedDocument(
        tc,
        {
          ...generated,
          ...(sourceClosure.length ? { source_closure: sourceClosure } : {}),
        },
        previewFilename,
        "docx",
      );
    } else if (tc.name === "generate_excel") {
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
    } else if (tc.name === "generate_ppt") {
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
