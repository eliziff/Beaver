import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantDock } from "./AssistantDock";

afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(document, "fullscreenElement"); Reflect.deleteProperty(document, "exitFullscreen"); });

function capRenderedWidth(dock: HTMLElement, max: number) {
    vi.spyOn(dock, "getBoundingClientRect").mockImplementation(() => ({
        width: Math.min(Number.parseFloat(dock.style.getPropertyValue("--assistant-dock-width")), max),
    }) as DOMRect);
}

function dockView(props: Partial<ComponentProps<typeof AssistantDock>> = {}) {
    return <AssistantDock tabs={[{ id: "sources", label: "Sources", content: <p>Source</p> }]}
        activeTabId="sources" onActivateTab={vi.fn()} expanded onExpandedChange={vi.fn()} {...props} />;
}

it("resizes the dock from the keyboard", () => {
    render(dockView());

    const dock = screen.getByRole("complementary", { name: "Assistant dock" });
    capRenderedWidth(dock, 500);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
    expect(dock.style.getPropertyValue("--assistant-dock-width")).toBe("500px");
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(dock.style.getPropertyValue("--assistant-dock-width")).toBe("476px");
    expect(screen.getByText("Source")).toBeVisible();
});

it("resizes against the rendered CSS maximum without rerendering each move", () => {
    render(dockView({ maxWidth: "calc(100% - 36rem)" }));
    const dock = screen.getByRole("complementary", { name: "Assistant dock" });
    const separator = screen.getByRole("separator");
    capRenderedWidth(dock, 480);

    fireEvent.pointerDown(separator, { clientX: 600 });
    fireEvent.pointerMove(window, { clientX: 250 });
    expect(dock.style.getPropertyValue("--assistant-dock-width")).toBe("480px");
    fireEvent.pointerMove(window, { clientX: 648 });
    expect(dock.style.getPropertyValue("--assistant-dock-width")).toBe("432px");
    fireEvent.pointerUp(window);
    expect(dock.style.getPropertyValue("--assistant-dock-width")).toBe("432px");
});

it("collapses without discarding its mounted content", () => {
    const onExpandedChange = vi.fn();
    const props = {
        tabs: [
            { id: "sources", label: "Sources", content:
                <input aria-label="Draft message" defaultValue="still here" /> },
            { id: "library", label: "Library", content: <p>Unopened library</p> },
        ],
        activeTabId: "sources",
        onExpandedChange,
    };
    const { rerender } = render(dockView(props));

    fireEvent.change(screen.getByRole("textbox", { name: "Draft message" }), {
        target: { value: "edited" },
    });
    expect(screen.queryByText("Unopened library")).not.toBeInTheDocument();
    rerender(dockView({ ...props, expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: "Expand assistant dock" }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    rerender(dockView(props));
    expect(screen.getByRole("textbox", { name: "Draft message" })).toHaveValue("edited");
});

it("keeps the sibling workspace interactive when opened at narrow widths", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const onExpandedChange = vi.fn();
    function Layout({ expanded }: { expanded: boolean }) {
        return <div><input aria-label="Chat draft" autoFocus defaultValue="Draft" />
            {dockView({ tabs: [{ id: "sources", label: "Sources", content: <button>Search</button> }],
                expanded, onExpandedChange })}</div>;
    }
    const { rerender } = render(<Layout expanded={false} />);
    const draft = screen.getByRole("textbox", { name: "Chat draft" });
    rerender(<Layout expanded />);
    expect(draft).toHaveFocus();
    expect(draft.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Search" }).focus();
    draft.focus();
    fireEvent.change(draft, { target: { value: "Still writing beside the dock" } });
    expect(draft).toHaveFocus();
    expect(draft).toHaveValue("Still writing beside the dock");
    expect(onExpandedChange).not.toHaveBeenCalled();
});

it.each(["sources"])("expands %s without remounting its reader and restores its dock width", async (id) => {
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
    const request = vi.fn(async () => {
        fullscreenElement = screen.getByRole("complementary", { name: "Assistant dock" });
        document.dispatchEvent(new Event("fullscreenchange"));
    });
    const exit = vi.fn(async () => {
        fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange"));
    });
    render(dockView({ tabs: [{ id, label: id, content: <input aria-label="Reader note" defaultValue="Retained" /> }],
        activeTabId: id }));
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    const dock = screen.getByRole("complementary", { name: "Assistant dock" });
    Object.defineProperty(dock, "requestFullscreen", { configurable: true, value: request });
    const reader = screen.getByRole("textbox", { name: "Reader note" });
    fireEvent.change(reader, { target: { value: "Reading state" } });
    fireEvent.click(screen.getByRole("button", { name: "Expand reader" }));
    expect(request).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Restore reader size" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Restore reader size" }));
    expect(exit).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Reader note" })).toBe(reader);
    expect(reader).toHaveValue("Reading state");
    expect(screen.getByRole("button", { name: "Expand reader" })).toHaveAttribute("aria-pressed", "false");
});


it("falls back to an in-app reader and restores focus and content on Escape", async () => {
    render(<div><button>Chat action</button>{dockView({
        tabs: [{ id: "sources", label: "Sources", content: <input aria-label="Source position" defaultValue="Paragraph 8" /> }],
    })}</div>);
    const reader = screen.getByRole("textbox", { name: "Source position" });
    const trigger = screen.getByRole("button", { name: "Expand reader" });
    trigger.focus(); fireEvent.click(trigger);
    const expanded = await screen.findByRole("dialog", { name: "Assistant dock" });
    expect(screen.getByText("Chat action").inert).toBe(true);
    expect(screen.getByRole("textbox", { name: "Source position" })).toBe(reader);
    fireEvent.keyDown(expanded, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Chat action" }).inert).not.toBe(true);
    expect(screen.getByRole("button", { name: "Expand reader" })).toHaveFocus();
    expect(reader).toHaveValue("Paragraph 8");
});
