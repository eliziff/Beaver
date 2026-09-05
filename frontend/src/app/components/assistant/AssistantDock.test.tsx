import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantDock } from "./AssistantDock";

afterEach(() => vi.unstubAllGlobals());

function capRenderedWidth(dock: HTMLElement, max: number) {
    vi.spyOn(dock, "getBoundingClientRect").mockImplementation(() => ({
        width: Math.min(Number.parseFloat(dock.style.getPropertyValue("--assistant-dock-width")), max),
    }) as DOMRect);
}

it("resizes the dock from the keyboard", () => {
    render(
        <AssistantDock
            tabs={[{ id: "sources", label: "Sources", content: <p>Source</p> }]}
            activeTabId="sources"
            onActivateTab={vi.fn()}
            expanded
            onExpandedChange={vi.fn()}
        />,
    );

    const dock = screen.getByRole("complementary", { name: "Assistant dock" });
    capRenderedWidth(dock, 500);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
    expect(dock.style.getPropertyValue("--assistant-dock-width")).toBe("500px");
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(dock.style.getPropertyValue("--assistant-dock-width")).toBe("476px");
    expect(screen.getByText("Source")).toBeVisible();
});

it("resizes against the rendered CSS maximum without rerendering each move", () => {
    render(<AssistantDock
        tabs={[{ id: "sources", label: "Sources", content: <p>Source</p> }]}
        activeTabId="sources" onActivateTab={vi.fn()} expanded
        onExpandedChange={vi.fn()} maxWidth="calc(100% - 36rem)"
    />);
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
        onActivateTab: vi.fn(),
        onExpandedChange,
    };
    const { rerender } = render(
        <AssistantDock
            {...props}
            expanded
        />,
    );

    expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
    expect(screen.getByRole("separator", { name: "Resize assistant dock" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse assistant dock" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Draft message" }), {
        target: { value: "edited" },
    });
    expect(screen.queryByText("Unopened library")).not.toBeInTheDocument();
    rerender(<AssistantDock {...props} expanded={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand assistant dock" }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    rerender(<AssistantDock {...props} expanded />);
    expect(screen.getByRole("textbox", { name: "Draft message" })).toHaveValue("edited");
});

it("can use an existing page trigger without adding a second collapsed button", () => {
    render(<AssistantDock
        tabs={[{ id: "assistant", label: "Assistant", content: null }]}
        activeTabId="assistant" onActivateTab={vi.fn()} expanded={false}
        onExpandedChange={vi.fn()} showCollapsedButton={false}
    />);

    expect(screen.queryByRole("button", { name: "Expand assistant dock" })).not.toBeInTheDocument();
});

it("contains focus while it covers the workspace on a narrow screen", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", matchMedia);
    const onExpandedChange = vi.fn();
    const { rerender } = render(<div>
        <button type="button" autoFocus>Workspace action</button>
        <AssistantDock
            tabs={[{ id: "assistant", label: "Assistant", content: <button type="button">Send</button> }]}
            activeTabId="assistant"
            onActivateTab={vi.fn()}
            expanded
            onExpandedChange={onExpandedChange}
        />
    </div>);

    const workspace = screen.getByText("Workspace action") as HTMLButtonElement;
    expect(workspace.inert).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 1279px)");
    expect(screen.getByRole("button", { name: "Send" })).toHaveFocus();
    const dock = screen.getByRole("dialog", { name: "Assistant dock" });
    expect(dock).toHaveAttribute("aria-modal", "true");
    expect(document.querySelector("[data-assistant-backdrop]")).toBeVisible();
    expect(document.documentElement.style.scrollbarGutter).toBe("auto");
    expect(screen.getByRole("button", { name: "Close assistant" })).toBeVisible();
    fireEvent.keyDown(dock, { key: "Escape" });
    expect(onExpandedChange).toHaveBeenCalledWith(false);

    rerender(<div>
        <button type="button">Workspace action</button>
        <AssistantDock tabs={[{ id: "assistant", label: "Assistant", content: null }]}
            activeTabId="assistant" onActivateTab={vi.fn()} expanded={false}
            onExpandedChange={onExpandedChange} />
    </div>);
    expect(document.documentElement.style.scrollbarGutter).toBe("");
    expect(screen.getByRole("button", { name: "Workspace action" }).inert).not.toBe(true);
});

it("leaves Escape to a nested dialog before collapsing the compact dock", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const onExpandedChange = vi.fn();
    render(<AssistantDock
        tabs={[{ id: "assistant", label: "Assistant", content:
            <div role="dialog" aria-label="Choose files"><button type="button">Close dialog</button></div> }]}
        activeTabId="assistant" onActivateTab={vi.fn()} expanded
        onExpandedChange={onExpandedChange}
    />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Close dialog" }), { key: "Escape" });
    expect(onExpandedChange).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Assistant dock" }), { key: "Escape" });
    expect(onExpandedChange).toHaveBeenCalledWith(false);
});
