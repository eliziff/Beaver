import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { TableLoadMore, TableSelectionCheckbox, useTableSelection } from "./TablePrimitive";

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

it("shows pagination only while more rows are available", () => {
    let clicks = 0;
    const { rerender } = render(
        <TableLoadMore show={false} onClick={() => clicks++} />,
    );
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

    rerender(<TableLoadMore show onClick={() => clicks++} />);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(clicks).toBe(1);
});
