import type { AssistantEvent } from "../../shared/types";
import { assistantEventKey } from "@/app/lib/assistantStreamEvents";

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
    library_create_docx: ["Creating document", "doc_created"],
    generate_excel: ["Creating spreadsheet"],
    generate_ppt: ["Creating presentation"],
    edit_document: ["Editing document", "doc_edited"],
    library_revise_docx: ["Editing document", "doc_edited"],
    read_document: ["Reading document", "doc_read"],
    fetch_documents: ["Reading documents", "doc_read"],
    find_in_document: ["Searching document", "doc_find"],
    read_workflow: ["Loading workflow"],
    list_workflows: ["Loading workflows"],
    list_documents: ["Loading documents"],
    courtlistener_search_case_law: ["Searching case law"],
    courtlistener_get_cases: ["Fetching cases"],
    courtlistener_find_in_case: ["Searching case"],
    courtlistener_read_case: ["Reading case"],
    courtlistener_verify_citations: ["Verifying citations"],
    a2aj_search: ["Searching Canadian legal sources"],
    a2aj_fetch: ["Reading Canadian legal source"],
    a2aj_lookup: ["Looking up Canadian legal passage"],
    toa_submit_library_document: ["Creating authorities", "automation_run"],
    toa_job_status: ["Creating authorities", "automation_run"],
    library_link_docx_citations: ["Adding citation links", "automation_run"],
    library_fix_docx_supras: ["Fixing supra references", "automation_run"],
};

function toolLabel(name: string) {
    if (TOOLS[name]) return TOOLS[name][0];
    if (name.startsWith("mcp_")) return "Using connector";
    const readable = name
        .replace(/^(?:openai|codex|beaver|mike|library)[_:./-]+/iu, "")
        .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
        .replace(/[_:./-]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .toLowerCase();
    return readable ? `Using ${readable}` : "Using tool";
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
        const markdown = event.text.replace(/\r\n?/gu, "\n").trim();
        const label = plainText(markdown).slice(0, 120);
        return label
            ? { label, markdown, busy: !!event.isStreaming }
            : null;
    }
    if (event.type === "tool_call_start")
        return { label: toolLabel(event.name), busy: true };
    if (event.type === "thinking")
        return { label: "Thinking", busy: true };
    if (event.type === "mcp_tool_call") {
        const error = event.status === "error";
        return {
            label: event.isStreaming
                ? "Using connector"
                : event.connector_name
                  ? `${event.connector_name}: ${toolLabel(event.tool_name)}`
                  : toolLabel(event.openai_tool_name),
            detail: error ? event.error : undefined,
            busy: !!event.isStreaming,
            error,
        };
    }
    if (event.type === "doc_read")
        return {
            label: `${event.isStreaming ? "Reading" : "Read"} ${event.filename}`,
            busy: !!event.isStreaming,
        };
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

function activityFamily(event: AssistantEvent) {
    if (event.type !== "tool_call_start") return event.type;
    return TOOLS[event.name]?.[1] ?? event.name;
}

export function dedupeActivityEntries<
    T extends { event: AssistantEvent; index: number },
>(entries: T[]): T[] {
    const seenKeys = new Set<string>();
    const seenFamilies = new Set<string>();
    const result: T[] = [];
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        const family = activityFamily(entry.event);
        const key =
            entry.event.type === "reasoning"
                ? `reasoning:${plainText(entry.event.text)}`
                : assistantEventKey(entry.event);
        if (
            (entry.event.type === "reasoning" &&
                /^analy[sz]ed (?:the )?request[.!:]*$/iu.test(
                    plainText(entry.event.text),
                )) ||
            (entry.event.type === "thinking" && result.length > 0) ||
            (entry.event.type === "tool_call_start" &&
                seenFamilies.has(family)) ||
            seenKeys.has(key)
        )
            continue;
        seenKeys.add(key);
        seenFamilies.add(family);
        result.push(entry);
    }
    return result.reverse();
}
