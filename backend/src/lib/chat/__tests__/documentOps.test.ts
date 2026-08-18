import { describe, expect, it } from "vitest";

import {
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
});
