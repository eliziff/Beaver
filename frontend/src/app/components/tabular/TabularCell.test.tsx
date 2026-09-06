import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ColumnConfig, TabularCell as TCell } from "@/app/lib/api/tabular";
import { TabularCell } from "./TabularCell";

const column = (format: ColumnConfig["format"]): ColumnConfig => ({ index: 0, name: "Amount", prompt: "Find it", format });
const done = (content: NonNullable<TCell["content"]>): TCell => ({ id: "cell", document_id: "doc", column_index: 0, status: "done", content });
const answered = (summary: string, value: string | number | boolean) =>
    done({ summary, value, claims: [{ text: summary, evidence_ids: [] }], evidence: [], outcome: "answered", coverage: "complete" });
const renderCell = (cell: TCell, col: ColumnConfig) =>
    render(<TabularCell cell={cell} column={col} onExpand={vi.fn()} onCitationClick={vi.fn()} />);

it("right-aligns numeric formats with tabular figures", () => {
    const { container } = renderCell(answered("1,250", 1250), column("number"));
    expect(container.firstElementChild).toHaveClass("text-right");
    expect(screen.getByText("1,250")).toHaveClass("tabular-nums");
});

it("normalises ISO dates", () => {
    renderCell(answered("2026-09-05", "2026-09-05"), column("date"));
    expect(screen.queryByText("2026-09-05")).not.toBeInTheDocument();
    expect(screen.getByText(/2026/u)).toHaveTextContent(/^(Sep|Sept)\.? 5, 2026$|^5 (Sep|Sept)\.? 2026$/u);
});

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

it("marks the answer with the shared flag dot", () => {
    renderCell(done({ summary: "Yes", value: true, flag: "green", claims: [], evidence: [], outcome: "answered", coverage: "complete" }), column("yes_no"));
    expect(screen.getByRole("img", { name: "Supported" })).toBeInTheDocument();
    expect(screen.getByText("Yes")).toHaveClass("rounded-full");
});
