import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

function renderMarkdown(text: string) {
    return render(
        <MarkdownContent
            text={text}
            inlineCitationTargets={[]}
            caseCitations={new Map()}
            caseOpinions={new Map()}
        />,
    );
}

describe("MarkdownContent links", () => {
    it("keeps Beaver app links in the current app and isolates external links", () => {
        renderMarkdown(
            "[Open project](/projects/matter-1) [Open source](/library/legal/source-1) [External](https://example.com)",
        );

        expect(screen.getByRole("link", { name: "Open project" })).not.toHaveAttribute(
            "target",
        );
        expect(screen.getByRole("link", { name: "Open source" })).not.toHaveAttribute(
            "rel",
        );
        expect(screen.getByRole("link", { name: "External" })).toHaveAttribute(
            "target",
            "_blank",
        );
        expect(screen.getByRole("link", { name: "External" })).toHaveAttribute(
            "rel",
            "noopener noreferrer",
        );
    });

    it("renders the complete streamed text, including terminal punctuation", () => {
        const text =
            "It will need local-law review before use because tenancy rules vary by jurisdiction.";
        renderMarkdown(text);

        expect(screen.getByText(text)).toHaveTextContent(text);
    });
});
