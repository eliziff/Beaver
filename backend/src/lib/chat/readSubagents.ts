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
  "Read or find exactly what the assigned task requests. Return condensed context for the main assistant, preserving legally material qualifications and contrary text. Treat every element of the assignment as required: omit merely analogous, adjacent, or conceptually related material that does not satisfy it. Do not broaden the assignment, plan work, or recommend next steps.";

export const READ_SUBAGENT_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: READ_SUBAGENT_TOOL_NAME,
    description:
      "Dispatch one concurrent round of two or three independent reading agents. Put every non-overlapping assignment in this single call; lone assignments are invalid. Delegate only when parallel reading is worthwhile. Later rounds are allowed only when the prior search ledger identifies a concrete gap and the new assignments materially change the query, scope, source collection, period, or strategy. An unqualified request about multiple jurisdictions means jurisdictions within the standing region, not different countries or world regions. Keep work in the main turn when fewer than two useful independent slices exist. Do not use it for simple lookups, deterministic operations, or any write task. Completed results include exact grounded passages and a compact search ledger; review them against every element of the user's request, omit non-responsive candidates, and reuse their evidence IDs without re-fetching them.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              task: {
                type: "string",
                minLength: 1,
                maxLength: MAX_TASK_CHARS,
                description:
                  "A self-contained reading task, including the question and sources to inspect.",
              },
              scope: {
                type: "string",
                minLength: 1,
                maxLength: 240,
                description:
                  "A distinct court set, source collection, period, or search strategy. Assignments must not overlap.",
              },
              jurisdiction: {
                type: "string",
                enum: ["CA", "US", "UK"],
                description:
                  "Country whose legal-source tools this reader may use. Defaults to CA when omitted.",
              },
              collections: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                uniqueItems: true,
                items: { type: "string", minLength: 1, maxLength: 40 },
              },
              source_types: {
                type: "array",
                minItems: 1,
                maxItems: 4,
                uniqueItems: true,
                items: {
                  type: "string",
                  enum: ["case", "legislation", "journal", "hansard"],
                },
              },
            },
            required: ["task", "scope"],
            additionalProperties: false,
          },
          description:
            "Two or three non-overlapping reader assignments dispatched concurrently.",
        },
      },
      required: ["assignments"],
      additionalProperties: false,
    },
  },
};

export const READ_SUBAGENT_SYSTEM_PROMPT =
  "Do ordinary legal research yourself with the direct legal-source and citator tools. Delegate only when the requested scale genuinely benefits from parallelism, such as an exhaustive scan, a bulk query, or broad research with at least two worthwhile independent lanes. Call delegate_read once per round with two or three specific, non-overlapping assignments in its assignments array; never dispatch or wait on one agent. Scope assignments by court or jurisdiction within the standing region, source collection, period, or genuinely different search strategy. Never delegate merely to recover or restate evidence already returned earlier in the conversation. Never turn an unqualified request about multiple jurisdictions into different countries or world regions. Never use United States or United Kingdom law as a lane unless the user's current request or selected regions expressly include it. Never clone or lightly rephrase one assignment. Keep work without at least two useful lanes in the main turn. Wait for all sibling results, then skeptically compare each exact passage against every required element of the user's request. Report only responsive results; omit merely analogous, adjacent, or conceptually related candidates. A reader miss is not proof that no result exists: inspect the returned search ledgers and, when a concrete untried query or scope could materially help, dispatch another two-or-three-agent round with meaningfully revised assignments. Do not force a result when thorough searches leave no honest answer; state the verified shortfall. Reuse returned evidence IDs directly and submit the final grounded answer yourself. Do not re-read a completed reader source unless its exact passages conflict.";

export type ReadSubagentRegion = "CA" | "US" | "UK";
export type ReadSubagentForeignRegion = Exclude<ReadSubagentRegion, "CA">;

const REGION_TERMS: Record<
  ReadSubagentRegion,
  readonly RegExp[]
> = {
  CA: [
    /\b(?:Canada|Canadian|SCC|Federal Court of Canada)\b/iu,
    /\b(?:Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland(?: and Labrador)?|Nova Scotia|Ontario|Prince Edward Island|Quebec|Saskatchewan|Yukon|Nunavut|Northwest Territories)\b/iu,
  ],
  US: [
    /\bUS\b/u,
    /\b(?:United States|U\.S\.|USA|American(?: law| cases?| decisions?| courts?)|SCOTUS|CourtListener)\b/iu,
  ],
  UK: [
    /\bUK\b/u,
    /\b(?:United Kingdom|U\.K\.|UKSC|EWCA|EWHC|BAILII|English (?:law|cases?|decisions?|courts?)|England and Wales|Scots? law|Scottish (?:cases?|decisions?|courts?)|Northern Ireland(?: law| cases?| decisions?| courts?)?)\b/iu,
  ],
};

function mentionsRegion(region: ReadSubagentRegion, text: string) {
  return REGION_TERMS[region].some((pattern) => pattern.test(text));
}

function preferenceRegion(value: string): ReadSubagentRegion | null {
  const folded = value.trim().toLocaleLowerCase();
  if (folded === "ca" || folded === "canada" || folded.startsWith("ca-")) return "CA";
  if (folded === "us" || folded === "united states" || folded.startsWith("us-")) return "US";
  if (folded === "uk" || folded === "united kingdom" || folded.startsWith("uk-")) return "UK";
  return null;
}

export function allowedReadSubagentRegions(
  preference: { mode: "ask" | "presume"; jurisdictions: string[] } | null,
  currentRequest: string,
) {
  const explicit = new Set<ReadSubagentRegion>();
  for (const region of Object.keys(REGION_TERMS) as ReadSubagentRegion[]) {
    if (mentionsRegion(region, currentRequest)) explicit.add(region);
  }
  if (explicit.size) return explicit;
  if (preference?.mode === "presume") {
    const selected = new Set(
      preference.jurisdictions.flatMap((value) => {
        const region = preferenceRegion(value);
        return region ? [region] : [];
      }),
    );
    if (selected.size) return selected;
  }
  return new Set<ReadSubagentRegion>(["CA"]);
}

export function readSubagentJurisdiction(call: NormalizedToolCall) {
  return call.input.jurisdiction === "US" || call.input.jurisdiction === "UK"
    ? call.input.jurisdiction
    : "CA";
}

function readSubagentCollections(call: NormalizedToolCall) {
  return new Set(
    (Array.isArray(call.input.collections) ? call.input.collections : [])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
}

export function readSubagentSourceTypes(call: NormalizedToolCall) {
  const selected = Array.isArray(call.input.source_types)
    ? call.input.source_types.filter(
        (value): value is string =>
          typeof value === "string" &&
          ["case", "legislation", "journal", "hansard"].includes(value),
      )
    : [];
  return new Set(selected.length ? selected : ["case", "legislation", "journal"]);
}

export function createReadSubagentAdmission(
  maxAgents = 3,
  allowedRegions: ReadonlySet<ReadSubagentRegion> = new Set(["CA"]),
) {
  const assignments = new Set<string>();
  return (calls: NormalizedToolCall[]) => {
    if (!calls.length) return { accepted: [], rejected: [] };
    let admitted = 0;
    const scopes = new Set<string>();
    const accepted: NormalizedToolCall[] = [];
    const acceptedAssignmentKeys: string[] = [];
    const rejected: NormalizedToolResult[] = [];
    for (const call of calls) {
      const scope =
        typeof call.input.scope === "string"
          ? call.input.scope.replace(/\s+/gu, " ").trim().toLocaleLowerCase()
          : "";
      const assignment = `${scope}\n${typeof call.input.task === "string" ? call.input.task : ""}`;
      const assignmentKey = assignment.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
      const jurisdiction = readSubagentJurisdiction(call);
      const namedRegion = (Object.keys(REGION_TERMS) as ReadSubagentRegion[])
        .find((region) => mentionsRegion(region, assignment));
      const error =
        !scope
          ? "Reading agents require a distinct scope."
          : !allowedRegions.has(jurisdiction)
            ? `${jurisdiction} law is outside the jurisdictions selected for this request.`
          : namedRegion && namedRegion !== jurisdiction
            ? `The assignment names ${namedRegion} law but its jurisdiction boundary is ${jurisdiction}.`
          : scopes.has(scope) || assignments.has(assignmentKey)
            ? "This reading-agent assignment duplicates one already assigned in this turn."
            : admitted >= maxAgents
              ? `A reading-agent round may use at most ${maxAgents} agents.`
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
      acceptedAssignmentKeys.push(assignmentKey);
    }
    if (accepted.length && !rejected.length) {
      for (const assignmentKey of acceptedAssignmentKeys) {
        assignments.add(assignmentKey);
      }
    }
    return { accepted, rejected };
  };
}

export function prepareReadSubagentRound(
  calls: NormalizedToolCall[],
  admit: ReturnType<typeof createReadSubagentAdmission>,
): {
  parent: NormalizedToolCall | null;
  assignments: NormalizedToolCall[];
  rejected: NormalizedToolResult[];
} {
  if (!calls.length) {
    return {
      parent: null,
      assignments: [] as NormalizedToolCall[],
      rejected: [] as NormalizedToolResult[],
    };
  }
  if (calls.length !== 1) {
    return {
      parent: null,
      assignments: [] as NormalizedToolCall[],
      rejected: calls.map((call) => ({
        tool_use_id: call.id,
        status: "error" as const,
        content: JSON.stringify({
          ok: false,
          error:
            "Call delegate_read once per round with two or three assignments.",
        }),
      })),
    };
  }
  const parent = calls[0];
  const raw = Array.isArray(parent.input.assignments)
    ? parent.input.assignments
    : [];
  const assignments = raw.flatMap((input, index) =>
    input && typeof input === "object" && !Array.isArray(input)
      ? [{
          id: `${parent.id}:${index + 1}`,
          name: READ_SUBAGENT_TOOL_NAME,
          input: input as Record<string, unknown>,
        }]
      : [],
  );
  if (assignments.length < 2 || assignments.length > 3) {
    return {
      parent: null,
      assignments: [] as NormalizedToolCall[],
      rejected: [{
        tool_use_id: parent.id,
        status: "error" as const,
        content: JSON.stringify({
          ok: false,
          error: "delegate_read requires two or three assignments.",
        }),
      }],
    };
  }
  const admitted = admit(assignments);
  if (
    admitted.rejected.length ||
    admitted.accepted.length !== assignments.length
  ) {
    return {
      parent: null,
      assignments: [] as NormalizedToolCall[],
      rejected: [{
        tool_use_id: parent.id,
        status: "error" as const,
        content: JSON.stringify({
          ok: false,
          error: "Every reader assignment must be valid and non-overlapping.",
          assignment_errors: admitted.rejected.map((result) =>
            JSON.parse(result.content),
          ),
        }),
      }],
    };
  }
  return { parent, assignments: admitted.accepted, rejected: [] };
}

export function combineReadSubagentResults(
  parent: NormalizedToolCall,
  results: NormalizedToolResult[],
): NormalizedToolResult {
  return {
    tool_use_id: parent.id,
    status: results.every((result) => result.status === "ok") ? "ok" : "error",
    content: JSON.stringify({
      ok: results.every((result) => result.status === "ok"),
      readers: results.map((result) => {
        try {
          return JSON.parse(result.content);
        } catch {
          return { status: result.status, output: result.content };
        }
      }),
    }),
  };
}

const SEARCH_LEDGER_TOOLS = new Set([
  "Glob",
  "Grep",
  "find_in_document",
  "library_find",
  "SearchSources",
  "a2aj_search",
  "courtlistener_search_case_law",
  "courtlistener_find_in_case",
  "caselaw_note_up",
]);

function compactSearchRequest(input: Record<string, unknown>) {
  const keys = ["query", "pattern", "citation", "path", "doc_id", "clusterId"];
  const selected = Object.fromEntries(
    keys.flatMap((key) => input[key] === undefined ? [] : [[key, input[key]]]),
  );
  return JSON.stringify(Object.keys(selected).length ? selected : input).slice(0, 320);
}

function compactSearchResult(result: NormalizedToolResult) {
  try {
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    if (Array.isArray(payload.results)) {
      const labels = payload.results.slice(0, 3).flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const row = value as Record<string, unknown>;
        const label = row.citation ?? row.title ?? row.name ?? row.identifier;
        return typeof label === "string" ? [label] : [];
      });
      return `${payload.results.length} result${payload.results.length === 1 ? "" : "s"}${labels.length ? `: ${labels.join("; ")}` : ""}`;
    }
    const count = payload.total ?? payload.total_matches ?? payload.count;
    if (typeof count === "number") return `${count} match${count === 1 ? "" : "es"}`;
  } catch {
    // Plain-text tool results are summarized below.
  }
  return result.content.replace(/\s+/gu, " ").trim().slice(0, 240) || result.status;
}

const GROUNDED_ANSWER_INSTRUCTIONS =
  "Finish only with submit_grounded_answer. Its top-level object contains only claims. Every claim requires text, evidence_ids, kind, premise_source, and premise_text. Use exact evidence_id values returned by retrieval tools. kind is quotation, conclusion, or premise_correction; premise_source and premise_text must be null unless correcting a premise. Put sources only in evidence_ids; do not put citation or pinpoint prose in text.";

const READ_TOOL_NAMES = new Set([
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
export function readSubagentTools(
  tools: OpenAIToolSchema[],
  jurisdiction: ReadSubagentRegion = "CA",
  sourceTypes: ReadonlySet<string> = new Set(["case", "legislation", "journal"]),
) {
  return tools.filter((tool) => {
    const name = tool.function.name;
    if (!READ_TOOL_NAMES.has(name)) return false;
    if (name === "SearchSources") return jurisdiction !== "UK";
    if (name === "hansard_fetch") {
      return jurisdiction === "CA" && sourceTypes.has("hansard");
    }
    if (name.startsWith("a2aj_") || name === "caselaw_note_up") {
      return jurisdiction === "CA";
    }
    if (name.startsWith("courtlistener_")) return jurisdiction === "US";
    if (name.startsWith("public_legal_source_")) return true;
    if (name === "consult_attested_characterization") return jurisdiction === "CA";
    return true;
  });
}

function publicProviderAllowed(
  jurisdiction: ReadSubagentRegion,
  input: Record<string, unknown>,
) {
  if (typeof input.provider !== "string") return false;
  return jurisdiction === "CA"
    ? input.provider === "journal"
    : jurisdiction === "US"
    ? input.provider === "govinfo"
    : jurisdiction === "UK"
      ? input.provider === "tna" || input.provider === "govuk-et"
      : false;
}

const COLLECTION_SCOPED_TOOLS = new Set([
  "SearchSources",
  "a2aj_fetch",
  "a2aj_lookup",
  "courtlistener_search_case_law",
  "courtlistener_get_cases",
  "courtlistener_find_in_case",
  "courtlistener_lookup_case_locator",
  "courtlistener_read_case",
  "caselaw_note_up",
]);

function collectionScopeError(
  call: NormalizedToolCall,
  collections: ReadonlySet<string>,
  discoveredSources: ReadonlyMap<string, ReadSubagentSource>,
) {
  if (!collections.size || !COLLECTION_SCOPED_TOOLS.has(call.name)) return null;
  const selected = [call.input.collection, call.input.dataset, call.input.court]
    .find((value): value is string =>
      typeof value === "string" && Boolean(value.trim()),
    );
  if (selected) {
    return collections.has(selected.trim().toLocaleLowerCase())
      ? null
      : `${selected} is outside this reader's assigned collections.`;
  }
  const citation = typeof call.input.citation === "string"
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
          candidate.clusterId !== undefined && clusterIds.includes(candidate.clusterId),
      );
  return source && collections.has(source.dataset.trim().toLocaleLowerCase())
    ? null
    : "This source call lacks a collection within the reader's assigned collection boundary.";
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
  const count = Array.isArray(input.assignments) ? input.assignments.length : 0;
  return count >= 2
    ? `Coordinating ${count} reading agents`
    : "Coordinating reading agents";
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
  activityDetail?: "auto" | "standard" | "tools" | "trace";
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
  const jurisdiction = readSubagentJurisdiction(params.call);
  const collections = readSubagentCollections(params.call);
  const sourceTypes = readSubagentSourceTypes(params.call);
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
  const searches: { tool: string; query: string; summary: string }[] = [];
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
    (params.activityDetail === "auto" || params.activityDetail === "trace") &&
    eventReasoning().length
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
            ...((params.activityDetail === "tools" ||
              params.activityDetail === "trace") && {
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
      const rejectedCalls = calls.filter(
        (call) =>
          (call.name.startsWith("public_legal_source_") &&
            !publicProviderAllowed(jurisdiction, call.input)) ||
          Boolean(collectionScopeError(call, collections, discoveredSources)) ||
          (call.name === "SearchSources" &&
            Array.isArray(call.input.source_types) &&
            call.input.source_types.some(
              (value) => typeof value !== "string" || !sourceTypes.has(value),
            )),
      );
      const constrainedCalls = calls
        .filter((call) => !rejectedCalls.includes(call))
        .map((call) =>
        call.name === "SearchSources"
          ? { ...call, input: { ...call.input, jurisdiction } }
          : call,
        );
      const results = [
        ...(constrainedCalls.length ? await params.runTools(constrainedCalls) : []),
        ...rejectedCalls.map((call) => ({
          tool_use_id: call.id,
          status: "error" as const,
          content: JSON.stringify({
            ok: false,
            error:
              collectionScopeError(call, collections, discoveredSources) ??
              (call.name === "SearchSources"
                ? "This search requests a source class outside the reader's assignment."
                : null) ??
              `${String(call.input.provider ?? "Unknown")} is outside this reader's ${jurisdiction} source boundary.`,
          }),
        })),
      ];
      for (const [index, result] of results.entries()) {
        const call = constrainedCalls.find((candidate) => candidate.id === result.tool_use_id) ??
          rejectedCalls.find((candidate) => candidate.id === result.tool_use_id) ??
          constrainedCalls[index];
        if (!call) continue;
        if (SEARCH_LEDGER_TOOLS.has(call.name) && searches.length < 24) {
          searches.push({
            tool: call.name,
            query: compactSearchRequest(call.input),
            summary: compactSearchResult(result) ?? "No result summary.",
          });
        }
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
        reasoningSummary:
          params.activityDetail === "auto" || params.activityDetail === "trace"
            ? "auto"
            : "none",
        abortSignal: params.signal,
        systemPrompt: `${ROLE_INSTRUCTIONS}\n\n${params.jurisdictionPrompt ? `${params.jurisdictionPrompt}\n\n` : ""}${SOURCE_SEARCH_SYSTEM_PROMPT}\n\nRemain strictly read-only and use only the supplied retrieval tools. ${GROUNDED_ANSWER_INSTRUCTIONS}`,
        messages: [{ role: "user", content }],
        tools: params.tools,
        runTools,
        ...((params.activityDetail === "auto" ||
          params.activityDetail === "trace") && {
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
        evidence: grounding.evidence.map((receipt) => ({
          evidence_id: receipt.evidence_id,
          citation: receipt.citation,
          name: receipt.name,
          locator: receipt.locator,
          exact_passage: receipt.span_text,
        })),
        searches,
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
