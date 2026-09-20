import { describe, expect, it } from "vitest";

import {
  buildPptxPresentation,
  findTextMatches,
  presentationFromMarkdown,
  renderXlsxWorkbook,
  workbookFromMarkdown,
} from "../tools/documentOps";

const TEXT = [
  "8.01 Financial Covenants.",
  "(a) The Borrower shall maintain Minimum Liquidity of $5,000,000.",
  "(b) The Total Net Leverage Ratio shall not exceed 4.50:1.00.",
  "Notices go to 100 King Street West, Toronto.",
].join("\n");

describe("findTextMatches offsets", () => {
  it("reports the original-text offset of each hit", () => {
    const { hits } = findTextMatches({
      text: TEXT,
      query: "Leverage Ratio",
      maxResults: 5,
      contextChars: 40,
    });
    expect(hits).toHaveLength(1);
    expect(TEXT.slice(hits[0].at, hits[0].at + 8)).toBe("Leverage");
  });
});

describe("renderXlsxWorkbook", () => {
  it("writes readable workbooks through the standard spreadsheet library", async () => {
    const XLSX = await import("xlsx");
    const bytes = await renderXlsxWorkbook("Review", [
      {
        name: "Issues/Notes",
        columns: ["Party", "Note"],
        rows: [["A&B", "<open>"]],
      },
      { name: "Issues/Notes", columns: ["Status"], rows: [["Done"]] },
    ]);
    const workbook = XLSX.read(bytes, { type: "buffer" });
    expect(workbook.SheetNames).toHaveLength(2);
    expect(new Set(workbook.SheetNames).size).toBe(2);
    expect(
      XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
        header: 1,
      }),
    ).toEqual([
      ["Party", "Note"],
      ["A&B", "<open>"],
    ]);
  });
});

it("round-trips native numbers, booleans, literal strings and formulas without losing uncached cells", async () => {
  const XLSX = await import("xlsx"), { spreadsheetToLLMStructure } = await import("../../spreadsheet");
  const bytes = await renderXlsxWorkbook("Calculation", [{ name: "Costs", rows: [
    ["Rate", "Hours", "Amount", "Literal"],
    [100, 2, { t: "n", f: "A2*B2" }, "=A2*B2"],
    [0.125, true, { t: "n", f: "A2*B2", v: 200, z: "$0.00" }, "0012"],
  ] }]);
  const sheet = XLSX.read(bytes, { type: "buffer", cellNF: true, sheetStubs: true }).Sheets.Costs;
  expect(sheet.A2).toMatchObject({ t: "n", v: 100 });
  expect(sheet.B3).toMatchObject({ t: "b", v: true });
  expect(sheet.C2.f).toBe("A2*B2");
  expect(sheet.C3).toMatchObject({ t: "n", f: "A2*B2", v: 200, z: "$0.00" });
  expect(sheet.D2).toMatchObject({ t: "s", v: "=A2*B2" });
  expect(sheet.D3.v).toBe("0012");
  const projection = await spreadsheetToLLMStructure(bytes);
  expect(projection.text).toContain("=A2*B2 ⟨n; cached:");
  expect(projection.tableCells.find(cell => cell.address === "C2")).toMatchObject({ formula: "A2*B2", type: "n" });
  await expect(renderXlsxWorkbook("Invalid", [{ name: "Bad", rows: [[{ t: "n", v: "wrong" }]] }])).rejects.toThrow();
});

describe("Write markup", () => {
  it("parses workbook sheets and presentation slides", () => {
    expect(workbookFromMarkdown([
      "# Review",
      "## Issues",
      "| Party | Status |",
      "| --- | --- |",
      "| Acme | Open |",
    ].join("\n"))).toEqual([{
      name: "Issues",
      columns: ["Party", "Status"],
      rows: [["Acme", "Open"]],
    }]);
    expect(presentationFromMarkdown([
      "# Review",
      "## Result",
      "- Motion granted",
      "```notes",
      "Speaker-only detail",
      "```",
    ].join("\n"))).toEqual([{
      title: "Result",
      bullets: ["Motion granted"],
    }]);
  });

  it("writes an openable PPTX package with every requested slide", async () => {
    const slides = presentationFromMarkdown([
      "## Result",
      "- Motion granted & costs reserved",
      "## Next step",
      "- Serve the order",
    ].join("\n"));
    const zip = await (await import("jszip")).default.loadAsync(
      await buildPptxPresentation(slides),
    );
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(zip.file("ppt/presentation.xml")).not.toBeNull();
    expect(zip.file("ppt/slides/slide1.xml")).not.toBeNull();
    expect(zip.file("ppt/slides/slide2.xml")).not.toBeNull();
    expect(await zip.file("ppt/slides/slide1.xml")!.async("text"))
      .toContain("Motion granted &amp; costs reserved");
    expect(await zip.file("ppt/slides/slide2.xml")!.async("text"))
      .toContain("Serve the order");
  });
});
