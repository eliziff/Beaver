import {
    Document,
    Footer,
    Header,
    HorizontalPositionRelativeFrom,
    ImageRun,
    LastRenderedPageBreak,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    VerticalPositionRelativeFrom,
} from "docx";
import { parseAsync, renderDocument } from "docx-preview";
import { describe, expect, it } from "vitest";

import { DOCX_RENDER_OPTIONS } from "./DocxView";

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);

describe("DOCX preview fidelity", () => {
    it("keeps saved pages, page furniture, tables, and inline/floating media", async () => {
        const source = new Document({
            sections: [
                {
                    headers: {
                        default: new Header({
                            children: [new Paragraph("Running header")],
                        }),
                    },
                    footers: {
                        default: new Footer({
                            children: [new Paragraph("Running footer")],
                        }),
                    },
                    children: [
                        new Paragraph({
                            children: [
                                new TextRun("Inline "),
                                new ImageRun({
                                    data: PNG,
                                    type: "png",
                                    transformation: {
                                        width: 48,
                                        height: 48,
                                    },
                                }),
                            ],
                        }),
                        new Table({
                            rows: [
                                new TableRow({
                                    children: [
                                        new TableCell({
                                            children: [
                                                new Paragraph("Table cell"),
                                            ],
                                        }),
                                    ],
                                }),
                            ],
                        }),
                        new Paragraph({
                            children: [
                                new TextRun({
                                    children: [
                                        new LastRenderedPageBreak(),
                                        "Second page",
                                    ],
                                }),
                                new ImageRun({
                                    data: PNG,
                                    type: "png",
                                    transformation: {
                                        width: 40,
                                        height: 40,
                                    },
                                    floating: {
                                        horizontalPosition: {
                                            relative:
                                                HorizontalPositionRelativeFrom.PAGE,
                                            offset: 1_000_000,
                                        },
                                        verticalPosition: {
                                            relative:
                                                VerticalPositionRelativeFrom.PAGE,
                                            offset: 1_000_000,
                                        },
                                    },
                                }),
                            ],
                        }),
                    ],
                },
            ],
        });
        const bytes = await Packer.toArrayBuffer(source);
        const options = {
            ...DOCX_RENDER_OPTIONS,
            useBase64URL: true,
        };
        const parsed = await parseAsync(bytes, options);
        const container = document.createElement("div");

        await renderDocument(parsed, container, undefined, options);

        expect(container.querySelectorAll("section.docx")).toHaveLength(2);
        expect(container.querySelectorAll("header")).toHaveLength(2);
        expect(container.querySelectorAll("footer")).toHaveLength(2);
        expect(container.querySelectorAll("table")).toHaveLength(1);
        expect(container).toHaveTextContent("Running header");
        expect(container).toHaveTextContent("Running footer");
        expect(container).toHaveTextContent("Table cell");

        const images = Array.from(
            container.querySelectorAll<HTMLImageElement>("img"),
        );
        expect(images).toHaveLength(2);
        expect(images.map((image) => image.getAttribute("src"))).toEqual([
            expect.stringMatching(/^data:/u),
            expect.stringMatching(/^data:/u),
        ]);
        expect(images[0].style.width).toBe(images[0].style.height);
        expect(images[1].style.width).toBe(images[1].style.height);
        expect(images[1].parentElement).toHaveStyle({
            display: "block",
            width: "0px",
            height: "0px",
        });
        expect(parseFloat(images[1].parentElement!.style.left)).toBeGreaterThan(
            0,
        );
    });
});
