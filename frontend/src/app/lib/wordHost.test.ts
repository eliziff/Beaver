import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWordClientTool, wordDocumentContext } from "./wordHost";

const callId = () => crypto.randomUUID();

function installWord(text: string, matches: Array<Record<string, unknown>> = []) {
    const body = {
        text,
        font: {}, paragraphs: { items: [], load: vi.fn() },
        load: vi.fn(), insertText: vi.fn(),
        search: vi.fn(() => ({ items: matches, load: vi.fn() })),
    };
    const document = {
        body,
        changeTrackingMode: "Off",
        getSelection: vi.fn(() => ({ ...body, text: "selected" })),
        load: vi.fn(),
    };
    vi.stubGlobal("Office", {
        HostType: { Word: "Word" },
        context: {
            document: { url: "file:///C:/Matters/Factum.docx" },
            requirements: { isSetSupported: () => true },
        },
        onReady: async () => ({ host: "Word" }),
    });
    vi.stubGlobal("Word", {
        ChangeTrackingMode: { off: "Off", trackAll: "TrackAll" },
        run: async (run: (context: unknown) => Promise<unknown>) => run({
            document,
            sync: async () => undefined,
        }),
    });
    return { body, document };
}

afterEach(() => vi.unstubAllGlobals());

describe("Word host adapter", () => {
    it.each([
        { original: "old", replacement: "x".repeat(10_001) },
        { original: "old", replacement: "new", formats: [] },
        { original: "old", formats: ["bold", "bold"] },
        { original: "old", formats: ["unsupported"] },
    ])("rejects malformed edit %# before touching Word", async (edit) => {
        const { body } = installWord("old");
        await expect(executeWordClientTool({ type: "client_tool_call", callId: callId(),
            name: "apply_word_edits", input: { edits: [edit] },
        })).resolves.toEqual({ error: "Invalid Word edit request." });
        expect(body.search).not.toHaveBeenCalled();
    });

    it("identifies the active document and reads bounded chunks", async () => {
        installWord("0123456789");
        await expect(wordDocumentContext()).resolves.toEqual({
            document_name: "Factum.docx",
        });
        await expect(executeWordClientTool({
            type: "client_tool_call",
            callId: callId(),
            name: "read_active_document",
            input: { offset: 3, max_chars: 4 },
        })).resolves.toEqual({
            scope: "document", offset: 3, text: "3456", total_chars: 10,
        });
    });

    it("uses native tracked changes for Review and restores the prior setting", async () => {
        const range = {
            font: {},
            paragraphs: { items: [{ styleBuiltIn: "Normal" }], load: vi.fn() },
            insertText: vi.fn(),
        };
        const { document } = installWord("old", [range]);
        const result = await executeWordClientTool({
            type: "client_tool_call",
            callId: callId(),
            name: "apply_word_edits",
            input: { mode: "review", edits: [{ original: "old", replacement: "new" }] },
        });
        expect(range.insertText).toHaveBeenCalledWith("new", "Replace");
        expect(result).toEqual({ edits: [{ index: 0, status: "tracked", matches: 1 }] });
        expect(document.changeTrackingMode).toBe("Off");
    });

    it("does not guess when an exact anchor is ambiguous", async () => {
        const ranges = [0, 1].map(() => ({
            font: {}, paragraphs: { items: [], load: vi.fn() }, insertText: vi.fn(),
        }));
        installWord("old old", ranges);
        await expect(executeWordClientTool({
            type: "client_tool_call",
            callId: callId(),
            name: "apply_word_edits",
            input: { mode: "direct", edits: [{ original: "old", replacement: "new" }] },
        })).resolves.toEqual({ edits: [{
            index: 0, status: "ambiguous", matches: 2,
        }] });
        expect(ranges.every((range) => !vi.mocked(range.insertText).mock.calls.length)).toBe(true);
    });
});
