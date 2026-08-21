import { Document, LevelFormat, Packer, Paragraph, TextRun } from "docx";
import { beforeAll, describe, expect, it } from "vitest";

import {
  scanDocxPathology,
  type DocxPathologyReport,
} from "../docx/pathology";
import { buildPathologyFixtures } from "./fixtures/docx-pathologies/generate";

const reports = new Map<string, DocxPathologyReport>();
const packages = new Map<string, Buffer>();

/** Named, not pasted: a literal would be invisible in this source. */
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** What a sample must never still carry, by code point. */
const INVISIBLE_RANGES = [
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0x200b, 0x200d],
  [0x2060, 0x2064],
  [0xe000, 0xf8ff],
  [0xfeff, 0xfeff],
];

function carriesInvisible(text: string) {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return INVISIBLE_RANGES.some(([low, high]) => code >= low && code <= high);
  });
}

const NO_TRAPS = {
  bidi_controls: 0,
  zero_width: 0,
  homoglyph_suspects: 0,
  private_use: 0,
  control_chars: 0,
  invisible_math: 0,
};

beforeAll(async () => {
  for (const [name, bytes] of await buildPathologyFixtures()) {
    packages.set(name, bytes);
    reports.set(name, await scanDocxPathology(bytes));
  }
});

function report(name: string) {
  const found = reports.get(name);
  if (!found) throw new Error(`missing fixture ${name}`);
  return found;
}

describe("scanDocxPathology negative control", () => {
  it("reports nothing at all for a document with no pathology", () => {
    expect(report("clean")).toEqual({
      auto_numbering: { referenced_paragraphs: 0, has_numbering_part: false },
      tracked_changes: { insertions: 0, deletions: 0 },
      comments: { count: 0 },
      content_controls: { count: 0 },
      hyperlinks: { count: 0, with_text: 0 },
      text_boxes: { count: 0, characters: 0 },
      manual_redline: {
        colored_runs: 0,
        struck_runs: 0,
        colored_and_struck: 0,
        likely: false,
      },
      tables: { count: 0, merged_cells: 0, nested: false },
      fields: { count: 0, instr_samples: [] },
      embeddings: { count: 0 },
      header_footer_literal_text: false,
      footnotes: { count: 0 },
      endnotes: { count: 0 },
      unicode_traps: { ...NO_TRAPS, samples: [] },
      notes_of_caution: [],
    });
  });
});

describe("scanDocxPathology fixture matrix", () => {
  it("counts red and struck runs that stand in for tracked changes", () => {
    const found = report("manual-red-strike-redline");
    // Blue and `auto` runs in the same paragraph stay out of the count.
    expect(found.manual_redline).toEqual({
      colored_runs: 2,
      struck_runs: 2,
      colored_and_struck: 1,
      likely: true,
    });
    expect(found.tracked_changes).toEqual({ insertions: 0, deletions: 0 });
    expect(found.notes_of_caution).toHaveLength(1);
  });

  it("counts paragraphs whose number lives in the numbering part", async () => {
    const found = report("auto-numbered");
    expect(found.auto_numbering).toEqual({
      referenced_paragraphs: 3,
      has_numbering_part: true,
    });
    // The fixture is only honest if the numbers are not in the text.
    const zip = await (await import("jszip")).default.loadAsync(
      packages.get("auto-numbered")!,
    );
    const body = await zip.file("word/document.xml")!.async("text");
    const text = [...body.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gu)]
      .map((match) => match[1])
      .join("");
    expect(text).not.toMatch(/\d/u);
  });

  it("counts insertions and deletions without reading them as manual redline", () => {
    const found = report("tracked-changes");
    expect(found.tracked_changes).toEqual({ insertions: 2, deletions: 1 });
    // A tracked deletion renders struck but carries no w:strike.
    expect(found.manual_redline.struck_runs).toBe(0);
    expect(found.manual_redline.likely).toBe(false);
    expect(found.notes_of_caution).toContain(
      "Change recording is on; further edits will be tracked.",
    );
  });

  it("counts comments from the comments part, not the boilerplate element", () => {
    expect(report("comments").comments).toEqual({ count: 2 });
    expect(report("clean").comments).toEqual({ count: 0 });
  });

  it("counts block and inline content controls", () => {
    expect(report("content-controls").content_controls).toEqual({ count: 2 });
  });

  it("counts a hyperlink that carries visible text", () => {
    const found = report("hyperlink-with-text");
    expect(found.hyperlinks).toEqual({ count: 1, with_text: 1 });
    expect(found.notes_of_caution).toEqual([]);
  });

  it("counts text-box characters that body extraction never reaches", () => {
    expect(report("text-box").text_boxes).toEqual({
      count: 1,
      characters: "Draft only - not for execution.".length,
    });
  });

  it("counts merged cells without reading the spans as nesting", () => {
    const found = report("merged-table");
    expect(found.tables.count).toBe(1);
    // A row span emits a start cell plus continuation cells; how many is
    // a packager detail.
    expect(found.tables.merged_cells).toBeGreaterThanOrEqual(2);
    expect(found.tables.nested).toBe(false);
  });

  it("counts field codes and samples their instructions", () => {
    const found = report("fields");
    expect(found.fields.count).toBe(2);
    expect(found.fields.instr_samples).toContain("PAGE");
    expect(found.fields.instr_samples).toContain("NUMPAGES");
    // A page-number-only footer carries no literal text.
    expect(found.header_footer_literal_text).toBe(false);
  });

  it("separates literal header and footer text from field codes", () => {
    const found = report("header-footer-text");
    expect(found.header_footer_literal_text).toBe(true);
    expect(found.fields.count).toBe(0);
  });

  it("counts notes without counting the separators every package ships", () => {
    const found = report("footnotes");
    expect(found.footnotes).toEqual({ count: 2 });
    expect(found.endnotes).toEqual({ count: 1 });
    expect(report("clean").footnotes).toEqual({ count: 0 });
    expect(report("clean").endnotes).toEqual({ count: 0 });
  });

  it("reports every pathology present in one document", () => {
    const found = report("kitchen-sink");
    expect(found.auto_numbering).toEqual({
      referenced_paragraphs: 2,
      has_numbering_part: true,
    });
    expect(found.tracked_changes).toEqual({ insertions: 1, deletions: 1 });
    expect(found.comments).toEqual({ count: 1 });
    expect(found.content_controls).toEqual({ count: 1 });
    expect(found.hyperlinks).toEqual({ count: 1, with_text: 0 });
    expect(found.text_boxes.count).toBe(1);
    expect(found.text_boxes.characters).toBeGreaterThan(0);
    expect(found.manual_redline.likely).toBe(true);
    expect(found.manual_redline.colored_and_struck).toBe(1);
    expect(found.tables.count).toBe(2);
    expect(found.tables.nested).toBe(true);
    expect(found.tables.merged_cells).toBeGreaterThanOrEqual(1);
    expect(found.embeddings).toEqual({ count: 1 });
    expect(found.header_footer_literal_text).toBe(true);
    expect(found.footnotes).toEqual({ count: 1 });
    expect(found.notes_of_caution.length).toBeGreaterThanOrEqual(8);
  });
});

describe("scanDocxPathology text plane", () => {
  it("counts each trap class over the story parts", () => {
    const found = report("unicode-traps");
    expect(found.unicode_traps).toMatchObject({
      // The override and the pop that closes it.
      bidi_controls: 2,
      zero_width: 1,
      // One word, not one character.
      homoglyph_suspects: 1,
      private_use: 1,
      control_chars: 0,
      invisible_math: 0,
    });
  });

  it("samples one excerpt per class, naming the character and the part", () => {
    const { samples } = report("unicode-traps").unicode_traps;
    expect(samples).toHaveLength(4);
    expect(samples.map((entry) => entry.split(" ")[0]).sort()).toEqual([
      "bidi_controls",
      "homoglyph_suspects",
      "private_use",
      "zero_width",
    ]);
    expect(samples[0]).toContain("U+202E");
    expect(samples[0]).toContain("word/document.xml");
    expect(samples.find((entry) => entry.startsWith("homoglyph_suspects"))).toContain(
      `Agr<U+0435>ement`,
    );
    // A trap outside the body still names the part it sits in.
    expect(samples.find((entry) => entry.startsWith("private_use"))).toMatch(
      /word\/header\d*\.xml/u,
    );
    // An excerpt that still carried an override would reorder
    // wherever it is printed.
    for (const entry of samples) expect(carriesInvisible(entry)).toBe(false);
  });

  it("routes on the traps without accusing the document", () => {
    const found = report("unicode-traps");
    const trap = found.notes_of_caution.filter((note) =>
      note.startsWith("Document text carries"),
    );
    expect(trap).toEqual([
      "Document text carries invisible or confusable Unicode (2 bidi controls, 1 zero-width character, 1 confusable word, 1 private-use character); treat quoted matches cautiously and prefer verbatim offsets.",
    ]);
  });

  it("reports no traps and adds no note for text that carries none", () => {
    expect(report("clean").unicode_traps).toEqual({
      ...NO_TRAPS,
      samples: [],
    });
    expect(report("hyperlink-with-text").notes_of_caution).toEqual([]);
  });

  it("counts a trap in text that body extraction never reaches", () => {
    const found = report("kitchen-sink");
    expect(found.unicode_traps).toMatchObject({ ...NO_TRAPS, zero_width: 1 });
    expect(found.unicode_traps.samples[0]).toContain("U+200B");
  });

  it("counts a text box written twice as one text", async () => {
    const zip = await (await import("jszip")).default.loadAsync(
      packages.get("kitchen-sink")!,
    );
    const xml = await zip.file("word/document.xml")!.async("text");
    const box = /<w:txbxContent(?:\s[^>]*)?>[\s\S]*?<\/w:txbxContent>/u.exec(xml);
    // Word writes a drawing text box as an mc:Choice plus an identical
    // mc:Fallback; the trap inside it is still one character.
    zip.file(
      "word/document.xml",
      xml.replace(box![0], `${box![0]}<mc:Fallback>${box![0]}</mc:Fallback>`),
    );
    const found = await scanDocxPathology(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    expect(found.unicode_traps.zero_width).toBe(1);
    expect(found.text_boxes.count).toBe(1);
  });
});

describe("scanDocxPathology on independently built documents", () => {
  it("calls a red struck run manual redline", async () => {
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new TextRun("Payment is due within "),
                  new TextRun({
                    text: "sixty (60) days",
                    color: "FF0000",
                    strike: true,
                  }),
                  new TextRun({ text: "thirty (30) days", color: "FF0000" }),
                ],
              }),
            ],
          },
        ],
      }),
    );
    const found = await scanDocxPathology(bytes);
    expect(found.manual_redline.likely).toBe(true);
    expect(found.tracked_changes).toEqual({ insertions: 0, deletions: 0 });
  });

  it("sees numbering that only the numbering part defines", async () => {
    const bytes = await Packer.toBuffer(
      new Document({
        numbering: {
          config: [
            {
              reference: "probe",
              levels: [
                { level: 0, format: LevelFormat.DECIMAL, text: "%1." },
              ],
            },
          ],
        },
        sections: [
          {
            children: [
              new Paragraph({
                numbering: { reference: "probe", level: 0 },
                children: [new TextRun("Interpretation.")],
              }),
            ],
          },
        ],
      }),
    );
    const found = await scanDocxPathology(bytes);
    expect(found.auto_numbering.referenced_paragraphs).toBeGreaterThan(0);
    expect(found.auto_numbering.has_numbering_part).toBe(true);
  });
});

describe("scanDocxPathology bounds", () => {
  it("degrades to zeros and a note rather than throwing", async () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("not a zip at all"),
      // A valid ZIP that is not a DOCX.
      await (await import("jszip")).default
        .loadAsync(await Packer.toBuffer(new Document({ sections: [] })))
        .then((zip) => {
          zip.remove("word/document.xml");
          return zip.generateAsync({ type: "nodebuffer" });
        }),
    ]) {
      const found = await scanDocxPathology(bytes);
      expect(found.notes_of_caution).toHaveLength(1);
      expect(found.notes_of_caution[0]).toMatch(/could not be inspected/u);
      expect(found.tables.count).toBe(0);
      expect(found.manual_redline.likely).toBe(false);
      expect(found.auto_numbering.has_numbering_part).toBe(false);
    }
  });
});
