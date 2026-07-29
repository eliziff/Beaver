import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { TableRow, TableScrollArea } from "./TablePrimitive";

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
