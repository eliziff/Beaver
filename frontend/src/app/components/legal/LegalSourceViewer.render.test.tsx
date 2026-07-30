import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegalSourceViewerPayload } from "@/app/lib/beaverApi";

const api = vi.hoisted(() => ({
    direct: vi.fn(),
    saved: vi.fn(),
    opinions: vi.fn(),
}));
const scrollIntoView = vi.fn();

vi.mock("@/app/lib/beaverApi", async (importOriginal) => {
    const original =
        await importOriginal<typeof import("@/app/lib/beaverApi")>();
    return {
        ...original,
        getDirectLegalSourceDocument: api.direct,
        getLegalSourceDocument: api.saved,
        getCourtlistenerOpinions: api.opinions,
    };
});
vi.mock("next/navigation", () => ({
    useRouter: () => ({ prefetch: vi.fn(), push: vi.fn() }),
}));
vi.mock("./LegalSourceMarkingPanel", () => ({
    LegalSourceMarkingPanel: ({ sourceId }: { sourceId: string }) => (
        <div>Marks for {sourceId}</div>
    ),
}));

import {
    LegalInlineText,
    LegalSourceViewer,
    legalSourceViewerActions,
} from "./LegalSourceViewer";
import { LegalLibrarySourcePage } from "./LegalLibrary";

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
                            kind: "list-item",
                            text: "Unordered factor",
                            inline: [
                                { kind: "text", text: "Unordered factor" },
                            ],
                            marker: "-",
                            ordered: false,
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

function multiSlicePayload(): LegalSourceViewerPayload {
    const base = viewerPayload();
    const text =
        "[1] First proposition.\n[2] Second proposition.\n[3] Third proposition.";
    const second = text.indexOf("[2]");
    const third = text.indexOf("[3]");
    return {
        ...base,
        text,
        presentation: undefined,
        structure: {
            ...base.structure,
            blocks: [
                { kind: "page", label: "page1", start: 0, end: third },
                { kind: "paragraph", label: "par1", start: 0, end: second },
                {
                    kind: "paragraph",
                    label: "par2",
                    start: second,
                    end: third,
                },
                {
                    kind: "page",
                    label: "page2",
                    start: third,
                    end: text.length,
                },
                {
                    kind: "paragraph",
                    label: "par3",
                    start: third,
                    end: text.length,
                },
            ],
            counts: { paragraph: 3, page: 2, section: 0, footnote: 0 },
        },
    };
}

describe("legal source reader", () => {
    beforeEach(() => {
        api.direct.mockReset();
        api.saved.mockReset();
        api.opinions.mockReset();
        scrollIntoView.mockReset();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
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
        expect(container.querySelectorAll("ul > li")).toHaveLength(1);
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
            screen.getByRole("link", { name: /View PDF/iu }),
        ).toHaveAttribute(
            "href",
            "https://decisions.example.test/item/1/document.pdf",
        );
        await waitFor(() => expect(api.direct).toHaveBeenCalledTimes(1));
    });

    it("keeps every source anchor unique and addressable", async () => {
        api.direct.mockResolvedValue(multiSlicePayload());
        const { container } = render(
            <LegalSourceViewer citation="2099 SCC 1" docType="cases" />,
        );
        await screen.findByRole("heading", { name: "Fixture v. Test" });

        const expectedIds = [
            "legal-page1",
            "legal-par1",
            "legal-par2",
            "legal-page2",
            "legal-par3",
        ];
        const ids = Array.from(
            container.querySelectorAll<HTMLElement>("[id^='legal-']"),
            (element) => element.id,
        );
        expect(ids).toHaveLength(new Set(ids).size);
        expect(ids.sort()).toEqual([...expectedIds].sort());
        for (const id of expectedIds) {
            expect(container.querySelector(`#${id}`)).not.toBeNull();
        }
        expect(container.querySelector("#legal-par1")?.tagName).toBe("SECTION");
        expect(container.querySelector("#legal-page1")?.tagName).toBe("SPAN");
        expect(
            container.querySelector("article")?.querySelectorAll("*"),
        ).toHaveLength(16);
    });

    it("opens an internal source at the cited paragraph", async () => {
        api.direct.mockResolvedValue(multiSlicePayload());
        const { container } = render(
            <LegalSourceViewer
                citation="2099 SCC 1"
                docType="cases"
                initialLocator="par2"
            />,
        );

        await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
        expect(container.querySelector("#legal-par2")).toHaveClass(
            "bg-amber-100/70",
        );
    });

    it("renders only safe inline links and no literal Markdown markers", () => {
        const { container } = render(
            <p>
                <LegalInlineText
                    tokens={[
                        { kind: "text", text: "See " },
                        { kind: "em", text: "ratio" },
                        { kind: "strong", text: " controls" },
                        { kind: "code", text: " s.1" },
                        { kind: "sup", text: "2" },
                        { kind: "sub", text: "n" },
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

        expect(container.textContent).toBe(
            "See ratio controls s.12n and sourceunsafe",
        );
        expect(container.textContent).not.toMatch(/\*|<em>/u);
        expect(container.querySelector("strong")).toHaveTextContent("controls");
        expect(container.querySelector("code")).toHaveTextContent("s.1");
        expect(container.querySelector("sup")).toHaveTextContent("2");
        expect(container.querySelector("sub")).toHaveTextContent("n");
        expect(container.querySelectorAll("a")).toHaveLength(1);
        expect(container.querySelector("a")).toHaveAttribute(
            "href",
            "https://example.test/case",
        );
    });

    it("uses the same reader for CourtListener opinions", async () => {
        api.opinions.mockResolvedValue([
            {
                opinionId: 11,
                type: "lead",
                author: "Justice One",
                url: null,
                html: "<p>The <em>ratio</em> controls.</p><script>bad()</script>",
            },
            {
                opinionId: 12,
                type: "dissent",
                author: "Justice Two",
                url: null,
                text: "The dissenting reasons.",
            },
        ]);

        const caseTab = {
            kind: "case" as const,
            id: "case:999" as const,
            chatId: "chat-1",
            clusterId: 999,
            caseName: "CourtListener fixture",
            citation: "999 F.4th 1",
            url: "https://www.courtlistener.com/opinion/999",
            dateFiled: "2099-01-02",
            pdfUrl: "https://www.courtlistener.com/pdf/999",
        };
        const { container, unmount } = render(
            <LegalSourceViewer
                caseTab={caseTab}
                compact
            />,
        );

        await screen.findByRole("heading", {
            name: "CourtListener fixture",
        });
        expect(container.querySelector("em")?.textContent).toBe("ratio");
        expect(container.querySelector("script")).not.toBeInTheDocument();
        screen.getByRole("link", { name: "View original source" });
        screen.getByRole("link", { name: "View PDF" });
        fireEvent.click(
            screen.getByRole("button", {
                name: "Dissent by Justice Two",
            }),
        );
        await screen.findByText("The dissenting reasons.");
        expect(api.direct).not.toHaveBeenCalled();
        expect(api.opinions).toHaveBeenCalledWith(999);
        unmount();
        render(<LegalSourceViewer caseTab={caseTab} compact />);
        await screen.findByRole("heading", {
            name: "CourtListener fixture",
        });
        expect(api.opinions).toHaveBeenCalledTimes(1);
    });

    it("keeps saved and direct readers in the same bounded source shell", async () => {
        api.saved.mockResolvedValue(viewerPayload());
        const { rerender } = render(
            <LegalLibrarySourcePage
                referenceId="saved-1"
                markingId="saved-1"
            />,
        );

        const savedTitle = await screen.findByRole("heading", {
            name: "Fixture v. Test",
        });
        expect(savedTitle.closest(".min-h-0.min-w-0.flex-1")).not.toBeNull();
        fireEvent.click(
            screen.getByRole("button", { name: "Mark source" }),
        );
        expect(
            screen.getByRole("complementary", {
                name: "Project source marks",
            }),
        ).toHaveTextContent("Marks for saved-1");

        api.direct.mockResolvedValue(viewerPayload());
        rerender(
            <LegalLibrarySourcePage
                provider="a2aj"
                citation="2099 SCC 1"
                docType="cases"
                language="en"
            />,
        );
        await waitFor(() => expect(api.direct).toHaveBeenCalledTimes(1));
        expect(
            screen.queryByRole("button", { name: "Mark source" }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "Fixture v. Test" }).closest(
                ".min-h-0.min-w-0.flex-1",
            ),
        ).not.toBeNull();
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
                label: "View PDF",
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
