import { ImageRun, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { runWordPython } from "../wordPython";
import { type XNode, createParser, createBuilder, elChildren, elName, findBody, makeEl, setChildren } from "../docx/core";
import { docxBytes, docxXml } from "./support/docxFixtures";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4f+A0AAVMAotDMHBLAAAAAElFTkSuQmCC", "base64");
async function sourceBytes(twoImages: boolean) {
  const picture = () => new ImageRun({ type: "png", data: image, transformation: { width: 12, height: 12 } });
  const bytes = await docxBytes([new Paragraph({ children: [new TextRun("Caption"), picture(), new TextRun(" middle"),
    ...(twoImages ? [picture()] : []), new TextRun(" tail.")] }), new Paragraph("Protected audit line.")]);
  const nodes = createParser().parse(await docxXml(bytes)) as XNode[];
  const p = elChildren(findBody(nodes)).find(n => elName(n) === "w:p")!;
  setChildren(p, [makeEl("w:r", elChildren(p).filter(n => elName(n) === "w:r").flatMap(r => elChildren(r)))]);
  const zip = await JSZip.loadAsync(bytes); zip.file("word/document.xml", createBuilder().build(nodes));
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("untouched drawings stay outside Review content revisions", () => {
  for (const task of [
    { name: "caption replacement", program: "replace_text(doc.paragraphs[0],'Caption','Label')", two: false },
    { name: "caption typography", program: "for r in isolate(doc.paragraphs[0],'Caption'): r.bold=True", two: false },
    { name: "suffix after a drawing", program: "replace_text(doc.paragraphs[0],'tail.','ending.')", two: false },
    { name: "text between two drawings", program: "replace_text(doc.paragraphs[0],'middle','center')", two: true },
  ]) it(task.name, async () => {
    const source = await sourceBytes(task.two);
    const { report, candidate } = await runWordPython(source, { action: "preview", mode: "tracked", program: task.program }, new AbortController().signal);
    expect(report).toMatchObject({ reopened: true, libreoffice_opened: true, review_verified: true });
    expect(report.new_revision_count).toBeGreaterThan(0);
    const xml = await docxXml(candidate!); expect(xml).toContain("Protected audit line.");
    expect(xml.match(/<w:drawing\b/gu)).toHaveLength(task.two ? 2 : 1);
    const revisions = xml.match(/<w:(?:ins|del|moveFrom|moveTo)\b[^>]*>[\s\S]*?<\/w:(?:ins|del|moveFrom|moveTo)>/gu) || [];
    expect(revisions.every(r => !r.includes("<w:drawing"))).toBe(true);
  }, 120_000);
});
