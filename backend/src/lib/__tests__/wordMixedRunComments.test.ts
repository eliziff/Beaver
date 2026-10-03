import { ImageRun, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { runWordPython } from "../wordPython";
import { type XNode, createParser, createBuilder, elChildren, elName, findBody, makeEl, setChildren } from "../docx/core";
import { docxBytes, docxXml } from "./support/docxFixtures";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4f+A0AAVMAotDMHBLAAAAAElFTkSuQmCC", "base64");
async function sourceBytes(mixed: boolean) {
  const source = await docxBytes([new Paragraph({ children: [new TextRun("Caption"),
    ...(mixed ? [new ImageRun({ type: "png", data: image, transformation: { width: 12, height: 12 } })] : []), new TextRun(" tail.")] }),
    new Paragraph("Protected audit line.")]);
  if (!mixed) return source;
  const nodes = createParser().parse(await docxXml(source)) as XNode[];
  const p = elChildren(findBody(nodes)).find(n => elName(n) === "w:p")!;
  const runs = elChildren(p).filter(n => elName(n) === "w:r");
  setChildren(p, [makeEl("w:r", runs.flatMap(r => elChildren(r)))]);
  const zip = await JSZip.loadAsync(source); zip.file("word/document.xml", createBuilder().build(nodes));
  return zip.generateAsync({ type: "nodebuffer" });
}
describe("unchanged mixed-run content in Review", () => {
  for (const task of [
    { name: "plain comment control", mixed: false, program: "doc.add_comment(isolate(doc.paragraphs[0],'Caption'),text='Keep this caption.',author='Reviewer')", unchanged: true },
    { name: "comment beside a drawing", mixed: true, program: "doc.add_comment(isolate(doc.paragraphs[0],'Caption'),text='Keep this caption.',author='Reviewer')", unchanged: true },
    { name: "isolate without a content edit", mixed: true, program: "isolate(doc.paragraphs[0],'Caption')", unchanged: true },
    { name: "still records a real font change", mixed: true, program: "for r in isolate(doc.paragraphs[0],'Caption'): r.bold=True", unchanged: false },
  ]) it(task.name, async () => {
    const source = await sourceBytes(task.mixed);
    const { report, candidate } = await runWordPython(source, { action: "preview", mode: "tracked", program: task.program }, new AbortController().signal);
    expect(report).toMatchObject({ reopened: true, libreoffice_opened: true, review_verified: true });
    const xml = await docxXml(candidate!); expect(xml).toContain("Protected audit line.");
    if (task.unchanged) {
      expect(report.new_revision_count).toBe(0);
      if (task.mixed) expect((xml.match(/<w:drawing\b/gu) || []).length).toBe(1);
    } else expect(report.new_revision_count).toBeGreaterThan(0);
  }, 120_000);
});
