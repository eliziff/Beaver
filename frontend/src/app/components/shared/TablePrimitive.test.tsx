import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { TableSelectionCheckbox, useTableSelection } from "./TablePrimitive";

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
    const { result } = renderHook(() => {
        const [selectedIds, setSelectedIds] = useState<string[]>([]);
        const selection = useTableSelection(
            ["a", "b", "c", "d"].map((id) => ({ id })), selectedIds, setSelectedIds);
        return { selectedIds, ...selection };
    });
    act(() => result.current.select("b"));
    act(() => result.current.select("d", true));
    expect(result.current.selectedIds).toEqual(["b", "c", "d"]);
});
