import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { expect, it } from "vitest";
import { Modal } from "./Modal";

it("keeps the dialog open after a drag from its textarea to the backdrop", async () => {
    const user = userEvent.setup();
    function Example() {
        const [open, setOpen] = useState(true);
        return <Modal open={open} onClose={() => setOpen(false)}>
            <textarea aria-label="Instructions" defaultValue="Keep these instructions" />
        </Modal>;
    }
    render(<Example />);
    const dialog = screen.getByRole("dialog");
    const instructions = screen.getByRole("textbox", { name: "Instructions" });
    await user.pointer([
        { keys: "[MouseLeft>]", target: instructions },
        { keys: "[/MouseLeft]", target: dialog },
    ]);
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(instructions).toHaveValue("Keep these instructions");
    await user.click(dialog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

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
