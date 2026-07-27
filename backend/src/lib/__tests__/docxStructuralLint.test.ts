import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { lintDocxStructure } from "../docxStructuralLint";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function escapeXml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

async function fixture(paragraphs: string[]) {
  const zip = new JSZip();
  const body = paragraphs
    .map(
      (text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`,
    )
    .join("\n");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="${W}"><w:body>
${body}
</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function codes(report: Awaited<ReturnType<typeof lintDocxStructure>>) {
  return report.findings.map((finding) => `${finding.code}:${finding.subject}`);
}

describe("deterministic DOCX structural lint", () => {
  it("flags a cross-reference to a missing top-level provision", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "1. Definitions",
        "2. Term",
        "3. Rent",
        "4. Termination",
        "The Tenant may terminate this Lease under Section 7.",
        "Rent is payable as set out in Section 3.",
      ]),
    );
    expect(codes(report)).toContain("cross_reference_missing:Section 7");
    expect(report.checks.cross_references.resolved).toBe(1);
  });

  it("skips references to external instruments", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "1. Definitions",
        "2. Tax",
        "3. Elections",
        "The parties shall make an election under Section 85 of the Income Tax Act.",
        "An election under Section 2 of this Agreement is irrevocable.",
      ]),
    );
    expect(report.checks.cross_references.skipped_external).toBe(1);
    expect(report.checks.cross_references.resolved).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it("flags a missing sibling provision after renumbering", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "14.1 The Landlord shall insure the Building.",
        "14.3 The Tenant shall not vitiate the insurance.",
        "The obligations in Section 14.2 survive termination.",
        "The obligations in Section 14.1 also survive.",
      ]),
    );
    expect(codes(report)).toContain("cross_reference_missing:Section 14.2");
    expect(report.checks.cross_references.resolved).toBe(1);
  });

  it("abstains when the document does not number to the referenced depth", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "1. Definitions",
        "2. Confidentiality",
        "3. General",
        "As described in Section 2.5, disclosure is restricted.",
      ]),
    );
    expect(
      codes(report).filter((code) => code.startsWith("cross_reference")),
    ).toEqual([]);
    expect(report.notes.join(" ")).toContain("could not be checked");
  });

  it("abstains entirely when there is no literal numbering", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "Definitions",
        "Confidentiality obligations apply as stated in Section 4.",
      ]),
    );
    expect(report.findings).toEqual([]);
    expect(report.notes.join(" ")).toContain("no literal clause numbering");
  });

  it("resolves Article references against Article headings", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "ARTICLE I",
        "ARTICLE II",
        "ARTICLE III",
        "Closing occurs as described in Article II.",
        "Indemnities are set out in Article VI.",
      ]),
    );
    expect(codes(report)).toContain("cross_reference_missing:Article VI");
    expect(report.checks.cross_references.resolved).toBe(1);
  });

  it("flags a reference to a schedule that is not included", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "The Permitted Encumbrances are listed in Schedule 1.",
        "The Rent is set out in Schedule 3.",
        "SCHEDULE 1",
        "Permitted Encumbrances: none.",
      ]),
    );
    expect(codes(report)).toContain("attachment_reference_missing:Schedule 3");
    expect(report.checks.attachments.resolved).toBe(1);
  });

  it("does not flag attachment references when no attachments are included", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "The equipment is listed in Exhibit A.",
        "The premises are shown on Exhibit B.",
      ]),
    );
    expect(report.findings).toEqual([]);
    expect(report.notes.join(" ")).toContain("no Exhibit is included");
  });

  it("flags gaps and duplicates in literal clause numbering", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "12.1 The first obligation.",
        "12.2 The second obligation.",
        "12.4 The fourth obligation.",
        "5.2 A duplicate provision.",
        "5.2 Another provision with the same number.",
      ]),
    );
    expect(codes(report)).toContain("numbering_gap:12.4");
    expect(codes(report)).toContain("numbering_duplicate:5.2");
    const gap = report.findings.find((f) => f.code === "numbering_gap");
    expect(gap?.message).toContain("12.3 is missing");
  });

  it("does not treat top-level list restarts as duplicates", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "1. First section.",
        "2. Second section.",
        "1. First item of a new list.",
        "2. Second item of a new list.",
      ]),
    );
    expect(
      codes(report).filter((code) => code.startsWith("numbering")),
    ).toEqual([]);
  });

  it("flags duplicate and unused defined terms, with curly quotes", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "This lease is made between Acme Corp. (the “Landlord”) and Bob Ltd. (the “Tenant”).",
        "“Rent” means the amounts payable under Section 3.",
        "The base rent (the “Rent”) is payable monthly.",
        "The Tenant shall pay the Rent monthly in advance.",
      ]),
    );
    expect(codes(report)).toContain("defined_term_duplicate:Rent");
    expect(codes(report)).toContain("defined_term_unused:Landlord");
    expect(
      codes(report).filter((code) => code.includes("Tenant")),
    ).toEqual([]);
  });

  it("treats singular/plural variants as usage", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "The Seller manufactures widgets (the “Products”).",
        "Each Product shall conform to the Specifications.",
        "The specifications are attached (the “Specifications”).",
      ]),
    );
    expect(
      codes(report).filter((code) => code.startsWith("defined_term_unused")),
    ).toEqual([]);
  });

  it("abstains on defined-term checks when no quoted definitions exist", async () => {
    const report = await lintDocxStructure(
      await fixture(["A short letter agreement with no defined terms."]),
    );
    expect(report.checks.defined_terms.definitions).toBe(0);
    expect(report.notes.join(" ")).toContain("defined-term checks abstained");
  });

  it("ignores text inside tracked deletions", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="${W}"><w:body>
<w:p><w:r><w:t>1. Definitions</w:t></w:r></w:p>
<w:p><w:r><w:t>2. Term</w:t></w:r></w:p>
<w:p><w:r><w:t>3. Rent</w:t></w:r></w:p>
<w:p><w:del w:id="1" w:author="x"><w:r><w:t>See Section 9.</w:t></w:r></w:del></w:p>
</w:body></w:document>`,
    );
    const report = await lintDocxStructure(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    expect(report.findings).toEqual([]);
    expect(report.checks.cross_references.references).toBe(0);
  });

  it("rejects a zip that is not a DOCX", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "not a docx");
    await expect(
      lintDocxStructure(await zip.generateAsync({ type: "nodebuffer" })),
    ).rejects.toThrow("valid DOCX");
  });

  it("reports a receipt of what was checked", async () => {
    const report = await lintDocxStructure(
      await fixture([
        "1. Definitions",
        "2. Term",
        "3. Rent",
        "Rent is payable under Section 3 and Section 2.",
      ]),
    );
    expect(report.paragraphs).toBe(4);
    expect(report.checks.cross_references.references).toBe(2);
    expect(report.checks.cross_references.resolved).toBe(2);
    expect(report.checks.numbering.anchors).toBe(3);
    expect(report.findings).toEqual([]);
  });
});
