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
            citations: [{
                kind: "a2aj" as const,
                source_class: "case" as const,
                ref: 1,
                citation: "2020 BCSC 1",
                name: "Example v. Example",
                dataset: "BCSC",
                url: null,
                locator_kind: "paragraph" as const,
                locator: "12",
                pinpoint: "para 12",
                quotes: [{ quote: "Exact passage" }],
            }],
        },
    ],
    citations: [],
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
    const onCitationClick = vi.fn();
    render(
        <ReadSubagentDock
            panels={[completedPanel]}
            onClose={vi.fn()}
            onCitationClick={onCitationClick}
            embedded
        />,
    );

    expect(screen.getByRole("button", {
        name: "Activity — Reading Example v. Example, 2020 BCSC 1",
    })).toBeVisible();
    await userEvent.click(screen.getByRole("button", {
        name: "Example v. Example, 2020 BCSC 1 at para 12",
    }));
    expect(onCitationClick).toHaveBeenCalledWith(
        expect.objectContaining({ citation: "2020 BCSC 1" }),
    );
});

it("shows live reading activity", async () => {
    render(
        <ReadSubagentDock
            panels={[runningPanel]}
            onClose={vi.fn()}
            onCitationClick={vi.fn()}
            embedded
        />,
    );

    expect(screen.getByRole("button", {
        name: "Activity — Reading Example v. Example, 2020 BCSC 1",
    })).toBeVisible();
    expect(screen.getByText("Reading Example v. Example, 2020 BCSC 1...")).toBeVisible();
});
