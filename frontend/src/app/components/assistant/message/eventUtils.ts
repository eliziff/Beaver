import type { AssistantEvent } from "../../shared/types";

export function toolCallLabel(name: string): string {
    if (name === "ask_inputs") return "Asking for input...";
    if (name === "generate_docx" || name === "library_create_docx")
        return "Creating document...";
    if (name === "generate_excel") return "Creating spreadsheet...";
    if (name === "generate_ppt") return "Creating presentation...";
    if (name === "edit_document" || name === "library_revise_docx")
        return "Editing document...";
    if (name === "read_document") return "Reading document...";
    if (name === "fetch_documents") return "Reading documents...";
    if (name === "find_in_document") return "Searching document...";
    if (name === "read_workflow") return "Loading workflow...";
    if (name === "list_workflows") return "Loading workflows...";
    if (name === "list_documents") return "Loading documents...";
    if (name === "courtlistener_search_case_law")
        return "Searching case law...";
    if (name === "courtlistener_get_cases") return "Fetching cases...";
    if (name === "courtlistener_find_in_case") return "Searching case...";
    if (name === "courtlistener_read_case") return "Reading case...";
    if (name === "courtlistener_verify_citations")
        return "Verifying citations...";
    if (name === "a2aj_search") return "Searching Canadian legal sources...";
    if (name === "a2aj_fetch") return "Reading Canadian legal source...";
    if (name === "a2aj_lookup") return "Looking up Canadian legal passage...";
    if (
        name === "toa_submit_library_document" ||
        name === "toa_job_status"
    )
        return "Creating authorities...";
    if (name === "library_link_docx_citations")
        return "Adding citation links...";
    if (name === "library_fix_docx_supras")
        return "Fixing supra references...";
    if (name.startsWith("mcp_")) return "Using connector...";
    const readable = name
        .replace(/^(?:openai|codex|beaver|mike|library)[_:./-]+/iu, "")
        .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
        .replace(/[_:./-]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .toLowerCase();
    return readable ? `Using ${readable}...` : "Using tool...";
}

function plainActivityText(text: string) {
    return text
        .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
        .replace(/[*_`~]+/gu, "")
        .replace(/^\s*(?:#{1,6}|[-+>])\s+/gmu, "")
        .replace(/\s+/gu, " ")
        .trim();
}

export function activityLabel(event: AssistantEvent): string | null {
    if (event.type === "reasoning")
        return plainActivityText(event.text).slice(0, 120) || null;
    if (event.type === "tool_call_start")
        return toolCallLabel(event.name).replace(/\.{3}$/u, "");
    if (event.type === "thinking") return "Thinking";
    if (event.type === "doc_read")
        return `${event.isStreaming ? "Reading" : "Read"} ${event.filename}`;
    if (event.type === "doc_find")
        return `${event.isStreaming ? "Searching" : "Searched"} ${event.filename}`;
    if (event.type === "doc_created")
        return `${event.isStreaming ? "Creating" : "Created"} ${event.filename}`;
    if (event.type === "doc_edited")
        return `${event.isStreaming ? "Editing" : event.error ? "Edit failed" : "Edited"} ${event.filename}`;
    if (event.type === "workflow_applied") return `Applied ${event.title}`;
    if (event.type === "ask_inputs") return "Waiting for input";
    if (event.type === "mcp_tool_call") {
        return event.connector_name
            ? `${event.connector_name}: ${toolCallLabel(event.tool_name).replace(/\.{3}$/u, "")}`
            : toolCallLabel(event.openai_tool_name).replace(/\.{3}$/u, "");
    }
    if (event.type === "courtlistener_search_case_law")
        return event.isStreaming ? "Searching case law" : "Searched case law";
    if (event.type === "courtlistener_get_cases")
        return event.isStreaming ? "Fetching cases" : "Fetched cases";
    if (event.type === "courtlistener_find_in_case")
        return event.isStreaming ? "Searching case" : "Searched case";
    if (event.type === "courtlistener_read_case")
        return event.isStreaming ? "Reading case" : "Read case";
    if (event.type === "courtlistener_verify_citations")
        return event.isStreaming ? "Verifying citations" : "Verified citations";
    if (event.type === "automation_run")
        return event.error ? "Automation failed" : event.stage;
    return null;
}

function activityFamily(event: AssistantEvent): string {
    if (event.type === "automation_run") return "automation_run";
    if (event.type !== "tool_call_start") return event.type;
    if (
        event.name === "read_document" ||
        event.name === "fetch_documents"
    )
        return "doc_read";
    if (event.name === "find_in_document") return "doc_find";
    if (
        event.name === "generate_docx" ||
        event.name === "library_create_docx"
    )
        return "doc_created";
    if (
        event.name === "edit_document" ||
        event.name === "library_revise_docx"
    )
        return "doc_edited";
    if (
        event.name === "toa_submit_library_document" ||
        event.name === "toa_job_status" ||
        event.name === "library_link_docx_citations" ||
        event.name === "library_fix_docx_supras"
    )
        return "automation_run";
    return event.name;
}

function activityKey(event: AssistantEvent): string {
    if (event.type === "reasoning")
        return `reasoning:${plainActivityText(event.text)}`;
    if (event.type === "doc_read")
        return `doc_read:${event.filename}`;
    if (event.type === "doc_find")
        return `doc_find:${event.filename}:${event.query}`;
    if (event.type === "doc_created")
        return `doc_created:${event.document_id ?? event.filename}`;
    if (event.type === "doc_edited")
        return `doc_edited:${event.document_id}`;
    if (event.type === "workflow_applied")
        return `workflow_applied:${event.workflow_id}`;
    if (event.type === "ask_inputs")
        return `ask_inputs:${event.items.map((item) => item.id).join(",")}`;
    if (event.type === "mcp_tool_call")
        return `mcp:${event.connector_id}:${event.openai_tool_name}`;
    if (event.type === "tool_call_start")
        return `tool:${event.name}`;
    if (event.type === "automation_run")
        return `automation:${event.job_id ?? event.id}`;
    return JSON.stringify(event);
}

export function dedupeActivityEntries<
    T extends { event: AssistantEvent; index: number },
>(entries: T[]): T[] {
    const seen = new Set<string>();
    return entries
        .filter((entry, index) => {
            if (
                entry.event.type === "thinking" &&
                entries.slice(index + 1).some(({ event }) => !!activityLabel(event))
            )
                return false;
            if (entry.event.type !== "tool_call_start") return true;
            const family = activityFamily(entry.event);
            return !entries
                .slice(index + 1)
                .some(({ event }) => activityFamily(event) === family);
        })
        .reverse()
        .filter(({ event }) => {
            const key = activityKey(event);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .reverse();
}
