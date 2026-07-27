import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CitationQuotesHeader } from "./CitationQuotesHeader";

describe("CitationQuotesHeader", () => {
    afterEach(() => vi.restoreAllMocks());

    it("copies the current quote and citation", async () => {
        const user = userEvent.setup();
        const writeText = vi.spyOn(navigator.clipboard, "writeText");
        render(
            <CitationQuotesHeader
                quotes={[
                    {
                        id: "quote-1",
                        quote: `he said "hi"`,
                        citationText: "Doe 2020",
                    },
                ]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Cite" }));

        expect(writeText).toHaveBeenCalledWith(`"he said 'hi'" Doe 2020`);
        expect(await screen.findByText("Copied")).toBeInTheDocument();
    });
});
