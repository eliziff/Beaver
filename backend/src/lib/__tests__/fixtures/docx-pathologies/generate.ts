import {
  AlignmentType,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document,
  ExternalHyperlink,
  Footer,
  FootnoteReferenceRun,
  Header,
  ImportedXmlComponent,
  InsertedTextRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  Textbox,
  TextRun,
  WidthType,
} from "docx";

import { loadZip } from "../../../zip";

/**
 * One tiny DOCX per pathology, built rather than committed, so the
 * matrix tracks whatever markup this packager version actually emits.
 */

const REVISION = { author: "Counsel", date: "2026-01-01T00:00:00Z" };

type Block = Paragraph | Table;

/** Raw OOXML the packager has no builder for — the w:sdt shape. */
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

/** A block-level w:sdt stands where a Paragraph would. */
function blockControl(tag: string, value: string) {
  return contentControl(tag, value, false) as unknown as Paragraph;
}

const NUMBERING = {
  config: [
    {
      reference: "clauses",
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.START,
        },
        {
          level: 1,
          format: LevelFormat.LOWER_LETTER,
          text: "(%2)",
          alignment: AlignmentType.START,
        },
      ],
    },
  ],
};

function pack(blocks: Block[]) {
  return Packer.toBuffer(new Document({ sections: [{ children: blocks }] }));
}

/**
 * Every package this packager writes carries a numbering part whether or
 * not anything references it, so the negative control drops it — and the
 * two parts that point at it.
 */
async function withoutNumberingPart(bytes: Buffer): Promise<Buffer> {
  const zip = await loadZip(bytes);
  zip.remove("word/numbering.xml");
  const types = await zip.file("[Content_Types].xml")!.async("text");
  zip.file(
    "[Content_Types].xml",
    types.replace(/<Override[^>]*PartName="\/word\/numbering\.xml"\/>/u, ""),
  );
  const rels = await zip.file("word/_rels/document.xml.rels")!.async("text");
  zip.file(
    "word/_rels/document.xml.rels",
    rels.replace(/<Relationship[^>]*Target="numbering\.xml"\/>/u, ""),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

/** The packager has no OLE builder; the part is what the scan counts. */
async function withEmbeddedObject(bytes: Buffer): Promise<Buffer> {
  const zip = await loadZip(bytes);
  zip.file("word/embeddings/oleObject1.bin", Buffer.from("OLE-PLACEHOLDER"));
  const types = await zip.file("[Content_Types].xml")!.async("text");
  zip.file(
    "[Content_Types].xml",
    types.replace(
      "<Default ContentType=\"application/xml\" Extension=\"xml\"/>",
      "<Default ContentType=\"application/xml\" Extension=\"xml\"/><Default ContentType=\"application/vnd.openxmlformats-officedocument.oleObject\" Extension=\"bin\"/>",
    ),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

export const pathologyFixtureBuilders: Record<
  string,
  () => Promise<Buffer>
> = {
  /** Negative control: no numbering part, no pathology of any kind. */
  clean: async () =>
    withoutNumberingPart(
      await pack([
        new Paragraph({
          children: [new TextRun("This agreement is made as of the date below.")],
        }),
        new Paragraph({
          children: [new TextRun("Each party bears its own costs.")],
        }),
      ]),
    ),

  /** Strike and red colour standing in for tracked-change markup. */
  "manual-red-strike-redline": () =>
    pack([
      new Paragraph({
        children: [
          new TextRun("The notice period is "),
          new TextRun({ text: "sixty (60) days", color: "FF0000", strike: true }),
          new TextRun({ text: "thirty (30) days", color: "C00000" }),
          new TextRun({ text: "or such longer period", strike: true }),
          new TextRun({ text: "as agreed", color: "0000FF" }),
          new TextRun({ text: " in writing.", color: "auto" }),
        ],
      }),
    ]),

  /** Numbers live in the numbering part; the text carries none. */
  "auto-numbered": () =>
    Packer.toBuffer(
      new Document({
        numbering: NUMBERING,
        sections: [
          {
            children: [
              new Paragraph({
                numbering: { reference: "clauses", level: 0 },
                children: [new TextRun("Definitions.")],
              }),
              new Paragraph({
                numbering: { reference: "clauses", level: 1 },
                children: [new TextRun("Affiliate has the meaning given.")],
              }),
              new Paragraph({
                numbering: { reference: "clauses", level: 0 },
                children: [new TextRun("Governing law.")],
              }),
            ],
          },
        ],
      }),
    ),

  /** w:ins and w:del, with change recording left switched on. */
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

  /** Comments live in their own part and are not body text. */
  comments: () =>
    Packer.toBuffer(
      new Document({
        comments: {
          children: [
            {
              id: 0,
              author: "Counsel",
              date: new Date("2026-01-01T00:00:00Z"),
              children: [new Paragraph("Confirm the governing law.")],
            },
            {
              id: 1,
              author: "Counsel",
              date: new Date("2026-01-01T00:00:00Z"),
              children: [new Paragraph("Check against the term sheet.")],
            },
          ],
        },
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new CommentRangeStart(0),
                  new TextRun("This agreement is governed by Ontario law."),
                  new CommentRangeEnd(0),
                  new TextRun({ children: [new CommentReference(0)] }),
                ],
              }),
              new Paragraph({
                children: [
                  new CommentRangeStart(1),
                  new TextRun("The purchase price is set out in Schedule A."),
                  new CommentRangeEnd(1),
                  new TextRun({ children: [new CommentReference(1)] }),
                ],
              }),
            ],
          },
        ],
      }),
    ),

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

  /** A hyperlink that does carry visible text. */
  "hyperlink-with-text": () =>
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
      new Textbox({
        children: [new TextRun("Draft only - not for execution.")],
      }),
    ]),

  /** Column and row spans, no nesting. */
  "merged-table": () =>
    pack([
      new Table({
        width: { size: 9000, type: WidthType.DXA },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                columnSpan: 2,
                children: [new Paragraph("Consideration")],
              }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({
                rowSpan: 2,
                children: [new Paragraph("Cash")],
              }),
              new TableCell({ children: [new Paragraph("On closing")] }),
            ],
          }),
          new TableRow({
            children: [new TableCell({ children: [new Paragraph("Deferred")] })],
          }),
        ],
      }),
    ]),

  /** Field codes only: a footer with no literal text of its own. */
  fields: () =>
    Packer.toBuffer(
      new Document({
        sections: [
          {
            footers: {
              default: new Footer({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({ children: [PageNumber.CURRENT] }),
                      new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
                    ],
                  }),
                ],
              }),
            },
            children: [
              new Paragraph({ children: [new TextRun("Schedule A follows.")] }),
            ],
          },
        ],
      }),
    ),

  /** Literal text in both a header and a footer. */
  "header-footer-text": () =>
    Packer.toBuffer(
      new Document({
        sections: [
          {
            headers: {
              default: new Header({
                children: [new Paragraph("PRIVILEGED AND CONFIDENTIAL")],
              }),
            },
            footers: {
              default: new Footer({
                children: [new Paragraph("Execution version")],
              }),
            },
            children: [
              new Paragraph({ children: [new TextRun("Recitals.")] }),
            ],
          },
        ],
      }),
    ),

  /** Footnotes and endnotes, alongside the separators that are not content. */
  footnotes: () =>
    Packer.toBuffer(
      new Document({
        footnotes: {
          1: { children: [new Paragraph("See Schedule B.")] },
          2: { children: [new Paragraph("As amended.")] },
        },
        endnotes: {
          1: { children: [new Paragraph("Definitions apply throughout.")] },
        },
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

  /** Several pathologies at once, plus an embedded object part. */
  "kitchen-sink": async () =>
    withEmbeddedObject(
      await Packer.toBuffer(
        new Document({
          numbering: NUMBERING,
          comments: {
            children: [
              {
                id: 0,
                author: "Counsel",
                date: new Date("2026-01-01T00:00:00Z"),
                children: [new Paragraph("Reconcile with the schedule.")],
              },
            ],
          },
          footnotes: { 1: { children: [new Paragraph("See Schedule C.")] } },
          sections: [
            {
              headers: {
                default: new Header({
                  children: [new Paragraph("DRAFT - SUBJECT TO REVIEW")],
                }),
              },
              children: [
                blockControl("party_name", "Northwind Holdings Inc."),
                new Paragraph({
                  numbering: { reference: "clauses", level: 0 },
                  children: [
                    new CommentRangeStart(0),
                    new TextRun("The term is "),
                    new InsertedTextRun({
                      text: "three years",
                      id: 1,
                      ...REVISION,
                    }),
                    new DeletedTextRun({ text: "five years", id: 2, ...REVISION }),
                    new CommentRangeEnd(0),
                    new TextRun({ children: [new CommentReference(0)] }),
                    new FootnoteReferenceRun(1),
                  ],
                }),
                new Paragraph({
                  numbering: { reference: "clauses", level: 1 },
                  children: [
                    new TextRun({
                      text: "sixty (60) days",
                      color: "FF0000",
                      strike: true,
                    }),
                    new TextRun({ text: "thirty (30) days", color: "C00000" }),
                    new ExternalHyperlink({
                      link: "https://example.org/schedule",
                      children: [new TextRun("")],
                    }),
                  ],
                }),
                new Textbox({
                  children: [new TextRun("Internal note: confirm the cap.")],
                }),
                new Table({
                  width: { size: 9000, type: WidthType.DXA },
                  rows: [
                    new TableRow({
                      children: [
                        new TableCell({
                          columnSpan: 2,
                          children: [new Paragraph("Payments")],
                        }),
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
                                  children: [
                                    new TableCell({
                                      children: [new Paragraph("On closing")],
                                    }),
                                  ],
                                }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            },
          ],
        }),
      ),
    ),
};

export async function buildPathologyFixtures(): Promise<Map<string, Buffer>> {
  const fixtures = new Map<string, Buffer>();
  for (const [name, build] of Object.entries(pathologyFixtureBuilders)) {
    fixtures.set(name, await build());
  }
  return fixtures;
}
