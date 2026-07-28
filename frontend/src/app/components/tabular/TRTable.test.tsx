import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TRTable } from "./TRTable";
import type { ColumnConfig, Document } from "../shared/types";

const doc = { id: "doc-1", filename: "report.pdf" } as Document;

function renderTable(
    columns: ColumnConfig[] = [],
    onEditColumn = vi.fn(),
) {
    return render(
        <TRTable
            loading={false}
            columns={columns}
            documents={[doc]}
            cells={[]}
            savingColumn={false}
            savingColumnsConfig={false}
            selectedDocIds={[]}
            onSelectionChange={vi.fn()}
            onExpand={vi.fn()}
            onCitationClick={vi.fn()}
            onEditColumn={onEditColumn}
            onAddColumn={vi.fn()}
            onAddDocuments={vi.fn()}
        />,
    );
}

describe("TRTable", () => {
    // The grid here is div-based (no table/columnheader/rowheader roles), so
    // this asserts on rendered content rather than ARIA table semantics.
    it("renders the Document header and a row for each document", () => {
        renderTable();
        expect(screen.getByText("Document")).toBeInTheDocument();
        expect(screen.getByText("report.pdf")).toBeInTheDocument();
        // One select-all checkbox in the header plus one per document row.
        expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    });

    it("keeps review data columns compact", () => {
        const { container } = renderTable([
            { index: 0, name: "Parties", prompt: "Identify parties" },
        ]);

        expect(
            container.querySelector("[data-tr-col-header]"),
        ).toHaveClass("w-[142px]", "lg:w-[240px]");
        expect(
            container.querySelector("[data-tr-doc-header]"),
        ).toHaveClass("w-[112px]", "xl:w-[332px]");
    });

    it("opens the shared editor for a column", () => {
        const column = {
            index: 0,
            name: "Parties",
            prompt: "Identify parties",
        };
        const onEditColumn = vi.fn();
        renderTable([column], onEditColumn);

        fireEvent.click(screen.getByRole("button", { name: "Edit Parties" }));
        expect(onEditColumn).toHaveBeenCalledWith(column);
    });
});
