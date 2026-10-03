import { execFileSync } from "node:child_process";
import path from "node:path";
import { Header, Footer, Paragraph, TextRun } from "docx";
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

const acceptedParagraphs = (xml: string) => [...xml.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/gu, "")
  .matchAll(/<w:p[ >][\s\S]*?<\/w:p>/gu)].map(([p]) =>
    [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map(m => m[1]).join(""));

describe.skipIf(!available())("Word adjacent text replacement", () => {
  for (const mode of ["direct", "tracked"] as const) {
    it.each([{ count: 0, digits: "111111", replacements: 2 }, { count: 1, digits: "11111", replacements: 1 }])(
      `${mode}: replaces original occurrences when the replacement contains the search text (count=$count)`,
      async ({ count, digits, replacements }) => {
        const source = await docxBytes([
          new Paragraph({ children: [new TextRun("Marker "), new TextRun({ text: "11", bold: true }),
            new TextRun({ text: "11", italics: true }), new TextRun(" only.")] }),
          new Paragraph("Preserve this inspection note exactly."),
        ], {}, {
          headers: { default: new Header({ children: [new Paragraph("Label register")] }) },
          footers: { default: new Footer({ children: [new Paragraph("Revision C")] }) },
        });
        const { report, candidate } = await runWordPython(source, { action: "preview", mode,
          program: `return replace_text(doc.paragraphs[0], '11', '111', count=${count})` }, new AbortController().signal);
        expect(report).toMatchObject({ result: replacements, reopened: true, libreoffice_opened: true });
        if (mode === "tracked") expect(report.review_verified).toBe(true);
        expect(acceptedParagraphs(await docxXml(candidate!))).toEqual([
          `Marker ${digits} only.`, "Preserve this inspection note exactly.",
        ]);
        expect(acceptedParagraphs(await docxXml(candidate!, "word/header1.xml"))).toEqual(["Label register"]);
        expect(acceptedParagraphs(await docxXml(candidate!, "word/footer1.xml"))).toEqual(["Revision C"]);
        if (mode === "direct" && count === 0) {
          const xml = await docxXml(candidate!);
          const properties = (value: string, text: string) => [...value.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/gu)]
            .filter(([r]) => r.match(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/u)?.[1] === text)
            .map(([r]) => r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/u)?.[0]);
          const originalProperties = properties(await docxXml(source), "11");
          expect(originalProperties).toHaveLength(2);
          expect(properties(xml, "111")).toEqual(originalProperties);
        }
      }, 120_000,
    );
  }
});
