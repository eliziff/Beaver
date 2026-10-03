import { execFileSync } from "node:child_process";
import path from "node:path";
import { Paragraph, ImageRun, TextRun } from "docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { resolveSofficeBinary } from "../convert";
import { runWordPython, wordPython } from "../wordPython";
import { type XNode, createParser, createBuilder, elChildren, elName, findBody, makeEl, setChildren } from "../docx/core";
import { docxBytes, docxXml } from "./support/docxFixtures";

const available = () => {
  if (process.env.WORD_PYTHON_CONTAINER_IMAGE) return true;
  try {
    execFileSync(wordPython(), ["-I", path.resolve(__dirname, "../../../scripts/word_python/probe.py")], { stdio: "ignore" });
    return !!resolveSofficeBinary();
  } catch { return false; }
};
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4f+A0AAVMAotDMHBLAAAAAElFTkSuQmCC", "base64");
async function sourceBytes() {
  const bytes = await docxBytes([
    new Paragraph({ children: [new TextRun({ text: "Verified specimen", bold: true }),
      new ImageRun({ type: "png", data: image, transformation: { width: 12, height: 12 } }), new TextRun(" stays attached.")] }),
    new Paragraph("Untouched custody note."),
  ]);
  const document = createParser().parse(await docxXml(bytes)) as XNode[];
  const p = elChildren(findBody(document)).find(n => elName(n) === "w:p")!;
  const runs = elChildren(p).filter(n => elName(n) === "w:r");
  setChildren(p, [makeEl("w:r", [...elChildren(runs[0]).filter(n => elName(n) === "w:rPr"),
    ...runs.flatMap(r => elChildren(r).filter(n => elName(n) !== "w:rPr"))])]);
  const zip = await JSZip.loadAsync(bytes);zip.file("word/document.xml", createBuilder().build(document));
  return zip.generateAsync({ type: "nodebuffer" });
}
const cases = [
  { name: "verifies a tracked replacement in a mixed run", mode: "tracked", program: "from copy import deepcopy\nfrom tracking import Recorder\nRecorder.record = lambda self: []\np = doc.paragraphs[0]._p\nsource = p.find(qn('w:r'))\nprops = source.find(qn('w:rPr'))\nchildren = [deepcopy(c) for c in source if c.tag != qn('w:rPr')]\nposition = p.index(source); p.remove(source)\nfor tag, text, wid in [('del', 'Verified specimen', '71'), ('ins', 'Checked specimen', '72')]:\n    revision = OxmlElement('w:' + tag); revision.set(qn('w:id'), wid); revision.set(qn('w:author'), 'Test')\n    r = OxmlElement('w:r')\n    if props is not None: r.append(deepcopy(props))\n    t = OxmlElement('w:delText' if tag == 'del' else 'w:t'); t.text = text; r.append(t); revision.append(r); p.insert(position, revision); position += 1\nfor child in children[1:]:\n    r = OxmlElement('w:r')\n    if props is not None: r.append(deepcopy(props))\n    r.append(child); p.insert(position, r); position += 1" },
  { name: "allows the direct equivalent", mode: "direct", program: "replace_text(doc.paragraphs[0], 'Verified specimen', 'Checked specimen')" },
  { name: "refuses a lost drawing disguised by a tracked text edit", mode: "tracked", refusal: true,
    program: "from tracking import Recorder\nRecorder.record = lambda self: []\np = doc.paragraphs[0]\ndrawing = p._p.xpath('.//w:drawing')[0]\ndrawing.getparent().remove(drawing)\nr = doc.paragraphs[1].runs[0]._r\nins = OxmlElement('w:ins'); ins.set(qn('w:id'), '77'); ins.set(qn('w:author'), 'Test'); r.addprevious(ins)\nnew = OxmlElement('w:r'); t = OxmlElement('w:t'); t.text = 'Added note. '; new.append(t); ins.append(new)" },
  { name: "refuses a moved drawing with unchanged text", mode: "tracked", refusal: true,
    program: "from tracking import Recorder\nRecorder.record = lambda self: []\np = doc.paragraphs[0]\ndrawing = p._p.xpath('.//w:drawing')[0]\nowner = drawing.getparent(); owner.remove(drawing); owner.append(drawing)\nr = doc.paragraphs[1].runs[0]._r\nins = OxmlElement('w:ins'); ins.set(qn('w:id'), '78'); ins.set(qn('w:author'), 'Test'); r.addprevious(ins)\nnew = OxmlElement('w:r'); t = OxmlElement('w:t'); t.text = 'Added note. '; new.append(t); ins.append(new)" },
] as const;
describe.skipIf(!available())("mixed-run Review verification", () => {
  for (const task of cases) it(task.name, async () => {
    const source = await sourceBytes();
    const operation = runWordPython(source, { action: "preview", mode: task.mode, program: task.program }, new AbortController().signal);
    if ("refusal" in task) {
      await expect(operation).rejects.toThrow(/tracked revision|rejecting revisions/u);
      return;
    }
    const { report, candidate } = await operation;
    expect(report).toMatchObject({ reopened: true, libreoffice_opened: true });
    if (task.mode === "tracked") expect(report).toMatchObject({ review_verified: true });
    const before = await JSZip.loadAsync(source), after = await JSZip.loadAsync(candidate!);
    for (const name of Object.keys(before.files).filter(n => n.startsWith("word/media/") && !before.files[n].dir)) {
      expect(await after.file(name)!.async("nodebuffer")).toEqual(await before.file(name)!.async("nodebuffer"));
    }
    expect((await docxXml(candidate!)).match(/<w:drawing\b/gu)).toHaveLength(1);
    expect(await docxXml(candidate!)).toContain("Untouched custody note.");
  }, 120_000);
});
