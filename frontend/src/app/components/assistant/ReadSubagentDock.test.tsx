import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ReadSubagentDock } from "./ReadSubagentDock";

const completedPanel = {
    type: "subagent_run" as const,
    id: "agent:1",
    task: "Find the authorities.",
    status: "completed" as const,
    activities: [
        {
            id: "read-case",
            tool: "Read",
            label: "Reading Example v. Example, 2020 BCSC 1",
            status: "completed" as const,
            sources: [{
                ref: 1,
                provider: "a2aj",
                jurisdiction: "CA",
                citation: "2020 BCSC 1",
                name: "Example v. Example",
                dataset: "BCSC",
                url: null,
                locator: "par12",
            }],
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

    expect(screen.getByRole("button", { name: "Activity — 1 tool call" })).toBeVisible();
    expect(screen.getByText("Reading Example v. Example, 2020 BCSC 1")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "2020 BCSC 1, par12" }));
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

    expect(screen.getByRole("button", { name: "Activity — 1 tool call" })).toBeVisible();
    expect(screen.getByText("Reading Example v. Example, 2020 BCSC 1...")).toBeVisible();
});
