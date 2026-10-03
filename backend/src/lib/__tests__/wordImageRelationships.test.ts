import { execFileSync } from "node:child_process";
import path from "node:path";
import { Header, Footer, Paragraph, ImageRun, TextRun } from "docx";
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
const pink = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4f+A0AAVMAotDMHBLAAAAAElFTkSuQmCC", "base64");
const blue = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC", "base64");
const cases = [
  {
    "name": "refuses retargeting a shared image in Review",
    "mode": "tracked",
    "refusal": true,
    "program": "import base64\nfrom io import BytesIO\nowner = doc\nb = doc.inline_shapes[0]._inline.xpath('.//a:blip')[0]\nblue = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC')\ntarget = next(r.target_part for r in doc.part.rels.values() if r.reltype.endswith('/image') and r.target_part.blob == blue)\nowner.part.rels[b.get(qn('r:embed'))]._target = target"
  },
  {
    "name": "allows direct retargeting of a shared image",
    "mode": "direct",
    "program": "import base64\nfrom io import BytesIO\nowner = doc\nb = doc.inline_shapes[0]._inline.xpath('.//a:blip')[0]\nblue = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC')\ntarget = next(r.target_part for r in doc.part.rels.values() if r.reltype.endswith('/image') and r.target_part.blob == blue)\nowner.part.rels[b.get(qn('r:embed'))]._target = target"
  },
  {
    "name": "tracks a drawing reference to another existing image",
    "mode": "tracked",
    "program": "import base64\nfrom io import BytesIO\nowner = doc\nb = doc.inline_shapes[0]._inline.xpath('.//a:blip')[0]\nblue = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC')\nrid = next(r.rId for r in owner.part.rels.values() if r.reltype.endswith('/image') and r.target_part.blob == blue)\nb.set(qn('r:embed'), rid)"
  },
  {
    "name": "tracks a drawing reference to a fresh image",
    "mode": "tracked",
    "program": "import base64\nfrom io import BytesIO\nowner = doc\nb = doc.inline_shapes[0]._inline.xpath('.//a:blip')[0]\nblue = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC')\nrid, _ = owner.part.get_or_add_image(BytesIO(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGAAAAEEAIFw9selAAAAAElFTkSuQmCC')))\nb.set(qn('r:embed'), rid)"
  }
];

const picture = (data: Buffer) => new ImageRun({ type: "png", data, transformation: { width: 12, height: 12 } });
const attr = (element: string, name: string) => element.match(new RegExp(`\\b${name}="([^"]*)"`, "u"))![1];
const relationships = (xml: string) => xml.match(/<Relationship\b[^>]*\/>/gu) ?? [];
async function sourceBytes() {
  const bytes = await docxBytes([
    new Paragraph({ children: [picture(pink)] }), new Paragraph({ children: [picture(blue)] }),
    new Paragraph("Preserve the package audit note."),
  ], {}, {
    headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun("Package register"), picture(pink)] })] }) },
    footers: { default: new Footer({ children: [new Paragraph("Revision H")] }) },
  });
  const zip = await JSZip.loadAsync(bytes);
  const main = await docxXml(bytes);
  const mainImageId = main.match(/<a:blip\b[^>]*r:embed="([^"]*)"/u)![1];
  const mainImage = relationships(await docxXml(bytes, "word/_rels/document.xml.rels")).find(r => attr(r, "Id") === mainImageId)!;
  const headerRels = await docxXml(bytes, "word/_rels/header1.xml.rels");
  const headerImage = relationships(headerRels).find(r => attr(r, "Type").endsWith("/image"))!;
  const mainTarget = attr(mainImage, "Target"), headerTarget = attr(headerImage, "Target");
  zip.file("word/_rels/header1.xml.rels", headerRels.replace(headerImage, headerImage.replace(/Target="[^"]*"/u, `Target="${mainTarget}"`)));
  if (headerTarget !== mainTarget) {
    const name = path.posix.normalize("word/" + headerTarget);
    zip.remove(name);
    const types = await docxXml(bytes, "[Content_Types].xml");
    zip.file("[Content_Types].xml", types.replace(/<Override\b[^>]*\/>/gu, e => attr(e, "PartName") === "/" + name ? "" : e));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

describe.skipIf(!available())("Word image relationships", () => {
  for (const task of cases) it(task.name, async () => {
    const source = await sourceBytes();
    const operation = runWordPython(source, { action: "preview", mode: task.mode as "direct" | "tracked", program: task.program }, new AbortController().signal);
    if ("refusal" in task && task.refusal) {
      await expect(operation).rejects.toThrow(/image.*relationship|relationship.*image/u);
      return;
    }
    const { report, candidate } = await operation;
    expect(report).toMatchObject({ reopened: true, libreoffice_opened: true });
    if (task.mode === "tracked") {
      expect(report.review_verified).toBe(true);
      expect(report.new_revision_count as number).toBeGreaterThanOrEqual(2);
    }
    const before = await JSZip.loadAsync(source), after = await JSZip.loadAsync(candidate!);
    for (const name of Object.keys(before.files).filter(n => n.startsWith("word/media/") && n.endsWith(".png"))) {
      expect(await after.file(name)!.async("nodebuffer")).toEqual(await before.file(name)!.async("nodebuffer"));
    }
    expect(await docxXml(candidate!)).toContain("Preserve the package audit note.");
    expect(await docxXml(candidate!, "word/header1.xml")).toContain("Package register");
    expect(await docxXml(candidate!, "word/_rels/header1.xml.rels")).toContain(attr(relationships(await docxXml(source, "word/_rels/header1.xml.rels")).find(r => attr(r, "Type").endsWith("/image"))!, "Target"));
    expect(await docxXml(candidate!, "word/footer1.xml")).toContain("Revision H");
  }, 120_000);
});
