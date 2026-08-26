import { getCodexModelCatalog, type CodexModelCatalog } from "../codexCatalog";
import type { NormalizedToolCall, NormalizedToolResult, Tool } from "../llm";
import type {
  LegalEvidenceReceipt,
  LegalEvidenceReceiptEvent,
} from "./legalEvidence";
import { jsonRecord as record } from "../value";

export const READ_SUBAGENT_TOOL_NAME = "delegate_read";
export const RESUME_SUBAGENT_TOOL_NAME = "resume_read";
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_EFFORT = "high";
const REGIONS = ["CA", "US", "UK"] as const;

export type ReadSubagentRegion = typeof REGIONS[number];
export type ReadSubagentAssignment = {
  task: string;
  scope: string;
  jurisdiction: ReadSubagentRegion;
  collections?: string[];
  source_types?: string[];
};
export type ReadSubagentSource = {
  provider: string;
  jurisdiction: string;
  citation: string;
  name: string | null;
  dataset: string;
  url: string | null;
  locator?: string;
  quote?: string;
};
export type ToolActivity = {
  id: string;
  tool: string;
  label: string;
  status: "running" | "completed" | "error" | "interrupted";
  source?: ReadSubagentSource;
};
export type ReadSubagentCheckpoint = {
  id: string;
  continuation_id: string;
  model: string;
  effort: string;
  assignment: ReadSubagentAssignment;
  evidence: LegalEvidenceReceipt[];
  activities?: ToolActivity[];
};
export type ReadSubagentEvent = {
  type: "subagent_run";
  id: string;
  agent: "scout" | "native";
  task: string;
  model: string;
  effort: string;
  status: "running" | "completed" | "error" | "cancelled" | "interrupted";
  output?: string;
  error?: string;
  activities?: ToolActivity[];
  sources?: ReadSubagentSource[];
  grounding?: LegalEvidenceReceiptEvent;
  resume?: ReadSubagentCheckpoint;
};
export type ReadSubagentCapability = {
  available: boolean;
  serverEnabled: boolean;
  model: string;
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
  },
  required: ["task", "scope"],
  additionalProperties: false,
} as const;

export const READ_SUBAGENT_TOOL: Tool = {
  name: READ_SUBAGENT_TOOL_NAME,
  description:
    "Dispatch one round of two to four independent read-only research assignments. Use distinct scopes and review every result before answering; keep small lookups in the main turn.",
  inputSchema: {
    type: "object",
    properties: {
      assignments: {
        type: "array", minItems: 2, maxItems: 4,
        items: assignmentSchema,
        description: "Two to four non-overlapping reading assignments.",
      },
    },
    required: ["assignments"],
    additionalProperties: false,
  },
};

export const RESUME_SUBAGENT_TOOL: Tool = {
  name: RESUME_SUBAGENT_TOOL_NAME,
  description: "Resume unfinished readers in their existing sessions by run ID.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array", minItems: 1, maxItems: 4, uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    required: ["ids"],
    additionalProperties: false,
  },
};

export const READ_SUBAGENT_SYSTEM_PROMPT =
  "Use direct research tools for ordinary work. Delegate only when two to four genuinely independent reading lanes will help. Keep every lane within the jurisdictions selected for this request, wait for all siblings, and skeptically compare their exact evidence against the question. Resume interrupted readers instead of replacing them. A reader miss is not proof of absence; refine concrete gaps, but never force a result. Reuse returned evidence IDs in the final grounded answer.";

const strings = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];
const region = (value: unknown): ReadSubagentRegion =>
  value === "US" || value === "UK" ? value : "CA";

function checkpoint(value: unknown): ReadSubagentCheckpoint | null {
  const row = record(value), input = record(row?.assignment);
  if (!row || !input || typeof row.id !== "string" ||
      typeof row.continuation_id !== "string" ||
      typeof row.model !== "string" || typeof row.effort !== "string" ||
      typeof input.task !== "string" || typeof input.scope !== "string" ||
      !REGIONS.includes(input.jurisdiction as ReadSubagentRegion)) return null;
  return {
    id: row.id,
    continuation_id: row.continuation_id,
    model: row.model,
    effort: row.effort,
    assignment: {
      task: input.task,
      scope: input.scope,
      jurisdiction: input.jurisdiction as ReadSubagentRegion,
      ...(Array.isArray(input.collections) && { collections: strings(input.collections) }),
      ...(Array.isArray(input.source_types) && { source_types: strings(input.source_types) }),
    },
    evidence: Array.isArray(row.evidence)
      ? row.evidence as LegalEvidenceReceipt[] : [],
    ...(Array.isArray(row.activities)
      ? { activities: row.activities as ToolActivity[] }
      : {}),
  };
}

export function resumableReadSubagents(events: readonly unknown[]) {
  const latest = new Map<string, Record<string, unknown>>();
  for (const value of events) {
    const event = record(value);
    if (event?.type === "subagent_run" && typeof event.id === "string") {
      latest.set(event.id, event);
    }
  }
  const resumable = new Map<string, ReadSubagentCheckpoint>();
  for (const [id, event] of latest) {
    if (event.status !== "interrupted" && event.status !== "running") continue;
    const parsed = checkpoint(event.resume);
    if (parsed && parsed.id === id) resumable.set(id, {
      ...parsed,
      ...(Array.isArray(event.activities)
        ? { activities: event.activities as ToolActivity[] }
        : {}),
    });
  }
  return resumable;
}

export function readSubagentResumePrompt(
  checkpoints: ReadonlyMap<string, ReadSubagentCheckpoint>,
) {
  if (!checkpoints.size) return "";
  return [
    "UNFINISHED READERS AVAILABLE:",
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
  const model = selection?.model?.trim().replace(/^codex:/u, "") ||
    process.env.MIKE_READ_SUBAGENT_MODEL?.trim() || DEFAULT_MODEL;
  const effort = selection?.effort?.trim() ||
    process.env.MIKE_READ_SUBAGENT_EFFORT?.trim() || DEFAULT_EFFORT;
  if (process.env.MIKE_READ_SUBAGENTS === "0") return {
    available: false, serverEnabled: false, model, displayName: model, effort,
    reason: "Reading agents are disabled by the server.",
  };
  const selected = (catalog ?? await getCodexModelCatalog()).models
    .find((item) => item.slug === model);
  const reason = !selected
    ? "The configured Codex reading model is unavailable."
    : !selected.supportedReasoningLevels.some((level) =>
        level.effort.toLowerCase() === effort.toLowerCase())
      ? "The configured reasoning effort is unavailable for this model." : undefined;
  return {
    available: !reason,
    serverEnabled: true,
    model,
    displayName: selected?.displayName ?? model,
    effort,
    ...(reason && { reason }),
  };
}

export function readSubagentActivityLabel(input: Record<string, unknown>) {
  const count = Array.isArray(input.assignments) ? input.assignments.length : 0;
  return count >= 2 ? `Coordinating ${count} reading agents` : "Coordinating reading agents";
}

export const readSubagentInstruction = (assignment: ReadSubagentAssignment) => [
  "Read only what the assignment requests. Preserve legally material qualifications and contrary text. Do not broaden the task or recommend next steps.",
  "Use only the supplied retrieval tools and finish with submit_grounded_answer. Every claim requires exact evidence_ids returned by those tools.",
  `Jurisdiction boundary: ${assignment.jurisdiction}.`,
  assignment.collections?.length
    ? `Collection boundary: ${assignment.collections.join(", ")}.` : "",
  assignment.source_types?.length
    ? `Source-type boundary: ${assignment.source_types.join(", ")}.` : "",
].filter(Boolean).join("\n\n");

export function receiptSource(receipt: LegalEvidenceReceipt): ReadSubagentSource {
  const prefix = receipt.locator.kind === "paragraph" ? "par"
    : receipt.locator.kind === "section" ? "sec"
      : receipt.locator.kind === "page" ? "page"
        : receipt.locator.kind === "footnote" ? "fn" : "";
  const label = receipt.locator.label;
  return {
    provider: receipt.provider,
    jurisdiction: receipt.jurisdiction,
    citation: receipt.citation,
    name: receipt.name,
    dataset: receipt.dataset,
    url: receipt.external_url,
    ...(label && { locator: prefix && !label.toLowerCase().startsWith(prefix)
      ? `${prefix}${label}` : label }),
    ...(receipt.span_text && { quote: receipt.span_text }),
  };
}
