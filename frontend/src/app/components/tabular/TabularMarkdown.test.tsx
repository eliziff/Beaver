import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { parseTabularMarkdown, TabularMarkdown } from "./TabularMarkdown";

it("renders tabular pills and citations through one shared path", async () => {
    const onCitationClick = vi.fn();
    render(
        <TabularMarkdown
            parsed={parseTabularMarkdown(
                "**Result** [[High]] [[page:7||quote:The quoted rule.]]",
            )}
            citationOffset={2}
            onCitationClick={onCitationClick}
        />,
    );

    expect(screen.getByText("Result").tagName).toBe("STRONG");
    expect(screen.getByText("High")).toHaveClass("rounded-full");
    await userEvent.click(
        screen.getByRole("button", {
            name: "Open citation 3: Page 7",
        }),
    );
    expect(onCitationClick).toHaveBeenCalledWith(
        { page: 7, quote: "The quoted rule." },
        3,
    );
});
