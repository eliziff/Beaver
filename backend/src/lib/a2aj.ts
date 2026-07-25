const A2AJ_BASE_URL = "https://api.a2aj.ca";
const A2AJ_TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;

export type A2AJDocument = {
    dataset: string;
    citation: string;
    alternateCitation: string | null;
    name: string | null;
    date: string | null;
    url: string | null;
    text: string;
    language: "en" | "fr";
    upstreamLicense: string | null;
};

export type A2AJSearchResult = {
    dataset: string;
    citation: string;
    alternateCitation: string | null;
    name: string | null;
    date: string | null;
    url: string | null;
    snippet: string | null;
};

function asRecord(value: unknown): JsonRecord | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonRecord)
        : null;
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textForLanguage(record: JsonRecord, field: string, language: "en" | "fr") {
    return (
        asString(record[`${field}_${language}`]) ??
        asString(record[`${field}_${language === "en" ? "fr" : "en"}`]) ??
        asString(record[field]) ??
        null
    );
}

function documentFromResult(value: unknown, language: "en" | "fr"): A2AJDocument | null {
    const record = asRecord(value);
    if (!record) return null;
    const requestedText = asString(record[`unofficial_text_${language}`]);
    const fallbackLanguage = language === "en" ? "fr" : "en";
    const actualLanguage = requestedText ? language : fallbackLanguage;
    const text = textForLanguage(record, "unofficial_text", actualLanguage);
    const citation =
        textForLanguage(record, "citation", actualLanguage) ??
        textForLanguage(record, "citation2", actualLanguage);
    if (!text || !citation) return null;
    return {
        dataset: asString(record.dataset) ?? "",
        citation,
        alternateCitation: textForLanguage(record, "citation2", actualLanguage),
        name: textForLanguage(record, "name", actualLanguage),
        date: textForLanguage(record, "document_date", actualLanguage),
        url:
            textForLanguage(record, "source_url", actualLanguage) ??
            textForLanguage(record, "url", actualLanguage),
        text,
        language: actualLanguage,
        upstreamLicense: asString(record.upstream_license),
    };
}

function searchResultFromResult(value: unknown, language: "en" | "fr"): A2AJSearchResult | null {
    const record = asRecord(value);
    if (!record) return null;
    const citation =
        textForLanguage(record, "citation", language) ??
        textForLanguage(record, "citation2", language);
    if (!citation) return null;
    const snippet =
        textForLanguage(record, "snippet", language) ??
        textForLanguage(record, "highlight", language) ??
        textForLanguage(record, "unofficial_text", language);
    return {
        dataset: asString(record.dataset) ?? "",
        citation,
        alternateCitation: textForLanguage(record, "citation2", language),
        name: textForLanguage(record, "name", language),
        date: textForLanguage(record, "document_date", language),
        url:
            textForLanguage(record, "source_url", language) ??
            textForLanguage(record, "url", language),
        snippet: snippet ? snippet.slice(0, 1200) : null,
    };
}

function apiError(status: number, body: unknown): Error {
    const record = asRecord(body);
    const detail = record?.detail;
    const message =
        asString(detail) ??
        (Array.isArray(detail)
            ? detail
                  .map((item) => asRecord(item)?.msg)
                  .filter((item): item is string => typeof item === "string")
                  .join("; ")
            : "") ??
        "";
    return new Error(message || `A2AJ API error (${status})`);
}

async function request(path: string, params: Record<string, string | number | undefined>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const response = await fetch(`${A2AJ_BASE_URL}${path}?${query}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(A2AJ_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw apiError(response.status, body);
    return asRecord(body) ?? {};
}

export async function fetchA2AJDocument(args: {
    citation: string;
    docType?: "cases" | "laws";
    language?: "en" | "fr";
    section?: string;
    maxChars?: number;
}): Promise<A2AJDocument | null> {
    const citation = args.citation.trim();
    if (!citation) throw new Error("citation is required");
    const language = args.language === "fr" ? "fr" : "en";
    const payload = await request("/fetch", {
        citation,
        doc_type: args.docType ?? "cases",
        output_language: language,
        section: args.section?.trim(),
    });
    const result = Array.isArray(payload.results)
        ? payload.results.find((item) => documentFromResult(item, language))
        : null;
    const document = result ? documentFromResult(result, language) : null;
    if (!document) return null;
    if (document.text.length > (args.maxChars ?? 50_000)) {
        return { ...document, text: document.text.slice(0, args.maxChars ?? 50_000) };
    }
    return document;
}

export async function searchA2AJ(args: {
    query: string;
    docType?: "cases" | "laws";
    searchType?: "full_text" | "name";
    language?: "en" | "fr";
    size?: number;
    dataset?: string;
    startDate?: string;
    endDate?: string;
    sortResults?: "default" | "newest_first" | "oldest_first";
}): Promise<A2AJSearchResult[]> {
    const query = args.query.trim();
    if (!query) throw new Error("query is required");
    const language = args.language === "fr" ? "fr" : "en";
    const payload = await request("/search", {
        query,
        doc_type: args.docType ?? "cases",
        search_type: args.searchType ?? "full_text",
        search_language: language,
        size: Math.min(Math.max(Math.floor(args.size ?? 10), 1), 50),
        dataset: args.dataset?.trim(),
        start_date: args.startDate?.trim(),
        end_date: args.endDate?.trim(),
        sort_results: args.sortResults ?? "default",
    });
    return (Array.isArray(payload.results) ? payload.results : [])
        .map((item) => searchResultFromResult(item, language))
        .filter((item): item is A2AJSearchResult => !!item)
        .slice(0, 50);
}
