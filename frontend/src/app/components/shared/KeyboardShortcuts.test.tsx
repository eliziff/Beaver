import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "@/app/components/modals/Modal";
import { KeyboardShortcuts } from "./KeyboardShortcuts";

beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
        length: 1,
    } as DOMRectList);
});

afterEach(() => vi.restoreAllMocks());

describe("KeyboardShortcuts", () => {
    it("focuses search, runs New, shows help, and ignores typing", async () => {
        const user = userEvent.setup();
        const onNew = vi.fn();
        render(
            <>
                <KeyboardShortcuts />
                <button type="button">Idle</button>
                <input data-page-search aria-label="Page search" />
                <button type="button" data-page-new disabled>
                    Disabled new
                </button>
                <button type="button" data-page-new onClick={onNew}>
                    New item
                </button>
            </>,
        );

        await user.click(screen.getByRole("button", { name: "Idle" }));
        await user.keyboard("/");
        expect(screen.getByRole("textbox", { name: "Page search" })).toHaveFocus();

        await user.keyboard("?");
        await user.keyboard("{Alt>}n{/Alt}");
        expect(onNew).not.toHaveBeenCalled();
        expect(
            screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
        ).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Idle" }));
        await user.keyboard("{Alt>}n{/Alt}");
        expect(onNew).toHaveBeenCalledOnce();

        fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
        expect(screen.getByRole("button", { name: "Idle" })).toHaveFocus();

        await user.keyboard("?");
        expect(
            screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
        ).toBeVisible();
        await user.keyboard("{Escape}");
        expect(
            screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
        ).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Idle" })).toHaveFocus();
    });

    it("closes only the topmost modal and restores nested focus", async () => {
        const user = userEvent.setup();
        render(<ModalStack />);

        const opener = screen.getByRole("button", { name: "Open first" });
        await user.click(opener);
        const secondOpener = screen.getByRole("button", {
            name: "Open second",
        });
        await user.click(secondOpener);

        screen.getByRole("textbox", { name: "Second value" }).focus();
        fireEvent.keyDown(document, { key: "Escape" });

        expect(
            screen.queryByRole("dialog", { name: "Second" }),
        ).not.toBeInTheDocument();
        expect(screen.getByRole("dialog", { name: "First" })).toBeVisible();
        await waitFor(() => expect(secondOpener).toHaveFocus());

        await user.keyboard("{Escape}");
        expect(
            screen.queryByRole("dialog", { name: "First" }),
        ).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });
});

function ModalStack() {
    const [firstOpen, setFirstOpen] = useState(false);
    const [secondOpen, setSecondOpen] = useState(false);

    return (
        <>
            <KeyboardShortcuts />
            <button type="button" onClick={() => setFirstOpen(true)}>
                Open first
            </button>
            <Modal
                open={firstOpen}
                onClose={() => setFirstOpen(false)}
                breadcrumbs={["First"]}
            >
                <button type="button" onClick={() => setSecondOpen(true)}>
                    Open second
                </button>
            </Modal>
            <Modal
                open={secondOpen}
                onClose={() => setSecondOpen(false)}
                breadcrumbs={["Second"]}
                keepMounted
            >
                <input aria-label="Second value" />
            </Modal>
        </>
    );
}
