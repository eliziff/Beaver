export type ClientToolCall = {
    type: "client_tool_call";
    callId: string;
    name: string;
    input: Record<string, unknown>;
};

type Paragraph = { styleBuiltIn: string };
type Paragraphs = { items: Paragraph[]; load(value: string): void };
type Font = { bold: boolean; italic: boolean; underline: string };
type WordRange = {
    text: string;
    font: Font;
    paragraphs: Paragraphs;
    load(value: string): void;
    insertText(text: string, location: "Replace"): unknown;
};
type SearchResults = { items: WordRange[]; load(value: string): void };
type WordBody = WordRange & {
    search(text: string, options: Record<string, boolean>): SearchResults;
};
type WordDocument = {
    body: WordBody;
    changeTrackingMode: string;
    getSelection(): WordRange;
    load(value: string): void;
};
type WordContext = { document: WordDocument; sync(): Promise<void> };
type WordRuntime = {
    run<T>(callback: (context: WordContext) => Promise<T>): Promise<T>;
    ChangeTrackingMode: { off: string; trackAll: string };
};
type OfficeRuntime = {
    HostType: { Word: string };
    context: {
        document: { url?: string };
        requirements: { isSetSupported(name: string, version: string): boolean };
    };
    onReady(): Promise<{ host?: string }>;
};

const globals = () => ({
    office: (window as unknown as { Office?: OfficeRuntime }).Office,
    word: (window as unknown as { Word?: WordRuntime }).Word,
});

export async function wordDocumentContext() {
    const { office, word } = globals();
    if (!office || !word) throw new Error("Open Beaver from its Word add-in.");
    const ready = await office.onReady();
    if (ready.host && ready.host !== office.HostType.Word) {
        throw new Error("This add-in requires Microsoft Word.");
    }
    if (!office.context.requirements.isSetSupported("WordApi", "1.4")) {
        throw new Error("This version of Word does not support tracked editing.");
    }
    const raw = office.context.document.url?.trim() ?? "";
    let documentName = "Untitled document";
    if (raw) {
        try {
            const path = new URL(raw).pathname.split("/").filter(Boolean).at(-1);
            if (path) documentName = decodeURIComponent(path);
        } catch {
            documentName = raw.split(/[\\/]/u).at(-1) || documentName;
        }
    }
    return { document_name: documentName.slice(0, 500) };
}

async function readDocument(input: Record<string, unknown>) {
    const { word } = globals();
    if (!word) return { error: "Word is unavailable." };
    const scope = input.scope === "selection" ? "selection" : "document";
    const offset = Number.isSafeInteger(input.offset) && Number(input.offset) >= 0
        ? Number(input.offset) : 0;
    const maximum = Number.isSafeInteger(input.max_chars)
        ? Math.max(1, Math.min(50_000, Number(input.max_chars))) : 50_000;
    return word.run(async (context) => {
        const range = scope === "selection"
            ? context.document.getSelection() : context.document.body;
        range.load("text");
        await context.sync();
        const total = range.text.length;
        return {
            scope,
            offset: Math.min(offset, total),
            text: range.text.slice(offset, offset + maximum),
            total_chars: total,
        };
    });
}

type WordEdit = {
    original: string;
    replacement?: string;
    formats?: string[];
    occurrence?: "all";
};
const FORMATS = new Set([
    "bold", "italic", "underline", "heading1", "heading2", "heading3",
]);
function parseEdits(source: unknown): WordEdit[] | null {
    if (!Array.isArray(source) || !source.length || source.length > 20) return null;
    const parsed: WordEdit[] = [];
    for (const value of source) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const row = value as Record<string, unknown>;
        const original = typeof row.original === "string" ? row.original : "";
        const replacement = typeof row.replacement === "string" ? row.replacement : undefined;
        const rawFormats = Array.isArray(row.formats) ? row.formats : [];
        const formats = rawFormats.length
            ? [...new Set(rawFormats.filter((item): item is string =>
                typeof item === "string" && FORMATS.has(item)))] : undefined;
        if (!original || original.length > 255 || /[\r\n^]/u.test(original) ||
            (replacement === undefined) === (formats === undefined) ||
            (formats && formats.length !== rawFormats.length) ||
            (row.occurrence !== undefined && row.occurrence !== "all")) return null;
        parsed.push({ original, ...(replacement !== undefined ? { replacement } : {}),
            ...(formats ? { formats } : {}),
            ...(row.occurrence === "all" ? { occurrence: "all" as const } : {}) });
    }
    return parsed;
}

async function applyOne(edit: WordEdit, review: boolean) {
    const { word } = globals();
    if (!word) return { status: "error", error: "Word is unavailable." };
    try {
        return await word.run(async (context) => {
            const document = context.document;
            const matches = document.body.search(edit.original, {
                ignorePunct: false,
                ignoreSpace: false,
                matchCase: true,
                matchPrefix: false,
                matchSuffix: false,
                matchWholeWord: false,
                matchWildcards: false,
            });
            document.load("changeTrackingMode");
            matches.load("items");
            await context.sync();
            const count = matches.items.length;
            if (!count) return { status: "not-found", matches: 0 };
            if (count > 1 && edit.occurrence !== "all") {
                return { status: "ambiguous", matches: count };
            }
            const selected = edit.occurrence === "all" ? matches.items : [matches.items[0]];
            if (edit.formats?.some((format) => format.startsWith("heading"))) {
                for (const range of selected) range.paragraphs.load("items");
                await context.sync();
                if (selected.some((range) => range.paragraphs.items.length !== 1)) {
                    return { status: "skipped", matches: count,
                        error: "Heading edits must target one paragraph." };
                }
            }
            const originalTracking = document.changeTrackingMode;
            const requestedTracking = review
                ? word.ChangeTrackingMode.trackAll : word.ChangeTrackingMode.off;
            if (originalTracking !== requestedTracking) {
                document.changeTrackingMode = requestedTracking;
                await context.sync();
            }
            try {
                for (const range of selected) {
                    if (edit.replacement !== undefined) {
                        range.insertText(edit.replacement, "Replace");
                    } else {
                        for (const format of edit.formats ?? []) {
                            if (format === "bold") range.font.bold = true;
                            else if (format === "italic") range.font.italic = true;
                            else if (format === "underline") range.font.underline = "Single";
                            else range.paragraphs.items[0].styleBuiltIn =
                                `Heading${format.at(-1)}`;
                        }
                    }
                }
                await context.sync();
            } finally {
                if (document.changeTrackingMode !== originalTracking) {
                    document.changeTrackingMode = originalTracking;
                    await context.sync();
                }
            }
            return { status: review ? "tracked" : "applied", matches: count };
        });
    } catch (error) {
        return { status: "error", error: error instanceof Error
            ? error.message.slice(0, 500) : "Word could not apply this edit." };
    }
}

async function applyEdits(input: Record<string, unknown>) {
    const edits = parseEdits(input.edits);
    if (!edits) return { error: "Invalid Word edit request." };
    const review = input.mode !== "direct";
    const outcomes = [];
    for (let index = 0; index < edits.length; index += 1) {
        outcomes.push({ index, ...await applyOne(edits[index], review) });
    }
    return { edits: outcomes };
}

const resultCache = new Map<string, unknown>();
const CACHE_KEY = "beaver.word.appliedCalls.v1";
function cached(callId: string) {
    if (resultCache.has(callId)) return resultCache.get(callId);
    try {
        const rows = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]") as unknown;
        if (!Array.isArray(rows)) return undefined;
        const match = rows.find((row) => Array.isArray(row) && row[0] === callId);
        if (match) resultCache.set(callId, match[1]);
        return match?.[1];
    } catch { return undefined; }
}
function remember(callId: string, result: unknown) {
    resultCache.set(callId, result);
    try {
        const current = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]") as unknown;
        const rows = Array.isArray(current)
            ? current.filter((row) => Array.isArray(row) && row[0] !== callId) : [];
        localStorage.setItem(CACHE_KEY,
            JSON.stringify([...rows, [callId, result]].slice(-50)));
    } catch { /* The in-memory cache still prevents same-pane replay. */ }
}

export async function executeWordClientTool(call: ClientToolCall) {
    if (call.name === "read_active_document") return readDocument(call.input);
    if (call.name !== "apply_word_edits") return { error: "Unknown client tool." };
    const previous = cached(call.callId);
    if (previous !== undefined) return previous;
    const result = await applyEdits(call.input);
    remember(call.callId, result);
    return result;
}
