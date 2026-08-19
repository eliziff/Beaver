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

        await user.click(screen.getByRole("button", { name: "Copy quote and citation" }));

        expect(writeText).toHaveBeenCalledWith(`"he said 'hi'" Doe 2020`);
        expect(await screen.findByText("Copied")).toBeInTheDocument();
    });

    it("selects and collapses quotes", async () => {
        const user = userEvent.setup();
        render(
            <CitationQuotesHeader
                quotes={[
                    { id: "one", quote: "First passage" },
                    { id: "two", quote: "Second passage" },
                ]}
            />,
        );

        expect(screen.getByText(/First passage/)).toBeInTheDocument();
        expect(screen.queryByText(/Second passage/)).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Quote 2" }));
        expect(screen.queryByText(/First passage/)).not.toBeInTheDocument();
        expect(screen.getByText(/Second passage/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Minimize" }));
        expect(screen.queryByText(/Second passage/)).not.toBeInTheDocument();
    });
});
