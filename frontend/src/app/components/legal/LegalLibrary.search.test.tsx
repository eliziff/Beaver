import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegalLibraryPage } from "./LegalLibrary";

const api = vi.hoisted(() => ({
    actOnResearchSet: vi.fn(),
    createResearchSet: vi.fn(),
    getLegalSourceCoverage: vi.fn(),
    listResearchSets: vi.fn(),
    searchLegalSources: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/beaverApi")>()),
    ...api,
}));

describe("LegalLibraryPage search", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.listResearchSets.mockResolvedValue([]);
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

    it("lazily creates personal saved research when the first result is saved", async () => {
        const empty = {
            id: "set-1", kind: "research-set", title: "Saved research",
            projectId: null, revision: 0, outputs: {},
            createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
            state: { schemaVersion: "beaver.research-set.v1", labels: {}, sources: {},
                evidence: {}, queries: {}, memo: "", audit: [] },
        };
        api.createResearchSet.mockResolvedValue(empty);
        api.actOnResearchSet.mockResolvedValue({ ...empty, revision: 1 });
        api.searchLegalSources.mockImplementation(({ docType }) => Promise.resolve(
            docType === "cases" ? [{
                provider: "a2aj", doc_type: "cases", source_id: "2024-scc-1",
                dataset: "SCC", citation: "2024 SCC 1", name: "Example v Test",
                date: "2024-01-01", url: "https://example.test", snippet: null,
            }] : [],
        ));
        render(<MemoryRouter><LegalLibraryPage /></MemoryRouter>);
        fireEvent.change(screen.getByPlaceholderText(
            "Search cases, legislation, journals, and Hansard",
        ), { target: { value: "example" } });
        fireEvent.click(screen.getByRole("button", { name: "Search" }));
        await screen.findByText("Example v Test");
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(api.createResearchSet).toHaveBeenCalledWith({
            title: "Saved research",
        }));
        expect(api.actOnResearchSet).toHaveBeenCalledWith("set-1", 0, {
            type: "source",
            reference: expect.objectContaining({
                provider: "a2aj", id: "2024-scc-1", kind: "case",
            }),
        });
    });
});
