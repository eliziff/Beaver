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
        />,
    );

    const dock = screen.getByRole("complementary", { name: "Assistant dock" });
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });

    expect(dock).toHaveStyle({ "--assistant-dock-width": "584px" });
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
