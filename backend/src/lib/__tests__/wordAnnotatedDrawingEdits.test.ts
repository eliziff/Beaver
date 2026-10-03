import { ImageRun, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { runWordPython } from "../wordPython";
import { type XNode, createParser, createBuilder, elChildren, elName, findBody, makeEl, setChildren } from "../docx/core";
import { docxBytes, docxXml } from "./support/docxFixtures";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4f+A0AAVMAotDMHBLAAAAAElFTkSuQmCC", "base64");
async function sourceBytes(mixed: boolean, cell: boolean) {
  const caption = new Paragraph({ children: [new TextRun("Caption"),
    ...(mixed ? [new ImageRun({ type: "png", data: image, transformation: { width: 12, height: 12 } })] : []), new TextRun(" tail.")] });
  const first = cell ? new Table({ rows: [new TableRow({ children: [new TableCell({ children: [caption] })] })] }) : caption;
  const bytes = await docxBytes([first, new Paragraph("Protected audit line.")]);
  if (!mixed) return bytes;
  const nodes = createParser().parse(await docxXml(bytes)) as XNode[];
  let p: XNode | undefined;
  const visit = (node: XNode) => { if (!p && elName(node) === "w:p") p = node; else for (const child of elChildren(node)) visit(child); };
  visit(findBody(nodes));
  setChildren(p!, [makeEl("w:r", elChildren(p!).filter(n => elName(n) === "w:r").flatMap(r => elChildren(r)))]);
  const zip = await JSZip.loadAsync(bytes); zip.file("word/document.xml", createBuilder().build(nodes));
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("Review edits with text comments beside drawings", () => {
  for (const task of [
    { name: "plain text control", mixed: false, cell: false, bold: false },
    { name: "annotated caption replacement", mixed: true, cell: false, bold: false },
    { name: "annotated caption typography", mixed: true, cell: false, bold: true },
    { name: "annotated caption in a table cell", mixed: true, cell: true, bold: false },
  ]) it(task.name, async () => {
    const source = await sourceBytes(task.mixed, task.cell);
    const program = (task.cell ? "p=doc.tables[0].cell(0,0).paragraphs[0]" : "p=doc.paragraphs[0]") +
      "\nruns=isolate(p,'Caption')\n" + (task.bold ? "for r in runs: r.bold=True" : "runs[0].text='Label'") +
      "\ndoc.add_comment(runs,text='Explain the caption edit.',author='Reviewer',initials='RV')";
    const { report, candidate } = await runWordPython(source, { action: "preview", mode: "tracked", program }, new AbortController().signal);
    expect(report).toMatchObject({ reopened: true, libreoffice_opened: true, review_verified: true });
    expect(report.new_revision_count).toBeGreaterThan(0);
    const xml = await docxXml(candidate!); expect(xml).toContain("Protected audit line.");
    expect((xml.match(/<w:drawing\b/gu) || []).length).toBe(task.mixed ? 1 : 0);
    expect((xml.match(/<w:(?:ins|del)\b[^>]*>[\s\S]*?<\/w:(?:ins|del)>/gu) || []).every(n => !n.includes("<w:drawing"))).toBe(true);
    expect(await docxXml(candidate!, "word/comments.xml")).toContain("Explain the caption edit.");
  }, 120_000);
});
