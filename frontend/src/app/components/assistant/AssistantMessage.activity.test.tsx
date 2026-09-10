import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ComponentProps } from "react";
import {
    assistantSessionReducer,
    createAssistantSessionState,
    type AssistantMessageState,
} from "@/app/lib/assistantSession";
import { AssistantMessage } from "./AssistantMessage";
import * as downloads from "@/app/lib/download";

function renderEvents(events: unknown[], props: Omit<ComponentProps<typeof AssistantMessage>, "message"> = {}) {
    const state = assistantSessionReducer(createAssistantSessionState(), {
        type: "transcript_loaded", active: true,
        messages: [{ id: "assistant-test", role: "assistant", content: events }],
    });
    return render(<AssistantMessage {...props} message={state.messages[0] as AssistantMessageState} />);
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
    it("downloads the artifact's exact version and uses the resolved version after an edit", async () => {
        const downloaded = vi.spyOn(downloads, "downloadBlob").mockImplementation(() => {});
        const requests: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            requests.push(url);
            return url.endsWith("/edits/accept")
                ? Response.json({ status: "accepted", version_id: "version/3",
                    download_url: "/api/single-documents/doc-1/file?version_id=version%2F3" })
                : new Response("document bytes");
        }));
        try {
            renderEvents([{ ...editEvent("manual"),
                download_url: "/api/single-documents/doc-1/file?version_id=version-2" }]);
            await userEvent.click(screen.getByRole("button", { name: "Download Draft.docx" }));
            await userEvent.click(screen.getByRole("button", { name: "Accept" }));
            await userEvent.click(screen.getByRole("button", { name: "Download Draft.docx" }));

            expect(requests).toEqual([
                "/api/single-documents/doc-1/file?version_id=version-2",
                "/api/single-documents/doc-1/edits/accept",
                "/api/single-documents/doc-1/file?version_id=version%2F3",
            ]);
            expect(downloaded).toHaveBeenCalledTimes(2);
            expect(downloaded.mock.calls[1][1]).toBe("Draft.docx");
        } finally {
            downloaded.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    it("keeps every tracked change emitted for one document version", () => {
        renderEvents([
            editEvent("manual"),
            editEvent("manual", "edit-2"),
        ]);

        expect(screen.getByText("2 tracked changes")).toBeVisible();
        expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(2);
    });

    it("shows a completed Manual Mode edit while the turn continues", () => {
        renderEvents([editEvent("manual")], { isStreaming: true });

        expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
        expect(screen.getByText("five")).toHaveClass("line-through");
        expect(screen.getByText("three")).not.toHaveClass("line-through");
        expect(screen.getByText("The term is")).toBeVisible();
        expect(screen.getByText("years from closing.")).toBeVisible();
    });

    it("shows a rejected edit as the retained original", () => {
        renderEvents([editEvent("manual")], { resolvedEditStatuses: { "edit-1": "rejected" } });

        expect(screen.getByText("Kept original")).toBeVisible();
        expect(screen.getByText("five")).not.toHaveClass("line-through");
        expect(screen.getByText("three")).toHaveClass("line-through");
        expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    });

    it("renders the Auto Mode audit from the canonical minimal diff", () => {
        renderEvents([editEvent("auto")]);

        expect(screen.getByText("Applied in Auto Mode")).toBeVisible();
        expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
        expect(screen.getByText("five")).toHaveClass("line-through");
        expect(screen.getByText("three")).not.toHaveClass("line-through");
    });

    it("shows running readers and keeps completed findings in a panel pill", async () => {
        const onReaderClick = vi.fn();
        const running = ["one", "two", "three"].map((id) => ({
            type: "subagent_run" as const,
            id,
            task: `Distinct Canadian lane ${id}`,
            status: "running" as const,
        }));
        renderEvents([
            ...running,
            {
                ...running[0],
                status: "completed",
                output: "Finding [1].",
                citations: [
                    {
                        kind: "a2aj",
                        source_class: "case",
                        ref: 1,
                        citation: "2020 BCSC 1",
                        name: "R. v. Example",
                        dataset: "BCSC",
                        url: "https://example.test/case",
                        quotes: [{ quote: "Exact passage" }],
                    },
                ],
            },
        ], { isStreaming: true, onReaderClick });

        expect(screen.getByText("Waiting for reading agent: Distinct Canadian lane two...")).toBeVisible();
        expect(screen.getByText("Waiting for reading agent: Distinct Canadian lane three...")).toBeVisible();
        const completedReader = screen.getByRole("button", { name: "Reading agent completed: Distinct Canadian lane one" });
        expect(completedReader).toBeVisible();
        const citationPill = screen.getByRole("link", {
            name: "R. v. Example, 2020 BCSC 1",
        });
        expect(citationPill).toHaveAttribute("target", "_blank");
        expect(screen.queryByRole("button", { name: "Citation actions" })).toBeNull();

        await userEvent.click(completedReader);
        expect(onReaderClick).toHaveBeenCalledOnce();
        expect(onReaderClick).toHaveBeenCalledWith("one");
    });

    it("hides raw search results and shows read passages as canonical chips", () => {
        renderEvents([
            {
                type: "tool_activity", id: "search-1", tool: "search_sources",
                status: "completed", label: "Searching case law for “Example”",
                citations: [{
                    kind: "a2aj", source_class: "case", ref: 1,
                    citation: "2020 BCSC 1", name: "Example v. Example",
                    dataset: "BCSC", url: null, quotes: [],
                }],
            },
            {
                type: "tool_activity", id: "read-2", tool: "Read",
                status: "completed", label: "Reading pages 60–63 of the article",
                citations: [{
                    kind: "public_legal", provider: "journal", ref: 1,
                    identifier: "article-1", source_class: "commentary",
                    authority: "Gordon F. Henderson, “Problems Involved in the Assignment of Patents and Patent Rights” (1966) 1:1 Ottawa L Rev 36",
                    locator_kind: "page", locator: "60–63",
                    locator_separator: " at ", pinpoint: "60–63", quotes: [],
                }],
            },
        ]);

        expect(screen.queryByText("Example v. Example")).not.toBeInTheDocument();
        expect(screen.getByText("Searching case law for “Example”")).toBeVisible();
        expect(screen.getByText(/Gordon F\. Henderson/u)).toHaveTextContent(
            "Gordon F. Henderson, “Problems Involved in the Assignment of Patents and Patent Rights” (1966) 1:1 Ottawa L Rev 36",
        );
        expect(screen.getAllByText(/Gordon F\. Henderson/u)).toHaveLength(1);
    });

    it("keeps reasoning and deterministic tool activity visible in order", () => {
        renderEvents([
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
        ], { isStreaming: true });

        const rows = screen.getAllByRole("listitem");
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveTextContent("I should probably inspect something.");
        expect(rows[1]).toHaveTextContent("Reading document...");
    });

    it("renders steering between assistant response segments", () => {
        renderEvents([
            { type: "content", text: "Initial answer." },
            {
                type: "steering",
                id: "22222222-2222-4222-8222-222222222222",
                text: "Focus on remedies",
            },
            { type: "content", text: "Revised answer." },
        ]);

        const steering = screen.getByLabelText("Steering message");
        expect(steering).toHaveTextContent("Focus on remedies");
        expect(steering.previousElementSibling).toHaveTextContent("Initial answer.");
        expect(steering.nextElementSibling).toHaveTextContent("Revised answer.");
    });

    it("shows reasoning history without exposing raw tool names", async () => {
        renderEvents([
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
        ]);

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
        renderEvents([{ type: "content", text: "Answer text." }]);

        await userEvent.click(
            screen.getByRole("button", { name: "Copy response" }),
        );
        expect(write).toHaveBeenCalledOnce();
        expect(
            screen.getByRole("button", { name: "Response copied" }),
        ).toBeInTheDocument();
    });

    it("announces response errors", () => {
        renderEvents([{ type: "error", message: "The provider rejected the request." }]);
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Unable to get a response. Try again.",
        );
    });

});
