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
import { assistantToolActivityLabel } from "./tools/a2ajTools";

export const READ_SUBAGENT_TOOL_NAME = "delegate_read";
const DEFAULT_MODEL_SLUG = "gpt-5.6-luna";
const DEFAULT_EFFORT = "high";
const MAX_TASK_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_REPAIR_CONTEXT_CHARS = 16_000;

export type ReadSubagentRole = "scout";
export type ReadSubagentActivity = {
  id: string;
  label: string;
  status: "running" | "completed" | "error";
  tool?: string;
  input?: Record<string, unknown>;
  source?: ReadSubagentSource;
};

export type ReadSubagentSource = {
  provider: string;
  jurisdiction: string;
  citation: string;
  name: string | null;
  dataset: string;
  url: string | null;
  clusterId?: number;
};

function discoveredCaseSources(
  call: NormalizedToolCall,
  result: NormalizedToolResult,
): ReadSubagentSource[] {
  if (
    !["SearchSources", "a2aj_search", "courtlistener_search_case_law"].includes(
      call.name,
    ) ||
    (call.name === "a2aj_search" && call.input.doc_type === "laws")
  )
    return [];
  try {
    const payload = JSON.parse(result.content) as { results?: unknown };
    if (!Array.isArray(payload.results)) return [];
    return payload.results.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      if (call.name === "SearchSources" && row.source_type !== "case") return [];
      const citation =
        typeof row.citation === "string" ? row.citation.trim() : "";
      if (!citation) return [];
      const provider =
        typeof row.provider === "string"
          ? row.provider
          : call.name.startsWith("courtlistener_")
            ? "courtlistener"
            : "a2aj";
      const nameValue = row.title ?? row.name ?? row.caseName;
      const datasetValue = row.collection ?? row.dataset ?? row.court;
      const clusterValue = row.identifier ?? row.clusterId;
      return [{
        provider,
        jurisdiction: provider === "courtlistener" ? "US" : "CA",
        citation,
        name: typeof nameValue === "string" && nameValue.trim()
          ? nameValue.trim()
          : null,
        dataset: typeof datasetValue === "string" ? datasetValue : "",
        url: typeof row.url === "string" ? row.url : null,
        ...(typeof clusterValue === "number" && { clusterId: clusterValue }),
      }];
    });
  } catch {
    return [];
  }
}

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
  activities?: ReadSubagentActivity[];
  reasoning?: string[];
  sources?: ReadSubagentSource[];
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
      "Delegate one bounded, read-only slice to an independent reading agent. A turn may use at most three reading agents total. Use multiple agents only for genuinely non-overlapping courts within the standing region, source collections, periods, or search strategies; never repeat the same assignment. An unqualified request about multiple jurisdictions means jurisdictions within the standing region, not different countries or world regions. Use fewer than three when useful independent slices do not exist. Do not use it for simple lookups, deterministic operations, or any write task. Completed results are already grounded; synthesize their claims with the returned evidence IDs without re-fetching them.",
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
        scope: {
          type: "string",
          minLength: 1,
          maxLength: 240,
          description:
            "The distinct slice assigned to this agent, such as a named court set, source collection, date period, or search strategy. Sibling calls must not overlap.",
        },
      },
      required: ["task", "scope"],
      additionalProperties: false,
    },
  },
};

export const READ_SUBAGENT_SYSTEM_PROMPT =
  "When broad research has independent lanes, delegate at most three sibling reading tasks in the same tool turn so they run concurrently. Give each a specific, non-overlapping scope by court or jurisdiction within the standing region, source collection, period, or genuinely different search strategy. Never turn an unqualified request about multiple jurisdictions into different countries or world regions. Never use United States or United Kingdom law as a lane unless the user's current request or selected regions expressly include it. Never clone or lightly rephrase one assignment. Use one or two agents when that is the useful division, and keep tasks without independent lanes in the main turn. Wait for all sibling results, then compile and compare their grounded claims. Reuse their evidence IDs directly; do not re-read a source merely to verify a completed reader result. Re-fetch only when a needed proposition lacks an evidence ID or the reader results conflict.";

export type ReadSubagentForeignRegion = "US" | "UK";

const FOREIGN_REGION_TERMS: Record<
  ReadSubagentForeignRegion,
  readonly RegExp[]
> = {
  US: [
    /\bUS\b/u,
    /\b(?:United States|U\.S\.|USA|American(?: law| cases?| decisions?| courts?)|SCOTUS|CourtListener)\b/iu,
  ],
  UK: [
    /\bUK\b/u,
    /\b(?:United Kingdom|U\.K\.|UKSC|EWCA|EWHC|BAILII|English (?:law|cases?|decisions?|courts?)|England and Wales|Scots? law|Scottish (?:cases?|decisions?|courts?)|Northern Ireland(?: law| cases?| decisions?| courts?)?)\b/iu,
  ],
};

function mentionsForeignRegion(region: ReadSubagentForeignRegion, text: string) {
  return FOREIGN_REGION_TERMS[region].some((pattern) => pattern.test(text));
}

export function allowedReadSubagentForeignRegions(
  preference: { mode: "ask" | "presume"; jurisdictions: string[] } | null,
  currentRequest: string,
) {
  const allowed = new Set<ReadSubagentForeignRegion>();
  const context = [
    currentRequest,
    ...(preference?.mode === "presume" ? preference.jurisdictions : []),
  ].join("\n");
  for (const region of Object.keys(
    FOREIGN_REGION_TERMS,
  ) as ReadSubagentForeignRegion[]) {
    if (mentionsForeignRegion(region, context)) allowed.add(region);
  }
  return allowed;
}

export function createReadSubagentAdmission(
  maxAgents = 3,
  allowedForeignRegions: ReadonlySet<ReadSubagentForeignRegion> = new Set(),
) {
  let admitted = 0;
  const scopes = new Set<string>();
  return (calls: NormalizedToolCall[]) => {
    const accepted: NormalizedToolCall[] = [];
    const rejected: NormalizedToolResult[] = [];
    for (const call of calls) {
      const scope =
        typeof call.input.scope === "string"
          ? call.input.scope.replace(/\s+/gu, " ").trim().toLocaleLowerCase()
          : "";
      const assignment = `${scope}\n${typeof call.input.task === "string" ? call.input.task : ""}`;
      const blockedRegion = (
        Object.keys(FOREIGN_REGION_TERMS) as ReadSubagentForeignRegion[]
      ).find(
        (region) =>
          !allowedForeignRegions.has(region) &&
          mentionsForeignRegion(region, assignment),
      );
      const error =
        !scope
          ? "Reading agents require a distinct scope."
          : blockedRegion
            ? `${blockedRegion} law was not requested. Keep reading-agent assignments within the standing region.`
          : scopes.has(scope)
            ? "This reading-agent scope duplicates one already assigned in this turn."
            : admitted >= maxAgents
              ? `A turn may use at most ${maxAgents} reading agents.`
              : null;
      if (error) {
        rejected.push({
          tool_use_id: call.id,
          status: "error",
          content: JSON.stringify({ ok: false, error }),
        });
        continue;
      }
      scopes.add(scope);
      admitted += 1;
      accepted.push(call);
    }
    return { accepted, rejected };
  };
}

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

export function readSubagentActivityLabel(input: Record<string, unknown>) {
  const scope =
    typeof input.scope === "string"
      ? input.scope.replace(/\s+/gu, " ").trim().slice(0, 80)
      : "";
  const task =
    typeof input.task === "string"
      ? input.task.replace(/\s+/gu, " ").trim().slice(0, 100)
      : "";
  const assignment = scope || task;
  return assignment
    ? `Coordinating reading agent: ${assignment}`
    : "Coordinating reading agent";
}

export async function runReadSubagent(params: {
  call: NormalizedToolCall;
  tools: OpenAIToolSchema[];
  runTools: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
  signal?: AbortSignal;
  onEvent?: (event: ReadSubagentEvent) => void;
  evidenceState: LegalEvidenceTurnState;
  publishEvidenceTo?: LegalEvidenceTurnState;
  model?: string;
  effort?: string;
  activityDetail?: "standard" | "tools" | "trace";
  jurisdictionPrompt?: string;
}): Promise<NormalizedToolResult> {
  const role: ReadSubagentRole = "scout";
  const task =
    typeof params.call.input.task === "string"
      ? params.call.input.task.trim().slice(0, MAX_TASK_CHARS)
      : "";
  const scope =
    typeof params.call.input.scope === "string"
      ? params.call.input.scope.trim().slice(0, 240)
      : "";
  if (!task || !scope) {
    return {
      tool_use_id: params.call.id,
      status: "error",
      content: JSON.stringify({
        ok: false,
        error: "task and scope are required.",
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
    task: `${scope}: ${task}`,
    model: capability.displayName,
    effort: capability.effort,
  };
  const activities: ReadSubagentActivity[] = [];
  const discoveredSources = new Map<string, ReadSubagentSource>();
  const reasoning: string[] = [];
  let currentReasoning = "";
  const eventActivities = () => activities.map((item) => ({ ...item }));
  const eventReasoning = () => [
    ...reasoning,
    ...(currentReasoning ? [currentReasoning] : []),
  ];
  const eventSources = () => {
    const sources = [
      ...discoveredSources.values(),
      ...[...params.evidenceState.evidence.values()].flatMap(({ receipt }) =>
        receipt.source_class === "case"
          ? [{
              provider: receipt.provider,
              jurisdiction: receipt.jurisdiction,
              citation: receipt.citation,
              name: receipt.name,
              dataset: receipt.dataset,
              url: receipt.external_url,
            }]
          : [],
      ),
    ];
    return [
      ...new Map(
        sources.map((source) => [
          `${source.provider}:${source.citation.toLocaleLowerCase()}`,
          source,
        ]),
      ).values(),
    ];
  };
  const debugEvent = () =>
    params.activityDetail === "trace" && eventReasoning().length
      ? { reasoning: eventReasoning() }
      : {};
  const sourceEvent = () => {
    const sources = eventSources();
    return sources.length ? { sources } : {};
  };
  params.onEvent?.({
    ...baseEvent,
    status: "running",
    ...debugEvent(),
    ...sourceEvent(),
  });
  try {
    const feedback: string[] = [];
    const runTools = async (calls: NormalizedToolCall[]) => {
      for (const call of calls) {
        const citation =
          typeof call.input.citation === "string"
            ? call.input.citation.trim().toLocaleLowerCase()
            : "";
        const clusterIds = Array.isArray(call.input.clusterIds)
          ? call.input.clusterIds
          : typeof call.input.clusterId === "number"
            ? [call.input.clusterId]
            : [];
        const source = citation
          ? discoveredSources.get(`citation:${citation}`)
          : [...discoveredSources.values()].find(
              (candidate) =>
                candidate.clusterId !== undefined &&
                clusterIds.includes(candidate.clusterId),
            );
        const label = source
          ? `Reading ${source.name ? `${source.name}, ` : ""}${source.citation}`
          : assistantToolActivityLabel(call.name, call.input);
        if (label)
          activities.push({
            id: call.id,
            label,
            status: "running",
            ...(params.activityDetail !== "standard" && {
              tool: call.name,
              input: call.input,
            }),
            ...(source && { source }),
          });
      }
      params.onEvent?.({
        ...baseEvent,
        status: "running",
        activities: eventActivities(),
        ...debugEvent(),
        ...sourceEvent(),
      });
      const results = await params.runTools(calls);
      for (const [index, result] of results.entries()) {
        const call = calls.find((candidate) => candidate.id === result.tool_use_id) ??
          calls[index];
        if (!call) continue;
        for (const source of discoveredCaseSources(call, result)) {
          discoveredSources.set(
            `citation:${source.citation.toLocaleLowerCase()}`,
            source,
          );
        }
      }
      for (const result of results) {
        const activity = activities.find(
          (candidate) => candidate.id === result.tool_use_id,
        );
        if (activity) {
          activity.status = result.status === "error" ? "error" : "completed";
        }
      }
      params.onEvent?.({
        ...baseEvent,
        status: "running",
        activities: eventActivities(),
        ...debugEvent(),
        ...sourceEvent(),
      });
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
        reasoningSummary: params.activityDetail === "trace" ? "auto" : "none",
        abortSignal: params.signal,
        systemPrompt: `${ROLE_INSTRUCTIONS}\n\n${params.jurisdictionPrompt ? `${params.jurisdictionPrompt}\n\n` : ""}${SOURCE_SEARCH_SYSTEM_PROMPT}\n\nRemain strictly read-only and use only the supplied retrieval tools. ${GROUNDED_ANSWER_INSTRUCTIONS}`,
        messages: [{ role: "user", content }],
        tools: params.tools,
        runTools,
        ...(params.activityDetail === "trace" && {
          callbacks: {
            onReasoningDelta: (text: string) => {
              currentReasoning += text;
              params.onEvent?.({
                ...baseEvent,
                status: "running",
                activities: eventActivities(),
                ...debugEvent(),
                ...sourceEvent(),
              });
            },
            onReasoningBlockEnd: () => {
              if (currentReasoning) reasoning.push(currentReasoning);
              currentReasoning = "";
            },
          },
        }),
      });
    const assignment = `Assigned scope: ${scope}\n\nQuestion: ${task}`;
    let prompt = assignment;
    let rendered: string | null = null;
    let grounding: LegalEvidenceReceiptEvent | null = null;
    while (!rendered || grounding?.status !== "passed") {
      let runError: unknown = null;
      try {
        await run(prompt);
      } catch (error) {
        runError = error;
      }
      rendered = renderLegalEvidenceAnswer(params.evidenceState);
      grounding = legalEvidenceReceiptEvent(params.evidenceState);
      if (
        runError &&
        !(
          runError instanceof Error &&
          runError.message === "Codex exec returned no response." &&
          rendered &&
          grounding?.status === "passed"
        )
      ) {
        throw runError;
      }
      if (rendered && grounding?.status === "passed") break;
      const priorFeedback = feedback.join("\n\n").slice(-MAX_REPAIR_CONTEXT_CHARS);
      const rejection =
        grounding?.bounces.at(-1)?.errors.join("; ") ??
        grounding?.failure ??
        "No grounded submission was received.";
      prompt = `${assignment}\n\nYour previous attempt did not pass the grounding gate: ${rejection}\n\nContinue revising using the schema and tool feedback below. Retrieve more passages if needed.\n\n${priorFeedback || "No tool feedback was returned; retrieve evidence before submitting."}`;
    }
    if (params.publishEvidenceTo) {
      const usedEvidence = new Set(
        grounding.claims.flatMap((claim) => claim.evidence_ids),
      );
      for (const evidenceId of usedEvidence) {
        const registered = params.evidenceState.evidence.get(evidenceId);
        if (registered) params.publishEvidenceTo.evidence.set(evidenceId, registered);
      }
    }
    const output =
      rendered.length <= MAX_OUTPUT_CHARS
        ? rendered
        : `${rendered.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated]`;
    params.onEvent?.({
      ...baseEvent,
      status: "completed",
      output,
      activities: eventActivities(),
      ...debugEvent(),
      ...sourceEvent(),
      grounding,
    });
    return {
      tool_use_id: params.call.id,
      status: "ok",
      content: JSON.stringify({
        ok: true,
        agent: role,
        findings: grounding.claims,
        sources: grounding.evidence.map((receipt) => ({
          evidence_id: receipt.evidence_id,
          citation: receipt.citation,
          name: receipt.name,
          locator: receipt.locator,
        })),
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reading agent failed.";
    params.onEvent?.({
      ...baseEvent,
      status: "error",
      error: message,
      activities: eventActivities(),
      ...debugEvent(),
      ...sourceEvent(),
    });
    return {
      tool_use_id: params.call.id,
      status: "error",
      content: JSON.stringify({ ok: false, error: message }),
    };
  }
}
