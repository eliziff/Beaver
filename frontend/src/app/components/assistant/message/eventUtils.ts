import type { AssistantEvent } from "../../shared/types";
import {
    assistantActivityFamily,
    assistantEventKey,
} from "@/app/lib/assistantStreamEvents";

type CaseCitation = Extract<AssistantEvent, { type: "case_citation" }>;
type AskResponse = Extract<AssistantEvent, { type: "ask_inputs_response" }>;

type ActivityItem = {
    label: string;
    detail?: string;
    url?: string | null;
    error?: boolean;
};

export type ActivityView = {
    label: string;
    detail?: string;
    markdown?: string;
    items?: ActivityItem[];
    busy?: boolean;
    error?: boolean;
    panelAction?: boolean;
    citationSources?: NonNullable<
        Extract<AssistantEvent, { type: "subagent_run" }>["sources"]
    >;
};

type ActivityContext = {
    response?: AskResponse;
    caseCitations?: Map<string, CaseCitation>;
    events?: AssistantEvent[];
    index?: number;
};

const TOOLS: Record<string, readonly [string, string?]> = {
    ask_inputs: ["Asking for input"],
    generate_docx: ["Creating document", "doc_created"],
    generate_excel: ["Creating spreadsheet"],
    generate_ppt: ["Creating presentation"],
    Edit: ["Editing document", "doc_edited"],
    Read: ["Reading document", "doc_read"],
    Grep: ["Searching document", "doc_find"],
    Glob: ["Listing documents"],
    read_workflow: ["Loading workflow"],
    list_workflows: ["Loading workflows"],
    courtlistener_search_case_law: ["Searching case law"],
    courtlistener_get_cases: ["Fetching cases"],
    courtlistener_find_in_case: ["Searching case"],
    courtlistener_read_case: ["Reading case"],
    courtlistener_verify_citations: ["Verifying citations"],
    a2aj_search: ["Searching Canadian legal sources"],
    a2aj_fetch: ["Reading Canadian legal source"],
    a2aj_lookup: ["Looking up Canadian legal passage"],
    create_table_of_authorities: ["Creating authorities", "automation_run"],
    link_docx_citations: ["Adding citation links", "automation_run"],
    fix_docx_supras: ["Fixing supra references", "automation_run"],
    submit_grounded_answer: ["Finalizing answer"],
    delegate_read: ["Starting reading agent", "subagent_run"],
};

function toolLabel(name: string) {
    if (TOOLS[name]) return TOOLS[name][0];
    return null;
}

function plainText(text: string) {
    return text
        .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
        .replace(/[*_`~]+/gu, "")
        .replace(/^\s*(?:#{1,6}|[-+>])\s+/gmu, "")
        .replace(/\s+/gu, " ")
        .trim();
}

function count(value: number, singular: string, plural = `${singular}s`) {
    return `${value} ${value === 1 ? singular : plural}`;
}

function caseLabel(
    event: {
        cluster_id: number | null;
        case_name?: string | null;
        citation?: string | null;
    },
    fallback = "case",
) {
    return (
        [event.case_name, event.citation].filter(Boolean).join(", ") ||
        (event.cluster_id ? `cluster ${event.cluster_id}` : fallback)
    );
}
function tracked(
    event: { isStreaming?: boolean; error?: string | null },
    labels: readonly [string, string, string],
    detail?: string,
    items?: ActivityItem[],
): ActivityView {
    const failed = !!event.error;
    return {
        label: labels[event.isStreaming ? 0 : failed ? 1 : 2],
        detail: event.error ?? detail,
        ...(items && { items }),
        busy: !!event.isStreaming,
        error: failed,
    };
}

export function activityView(
    event: AssistantEvent,
    context: ActivityContext = {},
): ActivityView | null {
    if (event.type === "reasoning") {
        if (!event.debug) return null;
        const text = event.text.replace(/\r\n?/gu, "\n").trim();
        const label = plainText(text.split(/\n{2,}/u).at(-1) ?? text).slice(0, 120);
        return label
            ? { label, busy: !!event.isStreaming }
            : null;
    }
    if (event.type === "tool_call_start") {
        const label = event.label ?? toolLabel(event.name);
        if (!label) return null;
        return {
            label,
            ...(event.input && {
                detail: event.name,
                markdown: `\`\`\`json\n${JSON.stringify(event.input, null, 2)}\n\`\`\``,
            }),
            busy: !!event.isStreaming,
        };
    }
    if (event.type === "thinking")
        return { label: "Thinking", busy: true };
    if (event.type === "compaction")
        return {
            label:
                event.status === "running"
                    ? "Compacting context"
                    : event.status === "failed"
                      ? "Context compaction failed"
                      : "Context compacted",
            busy: event.status === "running",
        };
    if (event.type === "mcp_tool_call") return null;
    if (event.type === "doc_read")
        return {
            label: `${event.isStreaming ? "Reading" : "Read"} ${event.filename}`,
            busy: !!event.isStreaming,
        };
    if (event.type === "subagent_run") {
        const failed = event.status === "error";
        const running = event.status === "running";
        const interrupted = event.status === "interrupted";
        const cancelled = event.status === "cancelled";
        const task = plainText(event.task).slice(0, 100);
        if (running && context.events && context.index !== undefined) {
            const latestById = new Map<
                string,
                {
                    event: Extract<AssistantEvent, { type: "subagent_run" }>;
                    index: number;
                }
            >();
            context.events.forEach((candidate, index) => {
                if (candidate.type === "subagent_run") {
                    latestById.set(candidate.id, { event: candidate, index });
                }
            });
            const active = [...latestById.values()]
                .filter((entry) => entry.event.status === "running")
                .sort((left, right) => left.index - right.index);
            if (context.index !== active.at(-1)?.index) return null;
            return {
                label: `Waiting for ${count(active.length, "reading agent")}`,
                busy: true,
            };
        }
        return {
            label: failed
                ? "Reading agent failed"
                : interrupted
                  ? `Reading agent interrupted: ${task}`
                  : cancelled
                    ? `Reading agent stopped: ${task}`
                : `Reading agent completed: ${task}`,
            detail: failed
                ? event.error
                : event.grounding?.status === "passed"
                  ? count(event.grounding.evidence.length, "verified passage")
                  : undefined,
            ...(event.output && {
                markdown: event.output,
                citationSources: event.sources ?? [],
            }),
            busy: false,
            error: failed,
            panelAction: true,
        };
    }
    if (event.type === "doc_find")
        return {
            label: `${event.isStreaming ? "Searching" : "Searched"} ${event.filename}`,
            detail: `“${event.query}”${
                event.isStreaming
                    ? ""
                    : ` · ${count(event.total_matches, "match")}`
            }`,
            busy: !!event.isStreaming,
        };
    if (event.type === "doc_created")
        return {
            label: `${event.isStreaming ? "Creating" : "Created"} ${event.filename}`,
            busy: !!event.isStreaming,
        };
    if (event.type === "doc_edited")
        return tracked(event, [
            `Editing ${event.filename}`,
            `Edit failed ${event.filename}`,
            `Edited ${event.filename}`,
        ]);
    if (event.type === "workflow_applied")
        return { label: `Applied ${event.title}` };
    if (event.type === "ask_inputs") {
        const responseById = new Map(
            context.response?.responses.map((item) => [item.id, item]) ?? [],
        );
        return {
            label: context.response ? "Asked for input" : "Waiting for input",
            busy: !context.response,
            items: event.items.map((item, index) => {
                const answer = responseById.get(item.id);
                const detail = !answer
                    ? undefined
                    : answer.skipped
                      ? "Skipped"
                      : answer.kind === "choice"
                        ? answer.answer
                        : answer.filenames.join(", ") ||
                          "No documents attached";
                return {
                    label: `${index + 1}. ${
                        item.kind === "choice"
                            ? item.question
                            : item.document_types.join(", ") ||
                              "Documents requested"
                    }`,
                    detail,
                };
            }),
        };
    }
    if (event.type === "courtlistener_search_case_law") {
        const results = event.result_count ?? 0;
        return tracked(
            event,
            ["Searching case law", "Case law search failed", "Searched case law"],
            event.isStreaming
                ? event.query
                    ? `for “${event.query}”`
                    : undefined
                : `${count(results, "result")}${
                      event.query ? ` for “${event.query}”` : ""
                  }`,
        );
    }
    if (event.type === "courtlistener_get_cases") {
        const caseCount = event.case_count ?? event.cluster_ids.length;
        const items =
            event.cases?.map((item) => ({
                label:
                    [item.case_name, item.citation]
                        .filter(Boolean)
                        .join(", ") || `Cluster ${item.cluster_id}`,
                url: item.url,
            })) ??
            event.cluster_ids.map((id) => {
                const citation = context.caseCitations?.get(`us-case-${id}`);
                return {
                    label:
                        [citation?.case_name, citation?.citation]
                            .filter(Boolean)
                            .join(", ") || `Cluster ${id}`,
                    url: citation?.url,
                };
            });
        return tracked(
            event,
            [
                `Fetching ${count(caseCount, "case")}`,
                "Case fetch failed",
                `Fetched ${count(caseCount, "case")}`,
            ],
            undefined,
            items,
        );
    }
    if (event.type === "courtlistener_find_in_case") {
        const searches = event.searches ?? [];
        if (searches.length) {
            const matches =
                event.total_matches ??
                searches.reduce(
                    (total, search) =>
                        total + (search.total_matches ?? 0),
                    0,
                );
            const cases = new Set(
                searches.map(
                    (search) =>
                        search.cluster_id ??
                        `${search.case_name ?? ""}|${search.citation ?? ""}`,
                ),
            ).size;
            return tracked(
                event,
                [
                    `Running ${count(searches.length, "search")} in ${count(cases, "case")}`,
                    "Case searches failed",
                    `Ran ${count(searches.length, "search")} in ${count(cases, "case")}`,
                ],
                event.isStreaming ? undefined : count(matches, "match"),
                searches.map((search) => ({
                    label: `“${search.query}” in ${caseLabel(search)}`,
                    detail: count(search.total_matches ?? 0, "match"),
                    error: !!search.error,
                })),
            );
        }
        const label = caseLabel(event);
        return tracked(
            event,
            [
                `Searching ${label}`,
                `Search failed ${label}`,
                `Searched ${label}`,
            ],
            `${count(event.total_matches ?? 0, "match")}${
                event.query ? ` for “${event.query}”` : ""
            }`,
        );
    }
    if (event.type === "courtlistener_read_case") {
        const label = caseLabel(event);
        return tracked(
            event,
            [`Reading ${label}`, `Read failed ${label}`, `Read ${label}`],
            event.opinion_count
                ? count(event.opinion_count, "opinion")
                : undefined,
        );
    }
    if (event.type === "courtlistener_verify_citations") {
        const citationCount = event.citation_count ?? 0;
        const items: ActivityItem[] = [];
        const allEvents = context.events ?? [];
        for (
            let index = (context.index ?? -1) + 1;
            index < allEvents.length;
            index++
        ) {
            const citation = allEvents[index];
            if (citation.type !== "case_citation") break;
            items.push({
                label:
                    [citation.case_name, citation.citation]
                        .filter(Boolean)
                        .join(", ") || "Unknown case",
                url: citation.url,
            });
        }
        return tracked(
            event,
            [
                `Verifying ${count(citationCount, "citation")}`,
                "Citation verification failed",
                `Verified ${count(citationCount, "citation")}`,
            ],
            event.isStreaming
                ? undefined
                : count(event.match_count ?? 0, "match"),
            items,
        );
    }
    if (event.type === "automation_run")
        return {
            label: event.error ? "Automation failed" : event.stage,
            detail: event.error,
            busy: event.status === "running" || event.status === "queued",
            error: !!event.error,
        };
    return null;
}

export function dedupeActivityEntries<
    T extends { event: AssistantEvent; index: number },
>(entries: T[]): T[] {
    const hasConcreteActivity = entries.some(({ event }) =>
        event.type !== "reasoning" && event.type !== "thinking"
    );
    const completedKeys = new Set<string>();
    const concreteFamilies = new Set<string>();
    const result: T[] = [];
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry.event.type === "reasoning" && !entry.event.debug) continue;
        if (entry.event.type === "reasoning" && hasConcreteActivity) continue;
        const isStreaming =
            "isStreaming" in entry.event && !!entry.event.isStreaming;
        const family = assistantActivityFamily(entry.event);
        const key =
            entry.event.type === "reasoning"
                ? `reasoning:${plainText(entry.event.text)}`
                : assistantEventKey(entry.event);
        const nextEntry = result.at(-1);
        if (
            (entry.event.type === "thinking" && result.length > 0) ||
            (entry.event.type === "tool_call_start" &&
                concreteFamilies.has(family)) ||
            (isStreaming && completedKeys.has(key)) ||
            (entry.event.type === "reasoning" &&
                nextEntry?.event.type === "reasoning" &&
                plainText(nextEntry.event.text) ===
                    plainText(entry.event.text))
        )
            continue;
        if (!isStreaming) completedKeys.add(key);
        if (entry.event.type !== "tool_call_start")
            concreteFamilies.add(family);
        result.push(entry);
    }
    return result.reverse();
}
