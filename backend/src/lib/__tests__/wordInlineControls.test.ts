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
const accepted = (xml: string) => xml.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/gu, "");
const controls = (xml: string) => xml.match(/<w:(?:noBreakHyphen|ptab|br)\b[^>]*\/>/gu) ?? [];
const text = (xml: string) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map(m => m[1]).join("");

describe.skipIf(!available())("Word inline-control preservation", () => {
  for (const mode of ["direct", "tracked"] as const) {
    it.each([false, true])(`${mode}: preserves untouched run controls during text replacement (extra=%s)`, async extra => {
      const bytes = await docxBytes([new Paragraph("placeholder"), new Paragraph("Preserve the audit note exactly.")], {}, {
        headers: { default: new Header({ children: [new Paragraph("Seal register")] }) },
        footers: { default: new Footer({ children: [new Paragraph("Revision D")] }) },
      });
      const zip = await JSZip.loadAsync(bytes);
      const xml = await docxXml(bytes);
      const inserted = "<w:t>Seal code: KIT</w:t><w:noBreakHyphen/><w:t>Verified</w:t>" + (extra
        ? '<w:ptab w:alignment="right" w:relativeTo="margin" w:leader="none"/><w:t>Seal</w:t>' +
          '<w:br w:type="textWrapping" w:clear="all"/><w:t>After.</w:t>' : "");
      const original = xml.replace(/<w:t[^>]*>placeholder<\/w:t>/u, inserted);
      zip.file("word/document.xml", original);
      const source = await zip.generateAsync({ type: "nodebuffer" });
      const { report, candidate } = await runWordPython(source, { action: "preview", mode,
        program: "return replace_text(doc.paragraphs[0], 'Verified', 'Checked')" }, new AbortController().signal);
      expect(report).toMatchObject({ result: 1, reopened: true, libreoffice_opened: true });
      if (mode === "tracked") expect(report.review_verified).toBe(true);
      const after = accepted(await docxXml(candidate!));
      expect(controls(original)).toHaveLength(extra ? 3 : 1);
      expect(controls(after)).toEqual(controls(original));
      expect(text(after)).toBe(text(original).replace("Verified", "Checked"));
      expect(text(await docxXml(candidate!, "word/header1.xml"))).toBe("Seal register");
      expect(text(await docxXml(candidate!, "word/footer1.xml"))).toBe("Revision D");
    }, 120_000);
  }
});
