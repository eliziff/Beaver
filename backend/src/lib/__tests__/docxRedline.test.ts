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

import { projectDocxRedline } from "../docx/redline";
import { extractDocxBodyText } from "../docxTrackedChanges";
import { pathologyFixtureBuilders } from "./fixtures/docx-pathologies/generate";

const REVISION = { author: "Counsel", date: "2026-01-01T00:00:00Z" };

/** What a reader gets by taking every marked edit: the accepted view. */
function acceptedView(text: string) {
  return text
    .replace(/\{--[\s\S]*?--\}(?:\[ink\])?/gu, "")
    .replace(/\{\+\+([\s\S]*?)\+\+\}(?:\[ink\])?/gu, "$1")
    .replace(/\{>>[\s\S]*?<<\}/gu, "");
}

const fixtures = new Map<string, Buffer>();

async function fixture(name: string) {
  const cached = fixtures.get(name);
  if (cached) return cached;
  const build = pathologyFixtureBuilders[name];
  if (!build) throw new Error(`missing fixture ${name}`);
  const bytes = await build();
  fixtures.set(name, bytes);
  return bytes;
}

/** The document scripts/probe-manual-redline.ts builds, byte for byte. */
function manualRedlineProbe() {
  return Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
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
          ],
        },
      ],
    }),
  );
}

beforeAll(async () => {
  for (const name of ["clean", "tracked-changes", "comments"]) {
    await fixture(name);
  }
});

describe("projectDocxRedline on native tracked changes", () => {
  it("wraps w:ins and restores w:del, with counts that match the markup", async () => {
    const found = await projectDocxRedline(await fixture("tracked-changes"));
    expect(found.text).toBe(
      "The seat of arbitration is {++Toronto++}{--Zurich--}.\n" +
        "Costs follow {++the cause++}.",
    );
    expect(found.counts).toEqual({
      tracked_insertions: 2,
      tracked_deletions: 1,
      comments: 0,
      ink_insertions: 0,
      ink_deletions: 0,
    });
    expect(found.notes).toEqual([]);
  });

  it("keeps the accepted view recoverable by stripping the markers", async () => {
    const bytes = await fixture("tracked-changes");
    const found = await projectDocxRedline(bytes);
    expect(acceptedView(found.text)).toBe(await extractDocxBodyText(bytes));
  });

  it("marks a deletion that extraction otherwise drops silently", async () => {
    const bytes = await fixture("tracked-changes");
    // The hole in the other direction: accepted-view extraction cannot show
    // that "Zurich" was ever there.
    expect(await extractDocxBodyText(bytes)).not.toContain("Zurich");
    expect((await projectDocxRedline(bytes)).text).toContain("{--Zurich--}");
  });
});

describe("projectDocxRedline on a manual ink redline", () => {
  let bytes: Buffer;
  beforeAll(async () => {
    bytes = await manualRedlineProbe();
  });

  it("attributes struck and red runs as ink, not as tracked changes", async () => {
    const found = await projectDocxRedline(bytes);
    expect(found.text).toBe(
      "The Tenant shall pay Rent of " +
        "{--$117,000--}[ink]{++ $125,000++}[ink]" +
        " per annum. " +
        "{--This indemnity survives termination.--}[ink]",
    );
    expect(found.counts).toEqual({
      tracked_insertions: 0,
      tracked_deletions: 0,
      comments: 0,
      ink_insertions: 1,
      ink_deletions: 2,
    });
    expect(found.notes).toEqual([]);
  });

  it("closes the measured hole: a struck clause no longer reads as operative", async () => {
    // Every extractor probed (mammoth raw text, mammoth HTML, pandoc plain)
    // returns this sentence as ordinary body text.
    const plain = await extractDocxBodyText(bytes);
    expect(plain).toContain("This indemnity survives termination.");
    expect(plain).toContain("$117,000 $125,000");

    const found = await projectDocxRedline(bytes);
    expect(acceptedView(found.text)).toBe(
      "The Tenant shall pay Rent of  $125,000 per annum. ",
    );
  });

  it("reads a run that is both struck and red as a deletion", async () => {
    const found = await projectDocxRedline(
      await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: "struck and red",
                      strike: true,
                      color: "FF0000",
                    }),
                  ],
                }),
              ],
            },
          ],
        }),
      ),
    );
    expect(found.text).toBe("{--struck and red--}[ink]");
    expect(found.counts.ink_deletions).toBe(1);
    expect(found.counts.ink_insertions).toBe(0);
  });

  it("leaves colours outside the red family unmarked", async () => {
    // Same thresholds as the pathology sniffer: blue and dark grey are not
    // an edit, and `auto` is not a colour at all.
    const found = await projectDocxRedline(
      await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: "blue", color: "0000FF" }),
                    new TextRun({ text: "grey", color: "808080" }),
                    new TextRun({ text: "auto", color: "auto" }),
                    new TextRun({ text: "dark red", color: "C00000" }),
                  ],
                }),
              ],
            },
          ],
        }),
      ),
    );
    expect(found.text).toBe("bluegreyauto{++dark red++}[ink]");
    expect(found.counts.ink_insertions).toBe(1);
  });

  it("does not call a tracked insertion ink because it is coloured red", async () => {
    const found = await projectDocxRedline(
      await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
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
              ],
            },
          ],
        }),
      ),
    );
    expect(found.text).toBe("The term is {++three years++}");
    expect(found.counts.ink_insertions).toBe(0);
    expect(found.counts.tracked_insertions).toBe(1);
  });
});

describe("projectDocxRedline on comments", () => {
  it("renders each comment body at the end of the range it annotates", async () => {
    const found = await projectDocxRedline(await fixture("comments"));
    expect(found.text).toBe(
      "This agreement is governed by Ontario law." +
        "{>>Counsel: Confirm the governing law.<<}\n" +
        "The purchase price is set out in Schedule A." +
        "{>>Counsel: Check against the term sheet.<<}",
    );
    expect(found.counts.comments).toBe(2);
    expect(found.notes).toEqual([]);
  });

  it("notes a comment body that no range in the body anchors", async () => {
    const found = await projectDocxRedline(
      await Packer.toBuffer(
        new Document({
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
          sections: [
            {
              children: [
                new Paragraph({
                  children: [
                    new CommentRangeStart(0),
                    new TextRun("The indemnity is capped."),
                    new CommentRangeEnd(0),
                    new TextRun({ children: [new CommentReference(0)] }),
                  ],
                }),
              ],
            },
          ],
        }),
      ),
    );
    expect(found.counts.comments).toBe(1);
    expect(found.text).toContain("{>>Counsel: Anchored.<<}");
    expect(found.notes).toEqual([
      "1 comment is not anchored to a range in the body; its text is not shown.",
    ]);
  });
});

describe("projectDocxRedline on a clean document", () => {
  it("returns exactly the extracted body text, with no markers at all", async () => {
    const bytes = await fixture("clean");
    const found = await projectDocxRedline(bytes);
    expect(found.text).toBe(await extractDocxBodyText(bytes));
    expect(found.text).not.toMatch(/\{\+\+|\{--|\{>>|\[ink\]/u);
    expect(found.counts).toEqual({
      tracked_insertions: 0,
      tracked_deletions: 0,
      comments: 0,
      ink_insertions: 0,
      ink_deletions: 0,
    });
    expect(found.notes).toEqual([]);
  });
});

describe("projectDocxRedline marker collision", () => {
  it("notes literal marker text rather than escaping it silently", async () => {
    const found = await projectDocxRedline(
      await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
                new Paragraph({
                  children: [
                    new TextRun("The convention is to write {++ for an add, "),
                    new DeletedTextRun({ text: "and --} for a cut", id: 1, ...REVISION }),
                  ],
                }),
              ],
            },
          ],
        }),
      ),
    );
    expect(found.text).toBe(
      "The convention is to write {++ for an add, {--and --} for a cut--}",
    );
    expect(found.notes).toEqual([
      "Document text already contains 2 marker sequences ({++, --}); markers are not escaped, so those positions are ambiguous.",
    ]);
    // The projection still runs; the note is the whole remedy.
    expect(found.counts.tracked_deletions).toBe(1);
  });
});

describe("projectDocxRedline coverage of the body walk", () => {
  it("reaches paragraphs inside tables and text inside hyperlinks", async () => {
    const found = await projectDocxRedline(
      await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
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
              ],
            },
          ],
        }),
      ),
    );
    expect(found.text).toBe("{--the repealed Act--}\nFee: {--$500--}[ink]");
    expect(found.counts.tracked_deletions).toBe(1);
    expect(found.counts.ink_deletions).toBe(1);
  });
});

describe("projectDocxRedline bounds", () => {
  it("degrades to empty text and a note rather than throwing", async () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("not a zip at all"),
      await (await import("jszip")).default
        .loadAsync(await Packer.toBuffer(new Document({ sections: [] })))
        .then((zip) => {
          zip.remove("word/document.xml");
          return zip.generateAsync({ type: "nodebuffer" });
        }),
    ]) {
      const found = await projectDocxRedline(bytes);
      expect(found.text).toBe("");
      expect(found.counts).toEqual({
        tracked_insertions: 0,
        tracked_deletions: 0,
        comments: 0,
        ink_insertions: 0,
        ink_deletions: 0,
      });
      expect(found.notes).toHaveLength(1);
      expect(found.notes[0]).toMatch(/could not be projected/u);
    }
  });
});
