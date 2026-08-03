/**
 * markdown↔docx capability-conformance suite.
 *
 * The drafting representation is "simplified for the model, exact on the
 * wire": the model drafts simplified Markdown and a deterministic renderer
 * (`renderDocxMarkdown` in chat/tools/docxMarkdown.ts) converts it to DOCX;
 * source DOCX files are read back into the model-visible drafting view
 * (`extractDocxDraftingSource` in docxDraftingSource.ts, plus the numbering
 * resolver and the redline projection for the planes those flatten).
 *
 * This suite pins, per feature class, what the REAL conversion functions
 * actually preserve in each direction:
 *
 *   INGESTION  .docx  →  drafting source HTML (the model-visible view)
 *                        + extractDocxBodyText (the accepted body text plane
 *                          find/context strings operate against)
 *                        + resolveDocxNumbering (labels mammoth drops)
 *                        + projectDocxRedline (the marked-up read mode)
 *   OUTPUT     Markdown →  renderDocxMarkdown → the produced .docx, opened
 *                        with JSZip so the class's OOXML presence is checked
 *                        (grid, numbering properties, note parts, footers).
 *
 * A class either survives the wire (substance present) or is a documented
 * drop (the drafting-view warning / an absent part). Both states are asserted
 * so the matrix in docs/docx-capability-conformance-2026-08-03.md stays tied
 * to tested behaviour.
 *
 * No LLM calls: every assertion is against deterministic conversion output.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";

import { renderDocxMarkdown } from "../chat/tools/docxMarkdown";
import { extractDocxDraftingSource } from "../docxDraftingSource";
import {
  applyNumberingToText,
  resolveDocxNumbering,
} from "../docx/numbering";
import { projectDocxRedline } from "../docx/redline";
import { extractDocxStories } from "../docx/stories";
import { extractDocxBodyText } from "../docxTrackedChanges";
import { buildPathologyFixtures } from "./fixtures/docx-pathologies/generate";

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const REAL_CORPUS = path.join(
  REPO_ROOT,
  "benchmarks",
  "docx_edit",
  "fixtures",
  "real",
  "ferry-boats-remission.txt",
);

const packages = new Map<string, Buffer>();

/** The pathology corpus is built, not committed; rebuild once per run. */
beforeAll(async () => {
  for (const [name, bytes] of await buildPathologyFixtures()) {
    packages.set(name, bytes);
  }
});

function fixture(name: string): Buffer {
  const bytes = packages.get(name);
  if (!bytes) throw new Error(`missing fixture ${name}`);
  return bytes;
}

async function packageXml(bytes: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(name);
  if (!file) throw new Error(`package has no ${name}`);
  return file.async("string");
}

/** Part names matching a package-path pattern, in package order. */
async function partNames(bytes: Buffer, pattern: RegExp): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  return Object.keys(zip.files)
    .map((entry) => entry.replace(/\\/gu, "/"))
    .filter((entry) => pattern.test(entry));
}

/** The one `real`-family fixture: a genuine regulation, packed line-by-line. */
async function realFerryBoatsRemission(): Promise<Buffer> {
  const source = readFileSync(REAL_CORPUS, "utf8");
  return Buffer.from(
    await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: source
              .split(/\r?\n/u)
              .map((line) => new Paragraph({ children: [new TextRun(line)] })),
          },
        ],
      }),
    ),
  );
}

/** Markdown carrying every class the matrix scores, for the round-trip. */
const MATRIX_MARKDOWN = [
  "# Definitions",
  "",
  "The **Vendor** supplies services.[^1]",
  "",
  "(a) First obligation",
  "(b) Second obligation",
  "",
  "| Term | Value |",
  "| --- | --- |",
  "| Price | $100 |",
  "",
  "[^1]: This is the source footnote.",
].join("\n");

describe("tables (merged / nested)", () => {
  it("ingestion: merge structure and cell text are capturable", async () => {
    const source = await extractDocxDraftingSource(fixture("merged-table"));

    expect(source.html).toContain("<table>");
    // The spans survive the mammoth pass verbatim, so the merge layout is
    // not just present but readable as spans.
    expect(source.html).toContain('colspan="2"');
    expect(source.html).toContain('rowspan="2"');
    for (const cell of ["Consideration", "Cash", "On closing", "Deferred"]) {
      expect(source.html).toContain(cell);
    }
    expect(source.warnings).toContain(
      "Merged or nested tables must be normalized without dropping their text.",
    );
    expect(source.requires_review).toBe(true);
  });

  it("ingestion: a nested table is flagged for normalization", async () => {
    const source = await extractDocxDraftingSource(fixture("kitchen-sink"));

    // The outer table plus the nested one both render.
    expect((source.html.match(/<table/gu) ?? []).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(source.warnings).toContain(
      "Merged or nested tables must be normalized without dropping their text.",
    );
  });

  it("output: the grid survives; merges are a documented drop", async () => {
    const bytes = await renderDocxMarkdown(MATRIX_MARKDOWN, {
      title: "Agreement",
    });
    const documentXml = await packageXml(bytes, "word/document.xml");

    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain('<w:tblW w:type="dxa" w:w="9360"/>');
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>');
    expect(documentXml).toContain("<w:gridCol");
    // The header row is a repeatable header; the cell text is on the wire.
    expect(documentXml).toContain("<w:tblHeader/>");
    expect(documentXml).toContain('<w:shd w:fill="EDEDED"/>');
    for (const cell of ["Term", "Value", "Price", "$100"]) {
      expect(documentXml).toContain(cell);
    }
    // The simplified Markdown table grammar has no colspan/rowspan, so a
    // merge cannot be authored and none may appear by accident.
    expect(documentXml).not.toMatch(/<w:gridSpan/u);
    expect(documentXml).not.toMatch(/<w:vMerge/u);
  });
});

describe("auto-numbering", () => {
  it("ingestion: labels live only in numbering.xml, recovered by the resolver", async () => {
    const bytes = fixture("auto-numbered");
    const body = await extractDocxBodyText(bytes);

    // The numbers appear nowhere in the text planes mammoth or the body
    // flattener read — this is exactly why the resolver exists.
    expect(body).toBe(
      "Definitions.\nAffiliate has the meaning given.\nGoverning law.",
    );
    expect(body).not.toMatch(/\d/u);

    const source = await extractDocxDraftingSource(bytes);
    // mammoth keeps the list structure, but the rendered labels are absent.
    expect(source.html).toContain("<ol>");
    expect(source.html).not.toContain("1. Definitions");

    const { labels, notes } = await resolveDocxNumbering(bytes);
    expect([...labels.entries()]).toEqual([
      [0, "1."],
      [1, "(a)"],
      [2, "2."],
    ]);
    expect(applyNumberingToText(body, labels)).toBe(
      "1. Definitions.\n(a) Affiliate has the meaning given.\n2. Governing law.",
    );
    expect(notes).toEqual([]);
  });

  it("output: headings and ordered lists carry numbering properties", async () => {
    const bytes = await renderDocxMarkdown(MATRIX_MARKDOWN, {
      title: "Agreement",
    });
    const documentXml = await packageXml(bytes, "word/document.xml");
    const numberingXml = await packageXml(bytes, "word/numbering.xml");

    // The numbered heading references a decimal legal list.
    expect(documentXml).toContain(
      '<w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/>',
    );
    expect(numberingXml).toContain('<w:lvlText w:val="%1."/>');
    expect(numberingXml).toContain('<w:lvlText w:val="%1.%2"/>');
    expect(numberingXml).toContain("<w:isLgl/>");

    // The ordered (a)/(b) list is a letter-formatted level.
    expect(numberingXml).toContain('w:val="lowerLetter"');
    expect(numberingXml).toContain('<w:lvlText w:val="(%2)"/>');

    // Every list paragraph in the body carries a numPr reference.
    expect(documentXml).toContain('<w:numPr><w:ilvl w:val="1"/>');
  });
});

describe("tracked changes", () => {
  it("ingestion: the drafting view is the accepted view; redline reads separately", async () => {
    const bytes = fixture("tracked-changes");

    // Accepted view: the insertion is in, the deletion is out.
    const body = await extractDocxBodyText(bytes);
    expect(body).toBe("The seat of arbitration is Toronto.\nCosts follow the cause.");
    expect(body).not.toContain("Zurich");

    // The drafting source flattens tracked changes silently (accepted view,
    // no marker, no warning) — the redline mode is the review surface.
    const source = await extractDocxDraftingSource(bytes);
    expect(source.html).toBe(
      "<p>The seat of arbitration is Toronto.</p><p>Costs follow the cause.</p>",
    );
    expect(source.warnings).toEqual([]);

    // The redline projection is where the marks survive.
    const redline = await projectDocxRedline(bytes);
    expect(redline.text).toContain("{++Toronto++}");
    expect(redline.text).toContain("{--Zurich--}");
    expect(redline.counts).toMatchObject({
      tracked_insertions: 2,
      tracked_deletions: 1,
    });

    // The story layer records the revision flags on the runs.
    const stories = await extractDocxStories(bytes);
    expect(stories.body[0].text).toBe("The seat of arbitration is Toronto.");
    expect(stories.body[0].runs.find((run) => run.text === "Zurich")?.del).toBe(
      true,
    );
    expect(stories.body[0].runs.find((run) => run.text === "Toronto")?.ins).toBe(
      true,
    );
  });

  it("output: Markdown carries no revision markup and records no edits", async () => {
    const bytes = await renderDocxMarkdown(MATRIX_MARKDOWN, {
      title: "Agreement",
    });
    const documentXml = await packageXml(bytes, "word/document.xml");
    const settingsXml = await packageXml(bytes, "word/settings.xml");

    // w:ins / w:del element tags — w:insideH/insideV table borders share the
    // "ins" prefix, so the tag guard is needed.
    expect(documentXml).not.toMatch(/<w:ins(?=[\s/>])/u);
    expect(documentXml).not.toMatch(/<w:del(?=[\s/>])/u);
    expect(settingsXml).not.toMatch(/w:trackChanges/u);
  });
});

describe("headers and footers", () => {
  it("ingestion: literal header/footer text is a documented drop with warnings", async () => {
    const bytes = fixture("header-footer-text");

    const body = await extractDocxBodyText(bytes);
    expect(body).toBe("Recitals.");

    const source = await extractDocxDraftingSource(bytes);
    expect(source.html).not.toContain("PRIVILEGED AND CONFIDENTIAL");
    expect(source.warnings).toContain(
      "Headers are not included in the drafting source.",
    );
    expect(source.warnings).toContain(
      "Footers are not included in the drafting source.",
    );
    expect(source.requires_review).toBe(true);

    // The story layer still reads the parts the drafting view drops.
    const stories = await extractDocxStories(bytes);
    expect(stories.headers.map((p) => p.map((x) => x.text).join(" "))).toEqual([
      "PRIVILEGED AND CONFIDENTIAL",
    ]);
    expect(stories.footers.map((p) => p.map((x) => x.text).join(" "))).toEqual([
      "Execution version",
    ]);
  });

  it("ingestion: a page-number-only footer is not a dropped-text warning", async () => {
    const source = await extractDocxDraftingSource(fixture("fields"));
    expect(source.warnings).toEqual([]);
    expect(source.requires_review).toBe(false);
  });

  it("output: an always-on page-number footer ships; no header part exists", async () => {
    const bytes = await renderDocxMarkdown(MATRIX_MARKDOWN, {
      title: "Agreement",
    });
    const footerParts = await partNames(bytes, /^word\/footer\d*\.xml$/u);
    const headerParts = await partNames(bytes, /^word\/header\d*\.xml$/u);

    expect(footerParts).toHaveLength(1);
    const footerXml = await packageXml(bytes, footerParts[0]);
    expect(footerXml).toContain('<w:instrText xml:space="preserve">PAGE</w:instrText>');

    // Markdown has no header or custom-footer concept, so none is authored.
    expect(headerParts).toHaveLength(0);
    const documentXml = await packageXml(bytes, "word/document.xml");
    expect(documentXml).toContain("<w:footerReference");
  });
});

describe("footnotes", () => {
  it("ingestion: native notes become markers plus definitions", async () => {
    const bytes = fixture("footnotes");

    const source = await extractDocxDraftingSource(bytes);
    expect(source.html).toContain("[^1]");
    expect(source.html).toContain("[^2]");
    expect(source.html).toContain("[^1]: See Schedule B.");
    expect(source.html).toContain("[^2]: As amended.");
    // Native note anchor markup is gone; only the markers remain.
    expect(source.html).not.toContain('href="#footnote-');
    expect(source.requires_review).toBe(true);

    // The story layer keeps the native note ids.
    const stories = await extractDocxStories(bytes);
    expect([...stories.footnotes.keys()]).toEqual(["1", "2"]);
    expect([...stories.endnotes.keys()]).toEqual(["1"]);
    expect(source.warnings).toContain("Endnotes may require manual review.");
  });

  it("output: markers render a native footnote part and reference", async () => {
    const bytes = await renderDocxMarkdown(MATRIX_MARKDOWN, {
      title: "Agreement",
    });
    const documentXml = await packageXml(bytes, "word/document.xml");
    const footnotesXml = await packageXml(bytes, "word/footnotes.xml");

    expect(documentXml).toContain('<w:footnoteReference w:id="1"/>');
    expect(footnotesXml).toContain('<w:footnote w:id="1">');
    expect(footnotesXml).toContain("This is the source footnote.");
    // Every package ships the separator notes; they are not content.
    expect(footnotesXml).toContain('w:type="separator"');
    expect(footnotesXml).toContain('w:type="continuationSeparator"');
  });
});

describe("text boxes", () => {
  it("ingestion: text-box text is off the body plane but visible to the drafting view", async () => {
    const bytes = fixture("text-box");

    const body = await extractDocxBodyText(bytes);
    expect(body).not.toContain("Draft only - not for execution.");

    // mammoth carries w:txbxContent into the drafting HTML, so the model can
    // see the text box even though the body text plane cannot — an asymmetry
    // the matrix records.
    const source = await extractDocxDraftingSource(bytes);
    expect(source.html).toContain("Draft only - not for execution.");

    // The story layer reads text boxes as their own plane.
    const stories = await extractDocxStories(bytes);
    expect(stories.textBoxes.map((p) => p.map((x) => x.text).join(" "))).toEqual(
      ["Draft only - not for execution."],
    );
  });

  it("output: Markdown has no text-box concept, so none is authored", async () => {
    const bytes = await renderDocxMarkdown(MATRIX_MARKDOWN, {
      title: "Agreement",
    });
    const documentXml = await packageXml(bytes, "word/document.xml");
    expect(documentXml).not.toMatch(/<w:txbxContent/u);
  });
});

describe("real document ingestion", () => {
  it("ferry-boats-remission: a real regulation reads clean with no review flag", async () => {
    const bytes = await realFerryBoatsRemission();

    const source = await extractDocxDraftingSource(bytes);
    expect(source.requires_review).toBe(false);
    expect(source.warnings).toEqual([]);
    expect(source.html).toContain("Ferry-Boats Remission Order, 2016");
    expect(source.html).toContain("1 Remission is granted");

    const body = await extractDocxBodyText(bytes);
    // Literal "1" / "(a)" markers in a real instrument stay literal because
    // the source lines are plain paragraphs, not auto-numbered list items.
    expect(body).toContain("1 Remission is granted");
    expect(body).toContain("(a) the ferry-boat");
    expect(body.split("\n").length).toBeGreaterThan(40);
  });
});

describe("round trip: rendered Markdown re-ingests without losing substance", () => {
  it("keeps heading, list, table, footnote and emphasis through the wire", async () => {
    const bytes = await renderDocxMarkdown(MATRIX_MARKDOWN, {
      title: "Agreement",
    });
    const source = await extractDocxDraftingSource(bytes);

    expect(source.html).toContain("Definitions");
    expect(source.html).toContain("<strong>Vendor</strong>");
    expect(source.html).toContain("<table>");
    expect(source.html).toContain("Price");
    expect(source.html).toContain("[^1]");
    expect(source.html).toContain("[^1]: This is the source footnote.");
    // The (a)/(b) list rendered as a list, so the markers survive as <ol>.
    expect(source.html).toContain("<ol>");
    expect(source.html).toContain("First obligation");
    // A re-ingest of our own output flags no class drop — only mammoth's
    // cosmetic "Unrecognised paragraph style" messages for the custom
    // Beaver styles (Title, LegalTableText). Every feature class survives,
    // but the review flag comes back on for a render→ingest→render cycle,
    // which the matrix records as a round-trip cost.
    expect(source.warnings.length).toBeGreaterThan(0);
    for (const warning of source.warnings) {
      expect(warning).toMatch(/^Unrecognised paragraph style: /u);
    }
  });
});
