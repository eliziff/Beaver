import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegalLibraryPage } from "./LegalLibrary";

const api = vi.hoisted(() => ({
    deleteLegalSource: vi.fn(),
    getLegalSourceCoverage: vi.fn(),
    listLegalLibrary: vi.fn(),
    saveLegalSource: vi.fn(),
    searchLegalSources: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/beaverApi")>()),
    ...api,
}));

describe("LegalLibraryPage search", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.listLegalLibrary.mockResolvedValue([]);
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
});
