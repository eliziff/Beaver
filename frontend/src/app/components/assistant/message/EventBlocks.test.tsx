import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { Citation } from "@/app/lib/citations";

import { ActivityRow } from "./EventBlocks";

it("keeps the read chip unchanged while preserving a completed read's exact source action", async () => {
    const broad: Citation = {
        kind: "a2aj", source_class: "case", ref: 1,
        name: "Bhasin v. Hrynew", citation: "2014 SCC 71", dataset: "SCC",
        url: "https://example.test/bhasin", quotes: [],
    };
    const passage: Citation = {
        ...broad, ref: 2, locator_kind: "paragraph", locator: "17, 112",
        pinpoint: "paras 17, 112", authority: "Bhasin, supra",
    };
    const activity = {
        id: "read-bhasin", tool: "Read",
        label: "Reading Bhasin v. Hrynew",
    };
    const { container, rerender } = render(<ActivityRow activity={{
        ...activity, status: "running", citations: [broad],
    }} />);

    const chip = screen.getByRole("link", { name: "Bhasin v. Hrynew, 2014 SCC 71" });
    expect(screen.getByRole("listitem")).toHaveTextContent(/Reading(?:\.\.\.)? Bhasin v\. Hrynew/u);
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-busy", "true");
    chip.focus();
    rerender(<ActivityRow activity={{
        ...activity, status: "completed", citations: [passage],
    }} />);

    expect(screen.getByRole("link", { name: /Bhasin/u })).toBe(chip);
    expect(chip).toHaveFocus();
    expect(screen.getByRole("listitem")).toHaveTextContent(/Reading Bhasin v\. Hrynew/u);
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-busy", "false");
    expect(container.querySelectorAll("[data-citation-ref]")).toHaveLength(1);

    rerender(<ActivityRow activity={{
        ...activity, status: "error", citations: [broad], detail: "Source unavailable",
    }} />);
    expect(screen.getByRole("link", { name: /Bhasin/u })).toBe(chip);
    expect(screen.getByText(/failed/u)).toBeVisible();
    expect(screen.getByText("Source unavailable")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Citation actions" })).toBeNull();
});

it("keeps failed read context and errors visible", () => {
    render(<ActivityRow activity={{
        id: "failed-read", tool: "Read", status: "error",
        label: "Reading R. v. Jordan", detail: "Source unavailable",
    }} />);
    expect(screen.getByText(/Reading R\. v\. Jordan/u)).toBeVisible();
    expect(screen.getByText("Source unavailable")).toBeVisible();
});

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

