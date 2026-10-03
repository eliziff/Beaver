import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TRTable } from "./TRTable";
import type { Document } from "@/app/lib/api/documents";

const doc = { id: "doc-1", filename: "report.pdf" } as Document;

function renderTable(props: Partial<ComponentProps<typeof TRTable>> = {}) {
    return render(<TRTable loading={false} columns={[]} documents={[doc]} cells={[]}
        savingColumnsConfig={false} selectedDocIds={[]} onSelectionChange={vi.fn()}
        onExpand={vi.fn()} onEditColumn={vi.fn()} {...props} />);
}

describe("TRTable", () => {
    it("orders headings and cells by the same column index", () => {
        const columns = [{ index: 2, name: "Later", prompt: "" }, { index: 0, name: "First", prompt: "" }];
        const cells = columns.map((column) => ({ id: String(column.index), document_id: doc.id,
            column_index: column.index, status: "done" as const, content: { summary: `${column.name} answer`,
                claims: [], evidence: [], outcome: "answered" as const, coverage: "complete" as const } }));
        const { container } = renderTable({ columns, cells });
        expect([...container.querySelectorAll("[data-tr-col-header]")].map((header) => header.textContent))
            .toEqual(["First", "Later"]);
        expect(container.querySelector("[data-tr-row]")?.textContent).toMatch(/First answer.*Later answer/u);
    });

    it("keeps separately arranged passages of one source in their chosen groups", () => {
        renderTable({ documents: [
            { ...doc, id: "passage-1", filename: "Opening position", group: ["Delivery", "Deadlines"] },
            { ...doc, id: "passage-2", filename: "Later amendment", group: ["Delivery", "Deadlines"] },
            { ...doc, id: "passage-3", filename: "Payment terms", group: ["Payment"] },
        ] });
        expect(screen.getAllByText("Delivery / Deadlines")).toHaveLength(1);
        expect(screen.getByText("Payment")).toBeVisible();
        expect(screen.getByLabelText("Select Opening position")).toBeVisible();
        expect(screen.getByLabelText("Select Later amendment")).toBeVisible();
    });

    it("blocks a column rerun while the review is running", () => {
        renderTable({ columns: [{ index: 0, name: "Parties", prompt: "" }], running: true, onRerunColumn: vi.fn() });
        fireEvent.click(screen.getByRole("button", { name: "Parties actions" }));
        expect(screen.getByRole("menuitem", { name: "Rerun column" })).toBeDisabled();
        expect(screen.getByRole("menuitem", { name: "Edit" })).toBeEnabled();
    });


});
