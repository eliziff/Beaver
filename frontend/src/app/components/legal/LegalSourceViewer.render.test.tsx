import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegalSourceViewerPayload } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({
    direct: vi.fn(),
    saved: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const original =
        await importOriginal<typeof import("@/app/lib/mikeApi")>();
    return {
        ...original,
        getDirectLegalSourceDocument: api.direct,
        getLegalSourceDocument: api.saved,
    };
});

import {
    LegalInlineText,
    LegalSourceViewer,
    legalSourceViewerActions,
} from "./LegalSourceViewer";

function viewerPayload(): LegalSourceViewerPayload {
    const text = "[1] Analysis of the legal test.";
    return {
        schemaVersion: "mike.legal-source.v1",
        provider: "a2aj",
        reference: {
            docType: "cases",
            citation: "2099 SCC 1",
            language: "en",
            dataset: "SCC",
        },
        metadata: {
            title: "Fixture v. Test",
            citation: "2099 SCC 1",
            alternateCitation: null,
            date: "2099-01-02",
            dataset: "SCC",
            url: "https://decisions.example.test/item/1",
            pdfUrl: "https://decisions.example.test/item/1/document.pdf",
            language: "en",
            upstreamLicense: null,
        },
        text,
        structure: {
            status: "usable",
            source: "native",
            blocks: [
                {
                    kind: "page",
                    label: "page1",
                    start: 0,
                    end: text.length,
                },
                {
                    kind: "paragraph",
                    label: "par1",
                    start: 0,
                    end: text.length,
                },
            ],
            counts: { paragraph: 1, page: 1, section: 0, footnote: 0 },
        },
        presentation: {
            source: "a2aj_markdown",
            segments: [
                {
                    start: 0,
                    end: text.length,
                    blocks: [
                        {
                            kind: "heading",
                            text: "Analysis",
                            inline: [{ kind: "text", text: "Analysis" }],
                            level: 2,
                        },
                        {
                            kind: "paragraph",
                            text: "The ratio controls.",
                            inline: [
                                { kind: "text", text: "The " },
                                { kind: "em", text: "ratio" },
                                { kind: "text", text: " controls." },
                            ],
                            depth: 0,
                        },
                        {
                            kind: "list-item",
                            text: "First factor",
                            inline: [{ kind: "text", text: "First factor" }],
                            marker: "1.",
                            ordered: true,
                            depth: 0,
                        },
                        {
                            kind: "list-item",
                            text: "Second factor",
                            inline: [{ kind: "text", text: "Second factor" }],
                            marker: "2.",
                            ordered: true,
                            depth: 0,
                        },
                        {
                            kind: "blockquote",
                            text: "Quoted holding.",
                            inline: [{ kind: "text", text: "Quoted holding." }],
                            depth: 0,
                        },
                    ],
                },
            ],
        },
        truncated: false,
    };
}

describe("legal source reader", () => {
    beforeEach(() => {
        api.direct.mockReset();
        api.saved.mockReset();
    });

    it("renders continuous semantic content without paragraph navigation", async () => {
        api.direct.mockResolvedValue(viewerPayload());

        const { container } = render(
            <LegalSourceViewer citation="2099 SCC 1" docType="cases" />,
        );

        await screen.findByRole("heading", { name: "Fixture v. Test" });
        expect(screen.getByRole("heading", { name: "Analysis" }).tagName).toBe(
            "H2",
        );
        expect(container.querySelector("em")?.textContent).toBe("ratio");
        expect(container.querySelectorAll("ol")).toHaveLength(1);
        expect(container.querySelectorAll("ol > li")).toHaveLength(2);
        expect(container.querySelector("blockquote")?.textContent).toBe(
            "Quoted holding.",
        );
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
        expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
        expect(screen.queryByText(/Select paragraphs/iu)).not.toBeInTheDocument();

        expect(
            screen.getByRole("link", { name: /View original source/iu }),
        ).toHaveAttribute(
            "href",
            "https://decisions.example.test/item/1",
        );
        expect(
            screen.getByRole("link", { name: /View authoritative PDF/iu }),
        ).toHaveAttribute(
            "href",
            "https://decisions.example.test/item/1/document.pdf",
        );
        await waitFor(() => expect(api.direct).toHaveBeenCalledTimes(1));
    });

    it("renders only safe inline links and no literal Markdown markers", () => {
        const { container } = render(
            <p>
                <LegalInlineText
                    tokens={[
                        { kind: "text", text: "See " },
                        { kind: "em", text: "ratio" },
                        { kind: "text", text: " and " },
                        {
                            kind: "link",
                            text: "source",
                            href: "https://example.test/case",
                        },
                        {
                            kind: "link",
                            text: "unsafe",
                            href: "javascript:alert(1)",
                        },
                    ]}
                />
            </p>,
        );

        expect(container.textContent).toBe("See ratio and sourceunsafe");
        expect(container.textContent).not.toMatch(/\*|<em>/u);
        expect(container.querySelectorAll("a")).toHaveLength(1);
        expect(container.querySelector("a")).toHaveAttribute(
            "href",
            "https://example.test/case",
        );
    });

    it("omits unsafe or absent source actions independently", () => {
        const metadata = viewerPayload().metadata;
        expect(
            legalSourceViewerActions({
                ...metadata,
                url: "javascript:alert(1)",
            }),
        ).toEqual([
            {
                kind: "pdf",
                label: "View authoritative PDF",
                href: metadata.pdfUrl,
            },
        ]);
        expect(
            legalSourceViewerActions({
                ...metadata,
                url: null,
                pdfUrl: null,
            }),
        ).toEqual([]);
    });
});
