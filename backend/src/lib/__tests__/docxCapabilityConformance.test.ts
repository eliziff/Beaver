/** Native DOCX ingestion and explicit format-loss contracts.
 * Ordinary Markdown rendering and round trips are covered in the owning suites.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { docxXml as packageXml } from "./support/docxFixtures";

import { renderDocxMarkdown } from "../chat/tools/docxMarkdown";
import { projectDocxRedline } from "../docx/redline";
import { extractDocxBodyText } from "../docxTrackedChanges";
import { structureNative } from "../structureNative";
import { pathologyFixtureBuilders as fixtures } from "./fixtures/docx-pathologies/generate";

const draftingText = async (bytes: Buffer) => {
  const native = structureNative();
  return native.documentText(await native.deriveDocxDocument(bytes, "test", true));
};

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

/** Part names matching a package-path pattern, in package order. */
async function partNames(bytes: Buffer, pattern: RegExp): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  return Object.keys(zip.files)
    .map((entry) => entry.replace(/\\/gu, "/"))
    .filter((entry) => pattern.test(entry));
}

/** Shared input for the numbering and footer output contracts. */
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
    const markdown = await draftingText(await fixtures["merged-table"]());

    // gfm keeps merged tables as raw HTML, so colspan/rowspan survive.
    expect(markdown).toMatch(/<table[^>]*>/u);
    expect(markdown).toContain('colspan="2"');
    expect(markdown).toContain('rowspan="2"');
    for (const cell of ["Consideration", "Cash", "On closing", "Deferred"]) {
      expect(markdown).toContain(cell);
    }
  });

  it("ingestion: a nested table remains visible", async () => {
    const markdown = await draftingText(await fixtures["kitchen-sink"]());

    // The outer table plus the nested one both render as raw HTML tables.
    expect((markdown.match(/<table/gu) ?? []).length).toBeGreaterThanOrEqual(
      2,
    );
  });
});

describe("auto-numbering", () => {
  it("ingestion: labels live only in numbering.xml and the drafting source renders them", async () => {
    const bytes = await fixtures["auto-numbered"]();
    const body = await extractDocxBodyText(bytes);

    // The numbers appear nowhere in the text planes the body flattener
    // reads — specialist numbering analysis must reconstruct them from OOXML.
    expect(body).toBe(
      "Definitions.\nAffiliate has the meaning given.\nGoverning law.",
    );
    expect(body).not.toMatch(/\d/u);

    const markdown = await draftingText(bytes);
    // Native drafting resolves numbering properties into visible list labels.
    expect(markdown).toMatch(/1\.\s+Definitions/iu);
    expect(markdown).toContain("Affiliate has the meaning given.");
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
    const bytes = await fixtures["tracked-changes"]();

    // Accepted view: the insertion is in, the deletion is out.
    const body = await extractDocxBodyText(bytes);
    expect(body).toBe("The seat of arbitration is Toronto.\nCosts follow the cause.");
    expect(body).not.toContain("Zurich");

    // The drafting source flattens tracked changes to the accepted view and
    // warns that revision intent was flattened — the redline mode is the
    // review surface where the marks survive.
    const markdown = await draftingText(bytes);
    // Native drafting emits the accepted view as plain Markdown paragraphs.
    expect(markdown).toContain("The seat of arbitration is Toronto.");
    expect(markdown).toContain("Costs follow the cause.");
    expect(markdown).not.toContain("Zurich");

    // The redline projection is where the marks survive.
    const redline = await projectDocxRedline(bytes);
    expect(redline.text).toContain("{++Toronto++}");
    expect(redline.text).toContain("{--Zurich--}");
    expect(redline.counts).toMatchObject({
      tracked_insertions: 2,
      tracked_deletions: 1,
    });
  });
});

describe("headers and footers", () => {
  it("ingestion: literal header/footer text is outside the drafting view", async () => {
    const bytes = await fixtures["header-footer-text"]();

    const body = await extractDocxBodyText(bytes);
    expect(body).toBe("Recitals.");

    const markdown = await draftingText(bytes);
    expect(markdown).not.toContain("PRIVILEGED AND CONFIDENTIAL");
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
    const bytes = await fixtures["footnotes"]();

    const markdown = await draftingText(bytes);
    expect(markdown).toContain("[^1]");
    expect(markdown).toContain("[^2]");
    expect(markdown).toContain("[^1]: See Schedule B.");
    expect(markdown).toContain("[^2]: As amended.");
    // Native note anchor markup is gone; only the markers remain.
    expect(markdown).not.toContain('href="#footnote-');
  });
});

describe("text boxes", () => {
  it("ingestion: text-box text is off the body plane and omitted by native drafting", async () => {
    const bytes = await fixtures["text-box"]();

    const body = await extractDocxBodyText(bytes);
    expect(body).not.toContain("Draft only - not for execution.");

    // Text boxes are outside the body-focused drafting projection.
    const markdown = await draftingText(bytes);
    expect(markdown).not.toContain("Draft only - not for execution.");
  });
});

describe("real-world corruption fixtures", () => {
  const REAL_DIR = path.join(
    REPO_ROOT,
    "benchmarks",
    "docx_edit",
    "fixtures",
    "real",
  );
  const readReal = (name: string) => readFileSync(path.join(REAL_DIR, name));

  it("corrupt-style: a referenced-but-undefined style degrades gracefully, not a crash", async () => {
    const bytes = readReal("corrupt-style.docx");

    // Best-effort extraction: the body still reads in full.
    const body = await extractDocxBodyText(bytes);
    expect(body).toBe(
      "The purchase price is $87.3 million, payable in full on the Closing Date.\nGoverning Law\nThis Agreement shall be governed by the laws of the Province of Ontario.",
    );

    // Undefined styles must not prevent the native drafting projection.
    const markdown = await draftingText(bytes);
    expect(markdown).toContain("Governing Law");
    expect(markdown).toContain("$87.3 million");
  });

  it("truncated: an unreadable ZIP raises a clear typed error, not an opaque JSZip one", async () => {
    const bytes = readReal("truncated.docx");

    // The package has no readable central directory, so there is no text to
    // salvage; both ingestion surfaces must fail closed with a readable error
    // rather than leak JSZip's "Corrupted zip: …" internals.
    await expect(draftingText(bytes)).rejects.toThrow(
      /corrupted or truncated/i,
    );
    await expect(extractDocxBodyText(bytes)).rejects.toThrow(
      /corrupted or truncated/i,
    );
  });

  it("malformed-body: broken document.xml raises a clear error while the body plane still recovers text", async () => {
    const bytes = readReal("malformed-body.docx");

    // Native drafting fails closed with a message naming the malformed part.
    await expect(draftingText(bytes)).rejects.toThrow(
      /malformed XML in word\/document\.xml/i,
    );

    // The fast-xml-parser body flattener is lenient and recovers the text a
    // strict converter cannot, so the edit plane still has anchors.
    const body = await extractDocxBodyText(bytes);
    expect(body).toContain("Governing Law");
    expect(body).toContain("$87.3 million");
  });
});

describe("round trip: rendered Markdown re-ingests without losing substance", () => {
  it("content controls re-ingest as flattened placeholder text", async () => {
    const bytes = await renderDocxMarkdown(
      ["{{party_name}}", "", "The purchaser is {{purchaser}}."].join("\n"),
      { title: "Agreement" },
    );

    // The rendered package carries real w:sdt controls with w:tag values.
    const documentXml = await packageXml(bytes, "word/document.xml");
    expect(documentXml).toContain('<w:tag w:val="party_name"/>');

    // Re-ingesting reads the placeholder text, not the control markers.
    const markdown = await draftingText(bytes);
    expect(markdown).toContain("[Party name]");
    expect(markdown).toContain("[Purchaser]");
    expect(markdown).not.toContain("{{party_name}}");
  });
});
