import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { Pagination, TableSelectionCheckbox, useTableSelection } from "./TablePrimitive";

it("selects all visible rows from a mixed selection", () => {
    function Harness() {
        const [selectedIds, setSelectedIds] = useState(["first"]);
        const selection = useTableSelection(
            [{ id: "first" }, { id: "second" }], selectedIds, setSelectedIds);
        return <>
            <TableSelectionCheckbox aria-label="Select all rows"
                checked={selection.allSelected}
                indeterminate={selection.someSelected}
                onChange={selection.toggleAll} />
            <output>{selectedIds.join(",")}</output>
        </>;
    }
    render(<Harness />);

    const selectAll = screen.getByRole("checkbox", { name: "Select all rows" });
    expect(selectAll).toBePartiallyChecked();
    fireEvent.click(selectAll);
    expect(selectAll).toBeChecked();
    expect(screen.getByText("first,second")).toBeInTheDocument();
    fireEvent.click(selectAll);
    expect(selectAll).not.toBeChecked();
});

it("selects a contiguous range from the last row anchor", () => {
    function Harness() {
        const [selectedIds, setSelectedIds] = useState<string[]>([]);
        const selection = useTableSelection(
            ["a", "b", "c", "d"].map((id) => ({ id })),
            selectedIds,
            setSelectedIds,
        );
        return <>
            <button onClick={() => selection.select("b")}>B</button>
            <button onClick={() => selection.select("d", true)}>Shift D</button>
            <output>{selectedIds.join(",")}</output>
        </>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    fireEvent.click(screen.getByRole("button", { name: "Shift D" }));
    expect(screen.getByText("b,c,d")).toBeInTheDocument();
});

it("moves through shared pagination without leaving its bounds", () => {
    const onPage = vi.fn();
    render(<Pagination page={2} pages={3} label="17 drafts" onPage={onPage} />);
    expect(screen.getByRole("navigation", { name: "17 drafts pages" })).toBeVisible();
    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    expect(screen.queryByText("17 drafts")).not.toBeInTheDocument();
    for (const name of ["Previous", "Next"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(onPage.mock.calls).toEqual([[1], [3]]);
});
