/**
 * markdown↔docx capability-conformance suite.
 *
 * The drafting representation is "simplified for the model, exact on the
 * wire": the model drafts simplified Markdown and a deterministic renderer
 * (`renderDocxMarkdown` in chat/tools/docxMarkdown.ts) converts it to DOCX;
 * source DOCX files are read back through the native Rust drafting projection,
 * plus the redline projection for the plane it flattens.
 *
 * This suite pins, per feature class, what the REAL conversion functions
 * actually preserve in each direction:
 *
 *   INGESTION  .docx  →  drafting source Markdown (the model-visible view)
 *                        + extractDocxBodyText (the accepted body text plane
 *                          find/context strings operate against)
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
import { projectDocxRedline } from "../docx/redline";
import { extractDocxBodyText } from "../docxTrackedChanges";
import { structureNative } from "../structureNative";
import { buildPathologyFixtures } from "./fixtures/docx-pathologies/generate";

const draftingText = async (bytes: Buffer) => {
  const native = structureNative();
  return native.documentText(await native.deriveDocxDocument(bytes, "test", true));
};

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
    const markdown = await draftingText(fixture("merged-table"));

    // gfm keeps merged tables as raw HTML, so colspan/rowspan survive.
    expect(markdown).toMatch(/<table[^>]*>/u);
    expect(markdown).toContain('colspan="2"');
    expect(markdown).toContain('rowspan="2"');
    for (const cell of ["Consideration", "Cash", "On closing", "Deferred"]) {
      expect(markdown).toContain(cell);
    }
  });

  it("ingestion: a nested table remains visible", async () => {
    const markdown = await draftingText(fixture("kitchen-sink"));

    // The outer table plus the nested one both render as raw HTML tables.
    expect((markdown.match(/<table/gu) ?? []).length).toBeGreaterThanOrEqual(
      2,
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
  it("ingestion: labels live only in numbering.xml and the drafting source renders them", async () => {
    const bytes = fixture("auto-numbered");
    const body = await extractDocxBodyText(bytes);

    // The numbers appear nowhere in the text planes the body flattener
    // reads — specialist numbering analysis must reconstruct them from OOXML.
    expect(body).toBe(
      "Definitions.\nAffiliate has the meaning given.\nGoverning law.",
    );
    expect(body).not.toMatch(/\d/u);

    const markdown = await draftingText(bytes);
    // Pandoc resolves the numbering into the markdown — the model sees
    // the labels as literal text (matching upstream Mike behaviour).
    // gfm emits "1.  Definitions." (double space after the period and a
    // trailing period from the document text).
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
    const bytes = fixture("tracked-changes");

    // Accepted view: the insertion is in, the deletion is out.
    const body = await extractDocxBodyText(bytes);
    expect(body).toBe("The seat of arbitration is Toronto.\nCosts follow the cause.");
    expect(body).not.toContain("Zurich");

    // The drafting source flattens tracked changes to the accepted view and
    // warns that revision intent was flattened — the redline mode is the
    // review surface where the marks survive.
    const markdown = await draftingText(bytes);
    // Pandoc emits the accepted view as plain markdown paragraphs.
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
  it("ingestion: literal header/footer text is outside the drafting view", async () => {
    const bytes = fixture("header-footer-text");

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
    const bytes = fixture("footnotes");

    const markdown = await draftingText(bytes);
    expect(markdown).toContain("[^1]");
    expect(markdown).toContain("[^2]");
    expect(markdown).toContain("[^1]: See Schedule B.");
    expect(markdown).toContain("[^2]: As amended.");
    // Native note anchor markup is gone; only the markers remain.
    expect(markdown).not.toContain('href="#footnote-');
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
  it("ingestion: text-box text is off the body plane and dropped by Pandoc", async () => {
    const bytes = fixture("text-box");

    const body = await extractDocxBodyText(bytes);
    expect(body).not.toContain("Draft only - not for execution.");

    // Pandoc drops drawingML text-box content, so it is not visible in the
    // drafting view — unlike mammoth which carried it through as HTML. The
    // raw-XML detection still fires the warning.
    const markdown = await draftingText(bytes);
    expect(markdown).not.toContain("Draft only - not for execution.");
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
  it("ferry-boats-remission: a real regulation reads cleanly", async () => {
    const bytes = await realFerryBoatsRemission();

    const markdown = await draftingText(bytes);
    expect(markdown).toContain("Ferry-Boats Remission Order, 2016");
    expect(markdown).toContain("1 Remission is granted");

    const body = await extractDocxBodyText(bytes);
    // Literal "1" / "(a)" markers in a real instrument stay literal because
    // the source lines are plain paragraphs, not auto-numbered list items.
    expect(body).toContain("1 Remission is granted");
    expect(body).toContain("(a) the ferry-boat");
    expect(body.split("\n").length).toBeGreaterThan(40);
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

    // Pandoc reads the document clean — dangling style references do not
    // produce warnings (Pandoc ignores undefined styles silently).
    const markdown = await draftingText(bytes);
    expect(markdown).toContain("Governing Law");
    expect(markdown).toContain("$87.3 million");
    // No "referenced but not defined" warnings — Pandoc treats
    // undefined styles as Normal paragraphs.
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

    // Pandoc cannot parse the malformed document.xml and exits non-zero;
    // the drafting view fails closed with a message naming the part.
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
  it("keeps heading, list, table, footnote and emphasis through the wire", async () => {
    const bytes = await renderDocxMarkdown(MATRIX_MARKDOWN, {
      title: "Agreement",
    });
    const markdown = await draftingText(bytes);

    expect(markdown).toContain("Definitions");
    expect(markdown).toContain("**Vendor**");
    // gfm emits pipe tables matching our write-side dialect.
    expect(markdown).toMatch(/\|/u); // pipe table delimiter
    expect(markdown).toContain("Price");
    expect(markdown).toContain("[^1]");
    expect(markdown).toContain("[^1]: This is the source footnote.");
    // The (a)/(b) list preserved as markdown list items.
    expect(markdown).toMatch(/^\d/um); // numbered list
    expect(markdown).toContain("First obligation");
  });

  it("content controls re-ingest as flattened placeholder text", async () => {
    const bytes = await renderDocxMarkdown(
      ["{{party_name}}", "", "The purchaser is {{purchaser}}."].join("\n"),
      { title: "Agreement" },
    );

    // The rendered package carries real w:sdt controls with w:tag values.
    const documentXml = await packageXml(bytes, "word/document.xml");
    expect(documentXml).toContain('<w:tag w:val="party_name"/>');

    // Re-ingesting reads the placeholder text, not the markers — and the
    // drafting view now warns that the controls were flattened, naming the
    // tag the model can re-render to keep the control.
    const markdown = await draftingText(bytes);
    expect(markdown).toContain("[Party name]");
    expect(markdown).toContain("[Purchaser]");
    expect(markdown).not.toContain("{{party_name}}");
  });
});
