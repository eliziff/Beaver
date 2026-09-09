import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CitationQuotesHeader } from "./CitationQuotesHeader";

describe("CitationQuotesHeader", () => {
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
