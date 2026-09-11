import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ColumnConfig, TabularCell as TCell } from "@/app/lib/api/tabular";
import { TabularCell } from "./TabularCell";

const column = (format: ColumnConfig["format"]): ColumnConfig => ({ index: 0, name: "Amount", prompt: "Find it", format });
const done = (content: NonNullable<TCell["content"]>): TCell => ({ id: "cell", document_id: "doc", column_index: 0, status: "done", content });
const renderCell = (cell: TCell, col: ColumnConfig) =>
    render(<TabularCell cell={cell} column={col} onExpand={vi.fn()} />);

it("shows a dash for not found, a glyph for failure and nothing while pending", () => {
    const { rerender } = renderCell(done({ summary: "", claims: [], evidence: [], outcome: "not_found", coverage: "complete" }), column("text"));
    expect(screen.getByLabelText("Not found")).toHaveTextContent("—");
    rerender(<TabularCell cell={{ id: "cell", document_id: "doc", column_index: 0, status: "error", content: null }}
        column={column("text")} onExpand={vi.fn()} />);
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(screen.queryByText(/failed|pending|running/iu)).not.toBeInTheDocument();
    rerender(<TabularCell cell={{ id: "cell", document_id: "doc", column_index: 0, status: "pending", content: null }}
        column={column("text")} onExpand={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Open Amount result" })).toHaveTextContent("");
});
