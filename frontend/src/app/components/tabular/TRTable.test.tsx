import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TRTable } from "./TRTable";
import type { ColumnConfig, TabularCell } from "@/app/lib/api/tabular";
import type { Document } from "@/app/lib/api/documents";

const doc = { id: "doc-1", filename: "report.pdf" } as Document;

function renderTable(
    columns: ColumnConfig[] = [],
    onEditColumn = vi.fn(),
    cells: TabularCell[] = [],
    onExpand = vi.fn(),
) {
    return render(
        <TRTable
            loading={false}
            columns={columns}
            documents={[doc]}
            cells={cells}
            selectedDocIds={[]}
            onSelectionChange={vi.fn()}
            onExpand={onExpand}
            onEditColumn={onEditColumn}
        />,
    );
}

describe("TRTable", () => {
    it("orders headings and cells by the same column index", () => {
        const columns = [{ index: 2, name: "Later", prompt: "" }, { index: 0, name: "First", prompt: "" }];
        const cells = columns.map((column) => ({ id: String(column.index), document_id: doc.id,
            column_index: column.index, status: "done" as const, content: { summary: `${column.name} answer`,
                claims: [], evidence: [], outcome: "answered" as const, coverage: "complete" as const } }));
        const { container } = renderTable(columns, vi.fn(), cells);
        expect([...container.querySelectorAll("[data-tr-col-header]")].map((header) => header.textContent))
            .toEqual(["First", "Later"]);
        expect(container.querySelector("[data-tr-row]")?.textContent).toMatch(/First answer.*Later answer/u);
    });

    it("keeps separately arranged passages of one source in their chosen groups", () => {
        render(<TRTable loading={false} columns={[]} documents={[
            { ...doc, id: "passage-1", filename: "Opening position", group: ["Delivery", "Deadlines"] },
            { ...doc, id: "passage-2", filename: "Later amendment", group: ["Delivery", "Deadlines"] },
            { ...doc, id: "passage-3", filename: "Payment terms", group: ["Payment"] },
        ]} cells={[]} selectedDocIds={[]} onSelectionChange={vi.fn()}
            onExpand={vi.fn()} onEditColumn={vi.fn()} />);
        expect(screen.getAllByText("Delivery / Deadlines")).toHaveLength(1);
        expect(screen.getByText("Payment")).toBeVisible();
        expect(screen.getByLabelText("Select Opening position")).toBeVisible();
        expect(screen.getByLabelText("Select Later amendment")).toBeVisible();
    });

    it("routes every column header-menu action to its callback", () => {
        const column = { index: 0, name: "Parties", prompt: "Identify parties" };
        const onEditColumn = vi.fn(), onRerunColumn = vi.fn(), onClearColumn = vi.fn(), onDeleteColumn = vi.fn();
        render(<TRTable loading={false} columns={[column]} documents={[doc]} cells={[]} selectedDocIds={[]} onSelectionChange={vi.fn()} onExpand={vi.fn()}
            onEditColumn={onEditColumn} onRerunColumn={onRerunColumn} onClearColumn={onClearColumn} onDeleteColumn={onDeleteColumn} />);
        const open = () => fireEvent.click(screen.getByRole("button", { name: "Parties actions" }));

        for (const [item, callback] of [
            ["Edit", onEditColumn],
            ["Rerun column", onRerunColumn],
            ["Clear column", onClearColumn],
            ["Delete", onDeleteColumn],
        ] as const) {
            open();
            fireEvent.click(screen.getByRole("menuitem", { name: item }));
            expect(callback).toHaveBeenCalledWith(column);
        }
    });

    it("blocks a column rerun while the review is running", () => {
        render(<TRTable loading={false} columns={[{ index: 0, name: "Parties", prompt: "" }]} documents={[doc]} cells={[]}
            selectedDocIds={[]} running onSelectionChange={vi.fn()} onExpand={vi.fn()}
            onEditColumn={vi.fn()} onRerunColumn={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "Parties actions" }));
        expect(screen.getByRole("menuitem", { name: "Rerun column" })).toBeDisabled();
        expect(screen.getByRole("menuitem", { name: "Edit" })).toBeEnabled();
    });

    it("offers the next step when the table has no rows", () => {
        const onAddColumns = vi.fn(), onAddDocuments = vi.fn();
        render(<TRTable loading={false} columns={[]} documents={[]} cells={[]} selectedDocIds={[]}
            onSelectionChange={vi.fn()} onExpand={vi.fn()} onEditColumn={vi.fn()}
            onAddColumns={onAddColumns} onAddDocuments={onAddDocuments} />);
        fireEvent.click(screen.getByRole("button", { name: "+ Column" }));
        fireEvent.click(screen.getByRole("button", { name: "Add documents" }));
        expect(onAddColumns).toHaveBeenCalledOnce();
        expect(onAddDocuments).toHaveBeenCalledOnce();
    });

    it("opens the cell details from the cell button", () => {
        const column = { index: 0, name: "Finding", prompt: "Find it" };
        const cell = { id: "cell-1", document_id: doc.id, column_index: 0, status: "done",
            content: { summary: "Answer", claims: [{ text: "A grounded answer.", evidence_ids: [] }],
                evidence: [], outcome: "answered", coverage: "complete" } } as TabularCell;
        const onExpand = vi.fn();
        renderTable([column], vi.fn(), [cell], onExpand);

        fireEvent.click(screen.getByRole("button", { name: "Open Finding result" }));
        expect(onExpand).toHaveBeenCalledOnce();
        expect(onExpand).toHaveBeenCalledWith(cell);
    });
});
