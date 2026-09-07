import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { spreadsheetToLLMStructure, spreadsheetToLLMText } from "../spreadsheet";

function fixtureWorkbook(bookType: XLSX.BookType) {
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
  const lastColumn = bookType === "xls" ? "IV" : "XFD";
  sheet[`${lastColumn}20`] = { t: "s", v: "", s: { font: { bold: true } } };
  sheet["!ref"] = `A1:${lastColumn}20`;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, {}, "Empty");
  XLSX.utils.book_append_sheet(workbook, sheet, "Damages");
  XLSX.utils.book_append_sheet(workbook, {
    "!ref": "AA10:AE12",
    "!merges": ["AA10:AB11", "AC12:AE12"].map(XLSX.utils.decode_range),
    AA10: { t: "s", v: "Costs 😊 | fees\npaid" },
    AB11: { t: "s", v: "Covered cell must not leak" },
  }, "Schedule");
  return XLSX.write(workbook, { type: "buffer", bookType }) as Buffer;
}

describe("spreadsheetToLLMStructure", () => {
  it("bounds workbook rendering complexity", async () => {
    const workbook = XLSX.utils.book_new();
    for (let index = 0; index < 257; index += 1)
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[index]]), `S${index}`);
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    await expect(spreadsheetToLLMStructure(bytes)).rejects.toThrow("too many sheets");
  });

  it.each(["xlsx", "xlsm", "xls"] as const)(
    "keeps a compact projection backed by exact native cells (%s)", async (format) => {
    const bytes = fixtureWorkbook(format);
    const structure = await spreadsheetToLLMStructure(bytes, format);
    expect(await spreadsheetToLLMText(bytes, format)).toBe(structure.text);

    expect(structure.text).toBe(
      [
        "## Sheet: Damages",
        "",
        "| Row | A | B | D |",
        "| --- | --- | --- | --- |",
        "| 1 | Quarterly revenue ⟨merged A1:C1⟩ |  | Total |",
        "| 2 | Matter | Status | Cost |",
        "| 7 | Smith | Open | 1,200 |",
        "",
        "## Sheet: Schedule",
        "",
        "| Row | AA | AC |",
        "| --- | --- | --- |",
        "| 10 | Costs 😊 \\| fees paid ⟨merged AA10:AB11⟩ |  |",
        "| 12 |  | ⟨merged AC12:AE12⟩ |",
      ].join("\n"),
    );
    expect(structure.tableCells).toHaveLength(10);
    expect(structure.text).not.toContain("XFD");
    const merges = new Map([["A1", "A1:C1"], ["AA10", "AA10:AB11"], ["AC12", "AC12:AE12"]]);
    for (const cell of structure.tableCells) {
      const label = merges.get(cell.address);
      expect(structure.text.slice(cell.start, cell.end)).toBe(
        [cell.displayValue, label && `⟨merged ${label}⟩`].filter(Boolean).join(" "),
      );
    }
    expect(structure.tableCells.slice(-2)).toMatchObject([
      { table: 2, tableName: "Schedule", row: 10, column: 27, address: "AA10",
        columnSpan: 2, rowSpan: 2, displayValue: "Costs 😊 \\| fees paid" },
      { table: 2, tableName: "Schedule", row: 12, column: 29, address: "AC12",
        columnSpan: 3, displayValue: "" },
    ]);

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
    expect(merged).not.toHaveProperty("rowSpan");
    expect(structure.tableCells.some((cell) => cell.address === "B1")).toBe(false);
  });
});
