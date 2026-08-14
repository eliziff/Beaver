import type {
  NormalizedToolResult,
  OpenAIToolSchema,
} from "../llm";
import {
  LOCAL_ASSISTANT_TOOLS,
  createLocalAssistantRequirementsState,
  pendingFinalAgentDraft,
  runLocalAssistantTools,
} from "./localAssistantTools";
import { localAutomationEvent } from "./localAutomationEvent";
import { hideLegalSourceUrls } from "./legalToolResultVisibility";
import { createPublicLegalSourceState } from "./publicLegalSourceState";
import { LEGAL_EVIDENCE_TOOL_NAME } from "./legalEvidence";
import { normalizeAskInputsEvent } from "./askInputs";
import { readTabularCells } from "./tabularCells";
import { TABULAR_TOOLS } from "./tools/toolSchemas";
import type { ChatToolContext, ChatToolRunner } from "./turnEngine";
import type { TabularCellStore } from "./types";

const MUTATIONS = new Set([
  "generate_docx",
  "library_revise_docx",
  "library_delete_and_renumber_docx",
  "library_link_docx_citations",
  "library_fix_docx_supras",
  "Edit",
  "toa_submit_library_document",
]);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const toolReply = (id: string, payload: unknown): NormalizedToolResult => ({
  tool_use_id: id,
  content: JSON.stringify(payload),
});
const mutationContent = (result?: NormalizedToolResult) =>
  result?.mutationReceipt ?? result?.content;

function committedMutation(result?: NormalizedToolResult) {
  try {
    const payload = JSON.parse(mutationContent(result) ?? "{}") as {
      ok?: unknown;
      action?: unknown;
      receipt?: unknown;
      version_id?: unknown;
    };
    return payload.ok === true && payload.receipt === "mike-document:v1" &&
      ["created", "revised"].includes(String(payload.action)) &&
      text(payload.version_id)
      ? payload
      : null;
  } catch {
    return null;
  }
}

function documentEvent(tool: string, content?: string) {
  if (![
    "generate_docx",
    "library_revise_docx",
    "library_delete_and_renumber_docx",
    "library_link_docx_citations",
    "library_fix_docx_supras",
    "Edit",
  ].includes(tool) || !content) return null;
  try {
    const value = record(JSON.parse(content));
    if (value?.ok !== true || !text(value.filename) ||
        !text(value.document_id) || !text(value.version_id) ||
        !text(value.download_url)) return null;
    const common = {
      filename: text(value.filename),
      document_id: text(value.document_id),
      version_id: text(value.version_id),
      version_number: typeof value.version_number === "number"
        ? value.version_number
        : null,
      download_url: text(value.download_url),
    };
    if (tool === "generate_docx" && value.action === "created") {
      return { type: "doc_created" as const, ...common };
    }
    return value.action === "revised" && Array.isArray(value.annotations)
      ? { type: "doc_edited" as const, ...common, annotations: value.annotations }
      : null;
  } catch {
    return null;
  }
}

const runnerState = () => ({
  courtlistener: { casesByClusterId: new Map() },
  publicLegal: createPublicLegalSourceState(),
  pdfHandles: new Set<string>(),
  edits: new Map(),
  reads: new Map(),
  workingSets: new Map(),
  requirements: createLocalAssistantRequirementsState(),
});

export function createLocalChatToolRunner(options: {
  userId: string;
  projectId: string | null;
  allowedDocumentIds?: Set<string>;
  tabular?: TabularCellStore;
  onMutationCommitted: () => void;
}) {
  const main = runnerState();
  let mutationCommitted = false;
  let mainRunner: ChatToolRunner | null = null;
  let autoFlushCount = 0;
  const tools = [
    ...LOCAL_ASSISTANT_TOOLS,
    ...(options.tabular ? TABULAR_TOOLS as OpenAIToolSchema[] : []),
  ];
  const allowed = new Set([...tools.map(({ function: value }) => value.name),
    "ask_inputs", LEGAL_EVIDENCE_TOOL_NAME]);

  const createToolRunner = (
    evidence: ChatToolContext["evidence"],
    scope: "main" | "reader",
  ): ChatToolRunner => {
    const state = scope === "main" ? main : runnerState();
    const runner: ChatToolRunner = async (rawCalls, context) => {
      const calls = rawCalls.filter((call) => allowed.has(call.name));
      const ask = calls.find((call) => call.name === "ask_inputs");
      const requestedInputs = ask ? normalizeAskInputsEvent(ask.input) : null;
      if (requestedInputs?.items.length && !mutationCommitted && scope === "main") {
        return {
          results: calls.map((call) => toolReply(call.id, {
            ok: true,
            status: "waiting_for_user",
          })),
          pause: requestedInputs,
        };
      }
      const executable = requestedInputs?.items.length
        ? calls.filter((call) => call !== ask)
        : calls;
      const tableResults = new Map<string, NormalizedToolResult>(executable.flatMap((call) => {
        if (call.name !== "read_table_cells" || !options.tabular) return [];
        const indices = (value: unknown) => Array.isArray(value)
          ? value.filter((item): item is number => Number.isSafeInteger(item))
          : undefined;
        const read = readTabularCells(
          options.tabular,
          evidence,
          indices(call.input.col_indices),
          indices(call.input.row_indices),
        );
        const event = { type: "doc_read" as const, filename: read.label };
        if (scope === "main") {
          context.addEvent(event);
          context.emit(event);
        }
        return [[call.id, { tool_use_id: call.id, content: read.content }]];
      }));
      const direct = executable.filter((call) => call.name !== "read_table_cells");
      const directResults = (await runLocalAssistantTools(
        options.userId,
        direct,
        {
          ...state,
          allowedDocumentIds: options.allowedDocumentIds,
          matterId: options.projectId,
          legalEvidence: evidence,
        },
      )).map((result, index) => hideLegalSourceUrls(
        direct.find((call) => call.id === result.tool_use_id)?.name ??
          direct[index]?.name ?? "",
        result,
      ));
      let results = executable.map((call) => tableResults.get(call.id) ??
        directResults.find((result) => result.tool_use_id === call.id)!);
      if (requestedInputs?.items.length) {
        results = rawCalls.map((call) => call === ask
          ? toolReply(call.id, {
              ok: false,
              error: "ask_inputs must be called before document or workflow changes in a turn",
            })
          : results.find((result) => result.tool_use_id === call.id) ??
            toolReply(call.id, { ok: false, error: "Tool result is unavailable" }));
      }
      if (scope === "main") {
        for (const call of calls) {
          const result = results.find((item) => item.tool_use_id === call.id);
          const event = documentEvent(call.name, mutationContent(result));
          if (event) {
            context.addEvent(event);
            context.emit({
              type: event.type === "doc_created" ? "doc_created_start" : "doc_edited_start",
              filename: event.filename,
            });
            context.emit(event);
          }
          const automation = localAutomationEvent(call.name, result?.content, call.id);
          if (automation) {
            context.addEvent(automation);
            context.emit(automation);
          }
        }
        const wasCommitted = mutationCommitted;
        mutationCommitted ||= calls.some((call) =>
          MUTATIONS.has(call.name) && committedMutation(
            results.find((result) => result.tool_use_id === call.id),
          ),
        );
        if (!wasCommitted && mutationCommitted) options.onMutationCommitted();
        const terminalCreate = calls.length > 0 && calls.every((call) =>
          call.name === "generate_docx" && committedMutation(
            results.find((result) => result.tool_use_id === call.id),
          )?.action === "created",
        );
        if (terminalCreate) results.forEach((result) => { result.terminal = true; });
      }
      return { results };
    };
    if (scope === "main") mainRunner = runner;
    return runner;
  };

  return {
    tools,
    readerTools: tools,
    createToolRunner,
    pdfHandles: main.pdfHandles,
    mutationCommitted: () => mutationCommitted,
    async beforeFinalize(context: ChatToolContext) {
      const draft = pendingFinalAgentDraft(main.requirements);
      if (!draft || !mainRunner) return;
      const result = await mainRunner([{
        id: "host-final-agent-flush",
        name: "generate_docx",
        input: draft,
      }], context);
      if (committedMutation(result.results[0])?.action !== "created") {
        throw new Error("Pending DOCX output could not be committed.");
      }
      autoFlushCount++;
    },
    metrics: () => ({ ...main.requirements, autoFlushCount }),
  };
}
