import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ColumnConfig, TabularCell as TCell } from "@/app/lib/api/tabular";
import { TabularCell } from "./TabularCell";

const column = (format: ColumnConfig["format"]): ColumnConfig => ({ index: 0, name: "Amount", prompt: "Find it", format });
const done = (content: NonNullable<TCell["content"]>): TCell => ({ id: "cell", document_id: "doc", column_index: 0, status: "done", content });
const renderCell = (cell: TCell, col: ColumnConfig) =>
    render(<TabularCell cell={cell} column={col} onExpand={vi.fn()} onCitationClick={vi.fn()} />);

it("shows a dash for not found, a glyph for failure and nothing while pending", () => {
    const { rerender } = renderCell(done({ summary: "", claims: [], evidence: [], outcome: "not_found", coverage: "complete" }), column("text"));
    expect(screen.getByLabelText("Not found")).toHaveTextContent("—");
    rerender(<TabularCell cell={{ id: "cell", document_id: "doc", column_index: 0, status: "error", content: null }}
        column={column("text")} onExpand={vi.fn()} onCitationClick={vi.fn()} />);
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(screen.queryByText(/failed|pending|running/iu)).not.toBeInTheDocument();
    rerender(<TabularCell cell={{ id: "cell", document_id: "doc", column_index: 0, status: "pending", content: null }}
        column={column("text")} onExpand={vi.fn()} onCitationClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Open Amount result" })).toHaveTextContent("");
});

it("marks the answer with the shared flag", () => {
    renderCell(done({ summary: "Yes", value: true, flag: "green", claims: [], evidence: [], outcome: "answered", coverage: "complete" }), column("yes_no"));
    expect(screen.getByRole("img", { name: "Supported" })).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
});

it("reveals bare reference counts in the app", () => {
    const evidence = [1, 2, 3].map((id) => ({ evidence_id: String(id), provider: "a2aj", stable_source_id: "case",
        name: "Example case", citation: "Example case", span_text: `Passage ${id}`,
        external_url: "https://example.com/case", locator: { kind: "paragraph", label: String(id) } }));
    const cell = done({ summary: "Supported result", claims: [{ text: "Supported result", evidence_ids: ["1", "2", "3"] }],
        evidence } as NonNullable<TCell["content"]>), reveal = vi.fn();
    render(<TabularCell cell={cell} column={column("text")} onExpand={vi.fn()} onCitationClick={reveal} />);
    fireEvent.click(screen.getByRole("button", { name: "Show references for Amount" }));
    expect(screen.queryByRole("link", { name: "3" })).not.toBeInTheDocument();
    expect(reveal).toHaveBeenCalledWith(cell, expect.objectContaining({ ref: 1 }));
});
