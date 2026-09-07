import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { ChatSearchResult } from "./ChatSearchResult";

it("renders readable highlighted context and a message link without nested links or actions", () => {
    const onNavigate = vi.fn();
    const chat = { id: "chat", title: "Lease matter", user_id: "owner", project_id: null,
        tabular_review_id: "review", created_at: "2026-09-05T12:00:00Z",
        search_hit: { message_id: "message", snippet: "Review **lease** terms in [the agreement](https://example.test). <img src=x onerror=alert(1)>" } };
    const view = render(<MemoryRouter><ChatSearchResult chat={chat} query="lease terms" onNavigate={onNavigate} /></MemoryRouter>);
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("Review lease terms in the agreement.");
    expect(link.querySelector("time")).toHaveAttribute("dateTime", chat.created_at);
    const url = new URL(link.getAttribute("href")!, "https://beaver.test");
    expect(url.pathname).toBe("/tabular-reviews/review");
    expect(url.searchParams.get("message")).toBe("message");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledOnce();
    view.rerender(<MemoryRouter><ChatSearchResult chat={chat} query="lease terms" compact /></MemoryRouter>);
    expect(screen.getByRole("link").querySelector("time")).toBeNull();
});
