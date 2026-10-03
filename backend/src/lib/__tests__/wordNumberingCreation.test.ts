import { execFileSync } from "node:child_process";
import path from "node:path";
import { Header, Footer, Paragraph } from "docx";
import JSZip from "jszip";
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
const text = (xml: string) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map(m => m[1]).join("");

describe.skipIf(!available())("Word numbering-part creation", () => {
  for (const mode of ["direct", "tracked"] as const) {
    it.each(["legal", "bullet"])(`${mode}: creates a %s list in a document without numbering`, async kind => {
      const paragraphs = ["Packaging checklist", "Inspect the latch", "Count the tags", "Sign the log", "Preserve the audit note."];
      const bytes = await docxBytes(paragraphs.map(p => new Paragraph(p)), {}, {
        headers: { default: new Header({ children: [new Paragraph("Package register")] }) },
        footers: { default: new Footer({ children: [new Paragraph("Revision E")] }) },
      });
      const zip = await JSZip.loadAsync(bytes);
      zip.remove("word/numbering.xml");
      zip.remove("word/_rels/numbering.xml.rels");
      const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
      zip.file("word/_rels/document.xml.rels", rels.replace(/<Relationship\b[^>]*Type="[^"]*\/numbering"[^>]*\/>/gu, ""));
      const types = await zip.file("[Content_Types].xml")!.async("string");
      zip.file("[Content_Types].xml", types.replace(/<Override\b[^>]*PartName="\/word\/numbering.xml"[^>]*\/>/gu, ""));
      const source = await zip.generateAsync({ type: "nodebuffer" });
      const { report, candidate } = await runWordPython(source, { action: "preview", mode,
        program: `return numbered_list([doc.paragraphs[i] for i in range(1,4)], kind='${kind}', start=3)` },
        new AbortController().signal);
      expect(report).toMatchObject({ reopened: true, libreoffice_opened: true, new_lists: 1 });
      if (mode === "tracked") expect(report.review_verified).toBe(true);
      const xml = await docxXml(candidate!);
      expect(text(xml)).toBe(paragraphs.join(""));
      expect((xml.match(/<w:numId /gu) ?? [])).toHaveLength(3);
      const numbering = await docxXml(candidate!, "word/numbering.xml");
      expect(numbering).toMatch(/<w:start w:val="3"\/>/u);
      expect((numbering.match(/<w:numFmt w:val="decimal"\/>/gu) ?? [])).toHaveLength(kind === "legal" ? 9 : 0);
      expect((numbering.match(/<w:numFmt w:val="bullet"\/>/gu) ?? [])).toHaveLength(kind === "bullet" ? 9 : 0);
      expect(text(await docxXml(candidate!, "word/header1.xml"))).toBe("Package register");
      expect(text(await docxXml(candidate!, "word/footer1.xml"))).toBe("Revision E");
    }, 120_000);
  }
});
