import { characterPlan, descendingPlan, highlightRuns, minimalEditPlan } from "../../../../shared/sequence-diff.mjs";

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
    const edits = parseWordEdits(input.edits);
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
    // Fence replay before Word can mutate: a closed pane cannot confirm whether
    // the last sync committed. Never repeat that batch automatically.
    remember(call.callId, { error: "This edit batch was already started. Read the document and review its tracked changes before requesting further edits." });
    const result = await applyEdits(call.input);
    remember(call.callId, result);
    return result;
}
import { parseWordEdits, type WordEdit } from "../../../../shared/word-edits.mjs";

// The Word adapter for a task pane that applies results computed from the document to the open document: its
// file read whole, its footnotes and paragraphs matched to the units the result was computed from, and each span
// found in its unit's text and changed character by character with the ALR macro's minimal plan (tracked
// replacements, green and red highlighting, links). Office.js gives no character offsets, so a span is found by
// its own text (its k-th match in its unit) and then split into one range per character.

type PaneItems<T> = { items: T[]; load(value: string): void };
type PaneRange = {
    text: string;
    hyperlink: string;
    font: { highlightColor: string | null };
    load(value: string): void;
    search(text: string, options: Record<string, boolean>): PaneItems<PaneRange>;
    expandTo(other: PaneRange): PaneRange;
    insertText(text: string, location: "Replace" | "Before" | "After"): unknown;
    delete(): void;
    select(): void;
    getRange(location?: "Whole"): PaneRange;
    getHyperlinkRanges(): PaneItems<PaneRange>;
    getTrackedChanges(): PaneItems<unknown>;
    fields: PaneItems<unknown>;
    contentControls: PaneItems<{ cannotEdit: boolean }>;
    parentContentControlOrNullObject: { isNullObject: boolean; cannotEdit: boolean; load(value: string): void };
    parentBody: { type: string; text: string; load(value: string): void };
    paragraphs: PaneItems<PaneRange> & { getFirst(): PaneRange };
};
type PaneDocument = {
    body: PaneRange & { footnotes: PaneItems<{ body: PaneRange }> };
    changeTrackingMode: string;
    getSelection(): PaneRange;
    load(value: string): void;
};
type PaneContext = { document: PaneDocument; sync(): Promise<void> };
type OfficeResult<T> = { status: string; value: T; error?: { message: string } };
type OfficeFile = { sliceCount: number;
    getSliceAsync(index: number, done: (result: OfficeResult<{ data: ArrayLike<number> }>) => void): void;
    closeAsync(done?: () => void): void };
type PaneOffice = OfficeRuntime & {
    FileType: { Compressed: string };
    EventType: { DocumentSelectionChanged: string };
    context: OfficeRuntime["context"] & {
        document: { url?: string;
            getFileAsync(type: string, options: { sliceSize: number }, done: (result: OfficeResult<OfficeFile>) => void): void;
            settings: { get(name: string): unknown; set(name: string, value: unknown): void; saveAsync(done?: () => void): void };
            addHandlerAsync(type: string, handler: () => void, done?: (result: OfficeResult<unknown>) => void): void;
            removeHandlerAsync(type: string, options: { handler: () => void }): void };
        ui?: { openBrowserWindow?(url: string): void };
    };
};
const pane = () => ({ office: globals().office as PaneOffice | undefined, word: globals().word });
const run = <T>(work: (context: PaneContext) => Promise<T>) => {
    const { word } = pane();
    if (!word) throw new Error("Word is unavailable.");
    return word.run((context) => work(context as unknown as PaneContext));
};

/** Whether the page runs in a Word that has what the pane needs: "ready", or why not ("no-word": not in an
 *  Office add-in, or Office.js did not load; "other-host"; "old-word": no WordApi `version`). */
export async function wordPaneStatus(version = "1.6") {
    const { office, word } = pane();
    if (!office || !word) return { status: "no-word" as const };
    const ready = await office.onReady();
    if (!ready.host) return { status: "no-word" as const };
    if (ready.host !== office.HostType.Word) return { status: "other-host" as const };
    if (!office.context.requirements.isSetSupported("WordApi", version)) return { status: "old-word" as const };
    return { status: "ready" as const, name: (await wordDocumentContext()).document_name };
}

/** The open document as a .docx file, with the edits not yet saved: Office.js gives it in slices of up to 4 MB. */
export function readDocumentFile(name: string) {
    const { office } = pane();
    return new Promise<File>((resolve, reject) => office!.context.document.getFileAsync(office!.FileType.Compressed,
        { sliceSize: 4_194_304 }, (opened) => {
            if (opened.status !== "succeeded") { reject(new Error(opened.error?.message ?? "Word could not give the document.")); return; }
            const file = opened.value, slices: Uint8Array[] = [];
            const next = (index: number) => {
                if (index === file.sliceCount) {
                    file.closeAsync();
                    resolve(new File(slices as BlobPart[], name,
                        { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
                    return;
                }
                file.getSliceAsync(index, (slice) => {
                    if (slice.status !== "succeeded") {
                        file.closeAsync();
                        reject(new Error(slice.error?.message ?? "Word could not give the document."));
                        return;
                    }
                    slices.push(Uint8Array.from(slice.value.data));
                    next(index + 1);
                });
            };
            next(0);
        }));
}

/** A value kept in the document itself (its add-in settings), so it follows the document when it is renamed. */
export const documentSetting = (name: string) => pane().office?.context.document.settings.get(name);
export function setDocumentSetting(name: string, value: unknown) {
    const settings = pane().office!.context.document.settings;
    settings.set(name, value);
    return new Promise<void>((resolve) => settings.saveAsync(() => resolve()));
}
/** Opens a link in the person's browser, where its downloads land in their own Downloads folder. */
export function openInBrowser(url: string) {
    const ui = pane().office?.context.ui;
    if (ui?.openBrowserWindow) ui.openBrowserWindow(url);
    else window.open(url, "_blank", "noopener");
}

/** The text a pane's result was computed from, one unit per footnote or paragraph, in reading order. */
export type WordUnit = { kind: "body" | "footnote"; text: string };
/** A span of one unit's text (`unit` indexes the units), as the result read it. */
export type WordSpan = { unit: number; start: number; end: number; expected: string };
export type WordOutcome = { status: "applied" | "unchanged" | "skipped"; reason?: string };
/** Thrown, with nothing written, when the document's footnotes or paragraphs no longer match the units. */
export class WordDocumentChanged extends Error {
    constructor() { super("The document has changed since it was read. Read it again."); }
}

/** Text as compared between the units and Word: without footnote and comment marks (Word's \u0002 and \u0005),
 *  soft hyphens or zero-width spaces, and with each run of spaces and other control characters one space. */
const normalized = (text: string) => text.replace(/[\u0002\u0005\u00ad\u200b]/gu, "")
    .replace(/[\u0000-\u0020\u00a0\s]+/gu, " ").trim();

/** Each unit's story in the document: footnote units are the document's footnotes in order (as many of them), a
 *  paragraph unit the next paragraph with its text. A `wanted` unit whose story's text differs, or is not found, is a
 *  changed document; so is a different number of footnotes. Other units may have changed (repaired, say). */
async function stories(context: PaneContext, units: WordUnit[], wanted: Set<number>) {
    const notes = context.document.body.footnotes, paragraphs = context.document.body.paragraphs;
    notes.load("items/body/text");
    paragraphs.load("items/text");
    await context.sync();
    const footnotes = units.flatMap((unit, index) => unit.kind === "footnote" ? [index] : []);
    if (footnotes.length !== notes.items.length) throw new WordDocumentChanged();
    const found = new Map<number, PaneRange>();
    footnotes.forEach((index, at) => {
        if (normalized(notes.items[at].body.text) === normalized(units[index].text)) found.set(index, notes.items[at].body);
        else if (wanted.has(index)) throw new WordDocumentChanged();
    });
    const texts = paragraphs.items.map(({ text }) => normalized(text));
    let next = 0;
    units.forEach((unit, index) => {
        if (unit.kind !== "body" || !normalized(unit.text)) return;
        const at = texts.indexOf(normalized(unit.text), next);
        if (at >= 0) { found.set(index, paragraphs.items[at]); next = at + 1; }
        else if (wanted.has(index)) throw new WordDocumentChanged();
    });
    return found;
}

/** How many times Word's search, left to right without overlap, meets `needle` before it meets it at `start`;
 *  -1 when it never starts there. */
export function matchIndex(text: string, needle: string, start: number) {
    let k = 0;
    for (let at = text.indexOf(needle); at >= 0 && at <= start; at = text.indexOf(needle, at + needle.length), k += 1)
        if (at === start) return k;
    return -1;
}
const searchText = (text: string) => text.replaceAll("^", "^^");
const EXACT = { matchCase: true, matchWildcards: false, ignorePunct: false, ignoreSpace: false,
    matchPrefix: false, matchSuffix: false, matchWholeWord: false };
/** Word searches at most 255 characters: a longer span is its first and last 200, joined. */
const SEARCH_LIMIT = 255, SEARCH_EDGE = 200;

/** Each span's characters as Word ranges (one per character, `at` mapping a UTF-16 offset to its range), or why
 *  it was not found as the result read it. Three round trips for any number of spans. */
async function locate(context: PaneContext, units: WordUnit[], spans: WordSpan[]) {
    const story = await stories(context, units, new Set(spans.map(({ unit }) => unit)));
    const searched = spans.map((span) => {
        const text = units[span.unit].text, range = story.get(span.unit)!;
        const parts: Array<[string, number]> = span.expected.length <= SEARCH_LIMIT ? [[span.expected, span.start]]
            : [[span.expected.slice(0, SEARCH_EDGE), span.start], [span.expected.slice(-SEARCH_EDGE), span.end - SEARCH_EDGE]];
        return parts.map(([needle, at]) => {
            const k = text.slice(span.start, span.end) === span.expected ? matchIndex(text, needle, at) : -1;
            const results = k >= 0 ? range.search(searchText(needle), EXACT) : null;
            results?.load("items/text");
            return { k, results };
        });
    });
    await context.sync();
    const ranges = searched.map((found) => {
        const hits = found.map(({ k, results }) => k >= 0 && results && results.items.length > k ? results.items[k] : null);
        if (hits.some((hit) => !hit)) return null;
        const whole = hits.length === 1 ? hits[0]! : hits[0]!.expandTo(hits[1]!);
        const chars = whole.search("?", { matchWildcards: true });
        chars.load("items/text");
        return { whole, chars };
    });
    await context.sync();
    return spans.map((span, index) => {
        const found = ranges[index];
        if (!found) return { span, error: "Not found in the document as it was read." };
        const items = found.chars.items, at: number[] = [];
        items.forEach((item, position) => { for (let unit = 0; unit < item.text.length; unit += 1) at.push(position); });
        if (items.map(({ text }) => text).join("") !== span.expected)
            return { span, error: "Its text in the document differs from the text that was checked." };
        return { span, whole: found.whole, items, at };
    });
}
type Located = Awaited<ReturnType<typeof locate>>[number];
type Found = Extract<Located, { items: PaneRange[] }>;
const isFound = (item: Located): item is Found => "items" in item;

/** Why the macro would not write to a span (ALR_Rules.bas PlanMinimalEdits): a tracked change, a field or a link,
 *  or a content control that cannot be edited. One round trip. */
async function refusals(context: PaneContext, located: Located[]) {
    const checks = located.map((item) => {
        if (!isFound(item)) return null;
        const tracked = item.whole.getTrackedChanges(), fields = item.whole.fields, controls = item.whole.contentControls;
        const parent = item.whole.parentContentControlOrNullObject;
        tracked.load("items");
        fields.load("items");
        controls.load("items/cannotEdit");
        parent.load("isNullObject,cannotEdit");
        item.whole.load("hyperlink");
        return { tracked, fields, controls, parent, whole: item.whole };
    });
    await context.sync();
    return checks.map((check) => !check ? null
        : check.controls.items.some(({ cannotEdit }) => cannotEdit) || (!check.parent.isNullObject && check.parent.cannotEdit)
            ? LOCKED : check.tracked.items.length ? "It has tracked changes."
                : check.fields.items.length || check.whole.hyperlink ? "It holds a field or a link." : null);
}
const LOCKED = "It is in a locked content control.";

/** Runs `write` with the document's change tracking set to `mode`, then puts the person's own mode back. */
async function withTracking<T>(context: PaneContext, mode: "trackAll" | "off", write: () => Promise<T>) {
    const word = pane().word!, document = context.document;
    document.load("changeTrackingMode");
    await context.sync();
    const previous = document.changeTrackingMode, wanted = word.ChangeTrackingMode[mode];
    if (previous !== wanted) { document.changeTrackingMode = wanted; await context.sync(); }
    try { return await write(); } finally {
        if (previous !== wanted) { document.changeTrackingMode = previous; await context.sync(); }
    }
}
const rangeOf = (item: Found, from: number, to: number) => item.at[from] === item.at[to - 1]
    ? item.items[item.at[from]] : item.items[item.at[from]].expandTo(item.items[item.at[to - 1]]);

/** The Office.js writes of one span's plan, in the macro's order (ALR_ApplyMinimalPlan: last first): each edit's
 *  characters replaced, or deleted, or for an insertion, text put before the character at its start (after the
 *  last character at the span's end). Offsets are the span's. */
export function planWrites(expected: string, target: string) {
    return descendingPlan(minimalEditPlan(expected, target)).map(([start, length, replacement]) =>
        length ? { from: start, to: start + length, write: replacement ? "Replace" as const : "Delete" as const, text: replacement }
            : start < expected.length ? { from: start, to: start + 1, write: "Before" as const, text: replacement }
                : { from: expected.length - 1, to: expected.length, write: "After" as const, text: replacement });
}

/** Rewrites each span to its `target` as tracked changes, with the fewest inserted and deleted characters, all
 *  in one batch. A span the macro would not write to is skipped, and says why. */
export function applyPlan(units: WordUnit[], spans: Array<WordSpan & { target: string }>) {
    return run(async (context) => {
        const located = await locate(context, units, spans), refused = await refusals(context, located);
        return withTracking(context, "trackAll", async () => {
            const outcomes = located.map((item, index): WordOutcome => {
                if (!isFound(item)) return { status: "skipped", reason: item.error };
                if (refused[index]) return { status: "skipped", reason: refused[index]! };
                const writes = planWrites(item.span.expected, spans[index].target);
                if (!writes.length) return { status: "unchanged" };
                for (const { from, to, write, text } of writes) {
                    const range = rangeOf(item, from, to);
                    if (write === "Delete") range.delete();
                    else range.insertText(text, write);
                }
                return { status: "applied" };
            });
            await context.sync();
            return outcomes;
        });
    });
}

/** Highlights each span by its `target`: characters that match bright green, characters that differ red, and for
 *  a word it lacks, the space where it goes. Tracking is off while it highlights. */
export function highlightPlan(units: WordUnit[], spans: Array<WordSpan & { target: string }>) {
    return run(async (context) => {
        const located = await locate(context, units, spans), refused = await refusals(context, located);
        return withTracking(context, "off", async () => {
            const outcomes = located.map((item, index): WordOutcome => {
                if (!isFound(item)) return { status: "skipped", reason: item.error };
                if (refused[index] === LOCKED) return { status: "skipped", reason: LOCKED };
                const expected = item.span.expected;
                for (const [start, end, edited] of highlightRuns(expected, characterPlan(expected, spans[index].target)))
                    rangeOf(item, start, end).font.highlightColor = edited ? "#FF0000" : "#00FF00";
                return { status: "applied" };
            });
            await context.sync();
            return outcomes;
        });
    });
}

/** Links each span to its `url`, as the document's tracking stands. A span with a link of its own keeps it. */
export function setLinks(units: WordUnit[], spans: Array<WordSpan & { url: string }>) {
    return run(async (context) => {
        const located = await locate(context, units, spans);
        for (const item of located) if (isFound(item)) item.whole.load("hyperlink");
        await context.sync();
        const outcomes = located.map((item, index): WordOutcome => {
            if (!isFound(item)) return { status: "skipped", reason: item.error };
            if (item.whole.hyperlink) return { status: "skipped", reason: "It has a link already." };
            item.whole.hyperlink = spans[index].url;
            return { status: "applied" };
        });
        await context.sync();
        return outcomes;
    });
}

/** Selects a span in the document. */
export function selectSpan(units: WordUnit[], span: WordSpan) {
    return run(async (context): Promise<WordOutcome> => {
        const [item] = await locate(context, units, [span]);
        if (!isFound(item)) return { status: "skipped", reason: item.error };
        item.whole.select();
        await context.sync();
        return { status: "applied" };
    });
}

/** Follows the selection: `onUnit` hears the unit the selection is in (null outside them), and `onLink` each link
 *  that appears in a footnote between two selections (one added with Ctrl+K), with its text. A note's links are
 *  read the first time the selection is in it; `forget` reads a note's links again (after the pane links it). */
export async function watchNewLinks(units: WordUnit[], onUnit: (unit: number | null) => void,
    onLink: (link: { unit: number; text: string; url: string }) => void) {
    const { office } = pane();
    const known = new Map<number, Set<string>>(), texts = units.map((unit) => normalized(unit.text));
    let previous: number | null = null, queue = Promise.resolve();
    const read = () => run(async (context) => {
        const selection = context.document.getSelection(), body = selection.parentBody, first = selection.paragraphs.getFirst();
        body.load("type,text");
        first.load("text");
        await context.sync();
        const inNote = /note/iu.test(body.type) && !/endnote/iu.test(body.type);
        const text = normalized(inNote ? body.text : first.text);
        const found = texts.findIndex((value, index) => value === text && (units[index].kind === "footnote") === inNote);
        const unit = found >= 0 ? found : null;
        onUnit(unit);
        // The note just left and the note now in: the links each has now.
        const notes = [...new Set([previous, unit])].filter((index): index is number =>
            index !== null && units[index].kind === "footnote");
        previous = unit;
        if (!notes.length) return;
        const story = await stories(context, units, new Set()).catch(() => null);
        if (!story) return;
        const links = notes.filter((index) => story.has(index)).map((index) => {
            const ranges = story.get(index)!.getRange("Whole").getHyperlinkRanges();
            ranges.load("items/text,items/hyperlink");
            return [index, ranges] as const;
        });
        await context.sync();
        for (const [index, ranges] of links) {
            const now = new Set(ranges.items.map(({ text: linked, hyperlink }) => `${linked}\u0000${hyperlink}`));
            const before = known.get(index);
            known.set(index, now);
            if (before) for (const key of now) if (!before.has(key)) {
                const [linked, url] = key.split("\u0000");
                onLink({ unit: index, text: linked, url });
            }
        }
    });
    const handler = () => { queue = queue.then(read).catch(() => undefined); };
    await new Promise<void>((resolve) => office!.context.document.addHandlerAsync(
        office!.EventType.DocumentSelectionChanged, handler, () => resolve()));
    handler();
    return {
        stop: () => office?.context.document.removeHandlerAsync(office.EventType.DocumentSelectionChanged, { handler }),
        forget: (indexes: number[]) => indexes.forEach((index) => known.delete(index)),
    };
}
