import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { horizontalDrag } from "./horizontal-drag";

function Resizer() {
    const [width, setWidth] = useState(300);
    return (
        <div
            data-testid="handle"
            data-width={width}
            onPointerDown={horizontalDrag((delta) =>
                setWidth((current) => current + delta),
            )}
        />
    );
}

describe("horizontalDrag", () => {
    it("reports incremental movement until pointer release", () => {
        render(<Resizer />);
        const handle = screen.getByTestId("handle");

        fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
        fireEvent.pointerMove(handle, { pointerId: 1, clientX: 125 });
        fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120 });
        fireEvent.pointerUp(handle, { pointerId: 1, clientX: 120 });
        fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140 });

        expect(handle).toHaveAttribute("data-width", "320");
    });
});
