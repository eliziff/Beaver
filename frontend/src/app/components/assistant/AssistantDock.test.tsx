import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AssistantDock } from "./AssistantDock";

it("resizes the dock from the keyboard", () => {
    render(
        <AssistantDock
            tabs={[{ id: "sources", label: "Sources", content: <p>Source</p> }]}
            activeTabId="sources"
            onActivateTab={vi.fn()}
            expanded
            onExpandedChange={vi.fn()}
            inspectorContent={<p>Source inspector</p>}
        />,
    );

    const dock = screen.getByRole("complementary", { name: "Assistant dock" });
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });

    expect(dock).toHaveStyle({ "--assistant-dock-width": "584px" });
    expect(screen.getByText("Source")).toBeVisible();
});

it("keeps an agent visible while inspecting its sources", () => {
    render(
        <AssistantDock
            tabs={[
                { id: "sources", label: "Sources", content: null },
                { id: "agents", label: "Agents", content: <p>Agent result</p> },
            ]}
            activeTabId="agents"
            onActivateTab={vi.fn()}
            expanded
            onExpandedChange={vi.fn()}
            inspectorContent={<p>Case text</p>}
            inspectorOpen
            onCloseInspector={vi.fn()}
        />,
    );

    expect(screen.getByText("Agent result")).toBeVisible();
    expect(screen.getByText("Case text")).toBeVisible();
    expect(screen.getByRole("button", { name: "Close sources" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Float assistant dock" }))
        .not.toBeInTheDocument();
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
