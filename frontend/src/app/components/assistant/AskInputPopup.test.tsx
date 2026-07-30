import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { AssistantEvent } from "../shared/types";
import { AskInputPopup } from "./AskInputPopup";

vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: ({
        open,
        onSelect,
    }: {
        open: boolean;
        onSelect: (docs: unknown[]) => void;
    }) =>
        open ? (
            <button
                onClick={() =>
                    onSelect([
                        {
                            id: "doc-1",
                            project_id: null,
                            filename: "brief.docx",
                            file_type: "docx",
                            storage_path: null,
                            pdf_storage_path: null,
                            size_bytes: 1,
                            page_count: 1,
                            structure_tree: null,
                            status: "ready",
                            created_at: null,
                        },
                    ])
                }
            >
                Choose brief
            </button>
        ) : null,
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

    screen.getByRole("radio", { name: "A client" });
    await userEvent.click(
        screen.getByRole("button", { name: "1 question" }),
    );
    expect(document.querySelector("[data-ask-input-panel]")).not.toHaveAttribute(
        "open",
    );
});

it("keeps a multi-question prompt in one fixed panel", async () => {
    const onSubmit = vi.fn();
    const event: Extract<AssistantEvent, { type: "ask_inputs" }> = {
        type: "ask_inputs",
        items: [
            {
                id: "one",
                kind: "choice",
                question: "First question",
                options: [{ value: "Yes" }],
                allow_other: false,
            },
            {
                id: "two",
                kind: "choice",
                question: "Second question",
                options: [{ value: "No" }],
                allow_other: false,
            },
        ],
    };

    render(<AskInputPopup event={event} onSubmit={onSubmit} />);
    expect(screen.getByText("First question")).toBeInTheDocument();
    expect(screen.getByText("Second question")).not.toBeVisible();
    expect(document.querySelector("[data-ask-input-panel]")).toHaveClass(
        "open:h-[min(28rem,70dvh)]",
    );
    expect(document.querySelector("[data-ask-input-options]")).toHaveClass(
        "min-h-0",
        "flex-1",
        "overflow-y-auto",
    );
    await userEvent.click(screen.getByRole("radio", { name: "Yes" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.getByText("Second question")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "No" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
            responses: [
                expect.objectContaining({ answer: "Yes" }),
                expect.objectContaining({ answer: "No" }),
            ],
        }),
        expect.any(String),
        [],
    );
});

it("keeps skipped questions navigable and submits them", async () => {
    const onSubmit = vi.fn();
    const event: Extract<AssistantEvent, { type: "ask_inputs" }> = {
        type: "ask_inputs",
        items: [
            {
                id: "one",
                kind: "choice",
                question: "First question",
                options: [{ value: "Yes" }],
                allow_other: false,
            },
            {
                id: "two",
                kind: "choice",
                question: "Second question",
                options: [{ value: "No" }],
                allow_other: false,
            },
        ],
    };

    render(<AskInputPopup event={event} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Decline to answer" }));
    await userEvent.click(
        screen.getByRole("button", { name: "Previous question" }),
    );
    expect(screen.getByRole("button", { name: "Answer instead" })).toBeInTheDocument();
    await userEvent.click(
        screen.getByRole("button", { name: "Next question" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Decline to answer" }));

    expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
            responses: [
                expect.objectContaining({ id: "one", skipped: true }),
                expect.objectContaining({ id: "two", skipped: true }),
            ],
        }),
        expect.any(String),
        [],
    );
});

it("keeps every choice reachable inside the fixed panel", () => {
    const options = Array.from({ length: 8 }, (_, index) => ({
        value: `Option ${index + 1}`,
    }));
    const event: Extract<AssistantEvent, { type: "ask_inputs" }> = {
        type: "ask_inputs",
        items: [
            {
                id: "many",
                kind: "choice",
                question: "Choose one",
                options,
                allow_other: true,
                other_label: "Something else",
            },
        ],
    };

    render(<AskInputPopup event={event} onSubmit={vi.fn()} />);

    const choices = document.querySelector("[data-ask-input-options]")!;
    for (const option of options) {
        expect(screen.getByText(option.value)).toBeInTheDocument();
    }
    expect(
        screen.getByRole("textbox", { name: "Something else" }),
    ).toBeInTheDocument();
    expect(choices).toHaveClass("overflow-y-auto");
    expect(choices).not.toContainElement(
        screen.getByRole("button", { name: "Confirm" }),
    );
});

it("submits a native Other answer", async () => {
    const onSubmit = vi.fn();
    const event: Extract<AssistantEvent, { type: "ask_inputs" }> = {
        type: "ask_inputs",
        items: [{
            id: "forum",
            kind: "choice",
            question: "Which forum?",
            options: [{ value: "Court" }],
            allow_other: true,
            other_label: "Another forum",
        }],
    };
    render(<AskInputPopup event={event} onSubmit={onSubmit} />);

    await userEvent.type(
        screen.getByRole("textbox", { name: "Another forum" }),
        "Tribunal",
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
            responses: [expect.objectContaining({ answer: "Tribunal" })],
        }),
        expect.stringContaining("Tribunal"),
        [],
    );
});

it("accepts a write-in answer even when the model omitted that option", async () => {
    const onSubmit = vi.fn();
    const question =
        "Which jurisdiction should govern this analysis, including any province, state, or federal jurisdiction that should be considered?".repeat(3);
    const event: Extract<AssistantEvent, { type: "ask_inputs" }> = {
        type: "ask_inputs",
        items: [{
            id: "jurisdiction",
            kind: "choice",
            question,
            options: [{ value: "Ontario" }],
            allow_other: false,
            other_label: "",
        }],
    };
    render(<AskInputPopup event={event} onSubmit={onSubmit} />);

    await userEvent.type(
        screen.getByRole("textbox", { name: "Write your own answer" }),
        "British Columbia",
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
            responses: [
                expect.objectContaining({ answer: "British Columbia" }),
            ],
        }),
        expect.stringContaining("British Columbia"),
        [],
    );
});

it("submits selected documents", async () => {
    const onSubmit = vi.fn();
    const event: Extract<AssistantEvent, { type: "ask_inputs" }> = {
        type: "ask_inputs",
        items: [{
            id: "source",
            kind: "documents",
            document_types: ["Source document"],
        }],
    };
    render(<AskInputPopup event={event} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: /Source document/ }));
    await userEvent.click(screen.getByRole("button", { name: "Choose brief" }));
    await userEvent.click(screen.getByRole("button", { name: "Choose brief" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
            responses: [
                expect.objectContaining({
                    filenames: ["brief.docx"],
                    documents: [
                        { document_id: "doc-1", filename: "brief.docx" },
                    ],
                }),
            ],
        }),
        expect.stringContaining("brief.docx"),
        [{ document_id: "doc-1", filename: "brief.docx" }],
    );
});
