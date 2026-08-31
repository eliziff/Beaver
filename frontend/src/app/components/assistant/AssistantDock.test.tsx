import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantDock } from "./AssistantDock";

afterEach(() => vi.unstubAllGlobals());

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
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });

    expect(dock).toHaveStyle({ "--assistant-dock-width": "504px" });
    expect(screen.getByText("Source")).toBeVisible();
});

it("collapses to an expand control without discarding the dock", () => {
    const onExpandedChange = vi.fn();
    render(
        <AssistantDock
            tabs={[{ id: "sources", label: "Sources", content: null }]}
            activeTabId="sources"
            onActivateTab={vi.fn()}
            expanded={false}
            onExpandedChange={onExpandedChange}
        />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand assistant dock" }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
});

it("contains focus while it covers the workspace on a narrow screen", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
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
    expect(screen.getByRole("tab", { name: "Assistant" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("complementary", { name: "Assistant dock" }), { key: "Escape" });
    expect(onExpandedChange).toHaveBeenCalledWith(false);

    rerender(<div>
        <button type="button">Workspace action</button>
        <AssistantDock tabs={[{ id: "assistant", label: "Assistant", content: null }]}
            activeTabId="assistant" onActivateTab={vi.fn()} expanded={false}
            onExpandedChange={onExpandedChange} />
    </div>);
    expect(screen.getByRole("button", { name: "Workspace action" }).inert).not.toBe(true);
});
