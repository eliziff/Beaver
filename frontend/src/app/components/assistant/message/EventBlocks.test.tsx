import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

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
