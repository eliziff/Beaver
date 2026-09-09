import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ReadSubagentPanel } from "./ReadSubagentDock";
import { ReadSubagentTabs } from "./ReadSubagentTabs";

const panel = (id: string, task: string): ReadSubagentPanel => ({
    type: "subagent_run", id, task, status: "completed", activities: [],
    citations: [], output: "Done",
});

it("switches reading agents as quiet tabs without close controls", () => {
    function Example() {
        const [active, setActive] = useState("1");
        return <ReadSubagentTabs activeId={active} onActivate={setActive} groups={[
                { id: "1", label: "Agent 1", panels: [panel("agent:1", "First task")] },
                { id: "2", label: "Agent 2", panels: [panel("agent:2", "Second task")] },
            ]} />;
    }
    render(<Example />);
    const first = screen.getByRole("tab", { name: /Agent 1/ });
    const second = screen.getByRole("tab", { name: /Agent 2/ });

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Second task")).toBeVisible();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
});
