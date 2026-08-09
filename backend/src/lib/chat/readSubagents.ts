import { getCodexModelCatalog, type CodexModelCatalog } from "../codexCatalog";
import { streamChatWithTools } from "../llm";
import type {
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
} from "../llm";
import { SOURCE_SEARCH_SYSTEM_PROMPT } from "./prompts";
import {
  legalEvidenceReceiptEvent,
  renderLegalEvidenceAnswer,
  type LegalEvidenceReceiptEvent,
  type LegalEvidenceTurnState,
} from "./legalEvidenceExperiment";

export const READ_SUBAGENT_TOOL_NAME = "delegate_read";
const DEFAULT_MODEL_SLUG = "gpt-5.6-luna";
const DEFAULT_EFFORT = "high";
const MAX_TASK_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_REPAIR_CONTEXT_CHARS = 16_000;

export type ReadSubagentRole = "scout";

export type ReadSubagentEvent = {
  type: "subagent_run";
  id: string;
  agent: ReadSubagentRole;
  task: string;
  model: string;
  effort: string;
  status: "running" | "completed" | "error";
  output?: string;
  error?: string;
  grounding?: LegalEvidenceReceiptEvent;
};

export type ReadSubagentCapability = {
  available: boolean;
  serverEnabled: boolean;
  model: string;
  displayName: string;
  effort: string;
  reason?: string;
};

const ROLE_INSTRUCTIONS =
  "Read or find exactly what the assigned task requests. Return condensed context for the main assistant, preserving legally material qualifications and contrary text. Do not broaden the assignment, plan work, or recommend next steps.";

export const READ_SUBAGENT_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: READ_SUBAGENT_TOOL_NAME,
    description:
      "Delegate one bounded, read-only task to an independent reading agent. For broad research, issue two or three calls together with non-overlapping courts, source collections, or search strategies. Do not use it for simple lookups, deterministic operations, or any write task. The result is supporting context, not legal evidence, so verify controlling text with normal evidence tools before relying on it.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TASK_CHARS,
          description:
            "A self-contained reading task, including the question and the sources or scope to inspect.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
};

export const READ_SUBAGENT_SYSTEM_PROMPT =
  "When broad research has independent lanes, delegate two or three sibling reading tasks in the same tool turn so they run concurrently. Divide them into non-overlapping scopes by jurisdiction or court, source collection, or genuinely different search strategy; ask each to surface contrary material. Keep simple lookups, deterministic work, and tasks without useful independent lanes in the main turn. Wait for all sibling results and compare them before synthesizing. Reading-agent output is supporting context, never authoritative evidence; retrieve and cite controlling source text with the normal evidence tools.";

const GROUNDED_ANSWER_INSTRUCTIONS =
  "Finish only with submit_grounded_answer. Its top-level object contains only claims. Every claim requires text, evidence_ids, kind, premise_source, and premise_text. Use exact evidence_id values returned by retrieval tools. kind is quotation, conclusion, or premise_correction; premise_source and premise_text must be null unless correcting a premise. Do not put citation or pinpoint prose in text because Beaver renders it from the evidence receipts.";

const READ_TOOL_NAMES = new Set([
  "Glob",
  "Grep",
  "Read",
  "list_documents",
  "fetch_documents",
  "read_document",
  "find_in_document",
  "list_workflows",
  "read_workflow",
  "library_list",
  "library_read",
  "library_outline",
  "library_links",
  "library_find",
  "library_lookup",
  "library_evidence",
  "legal_pdf_lookup",
  "SearchSources",
  "a2aj_fetch",
  "a2aj_lookup",
  "courtlistener_get_cases",
  "courtlistener_find_in_case",
  "courtlistener_lookup_case_locator",
  "courtlistener_read_case",
  "courtlistener_verify_citations",
  "public_legal_source_fetch",
  "public_legal_source_lookup",
  "hansard_fetch",
  "caselaw_note_up",
  "consult_attested_characterization",
]);

/** Fail-closed allowlist: new tools never reach a reading agent by accident. */
export function readSubagentTools(tools: OpenAIToolSchema[]) {
  return tools.filter((tool) => READ_TOOL_NAMES.has(tool.function.name));
}

export async function getReadSubagentCapability(
  catalog?: CodexModelCatalog,
  selection?: { model?: string; effort?: string },
): Promise<ReadSubagentCapability> {
  const model =
    selection?.model?.trim().replace(/^codex:/u, "") ||
    process.env.MIKE_READ_SUBAGENT_MODEL?.trim() ||
    DEFAULT_MODEL_SLUG;
  const effort =
    selection?.effort?.trim() ||
    process.env.MIKE_READ_SUBAGENT_EFFORT?.trim() ||
    DEFAULT_EFFORT;
  if (process.env.MIKE_READ_SUBAGENTS === "0") {
    return {
      available: false,
      serverEnabled: false,
      model,
      displayName: model,
      effort,
      reason: "Reading agents are disabled by the server.",
    };
  }
  const resolvedCatalog = catalog ?? (await getCodexModelCatalog());
  const selected = resolvedCatalog.models.find((item) => item.slug === model);
  if (!selected) {
    return {
      available: false,
      serverEnabled: true,
      model,
      displayName: model,
      effort,
      reason: "The configured Codex reading model is unavailable.",
    };
  }
  if (
    !selected.supportedReasoningLevels.some(
      (level) => level.effort.toLowerCase() === effort.toLowerCase(),
    )
  ) {
    return {
      available: false,
      serverEnabled: true,
      model,
      displayName: selected.displayName,
      effort,
      reason: "The configured reasoning effort is unavailable for this model.",
    };
  }
  return {
    available: true,
    serverEnabled: true,
    model,
    displayName: selected.displayName,
    effort,
  };
}

export function readSubagentActivityLabel(_input: Record<string, unknown>) {
  return "Reading agent";
}

export async function runReadSubagent(params: {
  call: NormalizedToolCall;
  tools: OpenAIToolSchema[];
  runTools: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
  signal?: AbortSignal;
  onEvent?: (event: ReadSubagentEvent) => void;
  evidenceState: LegalEvidenceTurnState;
  model?: string;
  effort?: string;
}): Promise<NormalizedToolResult> {
  const role: ReadSubagentRole = "scout";
  const task =
    typeof params.call.input.task === "string"
      ? params.call.input.task.trim().slice(0, MAX_TASK_CHARS)
      : "";
  if (!task) {
    return {
      tool_use_id: params.call.id,
      status: "error",
      content: JSON.stringify({
        ok: false,
        error: "task is required.",
      }),
    };
  }

  const capability = await getReadSubagentCapability(undefined, {
    model: params.model,
    effort: params.effort,
  });
  if (!capability.available) {
    return {
      tool_use_id: params.call.id,
      status: "error",
      content: JSON.stringify({ ok: false, error: capability.reason }),
    };
  }

  const baseEvent = {
    type: "subagent_run" as const,
    id: params.call.id,
    agent: role,
    task,
    model: capability.displayName,
    effort: capability.effort,
  };
  params.onEvent?.({ ...baseEvent, status: "running" });
  try {
    const feedback: string[] = [];
    const runTools = async (calls: NormalizedToolCall[]) => {
      const results = await params.runTools(calls);
      feedback.push(
        ...results.map(
          (result) =>
            `${calls.find((call) => call.id === result.tool_use_id)?.name ?? "tool"}: ${result.content}`,
        ),
      );
      return results;
    };
    const run = (content: string) =>
      streamChatWithTools({
        model: `codex:${capability.model}`,
        reasoningEffort: capability.effort,
        enableThinking: true,
        maxIterations: 8,
        abortSignal: params.signal,
        systemPrompt: `${ROLE_INSTRUCTIONS}\n\n${SOURCE_SEARCH_SYSTEM_PROMPT}\n\nRemain strictly read-only and use only the supplied retrieval tools. ${GROUNDED_ANSWER_INSTRUCTIONS}`,
        messages: [{ role: "user", content }],
        tools: params.tools,
        runTools,
      });
    await run(task);
    let rendered = renderLegalEvidenceAnswer(params.evidenceState);
    let grounding = legalEvidenceReceiptEvent(params.evidenceState);
    if (!rendered || grounding?.status !== "passed") {
      const priorFeedback = feedback.join("\n\n").slice(-MAX_REPAIR_CONTEXT_CHARS);
      const rejection =
        grounding?.bounces.at(-1)?.errors.join("; ") ??
        grounding?.failure ??
        "No grounded submission was received.";
      await run(
        `${task}\n\nYour previous attempt did not pass the grounding gate: ${rejection}\n\nRevise once using the schema and tool feedback below. You may retrieve more passages if needed.\n\n${priorFeedback || "No tool feedback was returned; retrieve evidence before submitting."}`,
      );
      rendered = renderLegalEvidenceAnswer(params.evidenceState);
      grounding = legalEvidenceReceiptEvent(params.evidenceState);
    }
    if (!rendered || grounding?.status !== "passed") {
      const message =
        grounding?.failure ??
        "Reading agent did not submit a receipt-backed grounded answer.";
      params.onEvent?.({ ...baseEvent, status: "error", error: message });
      return {
        tool_use_id: params.call.id,
        status: "error",
        content: JSON.stringify({ ok: false, error: message }),
      };
    }
    const output =
      rendered.length <= MAX_OUTPUT_CHARS
        ? rendered
        : `${rendered.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated]`;
    params.onEvent?.({
      ...baseEvent,
      status: "completed",
      output,
      grounding,
    });
    return {
      tool_use_id: params.call.id,
      status: "ok",
      content: JSON.stringify({
        ok: true,
        agent: role,
        model: capability.displayName,
        effort: capability.effort,
        output,
        grounding,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reading agent failed.";
    params.onEvent?.({ ...baseEvent, status: "error", error: message });
    return {
      tool_use_id: params.call.id,
      status: "error",
      content: JSON.stringify({ ok: false, error: message }),
    };
  }
}
