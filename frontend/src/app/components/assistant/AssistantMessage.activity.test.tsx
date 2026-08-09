import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AssistantMessage } from "./AssistantMessage";

describe("AssistantMessage activity", () => {
    it("collapses running readers and keeps completed findings in a panel pill", async () => {
        const onSubagentClick = vi.fn();
        const onSubagentSourceClick = vi.fn();
        const running = ["one", "two", "three"].map((id) => ({
            type: "subagent_run" as const,
            id,
            agent: "scout" as const,
            task: `Distinct Canadian lane ${id}`,
            model: "GPT-5.6 Luna",
            effort: "high",
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

        await userEvent.click(screen.getByRole("button", { name: /Activity/ }));
        expect(screen.getAllByText("Waiting for 2 reading agents...")).toHaveLength(1);
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

    it("translates a document revision without exposing the tool name", async () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "tool_call_start",
                        name: "library_revise_docx",
                        isStreaming: true,
                    },
                ]}
                isStreaming
            />,
        );

        const disclosure = screen.getByRole("button", {
            name: "Activity — Editing document",
        });
        await userEvent.click(disclosure);
        screen.getByText("Editing document...");
        expect(document.body).not.toHaveTextContent("library_revise_docx");
    });

    it("shows a single compact thinking row before the first event", () => {
        render(<AssistantMessage events={[]} isStreaming />);

        expect(
            screen.getAllByRole("status", { name: "Activity — Thinking" }),
        ).toHaveLength(1);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("does not expose grounded-answer internals", async () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "reasoning",
                        text: "Submitting conclusion with ID 3.",
                    },
                    {
                        type: "tool_call_start",
                        name: "submit_grounded_answer",
                        isStreaming: false,
                    },
                ]}
            />,
        );

        const disclosure = screen.getByRole("button", {
            name: "Activity — Finalizing answer",
        });
        await userEvent.click(disclosure);
        expect(document.body).not.toHaveTextContent("ID 3");
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
            "The provider rejected the request.",
        );
    });

});
