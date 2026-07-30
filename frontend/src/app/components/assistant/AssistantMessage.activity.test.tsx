import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AssistantEvent } from "../shared/types";
import { AssistantMessage } from "./AssistantMessage";

describe("AssistantMessage activity", () => {
    it("keeps one stable disclosure for interleaved work events", async () => {
        const initialEvents: AssistantEvent[] = [
            {
                type: "reasoning",
                text: "Checked **lease terms**.",
            },
            { type: "content", text: "First answer paragraph." },
            {
                type: "doc_read",
                filename: "Lease.docx",
                isStreaming: true,
            },
        ];
        const { rerender } = render(
            <AssistantMessage events={initialEvents} isStreaming />,
        );

        const workingButton = screen.getByRole("button", {
            name: "Activity — Reading Lease.docx",
        });

        const completedEvents: AssistantEvent[] = [
            initialEvents[0],
            initialEvents[1],
            {
                type: "doc_read",
                filename: "Lease.docx",
                isStreaming: false,
            },
            { type: "content", text: "Second answer paragraph." },
            {
                type: "reasoning",
                text: "Compared:\n\n- renewal dates\n- notice periods",
            },
        ];
        rerender(<AssistantMessage events={completedEvents} />);

        const activityButton = screen.getByRole("button", {
            name: "Activity — Compared: renewal dates notice periods",
        });
        expect(activityButton).toBe(workingButton);
        expect(screen.queryByText(/Completed in \d+ steps?/)).toBeNull();
        const summary = activityButton.textContent;

        await userEvent.click(activityButton);
        expect(activityButton).toHaveAccessibleName(
            "Activity — Compared: renewal dates notice periods",
        );
        expect(activityButton.textContent).toBe(summary);

        const activityList = screen.getAllByRole("list")[0];
        expect(activityButton.nextElementSibling).toBe(activityList);
        const activityRows = Array.from(activityList.children).map((node) =>
            node.textContent?.replace(/\s+/g, " ").trim(),
        );
        expect(activityRows).toEqual([
            "Checked lease terms.",
            expect.stringMatching(/Read.*Lease\.docx/u),
            expect.stringMatching(/Compared:.*renewal dates.*notice periods/u),
        ]);
        expect(
            within(activityList).getByText("lease terms").tagName,
        ).toBe("STRONG");
        expect(activityList.textContent).not.toContain("**");
        expect(activityList.textContent).not.toContain("Analyzed request");
        expect(
            within(activityList).queryByRole("button", {
                name: /thought process/i,
            }),
        ).toBeNull();
    });

    it("keeps prior repeated steps while the expanded trail updates", async () => {
        const firstEvents: AssistantEvent[] = [
            {
                type: "tool_call_start",
                name: "a2aj_search",
                label: "Searching BCCA cases for “retroactive support”",
                isStreaming: false,
            },
            {
                type: "tool_call_start",
                name: "a2aj_search",
                label: "Searching SCC cases for “retroactive support”",
                isStreaming: true,
            },
        ];
        const { rerender } = render(
            <AssistantMessage events={firstEvents} isStreaming />,
        );

        const disclosure = screen.getByRole("button", {
            name: /Activity .* Searching SCC cases for “retroactive support”/u,
        });
        await userEvent.click(disclosure);

        const updatedEvents: AssistantEvent[] = [
            firstEvents[0],
            {
                ...firstEvents[1],
                isStreaming: false,
            },
            {
                type: "reasoning",
                text: "Checking the retrieved authorities.",
                isStreaming: true,
            },
        ];
        rerender(<AssistantMessage events={updatedEvents} isStreaming />);

        expect(disclosure.closest("details")).toHaveAttribute("open");
        expect(
            Array.from(screen.getByRole("list").children).map((node) =>
                node.textContent?.replace(/\s+/g, " ").trim(),
            ),
        ).toEqual([
            "Searching BCCA cases for “retroactive support”",
            "Searching SCC cases for “retroactive support”",
            "Checking the retrieved authorities.",
        ]);
    });

    it("drops generic legal-search narration but keeps the real search", async () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "reasoning",
                        text: "Searching Canadian cases",
                    },
                    {
                        type: "tool_call_start",
                        name: "a2aj_search",
                        label: "Searching BCCA cases for “retroactive support”",
                        isStreaming: false,
                    },
                    {
                        type: "reasoning",
                        text: "Checking the retrieved authorities.",
                    },
                ]}
            />,
        );

        const disclosure = screen.getByRole("button", {
            name: /Activity .* Checking the retrieved authorities/u,
        });
        await userEvent.click(disclosure);
        const activityList = screen.getAllByRole("list")[0];
        expect(activityList).toHaveTextContent(
            "Searching BCCA cases for “retroactive support”",
        );
        expect(activityList).not.toHaveTextContent(
            "Searching Canadian cases",
        );
    });

    it("describes local Word revisions without exposing the tool name", async () => {
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
        expect(disclosure).toHaveAccessibleName(
            "Activity — Editing document",
        );
        screen.getByText("Editing document...");
        expect(
            screen.queryByText(/library_revise_docx/),
        ).not.toBeInTheDocument();
    });

    it("deduplicates provisional activity and uses one integrated status row", async () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "reasoning",
                        text: "Analyzed request.",
                    },
                    { type: "thinking", isStreaming: true },
                    {
                        type: "tool_call_start",
                        name: "read_document",
                        isStreaming: true,
                    },
                    {
                        type: "doc_read",
                        filename: "Lease.docx",
                        isStreaming: true,
                    },
                    {
                        type: "doc_read",
                        filename: "Lease.docx",
                        isStreaming: false,
                    },
                    {
                        type: "reasoning",
                        text: "Checked **renewal dates**.",
                    },
                    {
                        type: "reasoning",
                        text: "Checked **renewal dates**.",
                    },
                ]}
                isStreaming
            />,
        );

        const disclosure = screen.getByRole("button", {
            name: "Activity — Checked renewal dates.",
        });
        expect(screen.queryByText("Working")).not.toBeInTheDocument();
        await userEvent.click(disclosure);

        const activityList = screen.getByRole("list");
        expect(
            Array.from(activityList.children).map((node) =>
                node.textContent?.replace(/\s+/g, " ").trim(),
            ),
        ).toEqual([
            expect.stringContaining("Lease.docx"),
            expect.stringContaining("renewal dates"),
        ]);
    });

    it("shows a single compact thinking row before the first event", () => {
        render(<AssistantMessage events={[]} isStreaming />);

        expect(
            screen.getAllByRole("status", { name: "Activity — Thinking" }),
        ).toHaveLength(1);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("names the copy action and exposes its completed state", async () => {
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
        ).toBeVisible();
    });

    it("announces response errors", () => {
        render(
            <AssistantMessage
                isError
                errorMessage="Unable to get a response. Try again."
            />,
        );

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Unable to get a response. Try again.",
        );
    });

    it("humanizes unknown tool IDs in collapsed and expanded activity", async () => {
        const { container } = render(
            <AssistantMessage
                events={[
                    {
                        type: "tool_call_start",
                        name: "codex_case_magic_lookup",
                        isStreaming: true,
                    },
                ]}
                isStreaming
            />,
        );

        const disclosure = screen.getByRole("button", {
            name: "Activity — Using case magic lookup",
        });
        await userEvent.click(disclosure);
        expect(screen.getByText("Using case magic lookup...")).toBeVisible();
        expect(container.textContent).not.toContain("_");
    });

    it("collapses one Authorities job into one dockable automation run", async () => {
        const onAutomationClick = vi.fn();
        const jobId = "a".repeat(32);
        render(
            <AssistantMessage
                events={[
                    {
                        type: "tool_call_start",
                        name: "toa_submit_library_document",
                        isStreaming: true,
                    },
                    {
                        type: "automation_run",
                        id: "submit",
                        tool: "toa_submit_library_document",
                        job_id: jobId,
                        stage: "Detect citations",
                        status: "running",
                        progress: 40,
                        version_id: "version-2",
                    },
                    {
                        type: "automation_run",
                        id: "status",
                        tool: "toa_job_status",
                        job_id: jobId,
                        stage: "Review",
                        status: "review",
                        progress: 100,
                        app_url: "/table-of-authorities?job=abc",
                    },
                ]}
                onAutomationClick={onAutomationClick}
            />,
        );

        expect(
            screen.getAllByRole("button", {
                name: /Create book\/table of authorities/u,
            }),
        ).toHaveLength(1);
        expect(screen.queryByText("Creating authorities...")).toBeNull();
        await userEvent.click(
            screen.getByRole("button", {
                name: /Create book\/table of authorities/u,
            }),
        );
        expect(onAutomationClick).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "status",
                status: "review",
                version_id: "version-2",
            }),
        );
    });
});
