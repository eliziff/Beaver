import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  type DocxCitationAppearance,
  parseDocxMarkdown,
  renderDocxMarkdown,
  renderDocxMarkdownDocument,
} from "../chat/tools/docxMarkdown";

const markdown = `# Heading [@shared] {{heading}}[^missing]

Body [@body] {{paragraph}}[^keep][^missing].

> Quotation [@shared] {{quote}}[^missing]

1. Item [@list] {{item}}[^missing]
   - Nested [@shared] {{nested}}[^missing]

| Header [@header] {{header}}[^missing] | Other |
| --- | --- |
| Cell [@shared] {{cell}}[^missing] | Last [@last] {{last}}[^missing] |

<!-- pagebreak -->

{{block}}

[^keep]: Note [@shared] {{note}}.
[^unused]: Unused [@unused] {{unused}}.`;

const bodyMarkers = [
  { id: "shared", occurrence: 0 },
  { id: "body", occurrence: 0 },
  { id: "shared", occurrence: 1 },
  { id: "list", occurrence: 0 },
  { id: "shared", occurrence: 2 },
  { id: "header", occurrence: 0 },
  { id: "shared", occurrence: 3 },
  { id: "last", occurrence: 0 },
];
const inlineTags = ["heading", "paragraph", "quote", "item", "nested",
  "header", "cell", "last", "note"];
const citations = Object.fromEntries(["shared", "body", "list", "header", "last"].map((id) =>
  [id, { sources: [{ stableId: id, authority: `Authority ${id}`, shortAuthority: id,
    mainUrl: null, pinpoints: [] }] }]));

async function xml(bytes: Buffer, name: string) {
  const entry = (await JSZip.loadAsync(bytes)).file(name);
  if (!entry) throw new Error(`Missing ${name}`);
  return entry.async("string");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe("DOCX Markdown marker ownership", () => {
  it("reports the markers actually emitted in body order, then authored notes", async () => {
    const appearances: DocxCitationAppearance[] = [];
    await renderDocxMarkdown(markdown, { citations }, [], appearances);
    expect(appearances.map(({ markerId: id, occurrence, kind }) => ({ id, occurrence, kind })))
      .toEqual([...bodyMarkers.map((marker) => ({ ...marker, kind: "body" })),
        { id: "shared", occurrence: 4, kind: "footnote" }]);
    expect(appearances.at(-1)?.noteId).toBe(1);
  });

  it("removes missing notes from every body container without disturbing neighbours", () => {
    const warnings: string[] = [];
    const actual = parseDocxMarkdown(markdown, warnings);
    expect(actual).toEqual(parseDocxMarkdown(markdown.replaceAll("[^missing]", "")));
    expect(actual.footnotes.map(({ id }) => id)).toEqual(["keep"]);
    expect(warnings).toHaveLength(2);
  });

  it("binds all fields, joins only inline values, and leaves a supplied document unchanged", async () => {
    const document = freeze(parseDocxMarkdown(markdown));
    const before = structuredClone(document);
    const bytes = await renderDocxMarkdownDocument(document, {
      citations,
      values: { ...Object.fromEntries(inlineTags.map((tag) => [tag, `${tag} first\nsecond`])),
        block: "Block first\nBlock second", unused: "Do not export" },
    });
    const fields = await xml(bytes, "customXml/item1.xml");
    for (const tag of inlineTags) {
      expect(fields).toContain(`<b:field name="${tag}">${tag} first second</b:field>`);
    }
    expect(fields).toContain('<b:field name="block">Block first\nBlock second</b:field>');
    expect(fields).not.toContain("unused");
    expect((fields.match(/<b:field /gu) ?? [])).toHaveLength(inlineTags.length + 1);
    expect(await xml(bytes, "word/document.xml")).toContain('<w:t xml:space="preserve">Block second</w:t>');
    expect(await xml(bytes, "word/footnotes.xml")).toContain('<w:tag w:val="note"/>');
    expect(document).toEqual(before);
  });

  it("normalizes a reused field consistently when it occurs both inline and as a block", async () => {
    const bytes = await renderDocxMarkdown("Inline {{shared}}.\n\n{{shared}}", {
      values: { shared: "First\nSecond" },
    });
    expect(await xml(bytes, "customXml/item1.xml"))
      .toContain('<b:field name="shared">First Second</b:field>');
    expect((await xml(bytes, "word/document.xml")).match(/<w:tag w:val="shared"\/>/gu))
      .toHaveLength(2);
  });

  it("allocates generated citation notes after user notes without recursively numbering their citations", async () => {
    const bytes = await renderDocxMarkdown(markdown, { citations, citationPlacement: "footnotes" });
    const body = await xml(bytes, "word/document.xml");
    const notes = await xml(bytes, "word/footnotes.xml");
    expect([...body.matchAll(/<w:footnoteReference w:id="(\d+)"\/>/gu)].map((match) => Number(match[1])))
      .toEqual([2, 3, 1, 4, 5, 6, 7, 8, 9]);
    expect(notes).not.toContain("w:footnoteReference");
    expect([...notes.matchAll(/<w:footnote w:id="(\d+)"/gu)].map((match) => Number(match[1])))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(notes).toContain("shared, supra note 2");
  });

  it.each([false, true])("preserves table header styling, cell widths, and inline table citations (landscape=%s)", async (landscape) => {
    const bytes = await renderDocxMarkdown(
      "| Head [@shared] | Other | Last |\n| --- | --- | --- |\n| One | Two [@body] | Three |",
      { citations, landscape, citationPlacement: "after-paragraph" },
    );
    const body = await xml(bytes, "word/document.xml");
    const rows = [...body.matchAll(/<w:tr>(.*?)<\/w:tr>/gu)].map((match) => match[1]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("<w:tblHeader/>");
    expect(rows[1]).not.toContain("w:tblHeader");
    expect(rows[0].match(/w:fill="EDEDED"/gu)).toHaveLength(3);
    expect(rows[1]).not.toContain("w:fill=");
    expect(body.match(new RegExp(`<w:tcW w:type="dxa" w:w="${landscape ? 4320 : 3120}"/>`, "gu")))
      .toHaveLength(6);
    expect(body).toContain("Authority shared");
    expect(body).toContain("Authority body");
    expect(body).not.toContain('w:pStyle w:val="CitationBlock"');
  });
});
