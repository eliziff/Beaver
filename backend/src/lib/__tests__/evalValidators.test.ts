import { describe, expect, it } from "vitest";
import { renderDocxMarkdown } from "../chat/tools/docxMarkdown";
import {
  checkDocxStructure,
  forbiddenSources,
  missingFilenames,
  missingHeadings,
  missingProvenanceIds,
  quotationOccurs,
  seededIdentifierLeaks,
} from "../evalValidators";

const DOC =
  'The court held that "the standard of care applies to every occupier".\nCosts follow the event.';

describe("evaluation validator primitives", () => {
  it("finds exact and normalized quotations, rejects fabricated ones", () => {
    expect(quotationOccurs(DOC, "Costs follow the event.")).toEqual({
      found: true,
      method: "exact",
    });
    // Editorial alteration + collapsed whitespace still matches.
    expect(
      quotationOccurs(DOC, '"[T]he standard  of care applies to every occupier"'),
    ).toEqual({ found: true, method: "normalized" });
    expect(quotationOccurs(DOC, "the standard of proof applies")).toEqual({
      found: false,
      method: null,
    });
    expect(quotationOccurs(DOC, "   ")).toEqual({ found: false, method: null });
  });

  it("detects seeded identifier leakage case-insensitively", () => {
    expect(
      seededIdentifierLeaks("See file ZX-9981-Q for details.", [
        "zx-9981-q",
        "never-present",
      ]),
    ).toEqual(["zx-9981-q"]);
  });

  it("reports cited sources outside the permitted packet once each", () => {
    expect(
      forbiddenSources(
        ["a2aj-case-1", "rogue-blog", "Rogue-Blog", " a2aj-case-1 "],
        ["A2AJ-CASE-1"],
      ),
    ).toEqual(["rogue-blog"]);
  });

  it("matches required headings across markdown and bare lines", () => {
    const output = "# Issues\nBody.\n\n##  Analysis of  Duty\n\nConclusion";
    expect(
      missingHeadings(output, ["Issues", "analysis of duty", "Disposition"]),
    ).toEqual(["Disposition"]);
  });

  it("finds required provenance identifiers and deliverable filenames", () => {
    const output = "As held in R v Smith,\n2020 SCC 5, at para 12.";
    expect(
      missingProvenanceIds(output, ["2020 scc 5", "2019 ONCA 100"]),
    ).toEqual(["2019 ONCA 100"]);
    expect(
      missingFilenames(["Memo.DOCX ", "chronology.xlsx"], [" memo.docx", "brief.docx"]),
    ).toEqual(["brief.docx"]);
  });

  it("validates a real DOCX and counts revisions; rejects garbage bytes", async () => {
    const bytes = await renderDocxMarkdown("# T\n\nBody.", { title: "t" });
    const good = await checkDocxStructure(bytes);
    expect(good).toMatchObject({
      opens: true,
      hasBody: true,
      trackedInsertions: 0,
      trackedDeletions: 0,
      comments: 0,
    });
    const bad = await checkDocxStructure(Buffer.from("not a docx"));
    expect(bad.opens).toBe(false);
  });

  it("counts comment structures from the comments part", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document><w:body></w:body></w:document>");
    zip.file(
      "word/comments.xml",
      '<w:comments><w:comment w:id="0"/><w:comment w:id="1"/></w:comments>',
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const check = await checkDocxStructure(bytes);
    expect(check).toMatchObject({ opens: true, hasBody: true, comments: 2 });
  });
});
