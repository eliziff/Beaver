import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TRTable } from "./TRTable";
import type {
    ColumnConfig,
    Document,
    TabularCell,
} from "../shared/types";

const doc = { id: "doc-1", filename: "report.pdf" } as Document;

function renderTable(
    columns: ColumnConfig[] = [],
    onEditColumn = vi.fn(),
    cells: TabularCell[] = [],
    onExpand = vi.fn(),
    onCitationClick = vi.fn(),
) {
    return render(
        <TRTable
            loading={false}
            columns={columns}
            documents={[doc]}
            cells={cells}
            savingColumnsConfig={false}
            selectedDocIds={[]}
            onSelectionChange={vi.fn()}
            onExpand={onExpand}
            onCitationClick={onCitationClick}
            onEditColumn={onEditColumn}
        />,
    );
}

describe("TRTable", () => {
    it("renders the Document header and a row for each document", () => {
        renderTable();
        expect(screen.getByText("Document")).toBeInTheDocument();
        expect(screen.getByText("report.pdf")).toBeInTheDocument();
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

    it("opens details from the cell and routes citation locators separately", () => {
        const column = {
            index: 0,
            name: "Finding",
            prompt: "Find it",
        };
        const cell = {
            id: "cell-1",
            document_id: doc.id,
            column_index: 0,
            content: {
                summary:
                    'Answer [[page:7||quote:page quote]] [[sheet:Authorities||cell:B2||quote:sheet quote]]',
            },
            status: "done",
        } as TabularCell;
        const onExpand = vi.fn();
        const onCitationClick = vi.fn();
        renderTable(
            [column],
            vi.fn(),
            [cell],
            onExpand,
            onCitationClick,
        );

        const pageCitation = screen.getByTitle('Page 7: "page quote"');
        fireEvent.click(pageCitation.closest(".group")!);
        expect(onExpand).toHaveBeenCalledOnce();
        expect(onExpand).toHaveBeenCalledWith(cell);

        fireEvent.click(pageCitation);
        fireEvent.click(screen.getByTitle('Authorities!B2: "sheet quote"'));
        expect(onCitationClick).toHaveBeenNthCalledWith(
            1,
            cell,
            7,
            "page quote",
            1,
            undefined,
            undefined,
        );
        expect(onCitationClick).toHaveBeenNthCalledWith(
            2,
            cell,
            undefined,
            "sheet quote",
            2,
            "Authorities",
            "B2",
        );
        expect(onExpand).toHaveBeenCalledOnce();
    });
});
