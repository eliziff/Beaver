import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";
import type { Citation } from "../../shared/types";

function renderMarkdown(text: string, inlineCitationTargets: Citation[] = []) {
    return render(
        <MarkdownContent
            text={text}
            inlineCitationTargets={inlineCitationTargets}
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

    it("renders a complete legal citation and pinpoint as one clickable pill", () => {
        renderMarkdown(
            "See [2024 SCC 6](https://www.canlii.org/en/ca/scc/doc/2024/2024scc6/2024scc6.html) at paras. 12\u201314.",
        );

        const citation = screen.getByRole("link", {
            name: "2024 SCC 6 at paras. 12\u201314",
        });
        expect(citation).toHaveAttribute(
            "href",
            "https://www.canlii.org/en/ca/scc/doc/2024/2024scc6/2024scc6.html",
        );
        expect(citation).toHaveClass("rounded-full");
        expect(citation).toHaveClass("bg-red-50", "text-red-700", "ring-red-200");
        expect(citation).not.toHaveClass("bg-blue-50");
        expect(citation).toHaveClass("focus-visible:outline-2");
        expect(screen.queryByText("at paras. 12\u201314")).toBeNull();
    });

    it("renders a linked legislation citation as one clickable pill", () => {
        renderMarkdown(
            "[Franchises Act, SBC 2015, c 35, s. 14](https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/15035_01#section14)",
        );

        expect(
            screen.getByRole("link", {
                name: "Franchises Act, SBC 2015, c 35, s. 14",
            }),
        ).toHaveClass("rounded-full");
    });

    it("keeps a verified journal page inside the citation pill", () => {
        renderMarkdown("Quoted analysis `\u00a70\u00a7`.", [
            {
                type: "citation_data",
                kind: "public_legal",
                ref: 1,
                provider: "journal",
                identifier: "article-7",
                title: "A Fixture Article",
                url: "https://example.test/article.pdf#page=2",
                locator_kind: "page",
                locator: "page101",
                pinpoint: "p. 101",
                quotes: [{ quote: "Quoted analysis" }],
            },
        ]);

        const pill = document.querySelector('[data-citation-ref="1"]');
        expect(pill).toHaveTextContent("A Fixture Article, p. 101");
        expect(pill).toHaveClass("rounded-full", "bg-red-50", "text-red-700");
        expect(pill).toHaveAttribute(
            "title",
            'A Fixture Article, p. 101: "Quoted analysis"',
        );
    });

    it("moves saved same-paragraph quote fragments onto one citation pill", () => {
        const base =
            "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/2311/index.do?iframe=true&site_preference=mobile#par109";
        renderMarkdown(
            `> “[First supporting passage](${base}:~:text=First%20supporting%20passage)”\n\n` +
                `> “[Second supporting passage](${base}:~:text=Second%20supporting%20passage)”\n\n` +
                "— [2006 SCC 37](https://www.canlii.org/en/ca/scc/doc/2006/2006scc37/2006scc37.html) at para. 109.",
        );

        const citation = screen.getByRole("link", {
            name: "2006 SCC 37 at para. 109",
        });
        expect(citation).toHaveAttribute(
            "href",
            `${base}:~:text=First%20supporting%20passage&text=Second%20supporting%20passage`,
        );
        expect(
            screen.queryByRole("link", { name: "First supporting passage" }),
        ).toBeNull();
        expect(
            screen.queryByRole("link", { name: "Second supporting passage" }),
        ).toBeNull();
        expect(document.body).toHaveTextContent("First supporting passage");
        expect(document.body).toHaveTextContent("Second supporting passage");
    });

    it("leaves ordinary external links visually ordinary", () => {
        renderMarkdown("[Project website](https://example.com)");

        expect(
            screen.getByRole("link", { name: "Project website" }),
        ).not.toHaveClass("rounded-full");
    });
});
