import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { AskInputsEvent as AssistantEvent } from "@/app/lib/api/chat";
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
                            pdf_storage_path: null,
                            size_bytes: 1,
                            page_count: 1,
                            created_at: null,
                        },
                    ])
                }
            >
                Choose brief
            </button>
        ) : null,
}));

const questions = (): Extract<AssistantEvent, { type: "ask_inputs" }>["items"] => [
    { id: "one", kind: "choice", question: "First question", options: [{ value: "Yes" }] },
    { id: "two", kind: "choice", question: "Second question", options: [{ value: "No" }] },
];

it("submits multiple answers together", async () => {
    const onSubmit = vi.fn();
    const event: Extract<AssistantEvent, { type: "ask_inputs" }> = {
        type: "ask_inputs",
        items: questions(),
    };

    render(<AskInputPopup event={event} onSubmit={onSubmit} />);
    expect(screen.getByText("First question")).toBeInTheDocument();
    expect(screen.getByText("Second question")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Yes" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
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

it("submits declined questions", async () => {
    const onSubmit = vi.fn();
    const event: Extract<AssistantEvent, { type: "ask_inputs" }> = {
        type: "ask_inputs",
        items: questions(),
    };

    render(<AskInputPopup event={event} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Decline to answer" }));
    await userEvent.click(screen.getByRole("button", { name: "Decline to answer" }));

    expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
            responses: [
                { id: "one", kind: "choice" },
                { id: "two", kind: "choice" },
            ],
        }),
        expect.any(String),
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
