import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type {
    LegalSourceCoverage,
    LegalSourceReference,
    LegalSourceSearchResult,
} from "@/app/lib/beaverApi";

const api = vi.hoisted(() => ({
    coverage: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    save: vi.fn(),
    search: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => ({
    deleteLegalSource: api.delete,
    getLegalSourceCoverage: api.coverage,
    listLegalLibrary: api.list,
    saveLegalSource: api.save,
    searchLegalSources: api.search,
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ prefetch: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: () => null,
}));
vi.mock("@/app/components/shared/TableToolbar", () => ({
    TableToolbar: () => null,
}));
vi.mock("@/app/components/modals/ModalSelect", () => ({
    ModalSelect: ({
        id,
        value,
        onChange,
        options,
    }: {
        id: string;
        value: string;
        onChange: (value: string) => void;
        options: { value: string; label: string }[];
    }) => (
        <select
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
        >
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    ),
}));
vi.mock("./LegalSourceViewer", () => ({
    legalSourceKindLabel: () => "Legislation",
    LegalSourceViewer: () => null,
}));
vi.mock("./LegalSourceMarkingPanel", () => ({
    LegalSourceMarkingPanel: () => null,
}));

import { LegalLibraryPage } from "./LegalLibrary";

const coverage: LegalSourceCoverage[] = [
    {
        dataset: "laws/ab",
        description: "Alberta statutes",
        descriptionFr: null,
        docType: "laws",
        jurisdictionCode: "ab",
        jurisdiction: "Alberta",
        sourceKind: "legislation",
        earliestDate: "1900-01-01",
        latestDate: "2026-01-01",
        documentCount: 10,
    },
    {
        dataset: "regulations/ab",
        description: "Alberta regulations",
        descriptionFr: null,
        docType: "laws",
        jurisdictionCode: "ab",
        jurisdiction: "Alberta",
        sourceKind: "regulation",
        earliestDate: "1900-01-01",
        latestDate: "2026-01-01",
        documentCount: 10,
    },
];
const result: LegalSourceSearchResult = {
    provider: "a2aj",
    doc_type: "laws",
    source_id: "source-1",
    dataset: "laws/ab",
    citation: "RSA 2000, c A-1",
    alternateCitation: null,
    name: "Example Act",
    date: "2024-01-02",
    url: "https://example.test/act",
    snippet: "Section 7 applies.",
};
const saved: LegalSourceReference = {
    id: "saved-1",
    provider: "a2aj",
    doc_type: "laws",
    citation: result.citation,
    language: "en",
    dataset: result.dataset,
    source_id: result.source_id ?? null,
};

beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue([]);
    api.coverage.mockResolvedValue(coverage);
    api.search.mockResolvedValue([result]);
    api.save.mockResolvedValue(saved);
    api.delete.mockResolvedValue(undefined);
});

it("reads native search fields once and updates saved sources", async () => {
    const commits = vi.fn();
    render(
        <Profiler id="legal-library" onRender={commits}>
            <LegalLibraryPage />
        </Profiler>,
    );
    await screen.findByText("Search above to add a legal source.");

    await userEvent.selectOptions(
        screen.getByRole("combobox", { name: "Legal source type" }),
        "laws",
    );
    await screen.findByRole("option", { name: "Alberta statutes" });
    await userEvent.selectOptions(
        screen.getByRole("combobox", { name: "Jurisdiction" }),
        "ab",
    );
    await userEvent.selectOptions(
        screen.getByRole("combobox", { name: "Source type" }),
        "legislation",
    );
    await userEvent.selectOptions(
        screen.getByRole("combobox", { name: "Collection" }),
        "laws/ab",
    );

    commits.mockClear();
    const query = screen.getByRole("textbox", { name: "Search A2AJ" });
    expect(query).toBeRequired();
    await userEvent.type(query, "  section 7  ");
    fireEvent.change(screen.getByLabelText("From"), {
        target: { value: "2020-01-01" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
        target: { value: "2025-12-31" },
    });
    await userEvent.selectOptions(
        screen.getByRole("combobox", { name: "Sort" }),
        "newest_first",
    );
    expect(commits).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("heading", { name: "Example Act" });
    expect(api.search).toHaveBeenCalledWith({
        query: "section 7",
        docType: "laws",
        datasets: ["laws/ab"],
        startDate: "2020-01-01",
        endDate: "2025-12-31",
        sortResults: "newest_first",
    });

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", {
        name: `Remove ${result.citation} from Library`,
    });
    expect(api.save).toHaveBeenCalledWith({
        citation: result.citation,
        docType: "laws",
        dataset: "laws/ab",
        sourceId: "source-1",
    });
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();

    await userEvent.click(
        screen.getByRole("button", {
            name: `Remove ${result.citation} from Library`,
        }),
    );
    await waitFor(() =>
        expect(
            screen.queryByRole("button", {
                name: `Remove ${result.citation} from Library`,
            }),
        ).not.toBeInTheDocument(),
    );
    expect(api.delete).toHaveBeenCalledWith("saved-1");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});
