import { Paragraph } from "docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { runWordPython } from "../wordPython";
import { docxBytes, docxXml } from "./support/docxFixtures";

describe("Explicit field refresh overrides a disabled document setting", () => {
  for (const mode of ["direct", "tracked"] as const) {
    it.each(["false", "0"])(`${mode}: existing disabled value %s`, async value => {
      const zip = await JSZip.loadAsync(await docxBytes([new Paragraph("Protected audit line.")]));
      const settings = await zip.file("word/settings.xml")!.async("string");
      zip.file("word/settings.xml", settings.replace("<w:compat", `<w:updateFields w:val="${value}"/><w:compat`));
      const source = await zip.generateAsync({ type: "nodebuffer" });
      const { report, candidate } = await runWordPython(source, {
        action: "preview", mode, program: "update_fields_on_open()\nupdate_fields_on_open()",
      }, new AbortController().signal);
      expect(report).toMatchObject({ reopened: true, python_docx_reopened: true, libreoffice_opened: true });
      if (mode === "tracked") expect(report.review_verified).toBe(true);
      const updated = await docxXml(candidate!, "word/settings.xml");
      expect(updated.match(/<w:updateFields\b[^>]*>/gu)).toEqual(['<w:updateFields w:val="true"/>']);
      expect(updated.indexOf("<w:updateFields")).toBeLessThan(updated.indexOf("<w:compat"));
      expect(await docxXml(candidate!)).toContain("Protected audit line.");
      expect((await docxXml(source, "word/settings.xml"))).toContain(`w:updateFields w:val="${value}"`);
    }, 120_000);
  }
});
