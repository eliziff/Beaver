import { getCodexModelCatalog, type CodexModelCatalog } from "../codexCatalog";
import { isSupportedModel } from "../llm/models";
import type { NormalizedToolCall, NormalizedToolResult, Tool } from "../llm";
import { jsonRecord as record } from "../value";
import { objectSchema } from "./toolRegistry";
import type { AssistantEvent, ReadSubagentAssignment, ReadSubagentCheckpoint,
  ReadSubagentEvent } from "./assistantEvents";

export const READ_SUBAGENT_TOOL_NAME = "delegate_read";
export const RESUME_SUBAGENT_TOOL_NAME = "resume_read";
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_EFFORT = "high";
const REGIONS = ["CA", "US", "UK"] as const;

export type ReadSubagentRegion = typeof REGIONS[number];
export type ReadSubagentCapability = {
  available: boolean;
  serverEnabled: boolean;
  model: string;
  /** The id handed to the provider loop: codex:<slug> or any picker model id. */
  runModel: string;
  displayName: string;
  effort: string;
  reason?: string;
};

const assignmentSchema = {
  type: "object",
  properties: {
    task: {
      type: "string", minLength: 1, maxLength: 4_000,
      description: "A self-contained reading question and the sources to inspect.",
    },
    scope: {
      type: "string", minLength: 1, maxLength: 240,
      description: "A distinct court, collection, period, or search strategy.",
    },
    jurisdiction: {
      type: "string", enum: REGIONS,
      description: "Country whose legal sources this reader may use; defaults to CA.",
    },
    collections: {
      type: "array", minItems: 1, maxItems: 8, uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
    source_types: {
      type: "array", minItems: 1, maxItems: 4, uniqueItems: true,
      items: { type: "string", enum: ["case", "legislation", "journal", "hansard"] },
    },
    resources: { type: "array", minItems: 1, maxItems: 500, uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 4_000 },
      description: "Narrow this reader to these exact resources from the current selection." },
    evidence_ids: { type: "array", minItems: 1, maxItems: 5_000, uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 200 },
      description: "Narrow this reader to these original passages within the current selection." },
  },
  required: ["task", "scope"],
  additionalProperties: false,
} as const;

export const READ_SUBAGENT_TOOL: Tool = {
  name: READ_SUBAGENT_TOOL_NAME,
  description:
    "Delegate independent legal research assignments with distinct scopes. Compare each reader's findings and exact evidence before answering. Assess misses as research gaps, not proof of absence; keep small lookups in the main turn.",
  inputSchema: objectSchema({
    assignments: { type: "array", minItems: 2, maxItems: 4, items: assignmentSchema },
  }, ["assignments"]),
};

export const RESUME_SUBAGENT_TOOL: Tool = {
  name: RESUME_SUBAGENT_TOOL_NAME,
  description: "Resume unfinished or failed readers in their existing sessions by run ID.",
  inputSchema: objectSchema({
    ids: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 200 } },
  }, ["ids"]),
};

const strings = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];
const region = (value: unknown): ReadSubagentRegion =>
  value === "US" || value === "UK" ? value : "CA";

export function resumableReadSubagents(events: readonly AssistantEvent[]) {
  const latest = new Map<string, ReadSubagentEvent>();
  for (const event of events) {
    if (event.type === "subagent_run") {
      latest.set(event.id, event);
    }
  }
  const resumable = new Map<string, ReadSubagentCheckpoint>();
  for (const [id, event] of latest) {
    if (!["error", "interrupted", "running"].includes(event.status)) continue;
    const parsed = event.resume;
    if (parsed && parsed.id === id) resumable.set(id, {
      ...parsed,
      ...(event.activities && { activities: event.activities }),
    });
  }
  return resumable;
}

export function readSubagentResumePrompt(
  checkpoints: ReadonlyMap<string, ReadSubagentCheckpoint>,
) {
  if (!checkpoints.size) return "";
  return [
    "RESUMABLE READERS AVAILABLE:",
    "Call resume_read with their existing run IDs; do not replace the assignments.",
    ...[...checkpoints.values()].map(({ id, assignment }) =>
      `- ${id}: ${assignment.scope}: ${assignment.task}`),
  ].join("\n");
}

const REGION_TERMS: Record<ReadSubagentRegion, readonly RegExp[]> = {
  CA: [
    /\b(?:Canada|Canadian|SCC|Federal Court of Canada)\b/iu,
    /\b(?:Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland(?: and Labrador)?|Nova Scotia|Ontario|Prince Edward Island|Quebec|Saskatchewan|Yukon|Nunavut|Northwest Territories)\b/iu,
  ],
  US: [/\b(?:US|USA|United States|U\.S\.|American (?:law|cases?|courts?)|SCOTUS|CourtListener)\b/iu],
  UK: [/\b(?:UK|U\.K\.|United Kingdom|UKSC|EWCA|EWHC|BAILII|English law|England and Wales|Scots? law|Northern Ireland law)\b/iu],
};
const preferenceRegion = (value: string): ReadSubagentRegion | null => {
  const folded = value.trim().toLowerCase();
  if (["ca", "canada"].includes(folded) || folded.startsWith("ca-")) return "CA";
  if (["us", "united states"].includes(folded) || folded.startsWith("us-")) return "US";
  if (["uk", "united kingdom"].includes(folded) || folded.startsWith("uk-")) return "UK";
  return null;
};

export function allowedReadSubagentRegions(
  preference: { mode: "ask" | "presume"; jurisdictions: string[] } | null,
  request: string,
) {
  const explicit = new Set(REGIONS.filter((key) =>
    REGION_TERMS[key].some((pattern) => pattern.test(request))));
  if (explicit.size) return explicit;
  if (preference?.mode === "presume") {
    const selected = new Set(preference.jurisdictions.flatMap((value) => {
      const key = preferenceRegion(value);
      return key ? [key] : [];
    }));
    if (selected.size) return selected;
  }
  return new Set<ReadSubagentRegion>(["CA"]);
}

export function readSubagentAssignment(call: NormalizedToolCall): ReadSubagentAssignment | null {
  const task = typeof call.input.task === "string" ? call.input.task.trim() : "";
  const scope = typeof call.input.scope === "string" ? call.input.scope.trim() : "";
  return task && scope ? {
    task: task.slice(0, 4_000),
    scope: scope.slice(0, 240),
    jurisdiction: region(call.input.jurisdiction),
    ...(Array.isArray(call.input.collections) && {
      collections: strings(call.input.collections).map((item) => item.trim()).filter(Boolean),
    }),
    ...(Array.isArray(call.input.source_types) && {
      source_types: strings(call.input.source_types).filter((item) =>
        ["case", "legislation", "journal", "hansard"].includes(item)),
    }),
    ...(Array.isArray(call.input.resources) && { resources: strings(call.input.resources) }),
    ...(Array.isArray(call.input.evidence_ids) && { evidence_ids: strings(call.input.evidence_ids) }),
  } : null;
}

export function createReadSubagentAdmission(
  maxAgents = 4,
  allowed = new Set<ReadSubagentRegion>(["CA"]),
) {
  const prior = new Set<string>();
  return (calls: NormalizedToolCall[]) => {
    const round = new Set<string>();
    const accepted: NormalizedToolCall[] = [];
    const rejected: NormalizedToolResult[] = [];
    for (const call of calls) {
      const assignment = readSubagentAssignment(call);
      const key = assignment
        ? `${assignment.scope}\n${assignment.task}`.replace(/\s+/gu, " ").toLowerCase()
        : "";
      const named = assignment && REGIONS.find((region) => REGION_TERMS[region]
        .some((pattern) => pattern.test(`${assignment.scope} ${assignment.task}`)));
      const error = !assignment
        ? "Reader assignments require a task and distinct scope."
        : !allowed.has(assignment.jurisdiction)
          ? `${assignment.jurisdiction} law is outside this request.`
          : named && named !== assignment.jurisdiction
            ? `The assignment names ${named} law but selects ${assignment.jurisdiction}.`
            : round.has(key) || prior.has(key)
              ? "This reader assignment duplicates one already used in this turn."
              : accepted.length >= maxAgents
                ? `A reader round may use at most ${maxAgents} agents.` : null;
      if (error) rejected.push({
        tool_use_id: call.id, status: "error",
        content: JSON.stringify({ ok: false, error }),
      });
      else {
        round.add(key);
        accepted.push(call);
      }
    }
    if (!rejected.length) round.forEach((key) => prior.add(key));
    return { accepted, rejected };
  };
}

function readerError(call: NormalizedToolCall, error: string): NormalizedToolResult {
  return { tool_use_id: call.id, status: "error", content: JSON.stringify({ ok: false, error }) };
}

function prepareReadSubagentRound(
  calls: NormalizedToolCall[],
  admit: ReturnType<typeof createReadSubagentAdmission>,
) {
  if (calls.length !== 1) return {
    parent: null,
    assignments: [] as NormalizedToolCall[],
    rejected: calls.map((call) => readerError(call,
      "Call delegate_read once per round with two to four assignments.")),
  };
  const parent = calls[0];
  const inputs = Array.isArray(parent.input.assignments) ? parent.input.assignments : [];
  const assignments = inputs.flatMap((input, index) => record(input) ? [{
    id: `${parent.id}:${index + 1}`,
    name: READ_SUBAGENT_TOOL_NAME,
    input: record(input)!,
  }] : []);
  if (assignments.length < 2 || assignments.length > 4) return {
    parent: null,
    assignments: [],
    rejected: [readerError(parent, "delegate_read requires two to four assignments.")],
  };
  const admitted = admit(assignments);
  return admitted.rejected.length ? {
    parent: null,
    assignments: [],
    rejected: [readerError(parent, "Every reader assignment must be valid and non-overlapping.")],
  } : { parent, assignments: admitted.accepted, rejected: [] };
}

function combineReadSubagentResults(
  parent: NormalizedToolCall,
  results: NormalizedToolResult[],
): NormalizedToolResult {
  const ok = results.every((result) => result.status === "ok");
  return {
    tool_use_id: parent.id,
    status: ok ? "ok" : "error",
    content: JSON.stringify({ ok, readers: results.map((result) => {
      try { return JSON.parse(result.content); }
      catch { return { status: result.status, output: result.content }; }
    }) }),
  };
}

export async function runReadSubagentRound(options: {
  call: NormalizedToolCall;
  admit: ReturnType<typeof createReadSubagentAdmission>;
  runReader: (call: NormalizedToolCall, resume?: ReadSubagentCheckpoint) => Promise<NormalizedToolResult>;
  resumable?: ReadonlyMap<string, ReadSubagentCheckpoint>;
}) {
  if (options.call.name === READ_SUBAGENT_TOOL_NAME) {
    const round = prepareReadSubagentRound([options.call], options.admit);
    return round.parent
      ? combineReadSubagentResults(round.parent, await Promise.all(
          round.assignments.map((call) => options.runReader(call))))
      : round.rejected[0];
  }
  const ids = strings(options.call.input.ids);
  const checkpoints = ids.map((id) => options.resumable?.get(id));
  if (!ids.length || new Set(ids).size !== ids.length || checkpoints.some((item) => !item)) {
    return readerError(options.call, "resume_read requires available interrupted run IDs.");
  }
  const results = await Promise.all(checkpoints.map((item, index) => options.runReader({
    id: `${options.call.id}:${index + 1}`,
    name: RESUME_SUBAGENT_TOOL_NAME,
    input: item!.assignment,
  }, item)));
  return combineReadSubagentResults(options.call, results);
}

export async function getReadSubagentCapability(
  catalog?: CodexModelCatalog,
  selection?: { model?: string; effort?: string },
): Promise<ReadSubagentCapability> {
  const requested = selection?.model?.trim() ||
    process.env.MIKE_READ_SUBAGENT_MODEL?.trim() || DEFAULT_MODEL;
  const model = requested.replace(/^codex:/u, "");
  const effort = selection?.effort?.trim() ||
    process.env.MIKE_READ_SUBAGENT_EFFORT?.trim() || DEFAULT_EFFORT;
  if (process.env.MIKE_READ_SUBAGENTS === "0") return {
    available: false, serverEnabled: false, model, runModel: requested, displayName: model, effort,
    reason: "Reading agents are disabled by the server.",
  };
  // A bare slug the Codex catalog knows stays a Codex reader; any other picker model id
  // (gemini, claude, deepseek, opencode-go, ...) reads through its own provider (Eli, 2026-09-10).
  const selected = /^[a-z-]+:/u.test(requested) && !requested.startsWith("codex:") ? undefined
    : (catalog ?? await getCodexModelCatalog()).models.find((item) => item.slug === model);
  if (!selected && isSupportedModel(requested)) return {
    available: true, serverEnabled: true, model: requested, runModel: requested,
    displayName: requested, effort };
  const reason = !selected
    ? "The configured Codex reading model is unavailable."
    : !selected.supportedReasoningLevels.some((level) =>
        level.effort.toLowerCase() === effort.toLowerCase())
      ? "The configured reasoning effort is unavailable for this model." : undefined;
  return {
    available: !reason,
    serverEnabled: true,
    model,
    runModel: `codex:${model}`,
    displayName: selected?.displayName ?? model,
    effort,
    ...(reason && { reason }),
  };
}

export function readSubagentActivityLabel(input: Record<string, unknown>) {
  const assignments = Array.isArray(input.assignments) ? input.assignments : [];
  const first = assignments.length === 1 ? record(assignments[0]) : null;
  const task = typeof first?.task === "string"
    ? first.task.replace(/\s+/gu, " ").trim().slice(0, 100)
    : "";
  return task ? `Assigning reading: ${task}`
    : assignments.length >= 2 ? `Coordinating ${assignments.length} reading agents`
      : "Coordinating a reading agent";
}

export const readSubagentInstruction = (assignment: ReadSubagentAssignment) => [
  "Read only what the assignment requests. Preserve legally material qualifications and contrary text. Do not broaden the task or recommend next steps.",
  `Jurisdiction boundary: ${assignment.jurisdiction}.`,
  assignment.collections?.length
    ? `Collection boundary: ${assignment.collections.join(", ")}.` : "",
  assignment.source_types?.length
    ? `Source-type boundary: ${assignment.source_types.join(", ")}.` : "",
].filter(Boolean).join("\n\n");
