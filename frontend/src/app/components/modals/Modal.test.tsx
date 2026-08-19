import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { expect, it } from "vitest";
import { Modal } from "./Modal";

it("returns focus to the control that opened it", async () => {
    const user = userEvent.setup();
    function Example() {
        const [open, setOpen] = useState(false);
        return (
            <>
                <button type="button" onClick={() => setOpen(true)}>
                    Open settings
                </button>
                <Modal open={open} onClose={() => setOpen(false)}>
                    <input aria-label="Setting name" autoFocus />
                </Modal>
            </>
        );
    }

    render(
        <StrictMode>
            <Example />
        </StrictMode>,
    );
    const opener = screen.getByRole("button", { name: "Open settings" });
    await user.click(opener);
    expect(screen.getByRole("textbox", { name: "Setting name" })).toHaveFocus();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(opener).toHaveFocus());
});
