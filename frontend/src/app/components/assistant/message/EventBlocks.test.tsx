import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { Citation } from "../../shared/types";

import { ActivityRow } from "./EventBlocks";

it("does not repeat an activity label copied into its detail markdown", () => {
    render(
        <ActivityRow activity={{
            id: "search-1",
            tool: "search_sources",
            label: "Searching the journal corpus for “necessary party”",
            status: "completed",
            markdown: "Searching the journal corpus for “necessary party”\n\nFound responsive commentary.",
        }} />,
    );

    expect(screen.getAllByText("Searching the journal corpus for “necessary party”"))
        .toHaveLength(1);
    expect(screen.getByText("Found responsive commentary.")).toBeVisible();
});

it("visually truncates a long style of cause in tool-call citation pills", () => {
    const citation: Citation = {
        kind: "a2aj", source_class: "case", ref: 1,
        name: "An Extremely Long Corporate Plaintiff Name v. Another Extremely Long Corporate Defendant Name",
        citation: "2026 ABCA 1", dataset: "ABCA", url: null, quotes: [],
    };
    render(<ActivityRow activity={{
        id: "read-1", tool: "read", label: "Read authority",
        status: "completed", citations: [citation],
    }} />);

    expect(screen.getByText(citation.name!)).toHaveClass("truncate");
});
