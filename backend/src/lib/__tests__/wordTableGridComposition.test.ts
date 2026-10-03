import { Paragraph, Table, TableCell, TableRow } from "docx";
import { describe, expect, it } from "vitest";
import { runWordPython } from "../wordPython";
import { docxBytes, docxXml } from "./support/docxFixtures";

describe("pending table grid revisions", () => {
  for (const mode of ["direct", "tracked"] as const) for (const change of ["column", "width"] as const) {
    it(`${mode} composes a ${change} edit with existing grid history`, async () => {
      const source = await docxBytes([
        new Table({ rows: [["One", "Two"], ["Three", "Four"]].map(values =>
          new TableRow({ children: values.map(value => new TableCell({ children: [new Paragraph(value)] })) })) }),
        new Paragraph("Protected inventory note."),
      ]);
      const first = await runWordPython(source, { action: "preview", mode: "tracked",
        program: "from docx.shared import Mm\ndoc.tables[0].add_column(Mm(12))\nfor row in doc.tables[0].rows: row.cells[-1].text='Pending'" }, new AbortController().signal);
      expect(first.report.review_verified).toBe(true);
      const { report, candidate } = await runWordPython(first.candidate!, { action: "preview", mode,
        program: change === "column" ? "from docx.shared import Mm\ndoc.tables[0].add_column(Mm(16))\nfor row in doc.tables[0].rows: row.cells[-1].text='Final'" :
          "from docx.shared import Mm\ndoc.tables[0].columns[0].width=Mm(20)" }, new AbortController().signal);
      expect(report).toMatchObject({ reopened: true, libreoffice_opened: true });
      if (mode === "tracked") expect(report.review_verified).toBe(true);
      const xml = await docxXml(candidate!);
      expect((xml.match(/<w:tblGridChange\b/gu) || []).length).toBe(1);
      expect((xml.match(/<w:tc>/gu) || []).length).toBe(change === "column" ? 8 : 6);
      for (const value of ["One", "Two", "Three", "Four", "Pending", "Protected inventory note."]) expect(xml).toContain(`>${value}</w:t>`);
      if (change === "column") expect(xml).toContain(">Final</w:t>");
    }, 120_000);
  }
});
