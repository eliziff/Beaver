import {
  AlignmentType,
  Document,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  type ILevelsOptions,
} from "docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  applyNumberingToText,
  formatNumberingValue,
  resolveDocxNumbering,
} from "../docx/numbering";
import { extractDocxBodyText } from "../docxTrackedChanges";

type Item = { level: number; text: string } | { plain: string };

/** One numbering config, one section — the probe-numbering-fidelity shape. */
async function buildFixture(
  levels: readonly ILevelsOptions[],
  items: readonly Item[],
): Promise<Buffer> {
  const doc = new Document({
    numbering: { config: [{ reference: "sections", levels }] },
    sections: [
      {
        children: items.map((item) =>
          "plain" in item
            ? new Paragraph({ children: [new TextRun(item.plain)] })
            : new Paragraph({
                numbering: { reference: "sections", level: item.level },
                children: [new TextRun(item.text)],
              }),
        ),
      },
    ],
  });
  return Packer.toBuffer(doc).then((value) => Buffer.from(value));
}

/** Rewrites package entries in place; the `docx` lib cannot emit every shape. */
async function patchPackage(
  bytes: Buffer,
  edits: Record<string, (xml: string) => string>,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  for (const [path, edit] of Object.entries(edits)) {
    const entry = zip.file(path);
    if (!entry) throw new Error(`fixture has no ${path}`);
    zip.file(path, edit(await entry.async("text")));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

const decimalLevels: ILevelsOptions[] = [
  {
    level: 0,
    format: LevelFormat.DECIMAL,
    text: "%1.",
    alignment: AlignmentType.START,
  },
  {
    level: 1,
    format: LevelFormat.DECIMAL,
    text: "%1.%2",
    alignment: AlignmentType.START,
  },
];

describe("resolveDocxNumbering counters", () => {
  it("numbers two decimal levels and restarts the deeper one", async () => {
    const bytes = await buildFixture(decimalLevels, [
      { level: 0, text: "Definitions" },
      { level: 1, text: "Rent means the annual basic rent." },
      { level: 0, text: "Payment" },
      { level: 1, text: "The Tenant shall pay Rent." },
    ]);
    const { labels, notes } = await resolveDocxNumbering(bytes);
    expect([...labels.entries()]).toEqual([
      [0, "1."],
      [1, "1.1"],
      [2, "2."],
      [3, "2.1"],
    ]);
    expect(notes).toEqual([]);
  });

  it("keeps a deeper level running until a higher level is entered", async () => {
    const bytes = await buildFixture(decimalLevels, [
      { level: 0, text: "One" },
      { level: 1, text: "One one" },
      { level: 1, text: "One two" },
      { level: 1, text: "One three" },
      { level: 0, text: "Two" },
      { level: 1, text: "Two one" },
    ]);
    const { labels } = await resolveDocxNumbering(bytes);
    expect([...labels.values()]).toEqual([
      "1.",
      "1.1",
      "1.2",
      "1.3",
      "2.",
      "2.1",
    ]);
  });
});

describe("resolveDocxNumbering formats", () => {
  it("renders letter and roman levels", async () => {
    // %1 is level 0 and %2 is level 1: a level that prints its own counter
    // must name its own placeholder, whatever its nesting depth.
    const bytes = await buildFixture(
      [
        {
          level: 0,
          format: LevelFormat.LOWER_LETTER,
          text: "(%1)",
          alignment: AlignmentType.START,
        },
        {
          level: 1,
          format: LevelFormat.LOWER_ROMAN,
          text: "(%2)",
          alignment: AlignmentType.START,
        },
      ],
      [
        { level: 0, text: "First" },
        { level: 1, text: "First inner" },
        { level: 1, text: "Second inner" },
        { level: 0, text: "Second" },
        { level: 1, text: "Third inner" },
      ],
    );
    const { labels, notes } = await resolveDocxNumbering(bytes);
    expect([...labels.values()]).toEqual([
      "(a)",
      "(i)",
      "(ii)",
      "(b)",
      "(i)",
    ]);
    expect(notes).toEqual([]);
  });

  it("renders upper roman inside literal lvlText", async () => {
    const bytes = await buildFixture(
      [
        {
          level: 0,
          format: LevelFormat.UPPER_ROMAN,
          text: "Article %1",
          alignment: AlignmentType.START,
        },
      ],
      [
        { level: 0, text: "Definitions" },
        { level: 0, text: "Payment" },
        { level: 0, text: "Term" },
      ],
    );
    const { labels } = await resolveDocxNumbering(bytes);
    expect([...labels.values()]).toEqual([
      "Article I",
      "Article II",
      "Article III",
    ]);
  });

  it("formats values past the single-glyph range", () => {
    expect(formatNumberingValue(49, "lowerRoman")).toBe("xlix");
    expect(formatNumberingValue(49, "upperRoman")).toBe("XLIX");
    expect(formatNumberingValue(28, "lowerLetter")).toBe("ab");
    expect(formatNumberingValue(28, "upperLetter")).toBe("AB");
    expect(formatNumberingValue(26, "lowerLetter")).toBe("z");
    expect(formatNumberingValue(27, "lowerLetter")).toBe("aa");
    expect(formatNumberingValue(4, "decimalZero")).toBe("04");
    expect(formatNumberingValue(10, "decimalZero")).toBe("10");
    expect(formatNumberingValue(1, "ordinalText")).toBeNull();
  });
});

describe("resolveDocxNumbering starts", () => {
  it("starts a level at w:start", async () => {
    const bytes = await buildFixture(
      [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.START,
          start: 5,
        },
      ],
      [
        { level: 0, text: "Fifth" },
        { level: 0, text: "Sixth" },
      ],
    );
    const zip = await JSZip.loadAsync(bytes);
    const numbering = await zip.file("word/numbering.xml")!.async("text");
    expect(numbering).toContain('<w:start w:val="5"/>');
    const { labels } = await resolveDocxNumbering(bytes);
    expect([...labels.values()]).toEqual(["5.", "6."]);
  });

  it("lets w:startOverride beat the abstract w:start", async () => {
    const base = await buildFixture(
      [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.START,
          start: 5,
        },
      ],
      [
        { level: 0, text: "Ninth" },
        { level: 0, text: "Tenth" },
      ],
    );
    // The `docx` lib mirrors w:start into the override; move them apart.
    const bytes = await patchPackage(base, {
      "word/numbering.xml": (xml) =>
        xml.replace('<w:startOverride w:val="5"/>', '<w:startOverride w:val="9"/>'),
    });
    const { labels } = await resolveDocxNumbering(bytes);
    expect([...labels.values()]).toEqual(["9.", "10."]);
  });
});

describe("resolveDocxNumbering unsupported formats", () => {
  it("leaves ordinalText unlabelled and says so once", async () => {
    const bytes = await buildFixture(
      [
        {
          level: 0,
          format: LevelFormat.ORDINAL_TEXT,
          text: "%1",
          alignment: AlignmentType.START,
        },
      ],
      [
        { level: 0, text: "First clause." },
        { level: 0, text: "Second clause." },
      ],
    );
    const { labels, notes } = await resolveDocxNumbering(bytes);
    expect(labels.size).toBe(0);
    expect(notes).toEqual([
      'Numbering format "ordinalText" is not rendered here; those paragraphs carry no label.',
    ]);
  });

  it("skips bullets without a note", async () => {
    const bytes = await buildFixture(
      [
        {
          level: 0,
          format: LevelFormat.BULLET,
          text: "●",
          alignment: AlignmentType.START,
        },
      ],
      [
        { level: 0, text: "First bullet." },
        { level: 0, text: "Second bullet." },
      ],
    );
    const { labels, notes } = await resolveDocxNumbering(bytes);
    expect(labels.size).toBe(0);
    expect(notes).toEqual([]);
  });

  it("degrades to an empty map on unreadable bytes", async () => {
    const { labels, notes } = await resolveDocxNumbering(
      Buffer.from("not a zip"),
    );
    expect(labels.size).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^Numbering could not be resolved: /u);
  });
});

describe("resolveDocxNumbering paragraph indexes", () => {
  it("indexes the same paragraphs extractDocxBodyText emits", async () => {
    const bytes = await buildFixture(decimalLevels, [
      { plain: "This agreement is dated 1 March 2026." },
      { level: 0, text: "Definitions" },
      { plain: "In this agreement the following terms apply." },
      { level: 1, text: "Rent means the annual basic rent." },
      { level: 0, text: "Payment" },
      { level: 1, text: "The Tenant shall pay Rent." },
      { plain: "Signed by the parties." },
    ]);
    const text = await extractDocxBodyText(bytes);
    const paragraphs = text.split("\n");
    const { labels } = await resolveDocxNumbering(bytes);

    expect(paragraphs).toHaveLength(7);
    expect([...labels.entries()]).toEqual([
      [1, "1."],
      [3, "1.1"],
      [4, "2."],
      [5, "2.1"],
    ]);
    for (const [index, label] of labels) {
      expect({ label, sentence: paragraphs[index] }).toEqual(
        {
          1: { label: "1.", sentence: "Definitions" },
          3: {
            label: "1.1",
            sentence: "Rent means the annual basic rent.",
          },
          4: { label: "2.", sentence: "Payment" },
          5: { label: "2.1", sentence: "The Tenant shall pay Rent." },
        }[index],
      );
    }

    expect(applyNumberingToText(text, labels).split("\n")).toEqual([
      "This agreement is dated 1 March 2026.",
      "1. Definitions",
      "In this agreement the following terms apply.",
      "1.1 Rent means the annual basic rent.",
      "2. Payment",
      "2.1 The Tenant shall pay Rent.",
      "Signed by the parties.",
    ]);
  });

  it("counts table and content-control paragraphs the way the flattener does", async () => {
    const numbered = (text: string, level: number) =>
      new Paragraph({
        numbering: { reference: "sections", level },
        children: [new TextRun(text)],
      });
    const doc = new Document({
      numbering: { config: [{ reference: "sections", levels: decimalLevels }] },
      sections: [
        {
          children: [
            numbered("Before the table", 0),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [numbered("Cell one", 1)] }),
                    new TableCell({ children: [numbered("Cell two", 1)] }),
                  ],
                }),
              ],
            }),
            numbered("After the table", 0),
          ],
        },
      ],
    });
    // Word puts body content inside w:sdt; the `docx` lib cannot, so wrap the
    // whole body after packing. Both walks must still agree on the indexes.
    const bytes = await patchPackage(
      Buffer.from(await Packer.toBuffer(doc)),
      {
        "word/document.xml": (xml) =>
          xml
            .replace("<w:body>", "<w:body><w:sdt><w:sdtContent>")
            .replace("<w:sectPr>", "</w:sdtContent></w:sdt><w:sectPr>"),
      },
    );

    const text = await extractDocxBodyText(bytes);
    const { labels } = await resolveDocxNumbering(bytes);
    expect(applyNumberingToText(text, labels).split("\n")).toEqual([
      "1. Before the table",
      "1.1 Cell one",
      "1.2 Cell two",
      "2. After the table",
    ]);
  });
});

describe("resolveDocxNumbering style-referenced numbering", () => {
  it("numbers paragraphs whose style carries the numPr", async () => {
    // The `docx` lib drops `numbering` on a paragraph style (it emits neither
    // the style w:numPr nor a concrete w:num), so the reference is moved from
    // the paragraphs into styles.xml after packing.
    const base = await buildFixture(
      [
        {
          level: 0,
          format: LevelFormat.UPPER_ROMAN,
          text: "Article %1",
          alignment: AlignmentType.START,
        },
      ],
      [
        { level: 0, text: "Interpretation." },
        { level: 0, text: "Grant of rights." },
        { level: 0, text: "Termination." },
      ],
    );
    const zip = await JSZip.loadAsync(base);
    const original = await zip.file("word/document.xml")!.async("text");
    const numId = /<w:numId w:val="(\d+)"\/>/u.exec(original)?.[1];
    expect(numId).toBeDefined();

    const bytes = await patchPackage(base, {
      // Third paragraph inherits the numbering through w:basedOn.
      "word/document.xml": (xml) =>
        xml
          .replace(/<w:numPr>[\s\S]*?<\/w:numPr>/gu, "")
          .replace(/<w:pStyle w:val="ListParagraph"\/>/gu, '<w:pStyle w:val="ArticleHead"/>')
          .replace(
            /<w:pStyle w:val="ArticleHead"\/>(?![\s\S]*<w:pStyle w:val="ArticleHead"\/>)/u,
            '<w:pStyle w:val="ArticleHeadAlt"/>',
          ),
      "word/styles.xml": (xml) =>
        xml.replace(
          "</w:styles>",
          `<w:style w:type="paragraph" w:styleId="ArticleHead"><w:name w:val="Article Head"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr></w:style>` +
            `<w:style w:type="paragraph" w:styleId="ArticleHeadAlt"><w:name w:val="Article Head Alt"/><w:basedOn w:val="ArticleHead"/></w:style>` +
            "</w:styles>",
        ),
    });

    // The fixture is only honest if no paragraph carries its own numPr.
    const patched = await (await JSZip.loadAsync(bytes))
      .file("word/document.xml")!
      .async("text");
    expect(patched).not.toContain("<w:numPr>");

    const { labels, notes } = await resolveDocxNumbering(bytes);
    expect([...labels.entries()]).toEqual([
      [0, "Article I"],
      [1, "Article II"],
      [2, "Article III"],
    ]);
    expect(notes).toEqual([]);
  });

  it("drops numbering when a paragraph sets numId 0", async () => {
    const base = await buildFixture(decimalLevels, [
      { level: 0, text: "Numbered." },
      { level: 0, text: "Cancelled." },
    ]);
    const bytes = await patchPackage(base, {
      "word/document.xml": (xml) =>
        xml.replace(
          /(<w:numId w:val="\d+"\/>)(?![\s\S]*<w:numId w:val="\d+"\/>)/u,
          '<w:numId w:val="0"/>',
        ),
    });
    const { labels, notes } = await resolveDocxNumbering(bytes);
    expect([...labels.entries()]).toEqual([[0, "1."]]);
    expect(notes).toEqual([]);
  });
});
