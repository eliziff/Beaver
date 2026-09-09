import {
    Document,
    ExternalHyperlink,
    FootnoteReferenceRun,
    LastRenderedPageBreak,
    Packer,
    Paragraph,
    TextRun,
    type ParagraphChild,
} from "docx";
import JSZip from "jszip";
import { parseAsync, renderDocument } from "docx-preview";
import { describe, expect, it } from "vitest";

import { DOCX_RENDER_OPTIONS } from "./DocxView";
import { finalizeDocxDom, tagDocxMarkers } from "./docxNotes";

/**
 * Mirrors DocxView's pipeline: parse once, tag, render, link.
 * `customMarkFirst` supplies the one run property the fixture builder cannot emit.
 */
async function renderFixture(
    bytes: ArrayBuffer,
    customMarkFirst = false,
): Promise<HTMLElement> {
    const doc = await parseAsync(bytes, DOCX_RENDER_OPTIONS);
    if (customMarkFirst) {
        const visit = (nodes: any[]): boolean => {
            for (const node of nodes) {
                if (node.type === "footnoteReference") {
                    node.customMarkFollows = true;
                    return true;
                }
                if (node.children && visit(node.children)) return true;
            }
            return false;
        };
        visit(doc.documentPart.body.children);
    }
    tagDocxMarkers(doc);
    const container = document.createElement("div");
    await renderDocument(doc, container, undefined, DOCX_RENDER_OPTIONS);
    finalizeDocxDom(container);
    return container;
}

async function renderNotes(
    notes: Record<number, string>, paragraphs: ParagraphChild[][], customMarkFirst = false,
): Promise<HTMLElement> {
    const source = new Document({
        footnotes: Object.fromEntries(Object.entries(notes).map(([id, text]) =>
            [id, { children: [new Paragraph(text)] }],
        )),
        sections: [{ children: paragraphs.map((children) => new Paragraph({ children })) }],
    });
    return renderFixture(await Packer.toArrayBuffer(source), customMarkFirst);
}

function refNumbers(container: HTMLElement): string[] {
    return Array.from(
        container.querySelectorAll("a.docx-note-ref"),
        (el) => el.textContent ?? "",
    );
}

describe("DOCX notes", () => {
    it("resolves citation links from their owning note relationships, even with body ID collisions", async () => {
        const link = (text: string, url: string) => new ExternalHyperlink({ link: url, children: [new TextRun(text)] });
        const source = new Document({
            footnotes: { 1: { children: [new Paragraph({ children: [
                link("Case pinpoint", "https://example.test/case#par73"),
            ] })] } },
            sections: [{ children: [new Paragraph({ children: [
                link("Body link", "https://example.test/body"), new FootnoteReferenceRun(1),
            ] })] }],
        });
        const zip = await JSZip.loadAsync(await Packer.toArrayBuffer(source));
        for (const part of ["document", "footnotes"]) {
            const path = `word/${part}.xml`, rels = `word/_rels/${part}.xml.rels`;
            const xml = await zip.file(path)!.async("string");
            const id = /<w:hyperlink\b[^>]*r:id="([^"]+)"/u.exec(xml)![1];
            zip.file(path, xml.replace(`r:id="${id}"`, 'r:id="shared-link"'));
            zip.file(rels, (await zip.file(rels)!.async("string")).replace(`Id="${id}"`, 'Id="shared-link"'));
        }
        const container = await renderFixture(await zip.generateAsync({ type: "arraybuffer" }));
        const links = [...container.querySelectorAll<HTMLAnchorElement>("a")];
        expect(links.find((a) => a.textContent === "Body link")).toHaveAttribute("href", "https://example.test/body");
        expect(links.find((a) => a.textContent === "Case pinpoint")).toHaveAttribute("href", "https://example.test/case#par73");
        const ref = container.querySelector<HTMLAnchorElement>(".docx-note-ref")!;
        expect(container.querySelector(ref.getAttribute("href")!)).toHaveTextContent("Case pinpoint");
    });

    it("disables active or credential-bearing links from uploaded documents", () => {
        const container = document.createElement("div");
        container.innerHTML = `<a href="javascript:alert(1)">active</a>
            <a href="https://user:secret@example.test/">credential</a>
            <a href="https://example.test/path">safe</a><a href="#section">anchor</a>`;
        finalizeDocxDom(container);
        const links = container.querySelectorAll("a");
        expect(links[0]).not.toHaveAttribute("href");
        expect(links[1]).not.toHaveAttribute("href");
        expect(links[2]).toHaveAttribute("target", "_blank");
        expect(links[2]).toHaveAttribute("rel", "noopener noreferrer");
        expect(links[3]).toHaveAttribute("href", "#section");
    });

    it("keeps footnotes on the saved Word page that references them", async () => {
        const container = await renderNotes(
            { 1: "First page footnote", 2: "Second page footnote" },
            [
                [
                    new TextRun("First page body"), new FootnoteReferenceRun(1),
                    new TextRun({ children: [new LastRenderedPageBreak(), "Second page body"] }),
                    new FootnoteReferenceRun(2),
                ],
            ],
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

    it("numbers footnote references continuously across pages", async () => {
        // Four notes spread over three saved Word pages. Without the fix
        // docx-preview restarts its counter on each page (1, 1, 2, 1).
        const container = await renderNotes(
            {
                1: "Note one text",
                2: "Note two text",
                3: "Note three text",
                4: "Note four text",
            },
            [
                [
                    new TextRun("Page one"), new FootnoteReferenceRun(1),
                ],
                [
                    new TextRun({ children: [new LastRenderedPageBreak(), "Page two"] }),
                    new FootnoteReferenceRun(2), new TextRun(" more"), new FootnoteReferenceRun(3),
                ],
                [
                    new TextRun({ children: [new LastRenderedPageBreak(), "Page three"] }),
                    new FootnoteReferenceRun(4),
                ],
            ],
        );

        expect(container.querySelectorAll("section.docx")).toHaveLength(3);
        expect(refNumbers(container)).toEqual(["1", "2", "3", "4"]);

        // Every note body carries a label matching its reference.
        const labels = Array.from(
            container.querySelectorAll("a.docx-note-label"),
        );
        expect(labels.map((el) => el.textContent)).toEqual([
            "1",
            "2",
            "3",
            "4",
        ]);
        // ...and the labels sit in the notes, next to the note text.
        expect(labels.map((el) => el.closest("li")?.textContent?.trim())).toEqual(
            [
                "1Note one text",
                "2Note two text",
                "3Note three text",
                "4Note four text",
            ],
        );

        // Browser list numbering is suppressed so it cannot restart per page.
        for (const list of container.querySelectorAll("ol")) {
            expect(list).toHaveClass("docx-notes");
        }
    });

    it("keeps every note reachable when a page has more than four", async () => {
        const container = await renderNotes(
            {
                1: "Footnote one",
                2: "Footnote two",
                3: "Footnote three",
                4: "Footnote four",
                5: "Footnote five",
                6: "Footnote six",
                7: "Footnote seven",
                8: "Footnote eight",
                9: "Footnote nine",
            },
            [
                [
                    new TextRun("Dense first page"),
                    ...Array.from( { length: 8 }, (_, index) => new FootnoteReferenceRun(index + 1), ),
                    new TextRun({ children: [new LastRenderedPageBreak(), "Second page"] }),
                    new FootnoteReferenceRun(9),
                ],
            ],
        );

        const pages = container.querySelectorAll("section.docx");
        expect(pages).toHaveLength(2);
        expect(pages[0].querySelectorAll(".docx-notes > li")).toHaveLength(8);
        expect(pages[1].querySelectorAll(".docx-notes > li")).toHaveLength(1);
        expect(refNumbers(container)).toEqual([
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
        ]);
        for (let number = 1; number <= 9; number++) {
            const reference = container.querySelector<HTMLAnchorElement>(
                `#docx-noteref-f-${number}`,
            );
            const note = container.querySelector<HTMLLIElement>(
                `#docx-note-f-${number}`,
            );
            expect(reference?.getAttribute("href")).toBe(
                `#docx-note-f-${number}`,
            );
            expect(note?.querySelector("a")?.getAttribute("href")).toBe(
                `#docx-noteref-f-${number}`,
            );
        }
    });

    it("does not auto-number a reference with a custom mark", async () => {
        // `w:customMarkFollows` means the reference prints a symbol supplied
        // by the author (in the run right after it) instead of an auto
        // number, and does not consume one — so numbering starts at 1 on the
        // next note.
        const container = await renderNotes(
            { 1: "Star note", 2: "First numbered note", 3: "Second numbered note" },
            [
                [
                    new TextRun("Title"), new FootnoteReferenceRun(1), new TextRun("Body"),
                    new FootnoteReferenceRun(2), new FootnoteReferenceRun(3),
                ],
            ],
            true,
        );

        // The star reference renders no number at all, and does not consume
        // one either.
        expect(refNumbers(container)).toEqual(["1", "2"]);
        expect(
            Array.from(
                container.querySelectorAll("a.docx-note-label"),
                (el) => el.textContent,
            ),
        ).toEqual(["1", "2"]);
        // The custom-marked note is still rendered, just unlabelled.
        expect(container.querySelectorAll("li")).toHaveLength(3);
        expect(container).toHaveTextContent("Star note");
        expect(container.querySelectorAll("sup")).toHaveLength(2);
    });

    it("links every reference to its note and back", async () => {
        const container = await renderNotes(
            { 1: "Alpha note", 2: "Beta note", 3: "Gamma note" },
            [
                [
                    new TextRun("Body"), new FootnoteReferenceRun(1), new FootnoteReferenceRun(2),
                    new FootnoteReferenceRun(3),
                ],
            ],
        );

        const refs = Array.from(
            container.querySelectorAll<HTMLAnchorElement>("a.docx-note-ref"),
        );
        expect(refs).toHaveLength(3);
        for (const ref of refs) {
            const noteId = ref.getAttribute("href")!.slice(1);
            const note = container.querySelector(`li[id="${noteId}"]`);
            expect(note).not.toBeNull();

            const label = note!.querySelector<HTMLAnchorElement>(
                "a.docx-note-label",
            );
            expect(label).not.toBeNull();
            expect(label!.textContent).toBe(ref.textContent);
            expect(label!.getAttribute("href")).toBe(`#${ref.id}`);
            expect(ref.id).not.toBe("");
        }
    });

    it("renders a repeatedly referenced note once, keeping its number", async () => {
        const container = await renderNotes(
            { 1: "Shared note", 2: "Later note" },
            [
                [
                    new TextRun("One"), new FootnoteReferenceRun(1),
                    new TextRun({ children: [new LastRenderedPageBreak(), "Two"] }),
                    new FootnoteReferenceRun(1), new FootnoteReferenceRun(2),
                ],
            ],
        );

        // Both references to note 1 show "1"; the second reference does not
        // re-render the note body.
        expect(refNumbers(container)).toEqual(["1", "1", "2"]);
        const refs = Array.from(
            container.querySelectorAll<HTMLAnchorElement>("a.docx-note-ref"),
        );
        expect(refs[0].getAttribute("href")).toBe(refs[1].getAttribute("href"));
        // Only the first reference is a back-link target.
        expect(refs[0].id).not.toBe("");
        expect(refs[1].id).toBe("");
        expect(container.querySelectorAll("li")).toHaveLength(2);
        expect(
            container.querySelectorAll(
                `li[id="${refs[0].getAttribute("href")!.slice(1)}"]`,
            ),
        ).toHaveLength(1);
    });
});
