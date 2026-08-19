import { describe, expect, it } from "vitest";
import {
    clearHighlights,
    highlightQuote,
    STANDARD_FONT_DATA_URL,
} from "./highlightQuote";

describe("PDF quote highlighting", () => {
    it("highlights a quote across text-layer spans and restores their text", () => {
        const first = document.createElement("span");
        const second = document.createElement("span");
        first.textContent = "The controlling ";
        second.textContent = "passage applies.";

        expect(highlightQuote([first, second], "controlling passage")).toBe(true);
        expect(first.querySelector(".pdf-text-highlight")).toHaveTextContent(
            "controlling",
        );
        expect(second.querySelector(".pdf-text-highlight")).toHaveTextContent(
            "passage",
        );

        clearHighlights([first, second]);
        expect(first.textContent).toBe("The controlling ");
        expect(second.textContent).toBe("passage applies.");
    });

    it("loads standard fonts only from the current origin", () => {
        const fonts = new URL(STANDARD_FONT_DATA_URL);
        expect(fonts.origin).toBe(location.origin);
        expect(fonts.pathname).toBe("/pdfjs-standard-fonts/");
    });
});
