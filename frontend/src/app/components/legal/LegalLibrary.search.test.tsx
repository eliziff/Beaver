import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegalLibraryPage } from "./LegalLibrary";
import { useSourcesWorkspace } from "./SourcesWorkspace";

const api = vi.hoisted(() => ({
    actOnResearchFile: vi.fn(),
    createResearchFile: vi.fn(),
    getResearchFile: vi.fn(),
    getLegalSourceCoverage: vi.fn(),
    searchLegalSources: vi.fn(),
}));

vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  actOnResearchFile: api.actOnResearchFile,
  createResearchFile: api.createResearchFile,
  getResearchFile: api.getResearchFile
}));
vi.mock("@/app/lib/api/legalSources", async (original) => ({
  ...await original<typeof import("@/app/lib/api/legalSources")>(),
  getLegalSourceCoverage: api.getLegalSourceCoverage,
  searchLegalSources: api.searchLegalSources
}));
vi.mock("./ResearchFileBar", () => ({ ResearchFileBar: ({ onReadSource }: { onReadSource: (source: any) => void }) => {
    const { accept: onChange } = useSourcesWorkspace(); return (
    <><button onClick={() => onChange({ document: { id: "chosen", filename: "Chosen.research.md" }, versionId: "v1", workingRevision: 0,
        state: { schemaVersion: "beaver.research.v2", labels: {}, sources: {}, queries: null, note: "" } })}>Choose fixture</button>
    <button onClick={() => onReadSource({ id: "saved-source", reference: {
        provider: "a2aj", id: "case-1", kind: "case", title: "Saved decision" } })}>Read saved decision</button></>); } }));
vi.mock("./LegalSourceViewer", async (original) => ({
    ...await original<typeof import("./LegalSourceViewer")>(),
    LegalSourceViewer: () => <div>Decision text</div>,
}));
const linked = { document: { id: "linked-file", filename: "Linked.research.md" },
    versionId: "version-1", workingRevision: 0,
    state: { schemaVersion: "beaver.research.v2" as const,
        labels: {}, sources: {}, queries: null, note: "" } };

describe("LegalLibraryPage search", () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        api.getLegalSourceCoverage.mockResolvedValue([
            {
                docType: "laws",
                jurisdictionCode: "ca",
                jurisdiction: "Canada",
                sourceKind: "legislation",
                dataset: "federal-statutes",
                description: "Federal statutes",
            },
            {
                docType: "laws",
                jurisdictionCode: "ab",
                jurisdiction: "Alberta",
                sourceKind: "legislation",
                dataset: "alberta-statutes",
                description: "Alberta statutes",
            },
        ]);
        api.searchLegalSources.mockResolvedValue([]);
    });

    it("opens the research file linked from its Library preview", async () => {
        api.getResearchFile.mockResolvedValue(linked);
        render(<MemoryRouter initialEntries={["/sources?research_file=linked-file"]}>
            <LegalLibraryPage />
        </MemoryRouter>);
        await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledWith("linked-file"));
        expect(screen.getByRole("region", { name: "Research collection" })).toBeVisible();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("reads a saved source in the main area while retaining its workspace in the dock", async () => {
        api.getResearchFile.mockResolvedValue(linked);
        render(<MemoryRouter initialEntries={["/sources?research_file=linked-file"]}>
            <LegalLibraryPage />
        </MemoryRouter>);
        fireEvent.click(await screen.findByRole("button", { name: "Read saved decision" }));
        const reader = screen.getByRole("region", { name: "Source reader" });
        expect(reader).toHaveTextContent("Decision text");
        const workspace = screen.getByRole("complementary", { name: "Workspace" });
        expect(workspace).not.toContainElement(reader);
        expect(workspace).toContainElement(screen.getByRole("region", { name: "Research collection" }));
        fireEvent.click(screen.getByRole("button", { name: "Collapse workspace" }));
        expect(reader).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Open research workspace" }));
        expect(screen.getByRole("region", { name: "Research collection" })).toBeVisible();
    });

    it("shows an unavailable workspace error in the open collection", async () => {
        api.getResearchFile.mockRejectedValue(new Error("Workspace unavailable"));
        render(<MemoryRouter initialEntries={["/sources?research_file=missing"]}>
            <LegalLibraryPage />
        </MemoryRouter>);
        expect(await screen.findByRole("alert")).toBeVisible();
        expect(screen.getByRole("alert")).toHaveTextContent("Workspace unavailable");
    });

    it("discovers the workspace bound by the assistant without clearing a typed search", async () => {
        api.getResearchFile.mockResolvedValue(linked);
        const { rerender } = render(<MemoryRouter><LegalLibraryPage embedded /></MemoryRouter>);
        fireEvent.change(screen.getByPlaceholderText("Search cases, legislation, journals, and Hansard"),
            { target: { value: "contract notice" } });
        rerender(<MemoryRouter><LegalLibraryPage embedded researchFileId="linked-file" /></MemoryRouter>);
        await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledWith("linked-file"));
        expect(screen.getByRole("region", { name: "Research collection" })).toBeVisible();
        expect(screen.getByPlaceholderText("Search cases, legislation, journals, and Hansard")).toHaveValue("contract notice");
    });

    it("refreshes the selected Workspace without resetting its search", async () => {
        const publish = vi.fn(), refreshed = { ...linked, workingRevision: 1 };
        api.getResearchFile.mockResolvedValueOnce(linked).mockResolvedValueOnce(refreshed);
        const view = (refresh: string) => <MemoryRouter
            initialEntries={["/sources?research_file=linked-file"]}>
            <LegalLibraryPage researchRefreshKey={refresh} onResearchFileChange={publish} />
        </MemoryRouter>;
        const { rerender } = render(view("turn-1"));
        await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledOnce());
        const search = screen.getByPlaceholderText("Search cases, legislation, journals, and Hansard");
        fireEvent.change(search, { target: { value: "procedural fairness" } });

        rerender(view("turn-2"));
        await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledTimes(2));
        expect(api.getResearchFile).toHaveBeenLastCalledWith("linked-file");
        await waitFor(() => expect(publish).toHaveBeenLastCalledWith(refreshed));
        expect(screen.getByPlaceholderText("Search cases, legislation, journals, and Hansard"))
            .toHaveValue("procedural fairness");
        rerender(view("turn-2"));
        expect(api.getResearchFile).toHaveBeenCalledTimes(2);
    });

    it("searches all legislation without serializing every covered dataset", async () => {
        render(<MemoryRouter><LegalLibraryPage /></MemoryRouter>);
        await waitFor(() => expect(api.getLegalSourceCoverage).toHaveBeenCalled());
        fireEvent.click(screen.getByRole("tab", { name: "Legislation" }));
        expect(screen.getByRole("button", { name: "Jurisdiction" })).toBeVisible();
        expect(screen.getByRole("button", { name: "Collection" })).toBeVisible();
        fireEvent.change(screen.getByPlaceholderText(
            "Statute title, citation, or provision",
        ), { target: { value: "privacy" } });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));

        await waitFor(() => expect(api.searchLegalSources).toHaveBeenCalledWith(
            expect.objectContaining({
                query: "privacy",
                docType: "laws",
                datasets: undefined,
            }),
        ));
    });

    it("renders provider emphasis as safe React markup", async () => {
        api.searchLegalSources.mockResolvedValue([{
            provider: "a2aj",
            doc_type: "laws",
            source_id: "privacy-act",
            language: "en",
            dataset: "federal-statutes",
            citation: "RSC 1985, c P-21",
            name: "Privacy Act",
            date: null,
            url: "https://example.test/privacy",
            snippet: "The <em>privacy</em> of individuals",
        }]);
        const { container } = render(
            <MemoryRouter><LegalLibraryPage /></MemoryRouter>,
        );
        await waitFor(() => expect(api.getLegalSourceCoverage).toHaveBeenCalled());
        fireEvent.click(screen.getByRole("tab", { name: "Legislation" }));
        fireEvent.change(screen.getByPlaceholderText(
            "Statute title, citation, or provision",
        ), {
            target: { value: "privacy" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));

        await screen.findByText("Privacy Act");
        expect(screen.getByText("privacy").tagName).toBe("MARK");
        expect(container.textContent).not.toContain("<em>");
        expect(screen.getByRole("link", { name: "View Privacy Act" }).getAttribute("href"))
            .toContain("/sources/view");
        expect(screen.getByRole("link", { name: "Site: View original source for Privacy Act" }))
            .toHaveAttribute("href", "https://example.test/privacy");
    });

    it("does not repeat a journal title inside its displayed citation", async () => {
        const title = "The [Unwritten] Principles (Again): C++?";
        api.searchLegalSources.mockResolvedValue([{
            provider: "journal", doc_type: "articles", source_id: "17",
            language: "en",
            dataset: "Alberta Law Review",
            citation: `Example Author, “${title}” (2024) 42 Alta L Rev 1`,
            name: title, date: "2024-01-02", url: null, snippet: null,
        }]);
        render(<MemoryRouter><LegalLibraryPage /></MemoryRouter>);
        fireEvent.click(screen.getByRole("tab", { name: "Journals" }));
        fireEvent.change(screen.getByPlaceholderText(
            "Article title, author, journal, or citation",
        ), { target: { value: "principles" } });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));

        const card = (await screen.findByRole("heading", { name: title })).closest("article")!;
        expect(card.textContent!.split(title).length - 1).toBe(1);
        expect(card).toHaveTextContent("Example Author, (2024) 42 Alta L Rev 1");
    });

    it("does not guess a research file from a magic filename", async () => {
        const document = { id: "file-1", filename: "Research.research.md",
            file_type: "md", project_id: null, pdf_storage_path: null,
            size_bytes: 1, page_count: null, created_at: null,
            current_version_id: "version-1" };
        api.getResearchFile.mockResolvedValue({ document, versionId: "version-1", workingRevision: 0,
            state: { schemaVersion: "beaver.research.v2", labels: {
                key: { id: "key", name: "Key authority", parentId: null,
                    color: "#1d4ed8", order: 0, scope: "source" },
            }, sources: { saved: { id: "saved", labelIds: ["key"], badge: "Key",
                note: "", reference: { provider: "a2aj", id: "2024-scc-1",
                    kind: "case", title: "Example v Test", citation: "2024 SCC 1",
                    collection: "SCC", language: "en" }, passages: null } },
            queries: null, note: "" } });
        api.searchLegalSources.mockResolvedValue([{
            provider: "a2aj", doc_type: "cases", source_id: "2024-scc-1",
            language: "en",
            dataset: "SCC", citation: "2024 SCC 1", name: "Example v Test",
            date: "2024-01-01", url: null, snippet: null,
        }]);
        render(<MemoryRouter><LegalLibraryPage /></MemoryRouter>);
        fireEvent.click(screen.getByRole("tab", { name: "Cases" }));
        fireEvent.change(screen.getByPlaceholderText(
            "Case name, citation, or legal concept",
        ), { target: { value: "example" } });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));

        const heading = await screen.findByRole("heading", { name: "Example v Test" });
        const picker = screen.getByRole("button", { name: "Label Example v Test" });
        expect(picker).not.toHaveTextContent("Key");
        expect(picker.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING)
            .toBeTruthy();
        expect(api.getResearchFile).not.toHaveBeenCalled();
    });

    it("does not render provider-controlled non-HTTP source links", async () => {
        api.searchLegalSources.mockResolvedValue([{
            provider: "a2aj", doc_type: "laws", source_id: "privacy-act",
            language: "en",
            dataset: "federal-statutes", citation: "RSC 1985, c P-21",
            name: "Privacy Act", date: null, url: "javascript:alert(1)",
            snippet: null,
        }]);
        render(<MemoryRouter><LegalLibraryPage /></MemoryRouter>);
        await waitFor(() => expect(api.getLegalSourceCoverage).toHaveBeenCalled());
        fireEvent.click(screen.getByRole("tab", { name: "Legislation" }));
        fireEvent.change(screen.getByPlaceholderText(
            "Statute title, citation, or provision",
        ), { target: { value: "privacy" } });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));

        await screen.findByText("Privacy Act");
        expect(screen.queryByRole("link", { name: "Site: View original source for Privacy Act" }))
            .not.toBeInTheDocument();
    });

    it("opens the workspace chooser instead of inventing a file for a result", async () => {
        api.searchLegalSources.mockImplementation(({ docType }) => Promise.resolve(
            docType === "cases" ? [{
                provider: "a2aj", doc_type: "cases", source_id: "2024-scc-1",
                language: "en",
                dataset: "SCC", citation: "2024 SCC 1", name: "Example v Test",
                date: "2024-01-01", url: "https://example.test", snippet: null,
            }] : [],
        ));
        render(<MemoryRouter><LegalLibraryPage embedded /></MemoryRouter>);
        fireEvent.change(screen.getByPlaceholderText(
            "Search cases, legislation, journals, and Hansard",
        ), { target: { value: "example" } });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));
        await screen.findByText("Example v Test");
        const marker = screen.getByRole("button", { name: "Label Example v Test" });
        expect(screen.queryByRole("dialog", { name: "Workspace" })).not.toBeInTheDocument();
        fireEvent.dragStart(marker, { dataTransfer: { setData: vi.fn() } });
        expect(screen.getByRole("region", { name: "Research collection" })).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Choose fixture" }));
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Research collection" })).toBeVisible();
        expect(api.createResearchFile).not.toHaveBeenCalled();
        expect(api.actOnResearchFile).not.toHaveBeenCalled();
    });
});
