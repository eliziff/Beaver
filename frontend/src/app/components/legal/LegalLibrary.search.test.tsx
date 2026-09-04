import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegalLibraryPage } from "./LegalLibrary";

const api = vi.hoisted(() => ({
    actOnResearchFile: vi.fn(),
    createResearchFile: vi.fn(),
    getResearchFile: vi.fn(),
    getLegalSourceCoverage: vi.fn(),
    listResearchFiles: vi.fn(),
    searchLegalSources: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/beaverApi")>()),
    ...api,
}));
vi.mock("./ResearchFileBar", () => ({ ResearchFileBar: () => null }));

describe("LegalLibraryPage search", () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        api.listResearchFiles.mockResolvedValue([]);
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
        const linked = { document: { id: "linked-file", filename: "Linked.research.md" },
            versionId: "version-1", state: { schemaVersion: "beaver.research.v1",
                labels: {}, sources: {}, evidence: {}, queries: {}, note: "" } };
        api.getResearchFile.mockResolvedValue(linked);
        render(<MemoryRouter initialEntries={["/sources?research_file=linked-file"]}>
            <LegalLibraryPage />
        </MemoryRouter>);
        await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledWith("linked-file"));
        expect(screen.getByLabelText("Assistant dock")).toHaveAttribute("aria-hidden", "false");
    });

    it("searches all legislation without serializing every covered dataset", async () => {
        render(<MemoryRouter><LegalLibraryPage /></MemoryRouter>);
        await waitFor(() => expect(api.getLegalSourceCoverage).toHaveBeenCalled());
        fireEvent.click(screen.getByRole("button", { name: "Legislation" }));
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
            dataset: "federal-statutes",
            citation: "RSC 1985, c P-21",
            name: "Privacy Act",
            date: null,
            url: null,
            snippet: "The <em>privacy</em> of individuals",
        }]);
        const { container } = render(
            <MemoryRouter><LegalLibraryPage /></MemoryRouter>,
        );
        await waitFor(() => expect(api.getLegalSourceCoverage).toHaveBeenCalled());
        fireEvent.click(screen.getByRole("button", { name: "Legislation" }));
        fireEvent.change(screen.getByPlaceholderText(
            "Statute title, citation, or provision",
        ), {
            target: { value: "privacy" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));

        await screen.findByText("Privacy Act");
        expect(screen.getByText("privacy").tagName).toBe("MARK");
        expect(container.textContent).not.toContain("<em>");
        expect(screen.getByRole("link", { name: "View" }).getAttribute("href"))
            .toContain("/sources/view");
    });

    it("does not repeat a journal title inside its displayed citation", async () => {
        const title = "The [Unwritten] Principles (Again): C++?";
        api.searchLegalSources.mockResolvedValue([{
            provider: "journal", doc_type: "articles", source_id: "17",
            dataset: "Alberta Law Review",
            citation: `Example Author, “${title}” (2024) 42 Alta L Rev 1`,
            name: title, date: "2024-01-02", url: null, snippet: null,
        }]);
        render(<MemoryRouter><LegalLibraryPage /></MemoryRouter>);
        fireEvent.click(screen.getByRole("button", { name: "Journals" }));
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
        api.listResearchFiles.mockResolvedValue([document]);
        api.getResearchFile.mockResolvedValue({ document, versionId: "version-1",
            state: { schemaVersion: "beaver.research.v1", labels: {
                key: { id: "key", name: "Key authority", parentId: null,
                    color: "#1d4ed8", order: 0, scope: "source" },
            }, sources: { saved: { id: "saved", labelIds: ["key"], badge: "Key",
                note: "", reference: { provider: "a2aj", id: "2024-scc-1",
                    kind: "case", title: "Example v Test", citation: "2024 SCC 1" } } },
            evidence: {}, queries: {}, note: "" } });
        api.searchLegalSources.mockResolvedValue([{
            provider: "a2aj", doc_type: "cases", source_id: "2024-scc-1",
            dataset: "SCC", citation: "2024 SCC 1", name: "Example v Test",
            date: "2024-01-01", url: null, snippet: null,
        }]);
        render(<MemoryRouter><LegalLibraryPage /></MemoryRouter>);
        fireEvent.click(screen.getByRole("button", { name: "Cases" }));
        fireEvent.change(screen.getByPlaceholderText(
            "Case name, citation, or legal concept",
        ), { target: { value: "example" } });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));

        const heading = await screen.findByRole("heading", { name: "Example v Test" });
        const picker = screen.getByRole("button", { name: "Label Example v Test" });
        expect(picker).not.toHaveTextContent("Key");
        expect(picker.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING)
            .toBeTruthy();
        expect(api.listResearchFiles).not.toHaveBeenCalled();
        expect(api.getResearchFile).not.toHaveBeenCalled();
    });

    it("does not render provider-controlled non-HTTP source links", async () => {
        api.searchLegalSources.mockResolvedValue([{
            provider: "a2aj", doc_type: "laws", source_id: "privacy-act",
            dataset: "federal-statutes", citation: "RSC 1985, c P-21",
            name: "Privacy Act", date: null, url: "javascript:alert(1)",
            snippet: null,
        }]);
        render(<MemoryRouter><LegalLibraryPage /></MemoryRouter>);
        await waitFor(() => expect(api.getLegalSourceCoverage).toHaveBeenCalled());
        fireEvent.click(screen.getByRole("button", { name: "Legislation" }));
        fireEvent.change(screen.getByPlaceholderText(
            "Statute title, citation, or provision",
        ), { target: { value: "privacy" } });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));

        await screen.findByText("Privacy Act");
        expect(screen.queryByRole("link", { name: "View original source" }))
            .not.toBeInTheDocument();
    });

    it("lazily creates a normal research file and saves palette changes immediately", async () => {
        const onOpenSource = vi.fn();
        const onResearchFileChange = vi.fn();
        const empty = {
            document: { id: "file-1", filename: "Research.research.md",
                file_type: "md", project_id: null, pdf_storage_path: null,
                size_bytes: 1, page_count: null, created_at: null,
                current_version_id: "version-1" },
            versionId: "version-1",
            state: { schemaVersion: "beaver.research.v1", labels: {}, sources: {},
                evidence: {}, queries: {}, note: "" },
        };
        api.createResearchFile.mockResolvedValue(empty);
        api.actOnResearchFile.mockResolvedValue({ ...empty, versionId: "version-2",
            state: { ...empty.state, sources: { saved: { id: "saved", labelIds: [], note: "",
                reference: { provider: "a2aj", id: "2024-scc-1", kind: "case" } } } } });
        api.searchLegalSources.mockImplementation(({ docType }) => Promise.resolve(
            docType === "cases" ? [{
                provider: "a2aj", doc_type: "cases", source_id: "2024-scc-1",
                dataset: "SCC", citation: "2024 SCC 1", name: "Example v Test",
                date: "2024-01-01", url: "https://example.test", snippet: null,
            }] : [],
        ));
        render(<MemoryRouter><LegalLibraryPage embedded onOpenSource={onOpenSource}
            onResearchFileChange={onResearchFileChange} /></MemoryRouter>);
        fireEvent.change(screen.getByPlaceholderText(
            "Search cases, legislation, journals, and Hansard",
        ), { target: { value: "example" } });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));
        await screen.findByText("Example v Test");
        fireEvent.click(screen.getByRole("button", { name: "Label Example v Test" }));

        await waitFor(() => expect(api.createResearchFile).toHaveBeenCalledWith({
            title: "Research", projectId: undefined,
        }));
        expect(api.actOnResearchFile).not.toHaveBeenCalled();
        fireEvent.change(screen.getByRole("textbox", { name: "Item note" }), { target: { value: "Useful" } });
        fireEvent.blur(screen.getByRole("textbox", { name: "Item note" }));
        await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalled());
        expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", {
            type: "source",
            reference: expect.objectContaining({
                provider: "a2aj", id: "2024-scc-1", kind: "case",
            }),
        });
        await waitFor(() => expect(onResearchFileChange).toHaveBeenCalledWith(
            expect.objectContaining({ versionId: "version-2" }),
        ));
        fireEvent.click(screen.getByRole("button", { name: "View" }));
        expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({
            kind: "legal", provider: "a2aj", sourceId: "2024-scc-1",
            researchFileId: "file-1", researchSourceId: "saved",
        }));
    });
});
