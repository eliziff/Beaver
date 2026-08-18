import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { TableLoadMore, TableRow, TableScrollArea, TableSelectionCheckbox,
    useTableSelection } from "./TablePrimitive";

it("forbids horizontal scrolling unless a spatial table opts in", () => {
    const { container, rerender } = render(
        <TableScrollArea>
            <TableRow>Row</TableRow>
        </TableScrollArea>,
    );

    const scrollArea = container.querySelector(".overflow-y-auto");
    expect(scrollArea).toHaveClass("overflow-x-hidden");
    expect(container.querySelector(".min-w-max")).not.toBeInTheDocument();

    rerender(
        <TableScrollArea horizontal>
            <TableRow>Row</TableRow>
        </TableScrollArea>,
    );
    expect(container.querySelector(".overflow-y-auto")).toHaveClass(
        "overflow-x-auto",
    );
});

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
