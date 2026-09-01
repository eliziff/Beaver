import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WarningPopup } from "./WarningPopup";

describe("WarningPopup", () => {
    it("uses the shared top-layer dialog and preserves actions", () => {
        const close = vi.fn(), retry = vi.fn();
        render(<WarningPopup open onClose={close} title="Response interrupted"
            message="Try again." primaryAction={{ label: "Retry", onClick: retry }} />);

        const dialog = screen.getByRole("alertdialog", { name: "Response interrupted" });
        expect(dialog.tagName).toBe("DIALOG");
        expect(dialog).toHaveAttribute("open");
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(retry).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });
});
