import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Modal } from "./Modal";

it("keeps modal actions fixed while the body scrolls", () => {
    const { getByRole } = render(
        <Modal
            open
            onClose={vi.fn()}
            breadcrumbs={["Test"]}
            cancelAction={{ label: "Cancel" }}
            primaryAction={{ label: "Done" }}
        >
            <div>Long content</div>
        </Modal>,
    );

    const dialog = getByRole("dialog");
    expect(dialog.querySelector(".modal-scroll-body")).toHaveClass(
        "overflow-y-auto",
    );
    expect(getByRole("button", { name: "Done" }).parentElement?.parentElement)
        .toHaveClass("shrink-0");
});
