import {
    Document,
    FootnoteReferenceRun,
    LastRenderedPageBreak,
    Packer,
    Paragraph,
    TextRun,
} from "docx";
import { renderAsync } from "docx-preview";
import { describe, expect, it } from "vitest";

import { DOCX_RENDER_OPTIONS } from "./DocxView";

describe("DOCX pagination", () => {
    it("keeps footnotes on the saved Word page that references them", async () => {
        const source = new Document({
            footnotes: {
                1: {
                    children: [new Paragraph("First page footnote")],
                },
                2: {
                    children: [new Paragraph("Second page footnote")],
                },
            },
            sections: [
                {
                    children: [
                        new Paragraph({
                            children: [
                                new TextRun("First page body"),
                                new FootnoteReferenceRun(1),
                                new TextRun({
                                    children: [
                                        new LastRenderedPageBreak(),
                                        "Second page body",
                                    ],
                                }),
                                new FootnoteReferenceRun(2),
                            ],
                        }),
                    ],
                },
            ],
        });
        const bytes = await Packer.toArrayBuffer(source);
        const container = document.createElement("div");

        await renderAsync(
            bytes,
            container,
            undefined,
            DOCX_RENDER_OPTIONS,
        );

        const pages = container.querySelectorAll("section.docx");
        expect(pages).toHaveLength(2);
        expect(pages[0]).toHaveTextContent("First page body");
        expect(pages[0]).toHaveTextContent("First page footnote");
        expect(pages[0]).not.toHaveTextContent("Second page footnote");
        expect(pages[1]).toHaveTextContent("Second page body");
        expect(pages[1]).toHaveTextContent("Second page footnote");
        expect(pages[1]).not.toHaveTextContent("First page footnote");
    });
});
