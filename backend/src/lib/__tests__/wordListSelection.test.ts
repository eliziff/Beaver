import { execFileSync } from "node:child_process";
import path from "node:path";
import { Header, Footer, Paragraph } from "docx";
import { describe, expect, it } from "vitest";
import { resolveSofficeBinary } from "../convert";
import { runWordPython, wordPython } from "../wordPython";
import { docxBytes, docxXml } from "./support/docxFixtures";

const available = () => {
  if (process.env.WORD_PYTHON_CONTAINER_IMAGE) return true;
  try {
    execFileSync(wordPython(), ["-I", path.resolve(__dirname, "../../../scripts/word_python/probe.py")], { stdio: "ignore" });
    return !!resolveSofficeBinary();
  } catch { return false; }
};

describe.skipIf(!available())("Word list selection", () => {
  for (const mode of ["direct", "tracked"] as const) {
    it.each([true, false])(`${mode}: empty selection %s`, async empty => {
      const paragraphs = ["Packing checklist", "Inspect the latch", "Count the tags", "Sign the log", "Preserve the audit note."];
      const source = await docxBytes(paragraphs.map(p => new Paragraph(p)), {}, {
        headers: { default: new Header({ children: [new Paragraph("Package register")] }) },
        footers: { default: new Footer({ children: [new Paragraph("Revision E")] }) },
      });
      const program = empty
        ? "return numbered_list((p for p in doc.paragraphs if text(p) == 'No matching checklist marker'), kind='legal', start=3)"
        : "return numbered_list((doc.paragraphs[i] for i in range(1,4)), kind='legal', start=3)";
      const operation = runWordPython(source, { action: "preview", mode, program }, new AbortController().signal);
      if (empty) {
        await expect(operation).rejects.toThrow(/at least one paragraph/u);
        return;
      }
      const { report, candidate } = await operation;
      expect(report).toMatchObject({ reopened: true, libreoffice_opened: true, new_lists: 1 });
      if (mode === "tracked") expect(report.review_verified).toBe(true);
      const xml = await docxXml(candidate!);
      const content = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map(m => m[1]).join("");
      expect(content).toBe(paragraphs.join(""));
      expect((xml.match(/<w:numId /gu) ?? [])).toHaveLength(3);
      expect(await docxXml(candidate!, "word/numbering.xml")).toContain('<w:start w:val="3"/>');
      expect(await docxXml(candidate!, "word/header1.xml")).toContain("Package register");
      expect(await docxXml(candidate!, "word/footer1.xml")).toContain("Revision E");
    }, 120_000);
  }
});
