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
  registerPriorLegalEvidence,
  renderLegalEvidenceAnswer,
  type LegalEvidenceReceipt,
  type LegalEvidenceReceiptEvent,
  type LegalEvidenceTurnState,
} from "./legalEvidence";
import { assistantToolActivityLabel } from "./tools/a2ajTools";

export const READ_SUBAGENT_TOOL_NAME = "delegate_read";
export const RESUME_SUBAGENT_TOOL_NAME = "resume_read";
const DEFAULT_MODEL_SLUG = "gpt-5.6-luna";
const DEFAULT_EFFORT = "high";
const MAX_TASK_CHARS = 4_000;
const MAX_REPAIR_CONTEXT_CHARS = 16_000;

export type ReadSubagentRole = "scout";
export type ReadSubagentActivity = {
  id: string;
  label: string;
  status: "running" | "completed" | "error" | "interrupted";
  tool?: string;
  input?: Record<string, unknown>;
  source?: ReadSubagentSource;
  paragraphs?: string[];
};

function readActivityParagraphs(input: Record<string, unknown>) {
  if (input.locator_type !== "paragraph") return [];
  const start = String(input.locator ?? "").trim().replace(/^para(?:graph)?\.?\s*/iu, "");
  if (!start) return [];
  const end = String(input.end_locator ?? "").trim().replace(/^para(?:graph)?\.?\s*/iu, "");
  return [end ? `${start}\u2013${end}` : start];
}
function viewerLocator(locator: { kind: string; label: string }) {
  const prefix = locator.kind === "paragraph"
    ? "par"
    : locator.kind === "section"
      ? "sec"
      : locator.kind === "page"
        ? "page"
        : locator.kind === "footnote"
          ? "fn"
          : "";
  return prefix && !locator.label.toLocaleLowerCase().startsWith(prefix)
    ? `${prefix}${locator.label}`
    : locator.label;
}
function receiptSource(receipt: LegalEvidenceReceiptEvent["evidence"][number]) {
  return {
    provider: receipt.provider,
    jurisdiction: receipt.jurisdiction,
    citation: receipt.citation,
    name: receipt.name,
    dataset: receipt.dataset,
    url: receipt.external_url,
    ...(receipt.locator.label && { locator: viewerLocator(receipt.locator) }),
    ...(receipt.span_text && { quote: receipt.span_text }),
  };
}

export type ReadSubagentSource = {
  provider: string;
  jurisdiction: string;
  citation: string;
  name: string | null;
  dataset: string;
  url: string | null;
  clusterId?: number;
  locator?: string;
  quote?: string;
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
  status: "running" | "completed" | "error" | "interrupted";
  output?: string;
  error?: string;
  activities?: ReadSubagentActivity[];
  reasoning?: string[];
  sources?: ReadSubagentSource[];
  grounding?: LegalEvidenceReceiptEvent;
  resume?: ReadSubagentCheckpoint;
};

export type ReadSubagentCheckpoint = {
  id: string;
  continuation_id: string;
  model: string;
  effort: string;
  assignment: {
    task: string;
    scope: string;
    jurisdiction: ReadSubagentRegion;
    collections?: string[];
    source_types?: string[];
  };
  evidence: LegalEvidenceReceipt[];
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
      "Dispatch one concurrent round of two to four independent reading agents. Put every non-overlapping assignment in this single call; lone assignments are invalid. Delegate only when parallel reading is worthwhile. Later rounds are allowed only when the prior search ledger identifies a concrete gap and the new assignments materially change the query, scope, source collection, period, or strategy. An unqualified request about multiple jurisdictions means jurisdictions within the standing region, not different countries or world regions. Keep work in the main turn when fewer than two useful independent slices exist. Do not use it for simple lookups, deterministic operations, or any write task. Completed results include exact grounded passages and a compact search ledger; review them against every element of the user's request, omit non-responsive candidates, and reuse their evidence IDs without re-fetching them.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          minItems: 2,
          maxItems: 4,
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
            "Two to four non-overlapping reader assignments dispatched concurrently.",
        },
      },
      required: ["assignments"],
      additionalProperties: false,
    },
  },
};

export const RESUME_SUBAGENT_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: RESUME_SUBAGENT_TOOL_NAME,
    description:
      "Resume one or more interrupted reading agents in their existing sessions. Supply only the listed run IDs; the original assignment and tool history are retained.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
};

export const READ_SUBAGENT_SYSTEM_PROMPT =
  "Do ordinary legal research yourself with the direct legal-source and citator tools. Delegate only when the requested scale genuinely benefits from parallelism, such as an exhaustive scan, a bulk query, or broad research with at least two worthwhile independent lanes. Call delegate_read once per round with two to four specific, non-overlapping assignments in its assignments array; never dispatch or wait on one agent. Resume an interrupted reading agent with resume_read instead of creating a replacement assignment. Scope assignments by court or jurisdiction within the standing region, source collection, period, or genuinely different search strategy. Never turn an unqualified request about multiple jurisdictions into different countries or world regions. Never use United States or United Kingdom law as a lane unless the user's current request or selected regions expressly include it. Never clone or lightly rephrase one assignment. Keep work without at least two useful lanes in the main turn. Wait for all sibling results, then skeptically compare each exact passage against every required element of the user's request. Report only responsive results; omit merely analogous, adjacent, or conceptually related candidates. A reader miss is not proof that no result exists: inspect the returned search ledgers and, when a concrete untried query or scope could materially help, dispatch another two-to-four-agent round with meaningfully revised assignments. Do not force a result when thorough searches leave no honest answer; state the verified shortfall. Reuse returned evidence IDs directly and submit the final grounded answer yourself.";

export type ReadSubagentRegion = "CA" | "US" | "UK";
export type ReadSubagentForeignRegion = Exclude<ReadSubagentRegion, "CA">;

export function resumableReadSubagents(events: readonly unknown[]) {
  const latest = new Map<string, Record<string, unknown>>();
  for (const value of events) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.type === "subagent_run" && typeof event.id === "string") {
      latest.set(event.id, event);
    }
  }
  const resumable = new Map<string, ReadSubagentCheckpoint>();
  for (const [id, event] of latest) {
    if (event.status !== "interrupted" || !event.resume ||
        typeof event.resume !== "object" || Array.isArray(event.resume)) continue;
    const row = event.resume as Record<string, unknown>;
    const assignment = row.assignment;
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment) ||
        typeof row.continuation_id !== "string" ||
        typeof row.model !== "string" || typeof row.effort !== "string") continue;
    const input = assignment as Record<string, unknown>;
    if (typeof input.task !== "string" || typeof input.scope !== "string" ||
        !["CA", "US", "UK"].includes(String(input.jurisdiction))) continue;
    resumable.set(id, {
      id,
      continuation_id: row.continuation_id,
      model: row.model,
      effort: row.effort,
      assignment: {
        task: input.task,
        scope: input.scope,
        jurisdiction: input.jurisdiction as ReadSubagentRegion,
        ...(Array.isArray(input.collections) && {
          collections: input.collections.filter((value): value is string =>
            typeof value === "string"),
        }),
        ...(Array.isArray(input.source_types) && {
          source_types: input.source_types.filter((value): value is string =>
            typeof value === "string"),
        }),
      },
      evidence: Array.isArray(row.evidence)
        ? row.evidence as LegalEvidenceReceipt[]
        : [],
    });
  }
  return resumable;
}

export function readSubagentResumePrompt(
  checkpoints: ReadonlyMap<string, ReadSubagentCheckpoint>,
) {
  if (!checkpoints.size) return "";
  return [
    "INTERRUPTED READING AGENTS AVAILABLE TO RESUME:",
    "Call resume_read with these existing run IDs to continue their original sessions. Do not restate or replace their assignments.",
    ...[...checkpoints.values()].map((checkpoint) =>
      `- ${checkpoint.id}: ${checkpoint.assignment.scope}: ${checkpoint.assignment.task}`),
  ].join("\n");
}

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

export function readSubagentJurisdiction(
  call: NormalizedToolCall,
): ReadSubagentRegion {
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
  maxAgents = 4,
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
            "Call delegate_read once per round with two to four assignments.",
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
  if (assignments.length < 2 || assignments.length > 4) {
    return {
      parent: null,
      assignments: [] as NormalizedToolCall[],
      rejected: [{
        tool_use_id: parent.id,
        status: "error" as const,
        content: JSON.stringify({
          ok: false,
          error: "delegate_read requires two to four assignments.",
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

export async function runReadSubagentRound({
  calls,
  admit,
  runDirect,
  runReader,
  resumable = new Map(),
  runResume = runReader,
}: {
  calls: NormalizedToolCall[];
  admit: ReturnType<typeof createReadSubagentAdmission>;
  runDirect: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
  runReader: (call: NormalizedToolCall) => Promise<NormalizedToolResult>;
  resumable?: ReadonlyMap<string, ReadSubagentCheckpoint>;
  runResume?: (
    call: NormalizedToolCall,
    checkpoint: ReadSubagentCheckpoint,
  ) => Promise<NormalizedToolResult>;
}) {
  const readers = prepareReadSubagentRound(
    calls.filter((call) => call.name === READ_SUBAGENT_TOOL_NAME),
    admit,
  );
  const resumeCalls = calls.filter(
    (call) => call.name === RESUME_SUBAGENT_TOOL_NAME,
  );
  const direct = calls.filter(
    (call) =>
      call.name !== READ_SUBAGENT_TOOL_NAME &&
      call.name !== RESUME_SUBAGENT_TOOL_NAME,
  );
  const results = [
    ...(direct.length ? await runDirect(direct) : []),
    ...readers.rejected,
  ];
  if (readers.parent) {
    results.push(
      combineReadSubagentResults(
        readers.parent,
        await Promise.all(readers.assignments.map(runReader)),
      ),
    );
  }
  if (resumeCalls.length > 1) {
    results.push(...resumeCalls.map((call) => ({
      tool_use_id: call.id,
      status: "error" as const,
      content: JSON.stringify({
        ok: false,
        error: "Call resume_read once with all run IDs to resume.",
      }),
    })));
  } else if (resumeCalls[0]) {
    const parent = resumeCalls[0];
    const ids = Array.isArray(parent.input.ids)
      ? parent.input.ids.filter((value): value is string =>
          typeof value === "string")
      : [];
    const checkpoints = ids.map((id) => resumable.get(id));
    if (!ids.length || new Set(ids).size !== ids.length ||
        checkpoints.some((checkpoint) => !checkpoint)) {
      results.push({
        tool_use_id: parent.id,
        status: "error",
        content: JSON.stringify({
          ok: false,
          error: "resume_read requires available interrupted run IDs.",
        }),
      });
    } else {
      results.push(combineReadSubagentResults(
        parent,
        await Promise.all(checkpoints.map((checkpoint, index) =>
          runResume({
            id: `${parent.id}:${index + 1}`,
            name: RESUME_SUBAGENT_TOOL_NAME,
            input: checkpoint!.assignment,
          }, checkpoint!),
        )),
      ));
    }
  }
  return calls.map(
    (call) =>
      results.find((result) => result.tool_use_id === call.id) ?? {
        tool_use_id: call.id,
        status: "error" as const,
        content: JSON.stringify({
          ok: false,
          error: `Tool '${call.name}' is not available.`,
        }),
      },
  );
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
  "Finish only with submit_grounded_answer. Its top-level object contains only claims; every claim requires text and evidence_ids. Prefer concise direct quotations, weaving up to three disjoint exact spans into one support unit when useful; paraphrase only when synthesis is materially clearer. Use exact evidence_id values returned by retrieval tools. Put sources only in evidence_ids; do not put citation or pinpoint prose in text.";

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
  resume?: ReadSubagentCheckpoint;
}): Promise<NormalizedToolResult> {
  const role: ReadSubagentRole = "scout";
  const input = params.resume?.assignment ?? params.call.input;
  const task =
    typeof input.task === "string"
      ? input.task.trim().slice(0, MAX_TASK_CHARS)
      : "";
  const scope =
    typeof input.scope === "string"
      ? input.scope.trim().slice(0, 240)
      : "";
  const assignmentCall = { ...params.call, input };
  const jurisdiction = readSubagentJurisdiction(assignmentCall);
  const collections = readSubagentCollections(assignmentCall);
  const sourceTypes = readSubagentSourceTypes(assignmentCall);
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
    model: params.resume?.model ?? params.model,
    effort: params.resume?.effort ?? params.effort,
  });
  if (!capability.available) {
    return {
      tool_use_id: params.call.id,
      status: "error",
      content: JSON.stringify({ ok: false, error: capability.reason }),
    };
  }

  if (params.resume) {
    registerPriorLegalEvidence(params.evidenceState, params.resume.evidence);
  }
  let continuationId = params.resume?.continuation_id;
  const assignment = {
    task,
    scope,
    jurisdiction,
    ...(Array.isArray(input.collections) && {
      collections: input.collections.filter(
        (value): value is string => typeof value === "string",
      ),
    }),
    ...(Array.isArray(input.source_types) && {
      source_types: input.source_types.filter(
        (value): value is string => typeof value === "string",
      ),
    }),
  };
  const baseEvent = {
    type: "subagent_run" as const,
    id: params.resume?.id ?? params.call.id,
    agent: role,
    task: `${scope}: ${task}`,
    model: capability.displayName,
    effort: capability.effort,
  };
  const activities: ReadSubagentActivity[] = [];
  const activityByCallId = new Map<string, ReadSubagentActivity>();
  const activityBySource = new Map<string, ReadSubagentActivity>();
  const discoveredSources = new Map<string, ReadSubagentSource>();
  const searches: { tool: string; query: string; summary: string }[] = [];
  const eventActivities = () => activities.map((item) => ({
    ...item,
    ...(item.paragraphs && { paragraphs: [...item.paragraphs] }),
  }));
  const eventSources = () => {
    const sources = [
      ...discoveredSources.values(),
      ...[...params.evidenceState.evidence.values()].flatMap(({ receipt }) =>
        receipt.source_class === "case" ? [receiptSource(receipt)] : [],
      ),
    ];
    return [
      ...new Map(
        sources.map((source) => [
          `${source.provider}:${source.citation.toLocaleLowerCase()}:${source.locator ?? ""}`,
          source,
        ]),
      ).values(),
    ];
  };
  const sourceEvent = () => {
    const sources = eventSources();
    return sources.length ? { sources } : {};
  };
  const resumeEvent = () => continuationId
    ? {
        resume: {
          id: baseEvent.id,
          continuation_id: continuationId,
          model: capability.model,
          effort: capability.effort,
          assignment,
          evidence: [...params.evidenceState.evidence.values()].map(
            ({ receipt }) => receipt,
          ),
        } satisfies ReadSubagentCheckpoint,
      }
    : {};
  params.onEvent?.({
    ...baseEvent,
    status: "running",
    ...sourceEvent(),
    ...resumeEvent(),
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
        if (label) {
          const paragraphs = readActivityParagraphs(call.input);
          const sourceKey = source
            ? `citation:${source.citation.toLocaleLowerCase()}`
            : citation
              ? `citation:${citation}`
              : clusterIds.length
                ? `cluster:${clusterIds.join(",")}`
                : null;
          const existing = sourceKey ? activityBySource.get(sourceKey) : undefined;
          if (existing) {
            existing.status = "running";
            existing.paragraphs = [
              ...new Set([...(existing.paragraphs ?? []), ...paragraphs]),
            ];
            activityByCallId.set(call.id, existing);
            continue;
          }
          const activity: ReadSubagentActivity = {
            id: call.id,
            label,
            status: "running",
            ...((params.activityDetail === "tools" ||
              params.activityDetail === "trace") && {
              tool: call.name,
              input: call.input,
            }),
            ...(source && { source }),
            ...(paragraphs.length && { paragraphs }),
          };
          activities.push(activity);
          activityByCallId.set(call.id, activity);
          if (sourceKey) activityBySource.set(sourceKey, activity);
        }
      }
      params.onEvent?.({
        ...baseEvent,
        status: "running",
        activities: eventActivities(),
        ...sourceEvent(),
        ...resumeEvent(),
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
      for (const { receipt } of params.evidenceState.evidence.values()) {
        if (receipt.source_class !== "case") continue;
        discoveredSources.set(
          `citation:${receipt.citation.toLocaleLowerCase()}`,
          receiptSource(receipt),
        );
      }
      for (const call of calls) {
        const activity = activityByCallId.get(call.id);
        const citation = typeof call.input.citation === "string"
          ? call.input.citation.trim().toLocaleLowerCase()
          : "";
        const source = citation
          ? discoveredSources.get(`citation:${citation}`)
          : undefined;
        if (!activity || activity.source || !source) continue;
        activity.source = source;
        activity.label = `Reading ${source.name ? `${source.name}, ` : ""}${source.citation}`;
      }
      for (const result of results) {
        const activity = activityByCallId.get(result.tool_use_id);
        if (activity) {
          activity.status = result.status === "error" ? "error" : "completed";
        }
      }
      params.onEvent?.({
        ...baseEvent,
        status: "running",
        activities: eventActivities(),
        ...sourceEvent(),
        ...resumeEvent(),
      });
      feedback.push(
        ...results.map(
          (result) =>
            `${calls.find((call) => call.id === result.tool_use_id)?.name ?? "tool"}: ${result.content}`,
        ),
      );
      return results;
    };
    const run = async (content: string) => {
      const result = await streamChatWithTools({
        model: `codex:${capability.model}`,
        reasoningEffort: capability.effort,
        enableThinking: true,
        reasoningSummary: "none",
        abortSignal: params.signal,
        systemPrompt: continuationId
          ? ""
          : `${ROLE_INSTRUCTIONS}\n\n${params.jurisdictionPrompt ? `${params.jurisdictionPrompt}\n\n` : ""}${SOURCE_SEARCH_SYSTEM_PROMPT}\n\nRemain strictly read-only and use only the supplied retrieval tools. ${GROUNDED_ANSWER_INSTRUCTIONS}`,
        messages: [{ role: "user", content }],
        tools: params.tools,
        runTools,
        providerSession: {
          persist: true,
          ...(continuationId && { continuationId }),
          onContinuationId(id) {
            continuationId = id;
            params.onEvent?.({
              ...baseEvent,
              status: "running",
              activities: eventActivities(),
              ...sourceEvent(),
              ...resumeEvent(),
            });
          },
        },
      });
      continuationId = result.continuationId ?? continuationId;
      return result;
    };
    const assignmentPrompt = `Assigned scope: ${scope}\n\nQuestion: ${task}`;
    let prompt = params.resume
      ? "Continue the assigned task from where you stopped. Complete the grounded answer using the existing assignment and tool history."
      : assignmentPrompt;
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
      const rejection = grounding?.failure ?? "No grounded submission was received.";
      prompt = `${assignmentPrompt}\n\nYour previous attempt did not pass the grounding gate: ${rejection}\n\nContinue revising using the schema and tool feedback below. Retrieve more passages if needed.\n\n${priorFeedback || "No tool feedback was returned; retrieve evidence before submitting."}`;
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
    params.onEvent?.({
      ...baseEvent,
      status: "completed",
      output: rendered,
      activities: eventActivities(),
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
    const interrupted = Boolean(params.signal?.aborted) ||
      (error instanceof Error && error.name === "AbortError");
    for (const activity of activities) {
      if (activity.status === "running") {
        activity.status = interrupted ? "interrupted" : "error";
      }
    }
    params.onEvent?.({
      ...baseEvent,
      status: interrupted ? "interrupted" : "error",
      error: message,
      activities: eventActivities(),
      ...sourceEvent(),
      ...resumeEvent(),
    });
    return {
      tool_use_id: params.call.id,
      status: "error",
      content: JSON.stringify({
        ok: false,
        error: message,
        ...(interrupted && {
          interrupted: true,
          ...(continuationId && { resume_id: baseEvent.id }),
        }),
      }),
    };
  }
}
