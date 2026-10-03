import { Header, Footer, Paragraph, ImageRun, TextRun } from "docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { applyTrackedEdits, finalizeTrackedEdits, resolveTrackedChange } from "../docxTrackedChanges";
import { type XNode, cloneNode, createParser, createBuilder, elChildren, elName,
  findBody, getTextContent, makeEl, setChildren } from "../docx/core";
import { docxBytes, docxXml } from "./support/docxFixtures";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4f+A0AAVMAotDMHBLAAAAAElFTkSuQmCC", "base64");
const tree = async (bytes: Buffer) => createParser().parse(await docxXml(bytes)) as XNode[];
const paragraph = (document: XNode[]) => elChildren(findBody(document)).find(n => elName(n) === "w:p")!;

async function sourceBytes() {
  const bytes = await docxBytes([
    new Paragraph({ children: [new TextRun({ text: "Verified specimen", bold: true }),
      new ImageRun({ type: "png", data: image, transformation: { width: 12, height: 12 } }),
      new TextRun(" stays attached.")] }),
    new Paragraph("Untouched custody note."),
  ], {}, {
    headers: { default: new Header({ children: [new Paragraph("Package register")] }) },
    footers: { default: new Footer({ children: [new Paragraph("Revision J")] }) },
  });
  const document = await tree(bytes), p = paragraph(document);
  const runs = elChildren(p).filter(n => elName(n) === "w:r");
  const properties = elChildren(runs[0]).filter(n => elName(n) === "w:rPr");
  setChildren(p, [...elChildren(p).filter(n => elName(n) !== "w:r"), makeEl("w:r", [
    ...properties, ...runs.flatMap(r => elChildren(r).filter(n => elName(n) !== "w:rPr")),
  ])]);
  const zip = await JSZip.loadAsync(bytes);
  zip.file("word/document.xml", createBuilder().build(document));
  return zip.generateAsync({ type: "nodebuffer" });
}

// Compare visible content and complete formatting, independently of run segmentation.
function tokens(p: XNode) {
  const result: Array<{ properties: XNode[]; text?: string; node?: XNode }> = [];
  for (const run of elChildren(p).filter(n => elName(n) === "w:r")) {
    const properties = cloneNode(elChildren(run).filter(n => elName(n) === "w:rPr"));
    for (const child of elChildren(run).filter(n => elName(n) !== "w:rPr")) {
      const last = result.at(-1);
      if (elName(child) === "w:t") {
        if (last?.text !== undefined && JSON.stringify(last.properties) === JSON.stringify(properties)) last.text += getTextContent(child);
        else result.push({ properties, text: getTextContent(child) });
      } else result.push({ properties, node: cloneNode(child) });
    }
  }
  return result;
}

describe("mixed text and drawing runs", () => {
  for (const mode of ["auto", "manual"] as const) {
    for (const acrossImage of [false, true]) it(`${mode}: edit ${acrossImage ? "across" : "before"} a drawing`, async () => {
      const source = await sourceBytes();
      const find = acrossImage ? "Verified specimen stays attached." : "Verified specimen";
      const replace = acrossImage ? "Checked specimen remains attached." : "Checked specimen";
      const changed = await applyTrackedEdits(source, [{ find, replace, context_before: "", context_after: "" }]);
      expect(changed.errors).toEqual([]);
      expect(changed.changes).toHaveLength(1);
      const ids = changed.changes.flatMap(c => [c.delId, c.insId].filter((id): id is string => !!id));
      const final = await finalizeTrackedEdits(changed.bytes, ids, mode);
      const accepted = mode === "auto" ? final.bytes : (await resolveTrackedChange(final.bytes, ids, "accept")).bytes;
      const before = tokens(paragraph(await tree(source)));
      const after = tokens(paragraph(await tree(accepted)));
      expect(after.filter(t => t.node)).toEqual(before.filter(t => t.node));
      expect(after.filter(t => t.text !== undefined).map(t => t.text).join("")).toBe(acrossImage ? replace : replace + " stays attached.");
      expect(after.every(t => JSON.stringify(t.properties) === JSON.stringify(before[0].properties))).toBe(true);
      const rejected = await resolveTrackedChange(changed.bytes, ids, "reject");
      expect(tokens(paragraph(await tree(rejected.bytes)))).toEqual(before);
      const originalZip = await JSZip.loadAsync(source), finalZip = await JSZip.loadAsync(final.bytes);
      expect(Object.keys(finalZip.files).sort()).toEqual(Object.keys(originalZip.files).sort());
      for (const name of Object.keys(originalZip.files).filter(n => !originalZip.files[n].dir && n !== "word/document.xml")) {
        expect(await finalZip.file(name)!.async("nodebuffer"), name).toEqual(await originalZip.file(name)!.async("nodebuffer"));
      }
      const originalParagraphs = elChildren(findBody(await tree(source))).filter(n => elName(n) === "w:p");
      const finalParagraphs = elChildren(findBody(await tree(accepted))).filter(n => elName(n) === "w:p");
      expect(finalParagraphs.slice(1)).toEqual(originalParagraphs.slice(1));
    });
  }
});
