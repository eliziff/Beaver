import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { compileAgreementSkeleton, readSection } from "../legalTextSkeleton";
import { spreadsheetToLLMStructure } from "../spreadsheet";

function fixtureWorkbook() {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Quarterly revenue", undefined, undefined, "Total"],
    ["Matter", "Status", undefined, "Cost"],
  ]);
  XLSX.utils.sheet_add_aoa(sheet, [["Smith", "Open", undefined, 1200]], {
    origin: "A7",
  });
  sheet.D7.z = "#,##0";
  sheet["!merges"] = [XLSX.utils.decode_range("A1:C1")];
  // A style-only remote cell may inflate !ref in real workbooks. It must not
  // create 16,384 columns of model context.
  sheet.XFD20 = { t: "s", v: "", s: { font: { bold: true } } };
  sheet["!ref"] = "A1:XFD20";
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Damages");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("spreadsheetToLLMStructure", () => {
  it("bounds workbook rendering complexity", async () => {
    const workbook = XLSX.utils.book_new();
    for (let index = 0; index < 257; index += 1)
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[index]]), `S${index}`);
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    await expect(spreadsheetToLLMStructure(bytes)).rejects.toThrow("too many sheets");
  });

  it("keeps a compact projection backed by exact native cells", async () => {
    const structure = await spreadsheetToLLMStructure(fixtureWorkbook());

    expect(structure.text).toBe(
      [
        "## Sheet: Damages",
        "",
        "| Row | A | B | D |",
        "| --- | --- | --- | --- |",
        "| 1 | Quarterly revenue ⟨merged A1:C1⟩ |  | Total |",
        "| 2 | Matter | Status | Cost |",
        "| 7 | Smith | Open | 1,200 |",
      ].join("\n"),
    );
    expect(structure.tableCells).toHaveLength(8);
    expect(structure.text).not.toContain("XFD");
    for (const cell of structure.tableCells) {
      expect(structure.text.slice(cell.start, cell.end)).toContain(
        cell.displayValue,
      );
    }

    const merged = structure.tableCells.find((cell) => cell.address === "A1");
    expect(merged).toMatchObject({
      table: 1,
      tableName: "Damages",
      row: 1,
      column: 1,
      columnSpan: 3,
      address: "A1",
      displayValue: "Quarterly revenue",
    });
    expect(structure.tableCells.some((cell) => cell.address === "B1")).toBe(false);
  });

  it("makes the typed sheet grid addressable without exposing its inventory", async () => {
    const structure = await spreadsheetToLLMStructure(fixtureWorkbook());
    const skeleton = await compileAgreementSkeleton(structure.text, "workbook", {
      tableCells: structure.tableCells,
      recoverExtraction: false,
    });

    expect(skeleton.nodes.find((node) => node.label === "table:1")?.display).toBe(
      "Sheet Damages",
    );
    expect(readSection(skeleton, "table:1/row:7/col:4")).toMatchObject({
      status: "found",
      block: { text: "1,200" },
    });
    expect(readSection(skeleton, "table:1/row:7")).toMatchObject({
      status: "found",
      block: { text: "Smith | Open | 1,200" },
    });
  });
});
