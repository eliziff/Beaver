export const A2AJ_TOOL_NAMES = {
    search: "a2aj_search",
    fetch: "a2aj_fetch",
} as const;

export const A2AJ_TOOLS = [
    {
        type: "function",
        function: {
            name: A2AJ_TOOL_NAMES.search,
            description:
                "Search Canadian cases or legislation through the public A2AJ legal data API. Use this for a legal concept, case name, or statute title; use a2aj_fetch when you already have a citation.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search terms, case name, or statute title." },
                    doc_type: { type: "string", enum: ["cases", "laws"], description: "Search cases or laws. Defaults to cases." },
                    search_type: { type: "string", enum: ["full_text", "name"], description: "Search document text or names. Defaults to full_text." },
                    search_language: { type: "string", enum: ["en", "fr"], description: "Search language. Defaults to en." },
                    size: { type: "integer", minimum: 1, maximum: 10, description: "Number of results, up to 10." },
                    dataset: { type: "string", description: "Optional A2AJ dataset filter, such as SCC or ONCA." },
                    start_date: { type: "string", description: "Optional YYYY-MM-DD start date." },
                    end_date: { type: "string", description: "Optional YYYY-MM-DD end date." },
                    sort_results: { type: "string", enum: ["default", "newest_first", "oldest_first"] },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: A2AJ_TOOL_NAMES.fetch,
            description:
                "Fetch the authoritative Canadian case or legislation text for a citation from A2AJ. Use the returned text as the evidence for any quoted legal claim.",
            parameters: {
                type: "object",
                properties: {
                    citation: { type: "string", description: "Canadian citation, e.g. 2020 SCC 5 or RSC 1985, c C-46." },
                    doc_type: { type: "string", enum: ["cases", "laws"], description: "Fetch a case or law. Defaults to cases." },
                    output_language: { type: "string", enum: ["en", "fr"], description: "Text language. Defaults to en." },
                    section: { type: "string", description: "Optional section for legislation/regulations." },
                },
                required: ["citation"],
            },
        },
    },
];
