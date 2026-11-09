import {
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document,
  ExternalHyperlink,
  InsertedTextRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { beforeAll, describe, expect, it } from "vitest";
import { docxBytes } from "./support/docxFixtures";

import { extractDocxBodyText } from "../docxTrackedChanges";
import { sha256 } from "../hash";
import { structureNative } from "../structureNative";
import { pathologyFixtureBuilders as fixtures } from "./fixtures/docx-pathologies/generate";

const REVISION = { author: "Counsel", date: "2026-01-01T00:00:00Z" };
const redlineText = async (bytes: Buffer) => {
  const native = structureNative();
  const document = await native.openSource(bytes, { documentId: "test", versionId: "1", fileType: "docx",
    sourceSha256: sha256(bytes), mode: "redline" });
  return native.documentText(document!);
};

/** The document scripts/probe-manual-redline.ts builds, byte for byte. */
function manualRedlineProbe() {
  return docxBytes([
    new Paragraph({
      children: [
        new TextRun("The Tenant shall pay Rent of "),
        new TextRun({ text: "$117,000", strike: true }),
        new TextRun({ text: " $125,000", color: "FF0000" }),
        new TextRun(" per annum. "),
        new TextRun({
          text: "This indemnity survives termination.",
          strike: true,
          color: "FF0000",
        }),
      ],
    }),
  ]);
}

describe("DOCX redline text on native tracked changes", () => {
  it("wraps every w:ins and restores every w:del", async () => {
    const found = await redlineText(await fixtures["tracked-changes"]());
    expect(found).toBe(
      "The seat of arbitration is {++Toronto++}{--Zurich--}.\n" +
        "Costs follow {++the cause++}.",
    );
  });
});

describe("DOCX redline text on a manual ink redline", () => {
  let bytes: Buffer;
  beforeAll(async () => {
    bytes = await manualRedlineProbe();
  });

  it("attributes struck and red runs as ink, not as tracked changes", async () => {
    const found = await redlineText(bytes);
    expect(found).toBe(
      "The Tenant shall pay Rent of " +
        "{--$117,000--}[ink]{++ $125,000++}[ink]" +
        " per annum. " +
        "{--This indemnity survives termination.--}[ink]",
    );
  });

  it("leaves colours outside the red family unmarked", async () => {
    // Same thresholds as the pathology sniffer: blue and dark grey are not
    // an edit, and `auto` is not a colour at all.
    const found = await redlineText(
      await docxBytes([
        new Paragraph({
          children: [
            new TextRun({ text: "blue", color: "0000FF" }),
            new TextRun({ text: "grey", color: "808080" }),
            new TextRun({ text: "auto", color: "auto" }),
            new TextRun({ text: "dark red", color: "C00000" }),
          ],
        }),
      ]),
    );
    expect(found).toBe("bluegreyauto{++dark red++}[ink]");
  });

  it("does not call a tracked insertion ink because it is coloured red", async () => {
    const found = await redlineText(
      await docxBytes([
        new Paragraph({
          children: [
            new TextRun("The term is "),
            new InsertedTextRun({
              text: "three years",
              color: "FF0000",
              id: 1,
              ...REVISION,
            }),
          ],
        }),
      ]),
    );
    expect(found).toBe("The term is {++three years++}");
  });
});

describe("DOCX redline text on comments", () => {
  it("renders each comment body at the end of the range it annotates", async () => {
    const found = await redlineText(await fixtures["comments"]());
    expect(found).toBe(
      "This agreement is governed by Ontario law." +
        "{>>Counsel: Confirm the governing law.<<}\n" +
        "The purchase price is set out in Schedule A." +
        "{>>Counsel: Check against the term sheet.<<}",
    );
  });

  it("does not attach an unanchored comment to unrelated prose", async () => {
    const found = await redlineText(
      await docxBytes([
        new Paragraph({
          children: [
            new CommentRangeStart(0),
            new TextRun("The indemnity is capped."),
            new CommentRangeEnd(0),
            new TextRun({ children: [new CommentReference(0)] }),
          ],
        }),
      ], {
        comments: {
          children: [
            {
              id: 0,
              author: "Counsel",
              date: new Date("2026-01-01T00:00:00Z"),
              children: [new Paragraph("Anchored.")],
            },
            {
              id: 1,
              author: "Counsel",
              date: new Date("2026-01-01T00:00:00Z"),
              children: [new Paragraph("Orphaned.")],
            },
          ],
        },
      }),
    );
    expect(found).toContain("{>>Counsel: Anchored.<<}");
    expect(found).not.toContain("Orphaned.");
  });
});

describe("DOCX redline text on a clean document", () => {
  it("returns exactly the extracted body text, with no markers at all", async () => {
    const bytes = await fixtures["clean"]();
    const found = await redlineText(bytes);
    expect(found).toBe(await extractDocxBodyText(bytes));
    expect(found).not.toMatch(/\{\+\+|\{--|\{>>|\[ink\]/u);
  });
});

describe("DOCX redline marker collision", () => {
  it("preserves literal marker text", async () => {
    const found = await redlineText(
      await docxBytes([
        new Paragraph({
          children: [
            new TextRun("The convention is to write {++ for an add, "),
            new DeletedTextRun({ text: "and --} for a cut", id: 1, ...REVISION }),
          ],
        }),
      ]),
    );
    expect(found).toBe(
      "The convention is to write {++ for an add, {--and --} for a cut--}",
    );
  });
});

describe("DOCX redline coverage of the body walk", () => {
  it("reaches paragraphs inside tables and text inside hyperlinks", async () => {
    const found = await redlineText(
      await docxBytes([
        new Paragraph({
          children: [
            new ExternalHyperlink({
              link: "https://example.org/act",
              children: [
                new DeletedTextRun({
                  text: "the repealed Act",
                  id: 1,
                  ...REVISION,
                }),
              ],
            }),
          ],
        }),
        new Table({
          width: { size: 9000, type: WidthType.DXA },
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun("Fee: "),
                        new TextRun({ text: "$500", strike: true }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ]),
    );
    expect(found).toBe("{--the repealed Act--}\nFee: {--$500--}[ink]");
  });
});

describe("DOCX redline bounds", () => {
  it("returns empty text for unreadable packages", async () => {
    for (const bytes of [
      Buffer.from("not a zip at all"),
      await (await import("jszip")).default
        .loadAsync(await Packer.toBuffer(new Document({ sections: [] })))
        .then((zip) => {
          zip.remove("word/document.xml");
          return zip.generateAsync({ type: "nodebuffer" });
        }),
    ]) {
      expect(await redlineText(bytes)).toBe("");
    }
  });
});
