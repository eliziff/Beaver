import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AssistantEvent } from "../shared/types";
import { AskInputPopup } from "./AskInputPopup";

vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));

it("keeps questions compact, stable, and easy to tap", () => {
    const event: Extract<AssistantEvent, { type: "ask_inputs" }> = {
        type: "ask_inputs",
        items: [
            {
                id: "audience",
                kind: "choice",
                question: "Who is this for?",
                options: [{ value: "A client" }, { value: "The court" }],
                allow_other: true,
                other_label: "Someone else",
            },
        ],
    };

    const { container } = render(
        <AskInputPopup event={event} onSubmit={vi.fn()} />,
    );

    expect(container.querySelector("[data-shortcut-layer]")).toHaveClass(
        "max-w-2xl",
    );
    expect(container.querySelector("[data-ask-input-body]")).toHaveClass(
        "h-72",
    );
    expect(screen.getByRole("button", { name: /A client/ })).toHaveClass(
        "min-h-11",
    );
});
