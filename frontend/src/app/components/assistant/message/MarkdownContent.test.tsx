import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CitationPillMarkdown, GfmMarkdown, MarkdownContent } from "./MarkdownContent";
import type { Citation } from "../../shared/types";
import { preprocessCitations } from "./citationUtils";

function renderMarkdown(text: string, inlineCitationTargets: Citation[] = []) {
    return render(
        <MarkdownContent
            text={text}
            inlineCitationTargets={inlineCitationTargets}
        />,
    );
}

describe("MarkdownContent links", () => {
    it("does not make ungrounded subagent URLs clickable", () => {
        render(
            <CitationPillMarkdown
                text="[Project](/projects/1) [Injected](https://attacker.test)"
            />,
        );

        expect(screen.getByRole("link", { name: "Project" })).toHaveAttribute(
            "href",
            "/projects/1",
        );
        expect(screen.queryByRole("link", { name: "Injected" })).toBeNull();
    });

    it("rejects credential-bearing links in shared Markdown", () => {
        render(<GfmMarkdown>{"[Sign in](https://user:secret@example.test/)"}</GfmMarkdown>);

        expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    });

    it("repairs incomplete Markdown while text is streaming", () => {
        const { container } = render(
            <MarkdownContent
                text="This is **bold"
                isStreaming
                inlineCitationTargets={[]}
            />,
        );

        expect(screen.getByText("bold").tagName).toBe("STRONG");
        expect(container).not.toHaveTextContent("**");
    });

    it("keeps Beaver app links and suppresses unverified external links", () => {
        renderMarkdown(
            "[Open project](/projects/matter-1) [Open source](/sources/source-1) [External](https://example.com)",
        );

        expect(screen.getByRole("link", { name: "Open project" })).not.toHaveAttribute(
            "target",
        );
        expect(screen.getByRole("link", { name: "Open source" })).not.toHaveAttribute(
            "rel",
        );
        expect(screen.queryByRole("link", { name: "External" })).toBeNull();
        expect(screen.getByText("External")).toBeInTheDocument();
    });

    it("renders the complete streamed text, including terminal punctuation", () => {
        const text =
            "It will need local-law review before use because tenancy rules vary by jurisdiction.";
        renderMarkdown(text);

        expect(screen.getByText(text)).toHaveTextContent(text);
    });

    it("keeps a verified journal page inside the citation pill", () => {
        renderMarkdown("Quoted analysis `\u00a70\u00a7`.", [
            {
                kind: "public_legal",
                ref: 1,
                provider: "journal",
                identifier: "article-7",
                title: "A Fixture Article",
                authority:
                    "Ada Example, “A Fixture Article” (2026) 1:2 Fixture LJ 100",
                url: "https://example.test/article.pdf#page=2",
                locator_kind: "page",
                locator: "page101",
                locator_separator: " at ",
                pinpoint: "101",
                quotes: [{ quote: "Quoted analysis" }],
            },
        ]);

        const pill = document.querySelector('[data-citation-ref="1"]');
        expect(pill).toHaveTextContent(
            "Ada Example, “A Fixture Article” (2026) 1:2 Fixture LJ 100 at 101",
        );
        expect(pill).toHaveClass(
            "rounded-md",
            "[overflow-wrap:anywhere]",
            "bg-red-800",
            "text-red-50",
        );
        expect(pill).toHaveAttribute(
            "title",
            'Ada Example, “A Fixture Article” (2026) 1:2 Fixture LJ 100 at 101: "Quoted analysis"',
        );
    });

    it("uses only the pinpoint for consecutive passages from one decision", () => {
        const citations = new Map<number, Citation>([
            [1, {
                kind: "a2aj",
                source_class: "case",
                ref: 1,
                citation: "2017 BCSC 2477",
                name: "R. v. Retvedt",
                url: "https://www.canlii.org/example#par28:~:text=first",
                pinpoint: "para. 28",
                quotes: [{ quote: "First passage" }],
            }],
            [2, {
                kind: "a2aj",
                source_class: "case",
                ref: 2,
                citation: "2017 BCSC 2477",
                name: "R. v. Retvedt",
                url: "https://www.canlii.org/example#par29:~:text=second",
                pinpoint: "para. 29",
                quotes: [{ quote: "Second passage" }],
            }],
        ]);
        const targets: Citation[] = [];
        const text = preprocessCitations("First [1], then [2].", citations, targets);

        renderMarkdown(text, targets);

        expect(document.querySelector('[data-citation-ref="2"]')).toHaveTextContent(
            "para. 29",
        );
        expect(document.querySelector('[data-citation-ref="2"]')).not.toHaveTextContent(
            "Retvedt",
        );
    });

    it("compresses repeated legislation citations like other authorities", () => {
        const citations = new Map<number, Citation>([
            [1, {
                kind: "a2aj",
                source_class: "legislation",
                ref: 1,
                citation: "SBC 2011, c 25",
                name: "Family Law Act",
                url: "https://www.bclaws.gov.bc.ca/example#section19.15",
                pinpoint: "s. 19.15",
                quotes: [{ quote: "First provision" }],
            }],
            [2, {
                kind: "a2aj",
                source_class: "legislation",
                ref: 2,
                citation: "SBC 2011, c 25",
                name: "Family Law Act",
                url: "https://www.bclaws.gov.bc.ca/example#section19.16",
                pinpoint: "s. 19.16",
                quotes: [{ quote: "Second provision" }],
            }],
        ]);
        const targets: Citation[] = [];
        const text = preprocessCitations("First [1], then [2].", citations, targets);

        renderMarkdown(text, targets);

        expect(document.querySelector('[data-citation-ref="2"]')).toHaveTextContent(
            "s. 19.16",
        );
        expect(document.querySelector('[data-citation-ref="2"]')).not.toHaveTextContent(
            "Family Law Act",
        );
    });

    it("does not make model-authored external URLs clickable", () => {
        renderMarkdown("[Project website](https://example.com)");

        expect(screen.queryByRole("link", { name: "Project website" })).toBeNull();
        expect(screen.getByText("Project website")).toBeInTheDocument();
    });
});
