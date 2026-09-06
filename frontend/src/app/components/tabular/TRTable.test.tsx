import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TRTable } from "./TRTable";
import type { ColumnConfig, TabularCell } from "@/app/lib/api/tabular";
import type { Document } from "@/app/lib/api/documents";
import type { GroundedEvidence } from "@/app/lib/groundedAnswers";

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

    it("renders the Document header and a row for each document", () => {
        renderTable();
        expect(screen.getByText("Document")).toBeInTheDocument();
        expect(screen.getByText("report.pdf")).toBeInTheDocument();
        expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    });

    it("keeps separately arranged passages of one source in their chosen groups", () => {
        render(<TRTable loading={false} columns={[]} documents={[
            { ...doc, id: "passage-1", filename: "Opening position", group: ["Delivery", "Deadlines"] },
            { ...doc, id: "passage-2", filename: "Later amendment", group: ["Delivery", "Deadlines"] },
            { ...doc, id: "passage-3", filename: "Payment terms", group: ["Payment"] },
        ]} cells={[]} savingColumnsConfig={false} selectedDocIds={[]} onSelectionChange={vi.fn()}
            onExpand={vi.fn()} onCitationClick={vi.fn()} onEditColumn={vi.fn()} />);
        expect(screen.getAllByText("Delivery / Deadlines")).toHaveLength(1);
        expect(screen.getByText("Payment")).toBeVisible();
        expect(screen.getByLabelText("Select Opening position")).toBeVisible();
        expect(screen.getByLabelText("Select Later amendment")).toBeVisible();
    });

    it("edits, reruns and deletes a column from its header menu", () => {
        const column = { index: 0, name: "Parties", prompt: "Identify parties" };
        const onEditColumn = vi.fn(), onRerunColumn = vi.fn(), onClearColumn = vi.fn(), onDeleteColumn = vi.fn();
        render(<TRTable loading={false} columns={[column]} documents={[doc]} cells={[]} savingColumnsConfig={false}
            selectedDocIds={[]} onSelectionChange={vi.fn()} onExpand={vi.fn()} onCitationClick={vi.fn()}
            onEditColumn={onEditColumn} onRerunColumn={onRerunColumn} onClearColumn={onClearColumn} onDeleteColumn={onDeleteColumn} />);
        const open = () => fireEvent.click(screen.getByRole("button", { name: "Parties actions" }));

        open();
        fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
        expect(onEditColumn).toHaveBeenCalledWith(column);
        open();
        fireEvent.click(screen.getByRole("menuitem", { name: "Rerun column" }));
        expect(onRerunColumn).toHaveBeenCalledWith(column);
        open();
        fireEvent.click(screen.getByRole("menuitem", { name: "Clear column" }));
        expect(onClearColumn).toHaveBeenCalledWith(column);
        open();
        fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
        expect(onDeleteColumn).toHaveBeenCalledWith(column);
    });

    it("blocks a column rerun while the review is running", () => {
        render(<TRTable loading={false} columns={[{ index: 0, name: "Parties", prompt: "" }]} documents={[doc]} cells={[]}
            savingColumnsConfig={false} selectedDocIds={[]} running onSelectionChange={vi.fn()} onExpand={vi.fn()}
            onCitationClick={vi.fn()} onEditColumn={vi.fn()} onRerunColumn={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "Parties actions" }));
        expect(screen.getByRole("menuitem", { name: "Rerun column" })).toBeDisabled();
        expect(screen.getByRole("menuitem", { name: "Edit" })).toBeEnabled();
    });

    it("offers the next step when the table has no rows", () => {
        const onAddColumns = vi.fn(), onAddDocuments = vi.fn();
        render(<TRTable loading={false} columns={[]} documents={[]} cells={[]} savingColumnsConfig={false} selectedDocIds={[]}
            onSelectionChange={vi.fn()} onExpand={vi.fn()} onCitationClick={vi.fn()} onEditColumn={vi.fn()}
            onAddColumns={onAddColumns} onAddDocuments={onAddDocuments} />);
        fireEvent.click(screen.getByRole("button", { name: "Add columns" }));
        fireEvent.click(screen.getByRole("button", { name: "Add documents" }));
        expect(onAddColumns).toHaveBeenCalledOnce();
        expect(onAddDocuments).toHaveBeenCalledOnce();
    });

    it("opens details from the cell and the first citation from the count chip", () => {
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
                summary: "Answer",
                claims: [{ text: "A grounded answer.", evidence_ids: ["page", "sheet"] }],
                evidence: [
                    { evidence_id: "page", provider: "library", stable_source_id: doc.id,
                        version: "version-page", name: doc.filename, citation: doc.filename,
                        span_text: "page quote", locator: { kind: "page", label: "7" } },
                    { evidence_id: "sheet", provider: "library", stable_source_id: "workbook",
                        version: "version-sheet", name: "Authorities.xlsx", citation: "Authorities.xlsx",
                        span_text: "sheet quote", locator: { kind: "cell", label: "Authorities!B2", sheet: "Authorities", cells: "B2" } },
                ] as GroundedEvidence[],
                outcome: "answered", coverage: "complete",
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

        fireEvent.click(screen.getByRole("button", { name: "Open Finding result" }));
        expect(onExpand).toHaveBeenCalledOnce();
        expect(onExpand).toHaveBeenCalledWith(cell);

        fireEvent.click(screen.getByRole("button", { name: "2 citations" }));
        expect(onCitationClick).toHaveBeenCalledOnce();
        expect(onCitationClick).toHaveBeenCalledWith(
            cell,
            expect.objectContaining({ kind: "document", document_id: doc.id,
                version_id: "version-page", ref: 1, quotes: [{ page: "7", quote: "page quote" }] }),
        );
        expect(onExpand).toHaveBeenCalledOnce();
    });
});
