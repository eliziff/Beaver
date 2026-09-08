import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegalSourceViewerPayload } from "@/app/lib/api/legalSources";
import { highlightDocxQuotes } from "@/app/components/shared/views/highlightDocxQuote";
import { SourcesWorkspaceProvider } from "./SourcesWorkspace";
import type { ResearchFile } from "@/app/lib/researchFiles";

const api = vi.hoisted(() => ({
    direct: vi.fn(),
    saved: vi.fn(),
    createResearchFile: vi.fn(),
    researchFile: vi.fn(),
    researchItems: vi.fn(),
    actOnResearchFile: vi.fn(),
}));
const scrollIntoView = vi.fn();

vi.mock("@/app/lib/api/legalSources", async (original) => ({
  ...await original<typeof import("@/app/lib/api/legalSources")>(),
  getDirectLegalSourceDocument: api.direct,
  getLegalSourceDocument: api.saved
}));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  createResearchFile: api.createResearchFile,
  getResearchFile: api.researchFile,
  getResearchItems: api.researchItems,
  actOnResearchFile: api.actOnResearchFile
}));
vi.mock("react-router-dom", () => ({
    useNavigate: () => vi.fn(),
    Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
        <a href={to} {...props}>{children}</a>
    ),
}));
import {
    LegalSourceViewer as SourceViewer,
    legalSourceViewerActions,
} from "./LegalSourceViewer";
import { readerSelectionSpan } from "../shared/readerSelection";
import { LegalLibrarySourcePage } from "./LegalLibrary";
import { useSourcesWorkspace } from "./SourcesWorkspace";
function HighlightButton() {
  const { highlight } = useSourcesWorkspace();
  return <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => void highlight.run().then((saved) => { if (!saved) highlight.arm(!highlight.armed); }).catch(() => undefined)}>Highlight</button>;
}
function LegalSourceViewer({ researchFile, onResearchFileChange, ...props }: React.ComponentProps<typeof SourceViewer> &
  { researchFile?: ResearchFile | null; onResearchFileChange?: (file: ResearchFile | null) => void }) {
  return <SourcesWorkspaceProvider file={researchFile} fileId={props.researchFileId} onChange={onResearchFileChange}>
    <SourceViewer {...props} /><HighlightButton /></SourcesWorkspaceProvider>;
}
function selectText(node: Node) {
  const range = document.createRange(); range.selectNodeContents(node);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  return selection;
}

function viewerPayload(): LegalSourceViewerPayload {
    const text = [
        "# Analysis",
        "[1] The *ratio* controls.",
        "1. First factor",
        "2. Second factor",
        "- Unordered factor",
        "> Quoted holding.",
    ].join("\n\n");
    return {
        schemaVersion: "mike.legal-source.v1",
        provider: "a2aj",
        reference: {
            docType: "cases",
            provider: "a2aj",
            id: "2099-scc-1",
            kind: "case",
            sourceSha256: "a".repeat(64),
            citation: "2099 SCC 1",
            language: "en",
            dataset: "SCC",
        },
        metadata: {
            title: "Fixture v. Test",
            citation: "2099 SCC 1",
            alternateCitation: null,
            date: "2099-01-02",
            dataset: "SCC",
            url: "https://decisions.example.test/item/1",
            pdfUrl: "https://decisions.example.test/item/1/document.pdf",
            language: "en",
            upstreamLicense: null,
        },
        slices: [{
            start: 0,
            end: text.length,
            text,
            depth: 0,
            anchors: [{ kind: "page", label: "page1", start: 0, end: text.length }],
            primary: { kind: "paragraph", label: "par1", start: 0, end: text.length },
        }],
        truncated: false,
    };
}

function multiSlicePayload(): LegalSourceViewerPayload {
    const base = viewerPayload();
    const text =
        "[1] First proposition.\n[2] Second proposition.\n[3] Third proposition.";
    const second = text.indexOf("[2]");
    const third = text.indexOf("[3]");
    return {
        ...base,
        slices: [
            { start: 0, end: second, text: text.slice(0, second).trim(), depth: 0,
                anchors: [{ kind: "page", label: "page1", start: 0, end: third }],
                primary: { kind: "paragraph", label: "par1", start: 0, end: second } },
            { start: second, end: third, text: text.slice(second, third).trim(), depth: 0,
                anchors: [], primary: { kind: "paragraph", label: "par2", start: second, end: third } },
            { start: third, end: text.length, text: text.slice(third).trim(), depth: 0,
                anchors: [{ kind: "page", label: "page2", start: third, end: text.length }],
                primary: { kind: "paragraph", label: "par3", start: third, end: text.length } },
        ],
    };
}

const savedEvidence = { sourceId: "saved", labelIds: ["holding"], note: "",
    receipt: { evidence_id: "evidence", provider: "a2aj", stable_source_id: "2099-scc-1",
        source_sha256: "a".repeat(64), span_sha256: "b".repeat(64), block_id: "par1",
        span_text: "First proposition.", citation: "2099 SCC 1", name: "Fixture v. Test",
        external_url: null, locator: { kind: "paragraph", label: "par1" } } };
const researchPage = (...values: typeof savedEvidence[]) => ({
    items: values.map((value, index) => ({ kind: "passage" as const, index, value })),
    next_cursor: null, total: values.length,
});
const researchFile = {
    document: { id: "file-1", filename: "Fairness.research.md", file_type: "md",
        project_id: null, pdf_storage_path: null, size_bytes: 1, page_count: null,
        created_at: null, current_version_id: "version-1" },
    versionId: "version-1",
    workingRevision: 0,
    state: { schemaVersion: "beaver.research.v2" as const,
        labels: {
            source: { id: "source", name: "Key", parentId: null, color: "#1d4ed8", order: 0, scope: "source" },
            holding: { id: "holding", name: "Holding", parentId: null, color: "#047857", order: 0, scope: "highlight" },
        },
        sources: { saved: { id: "saved", collected: true, labelIds: ["source"],
      note: "",
            reference: { provider: "a2aj", id: "2099-scc-1", kind: "case" as const,
                title: "Fixture v. Test", citation: "2099 SCC 1", collection: "SCC", language: "en" },
            passages: { count: 1, sha256: "c".repeat(64), labelCounts: { holding: 1 }, unlabelledCount: 0 } } },
        queries: null, note: "" },
};

describe("legal source reader", () => {
    beforeEach(() => {
        api.direct.mockReset();
        api.saved.mockReset();
        api.createResearchFile.mockReset();
        api.researchFile.mockReset();
        api.researchItems.mockReset().mockResolvedValue(researchPage(savedEvidence));
        api.actOnResearchFile.mockReset();
        scrollIntoView.mockReset();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
    });

    it("treats provider anchor labels as data, not regular expressions", async () => {
        const untrusted = viewerPayload();
        untrusted.slices[0].primary!.label = "par(";
        api.direct.mockResolvedValue(untrusted);
        render(<LegalSourceViewer citation="2099 SCC 1" docType="cases" />);
        expect(await screen.findByRole("heading", { name: "Fixture v. Test" }))
            .toBeInTheDocument();
    });

    it("maps a selected passage to its exact offsets in the served text", () => {
        const root = document.createElement("div");
        root.innerHTML = '<section data-legal-text="0">Before <span>the exact holding</span> after</section>';
        document.body.append(root);
        const text = root.querySelector("span")!.firstChild!;
        const range = document.createRange();
        range.selectNodeContents(text);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        expect(readerSelectionSpan(root, selection, [{ start: 100, text: "Before the exact holding after" }]))
            .toEqual({ start: 107, end: 124 });
        root.remove();
        selection.removeAllRanges();
    });

    it("renders continuous semantic content without paragraph navigation", async () => {
        api.direct.mockResolvedValue(viewerPayload());

        const { container } = render(
            <LegalSourceViewer citation="2099 SCC 1" docType="cases" />,
        );

        await screen.findByRole("heading", { name: "Fixture v. Test" });
        expect(screen.getByRole("heading", { name: "Analysis" }).tagName).toBe(
            "H2",
        );
        expect(container.querySelector("em")?.textContent).toBe("ratio");
        expect(container.querySelectorAll("ol")).toHaveLength(1);
        expect(container.querySelectorAll("ol > li")).toHaveLength(2);
        expect(container.querySelectorAll("ul > li")).toHaveLength(1);
        expect(container.querySelector("blockquote")).toHaveTextContent(
            "Quoted holding.",
        );
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
        expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
        expect(screen.queryByText(/Select paragraphs/iu)).not.toBeInTheDocument();

        expect(
            screen.getByRole("link", { name: "Site" }),
        ).toHaveAttribute(
            "href",
            "https://decisions.example.test/item/1",
        );
        expect(
            screen.getByRole("link", { name: "PDF" }),
        ).toHaveAttribute(
            "href",
            "https://decisions.example.test/item/1/document.pdf",
        );
        await waitFor(() => expect(api.direct).toHaveBeenCalledTimes(1));
    });

    it("keeps every source anchor unique and addressable", async () => {
        api.direct.mockResolvedValue(multiSlicePayload());
        const { container } = render(
            <LegalSourceViewer citation="2099 SCC 1" docType="cases" />,
        );
        await screen.findByRole("heading", { name: "Fixture v. Test" });

        const expectedIds = [
            "legal-page1",
            "legal-1",
            "legal-2",
            "legal-page2",
            "legal-3",
        ];
        const ids = Array.from(
            container.querySelectorAll<HTMLElement>("[id^='legal-']"),
            (element) => element.id,
        );
        expect(ids).toHaveLength(new Set(ids).size);
        expect(ids.sort()).toEqual([...expectedIds].sort());
        for (const id of expectedIds) {
            expect(container.querySelector(`#${id}`)).not.toBeNull();
        }
        expect(container.querySelector("#legal-1")?.tagName).toBe("SECTION");
        expect(container.querySelector("#legal-page1")?.tagName).toBe("SPAN");
    });

    it("opens an internal source at the cited paragraph", async () => {
        api.direct.mockResolvedValue(multiSlicePayload());
        const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
            .mockImplementation(function () {
                return { top: this.id === "legal-2" ? 240 : 100 } as DOMRect;
            });
        const { container } = render(
            <LegalSourceViewer
                citation="2099 SCC 1"
                docType="cases"
                initialLocator="par2"
            />,
        );

        await screen.findByRole("heading", { name: "Fixture v. Test" });
        expect(screen.getByRole("button", { name: "Label Fixture v. Test" })).toBeEnabled();
        const reader = container.querySelector<HTMLElement>(".overflow-y-auto")!;
        await waitFor(() => expect(reader.scrollTop).toBe(124));
        rect.mockRestore();
    });

    it("saves the selection with the current pen in one request and prepares the source first", async () => {
        const blank = { ...researchFile, state: { ...researchFile.state, sources: {} } };
        api.direct.mockResolvedValue(viewerPayload());
        api.researchItems.mockResolvedValue(researchPage());
        api.actOnResearchFile.mockImplementation(async (_id, _version, _revision, action) =>
            action.type === "source" ? { ...researchFile, sourceId: "saved" }
                : { ...researchFile, sourceId: "saved", evidenceId: "evidence" });
        render(<LegalSourceViewer citation="2099 SCC 1" docType="cases" researchFile={blank} />);
        const selection = selectText(await screen.findByText("ratio"));
        fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
        const canonical = viewerPayload().slices[0].text;
        await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
            { type: "passage", sourceId: "saved", revision: "a".repeat(64),
                start: canonical.indexOf("ratio"), end: canonical.indexOf("ratio") + "ratio".length,
                labelIds: ["holding"] }));
        expect(api.actOnResearchFile.mock.calls.map(([, , , action]) => action.type)).toEqual(["source", "passage"]);
        expect(screen.queryByRole("button", { name: "Save highlight" })).not.toBeInTheDocument();
        expect(screen.queryByRole("dialog", { name: "Labels and note" })).not.toBeInTheDocument();
        selection.removeAllRanges();
    });

    it("highlights with the last-used pen on Ctrl+Shift+H", async () => {
        const pens = { ...researchFile, state: { ...researchFile.state, labels: { ...researchFile.state.labels,
            contrary: { id: "contrary", name: "Contrary", parentId: null, color: "#b91c1c", order: 1, scope: "highlight" as const } } } };
        localStorage.setItem("beaver.research.pen.v1:file-1", "contrary");
        api.direct.mockResolvedValue(viewerPayload());
        api.researchItems.mockResolvedValue(researchPage());
        api.actOnResearchFile.mockResolvedValue({ ...pens, sourceId: "saved", evidenceId: "evidence" });
        render(<LegalSourceViewer citation="2099 SCC 1" docType="cases" researchFile={pens} />);
        await screen.findByText("ratio");
        await act(async () => {});
        const selection = selectText(screen.getByText("ratio"));
        fireEvent.keyDown(document, { key: "H", ctrlKey: true, shiftKey: true });
        await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
            expect.objectContaining({ type: "passage", labelIds: ["contrary"] })));
        selection.removeAllRanges();
    });

    it("arms highlighter mode and captures the next block click", async () => {
        api.direct.mockResolvedValue(viewerPayload());
        api.researchItems.mockResolvedValue(researchPage());
        api.actOnResearchFile.mockResolvedValue({ ...researchFile, sourceId: "saved", evidenceId: "evidence" });
        const { container } = render(<LegalSourceViewer citation="2099 SCC 1" docType="cases" researchFile={researchFile} />);
        await screen.findByText("ratio");
        window.getSelection()?.removeAllRanges();
        fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
        await waitFor(() => expect(container.querySelector("[data-highlighter]")).not.toBeNull());
        fireEvent.pointerUp(screen.getByText("ratio"));
        await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
            expect.objectContaining({ type: "passage", sourceId: "saved",
                revision: "a".repeat(64), labelIds: ["holding"] })));
        const clicked = api.actOnResearchFile.mock.calls.at(-1)[3] as { start: number; end: number };
        expect(viewerPayload().slices[0].text.slice(clicked.start, clicked.end))
            .toContain("The *ratio* controls.");
        expect(container.querySelector("[data-highlighter]")).not.toBeNull();
    });

    it("forgets completed source preparation so a removed source can be added again", async () => {
        const blank = { ...researchFile, state: { ...researchFile.state, sources: {} } };
        api.direct.mockResolvedValue(viewerPayload());
        api.actOnResearchFile.mockImplementation(async (_id, versionId, revision, action) => ({
            ...blank, versionId, sourceId: "saved", workingRevision: revision + 1,
            state: { ...blank.state, sources: { saved: { ...researchFile.state.sources.saved, note: action.note ?? "" } } },
        }));
        const { rerender } = render(<LegalSourceViewer citation="2099 SCC 1" docType="cases"
            researchFile={blank} />);
        await screen.findByRole("heading", { name: "Fixture v. Test" });

        for (const [note, revision] of [["First", 1], ["Again", 3]] as const) {
            if (revision > 1) rerender(<LegalSourceViewer citation="2099 SCC 1" docType="cases"
                researchFile={{ ...blank, versionId: `version-${revision}`,
                    workingRevision: revision }} />);
            fireEvent.click(screen.getByRole("button", { name: "Label Fixture v. Test" }));
            fireEvent.change(screen.getByRole("textbox", { name: "Item note" }),
                { target: { value: note } });
            fireEvent.blur(screen.getByRole("textbox", { name: "Item note" }));
            await waitFor(() => expect(api.actOnResearchFile.mock.calls.filter(([, , , action]) => action.type === "source"))
                .toHaveLength(revision > 1 ? 2 : 1));
            fireEvent.click(screen.getByRole("button", { name: "Close label palette" }));
        }
    });

    it("opens Workspace instead of creating a file for unsaved source or passage work", async () => {
        const onOpenResearch = vi.fn();
        api.direct.mockResolvedValue(viewerPayload());
        render(<LegalSourceViewer citation="2099 SCC 1" docType="cases"
            onOpenResearch={onOpenResearch} />);
        fireEvent.click(await screen.findByRole("button", { name: "Label Fixture v. Test" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Choose or create a workspace first",
        );
        expect(onOpenResearch).toHaveBeenCalledTimes(1);
        const emphasis = screen.getByText("ratio");
        const selection = selectText(emphasis);
        fireEvent.pointerUp(emphasis);
        fireEvent.click(emphasis);
        expect(onOpenResearch).toHaveBeenCalledTimes(1);
        expect(api.actOnResearchFile).not.toHaveBeenCalled();
        selection.removeAllRanges();
        expect(api.createResearchFile).not.toHaveBeenCalled();
        expect(api.actOnResearchFile).not.toHaveBeenCalled();
    });

    it("indexes rendered text once for an overlapping highlight batch", () => {
        const root = document.createElement("div"); root.textContent = "First proposition.";
        const walker = vi.spyOn(document, "createTreeWalker");
        const matches = highlightDocxQuotes(root, ["First proposition", "proposition"]);
        expect(walker).toHaveBeenCalledTimes(1);
        expect(matches.every(Boolean)).toBe(true);
        expect([...root.querySelectorAll('[data-qspan="0"]')]
            .map((span) => span.textContent).join(""))
            .toBe("First proposition.");
        expect(root.querySelector('[data-qspan="1"]')).toHaveTextContent("proposition");
        walker.mockRestore();
    });

    it("does not accept a different passage with the same opening words", () => {
        const root = document.createElement("div");
        root.textContent = "The same unusually long opening phrase ends incorrectly. The same unusually long opening phrase ends correctly.";
        const [match] = highlightDocxQuotes(root, ["The same unusually long opening phrase ends correctly."]);
        expect(match).toHaveTextContent("The same unusually long opening phrase ends correctly.");
    });

    it("keeps every verified quote span highlighted in the internal reader", async () => {
        api.direct.mockResolvedValue(multiSlicePayload());
        const { container } = render(
            <LegalSourceViewer
                citation="2099 SCC 1"
                docType="cases"
                quotes={[
                    { quote: "First proposition." },
                    { quote: "Third proposition." },
                ]}
            />,
        );

        await waitFor(() =>
            expect(
                container.querySelectorAll(".docx-text-highlight"),
            ).toHaveLength(2),
        );
        expect(container.querySelector('[data-qspan="0"]')).toHaveTextContent(
            "First proposition.",
        );
        expect(container.querySelector('[data-qspan="1"]')).toHaveTextContent(
            "Third proposition.",
        );
    });

    it("restores classified passages without permanent paragraph circles", async () => {
        api.direct.mockResolvedValue(multiSlicePayload());
        api.researchFile.mockResolvedValue(researchFile);
        const onResearchFileChange = vi.fn();
        const { container } = render(<LegalSourceViewer citation="2099 SCC 1" docType="cases"
            researchFileId="file-1" researchSourceId="saved"
            onResearchFileChange={onResearchFileChange} />);

        await screen.findByRole("heading", { name: "Fixture v. Test" });
        await waitFor(() => expect(container.querySelector('[data-qspan="0"]')).not.toBeNull());
        const highlight = container.querySelector<HTMLElement>('[data-qspan="0"]')!;
        expect(highlight).toHaveTextContent("First proposition.");
        expect(highlight.style.getPropertyPriority("background-color")).toBe("important");
        expect(highlight.style.borderBottom).toContain("solid");
        expect(highlight).toHaveAttribute("role", "button");
        expect(highlight).toHaveAccessibleName("Holding saved highlight. Edit type and note.");
        expect(highlight).toHaveAttribute("title", expect.stringContaining("Holding"));
        expect(screen.queryByRole("button", { name: /^Label par/iu })).not.toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Saved highlights" })).not.toBeInTheDocument();
        expect(onResearchFileChange).toHaveBeenCalledWith(researchFile);

        fireEvent.click(highlight);
        expect(await screen.findByRole("dialog", { name: "Highlight type and note" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Holding" })).toBeInTheDocument();
        expect(api.actOnResearchFile).not.toHaveBeenCalled();
    });

    it("settles a deleted linked workspace and reports the error", async () => {
        api.direct.mockResolvedValue(viewerPayload());
        api.researchFile.mockRejectedValue(new Error("Research file not found"));
        render(<LegalSourceViewer citation="2099 SCC 1" docType="cases" researchFileId="deleted" />);

        await screen.findByRole("heading", { name: "Fixture v. Test" });
        expect(await screen.findByRole("alert")).toHaveTextContent("Research file not found");
        expect(screen.getByRole("button", { name: "Label Fixture v. Test" })).toBeEnabled();
    });

    it("keeps saved marks directly editable without a duplicate paragraph navigation strip", async () => {
        api.direct.mockResolvedValue(multiSlicePayload());
        const later = { ...savedEvidence,
            receipt: { ...savedEvidence.receipt,
                evidence_id: "later", block_id: "paragraph:par3:10:20", span_sha256: "c".repeat(64),
                span_text: "Third proposition.", locator: { kind: "paragraph", label: "par3" } } };
        const reversed = { ...researchFile, state: { ...researchFile.state,
            sources: { saved: { ...researchFile.state.sources.saved,
                passages: { count: 2, sha256: "d".repeat(64), labelCounts: {}, unlabelledCount: 2 } } } } };
        api.researchItems.mockResolvedValue(researchPage(later, savedEvidence));
        const { container } = render(<LegalSourceViewer citation="2099 SCC 1"
            docType="cases" researchFile={reversed} />);

        await waitFor(() => expect(
            container.querySelectorAll("[data-research-evidence]"),
        ).toHaveLength(2));
        expect(screen.queryByRole("button", { name: /saved highlight$/ })).not.toBeInTheDocument();
        const laterMark = container.querySelector<HTMLElement>('[data-research-evidence="later"]')!;
        expect(laterMark).toHaveTextContent("Third proposition.");
        fireEvent.click(laterMark);
        expect(await screen.findByRole("dialog", { name: "Highlight type and note" })).toBeVisible();
        expect(api.actOnResearchFile).not.toHaveBeenCalled();
    });

    it("loads later saved-highlight pages without a separate reader navigation strip", async () => {
        api.direct.mockResolvedValue(multiSlicePayload());
        const later = { ...savedEvidence, receipt: { ...savedEvidence.receipt, evidence_id: "later",
            span_text: "Third proposition.", locator: { kind: "paragraph", label: "par3" } } };
        api.researchItems.mockResolvedValueOnce({ ...researchPage(savedEvidence), next_cursor: "next", total: 2 })
            .mockResolvedValueOnce(researchPage(later));
        const { container } = render(<LegalSourceViewer citation="2099 SCC 1" docType="cases" researchFile={researchFile} />);
        await waitFor(() => expect(container.querySelector('[data-research-evidence="later"]')).toHaveTextContent("Third proposition."));
        expect(api.researchItems).toHaveBeenCalledTimes(2);
        expect(api.researchItems.mock.calls[1][1]).toMatchObject({ cursor: "next", sourceId: "saved" });
    });

    it("locates identical saved quotes by receipt locator", async () => {
        const payload = multiSlicePayload(), passage = "Repeated holding.";
        payload.slices[0].text = `[1] ${passage}`;
        payload.slices[2].text = `[3] ${passage}`;
        api.direct.mockResolvedValue(payload);
        const evidence = (id: string, label: string) => ({ ...savedEvidence,
            receipt: { ...savedEvidence.receipt, evidence_id: id,
                block_id: label, span_text: passage, locator: { kind: "paragraph", label } } });
        const file = { ...researchFile, state: { ...researchFile.state,
            sources: { saved: { ...researchFile.state.sources.saved,
                passages: { count: 2, sha256: "e".repeat(64), labelCounts: {}, unlabelledCount: 2 } } } } };
        api.researchItems.mockResolvedValue(researchPage(evidence("later", "par3"), evidence("first", "par1")));
        const { container } = render(<LegalSourceViewer citation="2099 SCC 1"
            docType="cases" researchFile={file} />);

        await waitFor(() => expect(container.querySelectorAll("[data-research-evidence]")).toHaveLength(2));
        expect(container.querySelector('[data-locator-value="par1"] [data-research-evidence="first"]')).toBeTruthy();
        expect(container.querySelector('[data-locator-value="par3"] [data-research-evidence="later"]')).toBeTruthy();
    });

    it("highlights one quote across a legal locator range", () => {
        const root = document.createElement("div");
        root.innerHTML = ["Range starts.", "Middle.", "Range ends."].map((text, index) =>
            `<section data-locator-value="par${index + 1}">${text}</section>`).join("");
        const [match] = highlightDocxQuotes(root,
            [{ quote: "Range starts. Middle. Range ends.", locator: "par1-par3" }]);

        expect(match?.closest("[data-locator-value]")).toHaveAttribute("data-locator-value", "par1");
        expect(root.querySelectorAll('[data-qspan="0"]')).toHaveLength(3);
        expect(root.querySelector('[data-locator-value="par3"] [data-qspan="0"]')).toHaveTextContent("Range ends.");
    });

    it("uses controlled research updates for highlight color without fetching again", async () => {
        api.direct.mockResolvedValue(multiSlicePayload());
        const { container, rerender } = render(<LegalSourceViewer citation="2099 SCC 1"
            docType="cases" researchFile={researchFile} />);
        await waitFor(() => expect(container.querySelector('[data-qspan="0"]')).not.toBeNull());
        expect(container.querySelector<HTMLElement>('[data-qspan="0"]')!.style.backgroundColor)
            .toBe("rgba(4, 120, 87, 0.35)");

        const changed = { ...researchFile, versionId: "version-2", state: {
            ...researchFile.state, labels: { ...researchFile.state.labels,
                holding: { ...researchFile.state.labels.holding, color: "#991b1b" } } } };
        rerender(<LegalSourceViewer citation="2099 SCC 1" docType="cases"
            researchFile={changed} />);
        await waitFor(() => expect(
            container.querySelector<HTMLElement>('[data-qspan="0"]')!.style.backgroundColor,
        ).toBe("rgba(153, 27, 27, 0.35)"));
        expect(api.researchFile).not.toHaveBeenCalled();
        expect(api.researchItems).toHaveBeenCalledTimes(1);
    });

    it("keeps the compact research controls in the header", async () => {
        api.direct.mockResolvedValue(viewerPayload());
        const onOpenResearch = vi.fn();
        render(<LegalSourceViewer citation="2099 SCC 1" docType="cases" compact
            researchFile={null} onOpenResearch={onOpenResearch} />);
        await screen.findByRole("heading", { name: "Fixture v. Test" });
        expect(screen.getByRole("group", { name: "No labels" })).toHaveAttribute(
            "data-empty", "true",
        );
        fireEvent.click(screen.getByRole("button", { name: "Open in workspace" }));
        expect(onOpenResearch).toHaveBeenCalledTimes(1);
        fireEvent.dragStart(screen.getByRole("button", { name: "Label Fixture v. Test" }),
            { dataTransfer: { setData: vi.fn() } });
        expect(onOpenResearch).toHaveBeenLastCalledWith("source-drop");
        expect(api.actOnResearchFile).not.toHaveBeenCalled();
    });

    it("lands each selected quote even when the same source keeps one quote", async () => {
        api.direct.mockResolvedValue(multiSlicePayload());
        const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
            .mockImplementation(function () {
                return {
                    top: this.hasAttribute("data-qspan") ? 240 : 100,
                } as DOMRect;
            });
        const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockReturnValue(800);
        const { container, rerender } = render(
            <LegalSourceViewer
                citation="2099 SCC 1"
                docType="cases"
                quotes={[{ quote: "First proposition." }]}
            />,
        );
        await screen.findByRole("heading", { name: "Fixture v. Test" });
        const reader = container.querySelector<HTMLElement>(".overflow-y-auto")!;

        await waitFor(() => expect(reader.scrollTop).toBe(108));
        reader.scrollTop = 0;
        rerender(<LegalSourceViewer citation="2099 SCC 1" docType="cases"
            quotes={[{ quote: "Second proposition." }]} />);
        await waitFor(() => expect(reader.scrollTop).toBe(108));
        rect.mockRestore();
        height.mockRestore();
    });

    it("highlights one verified quote across twelve internal paragraphs", async () => {
        const paragraphs = Array.from(
            { length: 12 },
            (_, index) => `[${index + 61}] Distinct passage ${index + 1}.`,
        );
        const text = paragraphs.join("\n");
        const base = viewerPayload();
        api.direct.mockResolvedValue({
            ...base,
            slices: paragraphs.map((paragraph, index) => {
                const start = text.indexOf(paragraph);
                const anchor = {
                    kind: "paragraph" as const,
                    label: `par${index + 61}`,
                    start,
                    end: start + paragraph.length,
                };
                return {
                    start: anchor.start,
                    end: anchor.end,
                    text: paragraph,
                    depth: 0,
                    anchors: [],
                    primary: anchor,
                };
            }),
        });
        const { container } = render(
            <LegalSourceViewer
                citation="2099 SCC 1"
                docType="cases"
                quotes={[{ quote: text }]}
            />,
        );

        await waitFor(() =>
            expect(
                Array.from({ length: 12 }, (_, index) =>
                    container.querySelector(
                        `#legal-${index + 61} [data-qspan="0"]`,
                    ),
                ).every(Boolean),
            ).toBe(true),
        );
    });

    it("keeps saved and direct readers in the same bounded source shell", async () => {
        api.saved.mockResolvedValue(viewerPayload());
        const { rerender } = render(
            <LegalLibrarySourcePage referenceId="saved-1" />,
        );

        await screen.findByRole("heading", {
            name: "Fixture v. Test",
        });
        api.direct.mockResolvedValue(viewerPayload());
        rerender(
            <LegalLibrarySourcePage
                provider="a2aj"
                citation="2099 SCC 1"
                docType="cases"
                language="en"
            />,
        );
        await waitFor(() => expect(api.direct).toHaveBeenCalledTimes(1));
        expect(screen.getByRole("heading", { name: "Fixture v. Test" })).toBeVisible();
    });

    it("omits unsafe or absent source actions independently", () => {
        const metadata = viewerPayload().metadata;
        expect(
            legalSourceViewerActions({
                ...metadata,
                url: "javascript:alert(1)",
            }),
        ).toEqual([
            {
                kind: "pdf",
                label: "PDF",
                href: metadata.pdfUrl,
            },
        ]);
        expect(
            legalSourceViewerActions({
                ...metadata,
                url: null,
                pdfUrl: null,
            }),
        ).toEqual([]);
    });
});
