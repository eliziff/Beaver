import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  DeletedTextRun,
  Document,
  ExternalHyperlink,
  Footer,
  FootnoteReferenceRun,
  Header,
  ImportedXmlComponent,
  InsertedTextRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  Textbox,
  TextRun,
  WidthType,
} from "docx";
import { beforeAll, describe, expect, it } from "vitest";

import { scanDocxPathology } from "../docx/pathology";
import { extractDocxStories, storiesBodyText } from "../docx/stories";
import { extractDocxBodyText } from "../docxTrackedChanges";
import { loadZip } from "../zip";

const REVISION = { author: "Counsel", date: "2026-01-01T00:00:00Z" };

type Block = Paragraph | Table;

function pack(blocks: Block[]) {
  return Packer.toBuffer(new Document({ sections: [{ children: blocks }] }));
}

/** Raw OOXML the packager has no builder for — same shape generate.ts uses. */
function imported(
  name: string,
  attributes?: Record<string, string>,
  nested: (ImportedXmlComponent | Paragraph | string)[] = [],
): ImportedXmlComponent {
  const element = new ImportedXmlComponent(name, attributes);
  nested.forEach((child) => element.push(child));
  return element;
}

function contentControl(tag: string, value: string, inline: boolean) {
  return imported("w:sdt", undefined, [
    imported("w:sdtPr", undefined, [
      imported("w:tag", { "w:val": tag }),
      imported("w:id", { "w:val": String(100 + tag.length) }),
      ...(inline ? [imported("w:text")] : []),
    ]),
    imported("w:sdtContent", undefined, [
      inline
        ? imported("w:r", undefined, [
            imported("w:t", { "xml:space": "preserve" }, [value]),
          ])
        : new Paragraph({ children: [new TextRun(value)] }),
    ]),
  ]);
}

function blockControl(tag: string, value: string) {
  return contentControl(tag, value, false) as unknown as Paragraph;
}

/** Post-pack surgery: the packager emits neither w:smartTag nor mc:AlternateContent. */
async function rewriteDocumentXml(
  bytes: Buffer,
  rewrite: (xml: string) => string,
): Promise<Buffer> {
  const zip = await loadZip(bytes);
  const xml = await zip.file("word/document.xml")!.async("text");
  const next = rewrite(xml);
  if (next === xml) throw new Error("document.xml rewrite matched nothing");
  zip.file("word/document.xml", next);
  return zip.generateAsync({ type: "nodebuffer" });
}

const builders: Record<string, () => Promise<Buffer>> = {
  /** Plain prose, including an empty paragraph. */
  plain: () =>
    pack([
      new Paragraph({ children: [new TextRun("This agreement is made as of the date below.")] }),
      new Paragraph({ children: [] }),
      new Paragraph({ children: [new TextRun("Each party bears its own costs.")] }),
    ]),

  /** Column span plus a nested table — the w:tbl/w:tr/w:tc descent. */
  tables: () =>
    pack([
      new Paragraph({ children: [new TextRun("Payments.")] }),
      new Table({
        width: { size: 9000, type: WidthType.DXA },
        rows: [
          new TableRow({
            children: [
              new TableCell({ columnSpan: 2, children: [new Paragraph("Consideration")] }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph("Instalment")] }),
              new TableCell({
                children: [
                  new Table({
                    width: { size: 3000, type: WidthType.DXA },
                    rows: [
                      new TableRow({
                        children: [new TableCell({ children: [new Paragraph("On closing")] })],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ]),

  /** One block-level and one inline w:sdt. */
  "content-controls": () =>
    pack([
      blockControl("party_name", "Northwind Holdings Inc."),
      new Paragraph({
        children: [
          new TextRun("The purchaser is "),
          contentControl("purchaser", "Lakeshore Capital", true) as never,
          new TextRun("."),
        ],
      }),
    ]),

  /** w:ins and w:del in the body. */
  "tracked-changes": () =>
    Packer.toBuffer(
      new Document({
        features: { trackRevisions: true },
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new TextRun("The seat of arbitration is "),
                  new InsertedTextRun({ text: "Toronto", id: 1, ...REVISION }),
                  new DeletedTextRun({ text: "Zurich", id: 2, ...REVISION }),
                  new TextRun("."),
                ],
              }),
              new Paragraph({
                children: [
                  new TextRun("Costs follow "),
                  new InsertedTextRun({ text: "the cause", id: 3, ...REVISION }),
                  new TextRun("."),
                ],
              }),
            ],
          },
        ],
      }),
    ),

  /** A hyperlink carrying visible text — the invisibility defect. */
  hyperlink: () =>
    pack([
      new Paragraph({
        children: [
          new ExternalHyperlink({
            link: "https://example.org/statute",
            children: [new TextRun({ text: "the Act", style: "Hyperlink" })],
          }),
          new TextRun(" applies to this transaction."),
        ],
      }),
    ]),

  /** w:txbxContent text that body extraction never reaches. */
  "text-box": () =>
    pack([
      new Paragraph({ children: [new TextRun("The parties agree as follows.")] }),
      new Textbox({ children: [new TextRun("Draft only - not for execution.")] }),
    ]),

  /** The same text box written twice, mc:Choice and mc:Fallback. */
  "text-box-alternate-content": async () =>
    rewriteDocumentXml(
      await pack([
        new Paragraph({ children: [new TextRun("The parties agree as follows.")] }),
        new Textbox({ children: [new TextRun("Draft only - not for execution.")] }),
      ]),
      (xml) => {
        const start = xml.indexOf("<w:pict>");
        const end = xml.indexOf("</w:pict>") + "</w:pict>".length;
        const pict = xml.slice(start, end);
        return `${xml.slice(0, start)}<mc:AlternateContent><mc:Choice Requires="wps">${pict}</mc:Choice><mc:Fallback>${pict}</mc:Fallback></mc:AlternateContent>${xml.slice(end)}`;
      },
    ),

  /** w:smartTag wrapping a run — the other descent body extraction skips. */
  "smart-tag": async () =>
    rewriteDocumentXml(
      await pack([
        new Paragraph({
          children: [
            new TextRun("Registered in "),
            new TextRun("Ontario"),
            new TextRun("."),
          ],
        }),
      ]),
      (xml) =>
        xml.replace(
          '<w:r><w:t xml:space="preserve">Ontario</w:t></w:r>',
          '<w:smartTag w:uri="urn:schemas-microsoft-com:office:smarttags" w:element="place"><w:r><w:t xml:space="preserve">Ontario</w:t></w:r></w:smartTag>',
        ),
    ),

  /** Two footnotes and one endnote, alongside the separators that are not content. */
  footnotes: () =>
    Packer.toBuffer(
      new Document({
        footnotes: {
          1: { children: [new Paragraph("See Schedule B.")] },
          2: { children: [new Paragraph("As amended.")] },
        },
        endnotes: { 1: { children: [new Paragraph("Definitions apply throughout.")] } },
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new TextRun("The consideration is set out below."),
                  new FootnoteReferenceRun(1),
                  new FootnoteReferenceRun(2),
                ],
              }),
            ],
          },
        ],
      }),
    ),

  /** Literal text in a header and a footer. */
  "header-footer": () =>
    Packer.toBuffer(
      new Document({
        sections: [
          {
            headers: {
              default: new Header({ children: [new Paragraph("PRIVILEGED AND CONFIDENTIAL")] }),
            },
            footers: { default: new Footer({ children: [new Paragraph("Execution version")] }) },
            children: [new Paragraph({ children: [new TextRun("Recitals.")] })],
          },
        ],
      }),
    ),

  /** Manual redline: strike and colour, no tracked-change markup. */
  "manual-redline": () =>
    pack([
      new Paragraph({
        children: [
          new TextRun("The notice period is "),
          new TextRun({ text: "sixty (60) days", color: "FF0000", strike: true }),
          new TextRun({ text: "thirty (30) days", color: "C00000" }),
          new TextRun({ text: " in writing.", color: "auto" }),
        ],
      }),
    ]),
};

/** Fixtures whose body carries no hyperlink and no smart tag. */
const PARITY_FIXTURES = [
  "plain",
  "tables",
  "content-controls",
  "tracked-changes",
  "text-box",
  "text-box-alternate-content",
  "footnotes",
  "header-footer",
  "manual-redline",
];

/**
 * Real documents from the harvey-labs corpus, all reported hyperlinks:0 by
 * the sniffer and carrying no w:smartTag — chosen to span heavy tracked
 * changes, many tables, and plain prose.
 */
const REAL_DOCS = [
  "benchmarks/harvey-labs/tasks/antitrust-competition/analyze-counterparty-markup-of-protective-order/documents/doj-redline-markup.docx",
  "benchmarks/harvey-labs/tasks/banking-finance/analyze-credit-agreement-markup/documents/borrower-markup-v2.docx",
  "benchmarks/harvey-labs/tasks/capital-markets/analyze-counterparty-markup-of-underwriting-agreement/documents/underwriter-redline-ua.docx",
  "benchmarks/harvey-labs/tasks/real-estate/compare-property-tax-records-against-seller-disclosure-statement/documents/tax-record-property-b.docx",
  "benchmarks/harvey-labs/tasks/energy-natural-resources/compare-power-purchase-agreement-against-term-sheet/documents/binding-term-sheet.docx",
];

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const CORPUS_PRESENT = existsSync(path.join(REPO_ROOT, "benchmarks", "harvey-labs", "tasks"));

const packages = new Map<string, Buffer>();

function fixture(name: string) {
  const found = packages.get(name);
  if (!found) throw new Error(`missing fixture ${name}`);
  return found;
}

beforeAll(async () => {
  for (const [name, build] of Object.entries(builders)) {
    packages.set(name, await build());
  }
}, 60_000);

describe("storiesBodyText byte parity with extractDocxBodyText", () => {
  it.each(PARITY_FIXTURES)(
    "matches on the %s fixture",
    async (name) => {
      const bytes = fixture(name);
      // The parity claim only holds where the extra descents cannot bite.
      expect((await scanDocxPathology(bytes)).hyperlinks.count).toBe(0);
      const stories = await extractDocxStories(bytes);
      expect(stories.notes).toEqual([]);
      expect(storiesBodyText(stories)).toBe(await extractDocxBodyText(bytes));
    },
  );

  it.skipIf(!CORPUS_PRESENT).each(REAL_DOCS)("matches on %s", async (relative) => {
    const bytes = await readFile(path.join(REPO_ROOT, relative));
    expect((await scanDocxPathology(bytes)).hyperlinks.count).toBe(0);
    const expected = await extractDocxBodyText(bytes);
    const stories = await extractDocxStories(bytes);
    expect(stories.notes).toEqual([]);
    // A real document that produced no text would pass parity vacuously.
    expect(expected.length).toBeGreaterThan(1000);
    expect(storiesBodyText(stories)).toBe(expected);
  });
});

describe("the invisibility defects the stories layer fixes", () => {
  it("reads hyperlink text that body extraction drops, with its target", async () => {
    const bytes = fixture("hyperlink");
    const bodyText = await extractDocxBodyText(bytes);
    const stories = await extractDocxStories(bytes);
    const storiesText = storiesBodyText(stories);

    expect(bodyText).not.toContain("the Act");
    expect(bodyText).toBe(" applies to this transaction.");
    expect(storiesText).toContain("the Act");
    expect(storiesText).toBe("the Act applies to this transaction.");

    const linked = stories.body[0].runs.filter((run) => run.hyperlink !== null);
    expect(linked).toHaveLength(1);
    expect(linked[0].text).toBe("the Act");
    expect(linked[0].hyperlink).toBe("https://example.org/statute");
    // The plain run beside it carries no target.
    expect(stories.body[0].runs.at(-1)?.hyperlink).toBeNull();
  });

  it("leaves the hyperlink target null when the relationship is undefined", async () => {
    const bytes = await rewriteDocumentXml(fixture("hyperlink"), (xml) =>
      xml.replace(/r:id="[^"]*"/u, 'r:id="rIdMissing"'),
    );
    const stories = await extractDocxStories(bytes);
    expect(storiesBodyText(stories)).toBe("the Act applies to this transaction.");
    expect(stories.body[0].runs[0].hyperlink).toBeNull();
    expect(stories.notes).toEqual([
      "A hyperlink points at relationship rIdMissing, which this package does not define; its target is unknown.",
    ]);
  });

  it("reads smart-tag text that body extraction drops", async () => {
    const bytes = fixture("smart-tag");
    expect(await extractDocxBodyText(bytes)).toBe("Registered in .");
    expect(storiesBodyText(await extractDocxStories(bytes))).toBe(
      "Registered in Ontario.",
    );
  });

  it("puts text-box content in textBoxes and keeps it out of the body", async () => {
    const bytes = fixture("text-box");
    const stories = await extractDocxStories(bytes);
    const bodyText = storiesBodyText(stories);

    expect(stories.textBoxes).toHaveLength(1);
    expect(stories.textBoxes[0].map((p) => p.text)).toEqual([
      "Draft only - not for execution.",
    ]);
    expect(bodyText).not.toContain("Draft only");
    // The drawing still occupies a paragraph, so the empty line stays.
    expect(bodyText).toBe("The parties agree as follows.\n");
    expect(bodyText).toBe(await extractDocxBodyText(bytes));
  });

  it("counts an mc:Choice/mc:Fallback text box once", async () => {
    const stories = await extractDocxStories(fixture("text-box-alternate-content"));
    expect(stories.textBoxes).toHaveLength(1);
    expect(stories.textBoxes[0][0].text).toBe("Draft only - not for execution.");
  });
});

describe("note stories", () => {
  it("extracts both footnotes and the endnote, excluding the separators", async () => {
    const stories = await extractDocxStories(fixture("footnotes"));

    expect(stories.footnotes.size).toBe(2);
    expect([...stories.footnotes.values()].map((paras) => paras[0].text)).toEqual([
      "See Schedule B.",
      "As amended.",
    ]);
    // Separator and continuation notes ship with every package and carry
    // w:id -1 and 0; content notes start at 1.
    expect([...stories.footnotes.keys()]).toEqual(["1", "2"]);

    expect(stories.endnotes.size).toBe(1);
    expect([...stories.endnotes.values()][0][0].text).toBe(
      "Definitions apply throughout.",
    );
    // Note text is not body text.
    expect(storiesBodyText(stories)).toBe("The consideration is set out below.");
  });

  it("extracts header and footer stories", async () => {
    const stories = await extractDocxStories(fixture("header-footer"));
    expect(stories.headers.flat().map((p) => p.text)).toContain(
      "PRIVILEGED AND CONFIDENTIAL",
    );
    expect(stories.footers.flat().map((p) => p.text)).toContain("Execution version");
    expect(storiesBodyText(stories)).toBe("Recitals.");
  });
});

describe("run redline state", () => {
  it("includes inserted runs and excludes deleted ones from the body text", async () => {
    const stories = await extractDocxStories(fixture("tracked-changes"));
    const runs = stories.body[0].runs;

    const inserted = runs.filter((run) => run.ins);
    const deleted = runs.filter((run) => run.del);
    expect(inserted.map((run) => run.text)).toEqual(["Toronto"]);
    expect(deleted.map((run) => run.text)).toEqual(["Zurich"]);

    const text = storiesBodyText(stories);
    expect(text).toContain("Toronto");
    expect(text).not.toContain("Zurich");
    expect(stories.body[0].text).toBe("The seat of arbitration is Toronto.");
    // The deleted run is kept for the redline layer, not thrown away.
    expect(runs.map((run) => run.text).join("")).toBe(
      "The seat of arbitration is TorontoZurich.",
    );
  });

  it("keeps text equal to the non-deleted runs on every paragraph", async () => {
    for (const name of PARITY_FIXTURES) {
      const stories = await extractDocxStories(fixture(name));
      const everyStory = [
        stories.body,
        ...stories.footnotes.values(),
        ...stories.endnotes.values(),
        ...stories.headers,
        ...stories.footers,
        ...stories.textBoxes,
      ];
      for (const paragraphs of everyStory) {
        for (const paragraph of paragraphs) {
          expect(paragraph.text).toBe(
            paragraph.runs
              .filter((run) => !run.del)
              .map((run) => run.text)
              .join(""),
          );
        }
      }
    }
  });

  it("records strike and colour, treating auto as no colour", async () => {
    const runs = (await extractDocxStories(fixture("manual-redline"))).body[0].runs;
    expect(
      runs.map((run) => ({ text: run.text, strike: run.strike, color: run.color })),
    ).toEqual([
      { text: "The notice period is ", strike: false, color: null },
      { text: "sixty (60) days", strike: true, color: "FF0000" },
      { text: "thirty (30) days", strike: false, color: "C00000" },
      { text: " in writing.", strike: false, color: null },
    ]);
  });
});

describe("bounds discipline", () => {
  it("degrades to empty stories and a note rather than throwing", async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from("not a zip at all")]) {
      const stories = await extractDocxStories(bytes);
      expect(stories.body).toEqual([]);
      expect(stories.textBoxes).toEqual([]);
      expect(stories.footnotes.size).toBe(0);
      expect(stories.notes).toHaveLength(1);
      expect(stories.notes[0]).toMatch(/^Package could not be read: /u);
      expect(storiesBodyText(stories)).toBe("");
    }
  });

  it("reports a package with no word/document.xml instead of failing", async () => {
    const zip = await loadZip(fixture("plain"));
    zip.remove("word/document.xml");
    const stories = await extractDocxStories(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    expect(stories.body).toEqual([]);
    expect(stories.notes).toEqual([
      "Package has no readable word/document.xml; the body story is empty.",
    ]);
    // Body extraction is silent about the same package; the note is the gain.
    expect(await extractDocxBodyText(fixture("plain"))).not.toBe("");
  });
});
