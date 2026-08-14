import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ReadSubagentDock } from "./ReadSubagentDock";
import { ReadSubagentTabs } from "./ReadSubagentTabs";

const completedPanel = {
    type: "subagent_run" as const,
    id: "agent:1",
    agent: "scout" as const,
    task: "Find the authorities.",
    model: "GPT-5.6 Luna",
    effort: "high",
    status: "completed" as const,
    activities: [
        {
            id: "read-case",
            label: "Reading Example v. Example, 2020 BCSC 1",
            status: "completed" as const,
            paragraphs: ["3", "5", "7", "9"],
            source: {
                provider: "a2aj",
                jurisdiction: "CA",
                citation: "2020 BCSC 1",
                name: "Example v. Example",
                dataset: "BCSC",
                url: null,
            },
        },
    ],
};

const runningPanel = {
    ...completedPanel,
    status: "running" as const,
    activities: completedPanel.activities.map((activity) => ({
        ...activity,
        status: "running" as const,
    })),
};

it("shows one bounded paragraph summary for a consolidated case read", async () => {
    const onSourceClick = vi.fn();
    render(
        <ReadSubagentDock
            panels={[completedPanel]}
            onClose={vi.fn()}
            onSourceClick={onSourceClick}
            embedded
        />,
    );

    await userEvent.click(screen.getByText("1 tool call"));
    expect(screen.getByText("at paras. 3, 5, 7 + 1 more")).toBeVisible();
    expect(screen.getAllByText("Example v. Example")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button"));
    expect(onSourceClick).toHaveBeenCalledWith(
        expect.objectContaining({ citation: "2020 BCSC 1", locator: "par3" }),
    );
});

it("marks a settled agent with a neutral done state", () => {
    render(
        <ReadSubagentTabs
            groups={[{ id: "1", label: "Agent 1", panels: [completedPanel] }]}
            activeId="1"
            onActivate={vi.fn()}
            onClose={vi.fn()}
            onSourceClick={vi.fn()}
        />,
    );

    expect(screen.getByTitle("Done")).toHaveClass("bg-gray-400");
});

it("shows live activity on the agent tab and current trace", async () => {
    render(
        <ReadSubagentTabs
            groups={[{ id: "1", label: "Agent 1", panels: [runningPanel] }]}
            activeId="1"
            onActivate={vi.fn()}
            onClose={vi.fn()}
            onSourceClick={vi.fn()}
        />,
    );

    expect(screen.getByTitle("Working")).toBeVisible();
    await userEvent.click(screen.getByText("1 tool call"));
    expect(screen.getAllByLabelText("Working")).toHaveLength(2);
});
