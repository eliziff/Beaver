import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CitationPillMarkdown, GfmMarkdown, MarkdownContent } from "./MarkdownContent";
import type { Citation } from "@/app/lib/citations";
import { preprocessCitations } from "./citationUtils";

function renderMarkdown(text: string, inlineCitationTargets: Citation[] = []) {
    return render(
        <MarkdownContent
            text={text}
            inlineCitationTargets={inlineCitationTargets}
        />,
    );
}

it("collapses repeated adjacent citations while retaining distinct sources and pinpoints", () => {
    const first: Citation = { kind: "document", ref: 1, document_id: "brief", filename: "Brief", pinpoint: "para 5", quotes: [] };
    const second: Citation = { kind: "a2aj", ref: 2, citation: "2024 SCC 1", pinpoint: "para 12", quotes: [] };
    const citations = [first, second, { ...first, ref: 3 }, { ...second, ref: 4, pinpoint: "para 13" }];
    const targets: Citation[] = [];
    preprocessCitations("Point [1][1][3][2][2][4]", new Map(citations.map((c) => [c.ref, c])), targets);
    expect(targets.map((c) => c.pinpoint)).toEqual(["para 5", "para 12", "para 13"]);
    const { container } = render(<CitationPillMarkdown text="Point [1][1][3][2][2][4]" citations={citations} />);
    expect(container.querySelectorAll("[data-citation-ref]")).toHaveLength(3);
});

describe("MarkdownContent tables", () => {
    it.each([false, true])("renders Markdown tables (streaming: %s)", (isStreaming) => {
        render(<MarkdownContent
            text={"| Item | Count |\n| --- | ---: |\n| **Files** | 2 |"}
            inlineCitationTargets={[]}
            isStreaming={isStreaming}
        />);
        expect(screen.getByRole("columnheader", { name: "Count" })).toBeInTheDocument();
        expect(screen.getByRole("cell", { name: "Files" }).querySelector("strong")).toHaveTextContent("Files");
        expect(screen.getByRole("cell", { name: "2" })).toHaveStyle({ textAlign: "right" });
    });

    it("preserves ASCII table spacing in a code block", () => {
        const ascii = "+------+-------+\n| Item | Count |\n+------+-------+\n| Files|     2 |\n+------+-------+\n";
        const { container } = renderMarkdown("```text\n" + ascii + "```");
        expect(container.querySelector("pre code")?.textContent).toBe(ascii);
    });

    it.each([false, true])("renders a verified source chip inside a table cell (streaming: %s)", (isStreaming) => {
        const citation: Citation = {
            kind: "a2aj", ref: 1, source_class: "case", citation: "2024 SCC 1",
            name: "Example v Example", dataset: "SCC", url: "https://example.test/case",
            pinpoint: "para 12", quotes: [{ quote: "The appeal is allowed." }],
        };
        const targets: Citation[] = [];
        const text = preprocessCitations("| Outcome | Source |\n| --- | --- |\n| The appeal is allowed. | [1] |", new Map([[1, citation]]), targets);
        render(<MarkdownContent text={text} inlineCitationTargets={targets} isStreaming={isStreaming} />);
        const chip = screen.getByRole("link", { name: /Example v Example/ });
        expect(chip.closest("td")).toBeInTheDocument();
        expect(chip).toHaveAttribute("href", citation.url);
        expect(chip).toHaveTextContent("para 12");
    });
});

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

    it("turns grounded subagent markers into source chips", async () => {
        const source: Citation = {
            kind: "a2aj", source_class: "case", ref: 1,
            citation: "2020 BCSC 1", name: "Example v. Example",
            dataset: "BCSC", url: null, locator_kind: "paragraph",
            locator: "12", pinpoint: "para 12", quotes: [{ quote: "Exact passage" }],
        };
        const otherSource: Citation = { ...source, ref: 2, citation: "2021 BCSC 2" };
        const onCitationClick = vi.fn();
        render(<CitationPillMarkdown
            text="The proposition is established. [1]"
            citations={[otherSource, source]}
            onCitationClick={onCitationClick} />);

        const chip = screen.getByRole("button", {
            name: "Example v. Example, 2020 BCSC 1 at para 12",
        });
        await userEvent.click(chip);
        expect(onCitationClick).toHaveBeenCalledWith(source);
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
        expect(pill).toHaveAttribute("href", "https://example.test/article.pdf#page=2");
        expect(pill).toHaveAttribute("target", "_blank");
        expect(pill).toHaveTextContent(
            "Ada Example, “A Fixture Article” (2026) 1:2 Fixture LJ 100 at 101",
        );
    });

    it("keeps the full authority on consecutive final-answer pinpoints", () => {
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
            "R. v. Retvedt, 2017 BCSC 2477, para. 29",
        );
    });

    it("keeps the full legislation title on consecutive final-answer pinpoints", () => {
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
            "Family Law Act, SBC 2011, c 25, s. 19.16",
        );
    });

    it("does not make model-authored external URLs clickable", () => {
        renderMarkdown("[Project website](https://example.com)");

        expect(screen.queryByRole("link", { name: "Project website" })).toBeNull();
        expect(screen.getByText("Project website")).toBeInTheDocument();
    });
});
