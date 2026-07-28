import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { AssistantEvent } from "../shared/types";
import { AskInputPopup } from "./AskInputPopup";

vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));

it("collapses the question body", async () => {
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

    render(<AskInputPopup event={event} onSubmit={vi.fn()} />);

    screen.getByRole("button", { name: /A client/ });
    await userEvent.click(
        screen.getByRole("button", { name: "Question 1 of 1" }),
    );
    expect(
        screen.queryByRole("button", { name: /A client/ }),
    ).not.toBeInTheDocument();
});
