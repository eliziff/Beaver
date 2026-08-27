import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ComponentProps } from "react";
import {
    assistantSessionReducer,
    createAssistantSessionState,
    type AssistantMessageState,
} from "@/app/lib/assistantSession";
import { AssistantMessage as CanonicalAssistantMessage } from "./AssistantMessage";

function canonicalMessage(events: unknown[], error?: string) {
    const state = assistantSessionReducer(createAssistantSessionState(), {
        type: "transcript_loaded",
        active: true,
        messages: [{
            id: "assistant-test",
            role: "assistant",
            content: [...events, ...(error ? [{ type: "error", message: error }] : [])],
        }],
    });
    return state.messages[0] as AssistantMessageState;
}

function AssistantMessage({
    events = [],
    isError,
    errorMessage,
    onSubagentClick,
    ...props
}: Omit<ComponentProps<typeof CanonicalAssistantMessage>, "message" | "onReaderClick"> & {
    events?: unknown[];
    isError?: boolean;
    errorMessage?: string;
    onSubagentClick?: (readerId: string) => void;
}) {
    return <CanonicalAssistantMessage
        {...props}
        message={canonicalMessage(events, isError ? errorMessage : undefined)}
        onReaderClick={onSubagentClick}
    />;
}

const editEvent = (
    edit_mode: "manual" | "auto",
    editId = "edit-1",
): Record<string, unknown> => ({
    type: "document_artifact",
    action: "edited",
    filename: "Draft.docx",
    document_id: "doc-1",
    version_id: "version-2",
    version_number: 2,
    download_url: "/draft.docx",
    edit_mode,
    annotations: [{
        edit_id: editId,
        document_id: "doc-1",
        version_id: "version-2",
        deleted_text: "five",
        inserted_text: "three",
        context_before: "The term is ",
        context_after: " years from closing.",
        diff: [
            { kind: "delete", text: "five" },
            { kind: "insert", text: "three" },
        ],
        status: edit_mode === "auto" ? "accepted" : "pending",
    }],
});

describe("AssistantMessage activity", () => {
    it("keeps every tracked change emitted for one document version", () => {
        render(
            <AssistantMessage
                events={[
                    editEvent("manual"),
                    editEvent("manual", "edit-2"),
                ]}
            />,
        );

        expect(screen.getByText("2 tracked changes")).toBeVisible();
        expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(2);
    });

    it("shows a completed Manual Mode edit while the turn continues", () => {
        render(
            <AssistantMessage
                isStreaming
                events={[editEvent("manual")]}
            />,
        );

        expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
        expect(screen.getByText("five")).toHaveClass("line-through");
        expect(screen.getByText("three")).not.toHaveClass("line-through");
        expect(screen.getByText("The term is")).toBeVisible();
        expect(screen.getByText("years from closing.")).toBeVisible();
    });

    it("shows a rejected edit as the retained original", () => {
        render(
            <AssistantMessage
                events={[editEvent("manual")]}
                resolvedEditStatuses={{ "edit-1": "rejected" }}
            />,
        );

        expect(screen.getByText("Kept original")).toBeVisible();
        expect(screen.getByText("five")).not.toHaveClass("line-through");
        expect(screen.getByText("three")).toHaveClass("line-through");
        expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    });

    it("renders the Auto Mode audit from the canonical minimal diff", () => {
        render(<AssistantMessage events={[editEvent("auto")]} />);

        expect(screen.getByText("Applied in Auto Mode")).toBeVisible();
        expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
        expect(screen.getByText("five")).toHaveClass("line-through");
        expect(screen.getByText("three")).not.toHaveClass("line-through");
    });

    it("shows running readers and keeps completed findings in a panel pill", async () => {
        const onSubagentClick = vi.fn();
        const onSubagentSourceClick = vi.fn();
        const running = ["one", "two", "three"].map((id) => ({
            type: "subagent_run" as const,
            id,
            task: `Distinct Canadian lane ${id}`,
            status: "running" as const,
        }));
        render(
            <AssistantMessage
                events={[
                    ...running,
                    {
                        ...running[0],
                        status: "completed",
                        output:
                            "Finding [R. v. Example, 2020 BCSC 1](https://example.test/case).",
                        sources: [
                            {
                                provider: "a2aj",
                                jurisdiction: "CA",
                                citation: "2020 BCSC 1",
                                name: "R. v. Example",
                                dataset: "BCSC",
                                url: "https://example.test/case",
                            },
                        ],
                    },
                ]}
                isStreaming
                onSubagentClick={onSubagentClick}
                onSubagentSourceClick={onSubagentSourceClick}
            />,
        );

        expect(screen.getByText("Waiting for reading agent: Distinct Canadian lane two...")).toBeVisible();
        expect(screen.getByText("Waiting for reading agent: Distinct Canadian lane three...")).toBeVisible();
        expect(
            screen.getByRole("button", {
                name: "Reading agent completed: Distinct Canadian lane one",
            }),
        ).toBeInTheDocument();
        const citationPill = screen.getByRole("button", {
            name: "R. v. Example, 2020 BCSC 1",
        });
        await userEvent.click(citationPill);
        expect(onSubagentSourceClick).toHaveBeenCalledOnce();

        await userEvent.click(
            screen.getByRole("button", {
                name: "Reading agent completed: Distinct Canadian lane one",
            }),
        );
        expect(onSubagentClick).toHaveBeenCalledOnce();
    });

    it("labels a document revision as editing", async () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "tool_activity",
                        id: "edit-1",
                        tool: "Edit",
                        status: "running",
                        label: "Editing document",
                    },
                ]}
                isStreaming
            />,
        );

        const disclosure = screen.getByRole("button", {
            name: "Activity — Editing document",
        });
        expect(disclosure).toBeInTheDocument();
        expect(screen.getByText("Editing document...")).toBeVisible();
    });

    it("shows a single compact thinking row before the first event", () => {
        render(<AssistantMessage events={[]} isStreaming />);

        expect(
            screen.getAllByRole("status", { name: "Activity — Thinking" }),
        ).toHaveLength(1);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("uses only the current reasoning step in the activity label", () => {
        let state = assistantSessionReducer(createAssistantSessionState({
            chatId: "chat-1",
        }), {
            type: "run_started",
            runId: "run-1",
            chatId: "chat-1",
            message: {
                id: "user-1",
                role: "user",
                content: "Research this",
            },
        });
        state = assistantSessionReducer(state, {
            type: "protocol",
            runId: "run-1",
            chatId: "chat-1",
            event: {
                type: "reasoning",
                text: "Planning targeted non-overlapping delegations\n\nAssigning authority identification tasks",
                append: false,
            },
        });

        render(
            <CanonicalAssistantMessage
                message={state.messages.findLast((message) =>
                    message.role === "assistant") as AssistantMessageState}
            />,
        );

        expect(
            screen.getByRole("button", {
                name: /Assigning authority identification tasks$/u,
            }),
        ).toBeVisible();
    });

    it("keeps reasoning and deterministic tool activity visible in order", () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "reasoning",
                        text: "I should probably inspect something.",
                    },
                    {
                        type: "tool_activity",
                        id: "read-1",
                        tool: "Read",
                        status: "running",
                        label: "Reading document",
                    },
                ]}
                isStreaming
            />,
        );

        const rows = screen.getAllByRole("listitem");
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveTextContent("I should probably inspect something.");
        expect(rows[1]).toHaveTextContent("Reading document...");
        expect(screen.getByText("Reading document...")).toBeVisible();
        expect(screen.getByText("I should probably inspect something.")).toBeVisible();
    });

    it("shows completed compaction as a quiet conversation receipt", () => {
        render(
            <AssistantMessage
                events={[{ type: "compaction", status: "completed" }]}
            />,
        );

        expect(screen.getByRole("status")).toHaveTextContent("Context compacted");
        expect(screen.queryByRole("button", { name: /Activity/u })).toBeNull();
    });

    it("renders steering between assistant response segments", () => {
        render(
            <AssistantMessage
                events={[
                    { type: "content", text: "Initial answer." },
                    {
                        type: "steering",
                        id: "22222222-2222-4222-8222-222222222222",
                        text: "Focus on remedies",
                    },
                    { type: "content", text: "Revised answer." },
                ]}
            />,
        );

        const steering = screen.getByLabelText("Steering message");
        expect(steering).toHaveTextContent("Focus on remedies");
        expect(steering.previousElementSibling).toHaveTextContent("Initial answer.");
        expect(steering.nextElementSibling).toHaveTextContent("Revised answer.");
    });

    it("shows reasoning history without exposing raw tool names", async () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "reasoning",
                        text: "Submitting conclusion with ID 3.",
                    },
                    {
                        type: "tool_activity",
                        id: "submit-1",
                        tool: "submit_grounded_answer",
                        status: "completed",
                        label: "Finalizing answer",
                    },
                ]}
            />,
        );

        const disclosure = screen.getByRole("button", {
            name: "Activity — Finalizing answer",
        });
        await userEvent.click(disclosure);
        expect(document.body).toHaveTextContent("Submitting conclusion with ID 3.");
        expect(document.body).not.toHaveTextContent("submit_grounded_answer");
    });

    it("announces a completed copy action", async () => {
        const write = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { write },
        });
        vi.stubGlobal(
            "ClipboardItem",
            class {
                constructor(_items: Record<string, Blob>) {}
            },
        );
        render(
            <AssistantMessage
                events={[{ type: "content", text: "Answer text." }]}
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Copy response" }),
        );
        expect(write).toHaveBeenCalledOnce();
        expect(
            screen.getByRole("button", { name: "Response copied" }),
        ).toBeInTheDocument();
    });

    it("announces response errors", () => {
        render(
            <AssistantMessage
                events={[]}
                isError
                errorMessage="The provider rejected the request."
            />,
        );
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Unable to get a response. Try again.",
        );
    });

});
