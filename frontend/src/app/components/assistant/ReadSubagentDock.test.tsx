import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ReadSubagentDock } from "./ReadSubagentDock";

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
            tool: "Read",
            label: "Reading Example v. Example, 2020 BCSC 1",
            status: "completed" as const,
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

it("opens the exact source metadata attached by the backend", async () => {
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
    expect(screen.getByText("Reading Example v. Example, 2020 BCSC 1")).toBeVisible();
    await userEvent.click(screen.getByRole("button"));
    expect(onSourceClick).toHaveBeenCalledWith(
        expect.objectContaining({ citation: "2020 BCSC 1" }),
    );
});

it("shows live reading activity", async () => {
    render(
        <ReadSubagentDock
            panels={[runningPanel]}
            onClose={vi.fn()}
            onSourceClick={vi.fn()}
            embedded
        />,
    );

    await userEvent.click(screen.getByText("1 tool call"));
    expect(screen.getAllByLabelText("Working")).toHaveLength(1);
    expect(screen.getByText("Reading Example v. Example, 2020 BCSC 1...")).toBeVisible();
});
