import { execFileSync } from "node:child_process";
import path from "node:path";
import { Paragraph } from "docx";
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

describe.skipIf(!available())("Word Review-mode control verification", () => {
  for (const kind of ["noBreakHyphen", "br"] as const) {
    it.each([true, false])(`${kind}: verifies control changes only with native revisions (bypass=%s)`, async bypass => {
      const bytes = await docxBytes([new Paragraph("placeholder"), new Paragraph("Preserve the register note exactly.")]);
      const zip = await JSZip.loadAsync(bytes);
      const inserted = kind === "noBreakHyphen"
        ? '<w:t>KIT</w:t><w:noBreakHyphen/><w:t>Verified</w:t>'
        : '<w:t>First label</w:t><w:br w:clear="all"/><w:t>Second label</w:t>';
      zip.file("word/document.xml", (await docxXml(bytes)).replace(/<w:t[^>]*>placeholder<\/w:t>/u, inserted));
      const source = await zip.generateAsync({ type: "nodebuffer" });
      const program = (bypass ? "import sys\nsys.modules['tracking'].Recorder.record = lambda self: []\n" : "") +
        `r = next(r for r in doc.paragraphs[0].runs if r._r.find(qn('w:${kind}')) is not None)\nr.text = r.text`;
      const run = runWordPython(source, { action: "preview", mode: "tracked", program }, new AbortController().signal);
      if (bypass) await expect(run).rejects.toThrow(/not a tracked revision/u);
      else {
        const { report, candidate } = await run;
        expect(report).toMatchObject({ reopened: true, libreoffice_opened: true, review_verified: true });
        expect(report.new_revision_count).toBeGreaterThanOrEqual(2);
        const xml = await docxXml(candidate!);
        // Deletions retain the original control; accepting them removes its semantics.
        expect(xml).toMatch(kind === "noBreakHyphen" ? /<w:noBreakHyphen\/>/u : /<w:br w:clear="all"\/>/u);
        const accepted = xml.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/gu, "");
        expect(accepted).not.toMatch(kind === "noBreakHyphen" ? /<w:noBreakHyphen\/>/u : /w:clear="all"/u);
        expect(accepted).toContain("Preserve the register note exactly.");
      }
    }, 120_000);
  }
});
