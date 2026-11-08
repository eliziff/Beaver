import { z } from "zod/v4";

// A workbook the assistant writes: its sheets, each an optional header row and rows of SheetJS cells (a plain value,
// or a typed value with its formula and number format). Workbooks are read by the engine (formats/sheet.rs).
const scalar = z.union([z.string().max(32_767), z.number().finite(), z.boolean(), z.null()]);
const nativeCell = z.object({ t: z.enum(["s", "n", "b"]), v: scalar.optional(),
  f: z.string().min(1).max(8_192).optional(), z: z.string().max(256).optional() }).strict()
  .refine(cell => cell.v !== undefined || !!cell.f, "A cell needs a value or formula")
  .refine(cell => !cell.f?.startsWith("="), "SheetJS formulas omit the leading equals sign")
  .refine(cell => cell.v == null || typeof cell.v === ({ n: "number", s: "string", b: "boolean" }[cell.t]),
    "Cell type and value disagree");
export const workbookSheetsSchema = z.array(z.object({
  name: z.string().min(1).max(100), columns: z.array(z.string().max(32_767)).max(16_384).optional(),
  rows: z.array(z.array(z.union([scalar, nativeCell])).max(16_384)).max(100_000),
})).min(1).max(256).refine(sheets => sheets.reduce((n, sheet) =>
  n + (sheet.columns?.length ?? 0) + sheet.rows.reduce((n, row) => n + row.length, 0), 0) <= 500_000,
  "Workbook exceeds the cell limit");
