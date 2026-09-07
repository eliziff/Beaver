import { render, screen } from "@testing-library/react";
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
                url: "https://www.canlii.org/example#par12",
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
        citations: activity.citations.map((citation) => ({
            ...citation, ref: 0, locator: null, pinpoint: null, quotes: [],
        })),
    })),
};

it("keeps the delegated source chip unchanged and opens its exact source after completion", () => {
    const onCitationClick = vi.fn();
    const { rerender } = render(
        <ReadSubagentDock
            panels={[runningPanel]}
            onCitationClick={onCitationClick}
            embedded
        />,
    );

    expect(screen.getByRole("button", {
        name: "Activity — Reading Example v. Example, 2020 BCSC 1",
    })).toBeVisible();
    const citation = screen.getByRole("button", {
        name: "Example v. Example, 2020 BCSC 1",
    });
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-busy", "true");
    rerender(<ReadSubagentDock panels={[completedPanel]} onCitationClick={onCitationClick} embedded />);
    expect(screen.getByRole("button", { name: "Example v. Example, 2020 BCSC 1" })).toBe(citation);
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-busy", "false");
    // The chip opens the source in the reader rather than a browser tab.
    citation.click();
    expect(onCitationClick).toHaveBeenCalledTimes(1);
});
