import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { AdvancedHistorySearch } from "./AdvancedHistorySearch";
import type { ChatSearchOptions } from "@/app/lib/api/chat";

const listChats = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/api/chat", () => ({ listChats }));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ chats: null, renameChat: vi.fn(), deleteChat: vi.fn() }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "owner" } }),
}));

const hit = { id: "chat-1", title: "Old matter", project_id: null, user_id: "owner",
    created_at: "2026-09-05T10:00:00Z",
    search_hit: { message_id: "message-42", snippet: "The Lease terms include renewal." } };

beforeEach(() => listChats.mockReset().mockResolvedValue([]));

it("finishes an empty search and ignores the previous query's late response", async () => {
    let finishPrevious!: (rows: typeof hit[]) => void;
    let previousSignal!: AbortSignal;
    listChats.mockImplementation((options: ChatSearchOptions = {}, signal: AbortSignal) => {
        if (options.search === "lease terms") {
            previousSignal = signal;
            return new Promise((resolve) => { finishPrevious = resolve; });
        }
        return Promise.resolve([]);
    });
    render(<MemoryRouter><Harness /></MemoryRouter>);
    expect(screen.getAllByText("Searching…").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "no such conversation" } });
    expect(await screen.findByText("0 results")).toBeVisible();
    expect(previousSignal.aborted).toBe(true);
    await act(async () => finishPrevious([hit]));
    expect(screen.getByText("0 results")).toBeVisible();
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.queryByRole("link", { name: /Old matter/ })).toBeNull();
});

function Harness() {
    const [open, setOpen] = useState(true);
    const location = useLocation();
    return <>{open && <AdvancedHistorySearch initialQuery="lease terms" initialContext="assistant"
        onClose={() => setOpen(false)} />}
        <output aria-label="Destination">{location.pathname}{location.search}</output></>;
}

it.each([null, "review-1"])("opens a transcript hit at its canonical message and closes search (review %s)", async (reviewId) => {
    listChats.mockResolvedValue([{ ...hit, tabular_review_id: reviewId }]);
    render(<MemoryRouter><Harness /></MemoryRouter>);
    const dialog = screen.getByRole("dialog", { name: "Advanced search" });
    const link = await within(dialog).findByRole("link", { name: /Old matter/ });
    expect(link.querySelector("mark")).toHaveTextContent("Lease terms");
    expect(link).toHaveTextContent("include renewal.");
    const url = new URL(link.getAttribute("href")!, "https://beaver.test");
    expect(url.pathname).toBe(reviewId ? `/tabular-reviews/${reviewId}` : "/assistant/chat/chat-1");
    expect(url.searchParams.get("message")).toBe("message-42");
    expect(url.searchParams.has("highlight")).toBe(false);
    expect(url.searchParams.get("chat")).toBe(reviewId ? "chat-1" : null);
    fireEvent.click(link);
    expect(screen.queryByRole("dialog", { name: "Advanced search" })).toBeNull();
    expect(screen.getByLabelText("Destination")).toHaveTextContent(`${url.pathname}${url.search}`);
});

it("applies transcript, context, activity-order and inclusive creation-date filters", async () => {
    const from = new Date("2026-09-01T00:00:00").toISOString();
    const afterThrough = new Date("2026-09-06T00:00:00").toISOString();
    listChats.mockImplementation(async (options: ChatSearchOptions = {}) =>
        options.search_scope === "transcripts" && options.search_context === "reviews" &&
        options.sort === "oldest" && options.created_from === from && options.created_to === afterThrough
            ? [{ ...hit, tabular_review_id: "review-1" }] : []);
    render(<MemoryRouter><Harness /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("Search in"), { target: { value: "transcripts" } });
    fireEvent.change(screen.getByLabelText("Conversations"), { target: { value: "reviews" } });
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "oldest" } });
    fireEvent.change(screen.getByLabelText("Created from"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Created through"), { target: { value: "2026-09-05" } });
    expect(await screen.findByRole("link", { name: /Old matter/ })).toBeVisible();
    await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
    listChats.mockClear();
    fireEvent.change(screen.getByLabelText("Created through"), { target: { value: "2026-08-31" } });
    expect(screen.getByRole("alert")).toBeVisible();
    expect(listChats).not.toHaveBeenCalled();
});
