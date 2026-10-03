import { Footer, Header, Paragraph, Table, TableCell, TableRow } from "docx";
import { describe, expect, it } from "vitest";
import { runWordPython } from "../wordPython";
import { docxBytes, docxXml } from "./support/docxFixtures";

describe("Word table topology additions", () => {
  for (const mode of ["direct", "tracked"] as const) for (const kind of ["row", "column"] as const) {
    it(`${mode} adds a ${kind} while preserving existing cells`, async () => {
      const rows = [["Item", "Count"], ["Crates", "12"]];
      const source = await docxBytes([
        new Table({ rows: rows.map(values => new TableRow({ children: values.map(value =>
          new TableCell({ children: [new Paragraph(value)] })) })) }),
        new Paragraph("Protected audit note."),
      ], {}, { headers: { default: new Header({ children: [new Paragraph("Inventory header")] }) },
        footers: { default: new Footer({ children: [new Paragraph("Revision K")] }) } });
      const program = kind === "row" ? "cells=doc.tables[0].add_row().cells\nfor c,v in zip(cells,['Seals','3']): c.text=v" :
        "from docx.shared import Mm\ndoc.tables[0].add_column(Mm(12))\nfor r,v in zip(doc.tables[0].rows,['Notes','C12']): r.cells[-1].text=v";
      const { report, candidate } = await runWordPython(source, { action: "preview", mode, program }, new AbortController().signal);
      expect(report).toMatchObject({ reopened: true, libreoffice_opened: true });
      if (mode === "tracked") expect(report.review_verified).toBe(true);
      const xml = await docxXml(candidate!);
      for (const value of rows.flat()) expect(xml).toContain(`>${value}</w:t>`);
      expect(xml).toContain("Protected audit note.");
      expect(await docxXml(candidate!, "word/header1.xml")).toContain("Inventory header");
      expect(await docxXml(candidate!, "word/footer1.xml")).toContain("Revision K");
      if (kind === "column" && mode === "tracked") {
        expect((xml.match(/<w:cellIns\b/gu) || []).length).toBe(2);
        expect(report.new_revisions).toMatchObject({ cellIns: 2 });
      }
    }, 120_000);
  }
});
