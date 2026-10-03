import { execFileSync } from "node:child_process";
import path from "node:path";
import { Header, Footer, Paragraph, ImageRun } from "docx";
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
const originalImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4f+A0AAVMAotDMHBLAAAAAElFTkSuQmCC", "base64");
const cases = [
  {
    "name": "refuses an untracked replacement of existing image bytes",
    "mode": "tracked",
    "refusal": true,
    "program": "import base64\nfrom io import BytesIO\nb = doc.inline_shapes[0]._inline.xpath('.//a:blip')[0]\npayload = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC')\ndoc.part.related_parts[b.get(qn('r:embed'))]._blob = payload",
    "expected": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"
  },
  {
    "name": "allows direct replacement of image bytes",
    "mode": "direct",
    "program": "import base64\nfrom io import BytesIO\nb = doc.inline_shapes[0]._inline.xpath('.//a:blip')[0]\npayload = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC')\ndoc.part.related_parts[b.get(qn('r:embed'))]._blob = payload",
    "expected": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"
  },
  {
    "name": "tracks a new blue image relationship",
    "mode": "tracked",
    "program": "import base64\nfrom io import BytesIO\nb = doc.inline_shapes[0]._inline.xpath('.//a:blip')[0]\npayload = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC')\nrid, _ = doc.part.get_or_add_image(BytesIO(payload))\nb.set(qn('r:embed'), rid)",
    "expected": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"
  },
  {
    "name": "tracks a new green image relationship",
    "mode": "tracked",
    "program": "import base64\nfrom io import BytesIO\nb = doc.inline_shapes[0]._inline.xpath('.//a:blip')[0]\npayload = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGAAAAEEAIFw9selAAAAAElFTkSuQmCC')\nrid, _ = doc.part.get_or_add_image(BytesIO(payload))\nb.set(qn('r:embed'), rid)",
    "expected": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGAAAAEEAIFw9selAAAAAElFTkSuQmCC"
  }
];

describe.skipIf(!available())("Word image preservation", () => {
  for (const task of cases) it(task.name, async () => {
    const source = await docxBytes([
      new Paragraph({ children: [new ImageRun({ type: "png", data: originalImage, transformation: { width: 12, height: 12 } })] }),
      new Paragraph("Preserve the package audit note."),
    ], {}, {
      headers: { default: new Header({ children: [new Paragraph("Package register")] }) },
      footers: { default: new Footer({ children: [new Paragraph("Revision G")] }) },
    });
    const operation = runWordPython(source, { action: "preview", mode: task.mode as "direct" | "tracked", program: task.program }, new AbortController().signal);
    if ("refusal" in task && task.refusal) {
      await expect(operation).rejects.toThrow(/binary|image/u);
      return;
    }
    const { report, candidate } = await operation;
    expect(report).toMatchObject({ reopened: true, libreoffice_opened: true });
    if (task.mode === "tracked") {
      expect(report.review_verified).toBe(true);
      expect(report.new_revision_count as number).toBeGreaterThanOrEqual(2);
    }
    const zip = await JSZip.loadAsync(candidate!);
    const images = await Promise.all(Object.keys(zip.files).filter(n => n.startsWith("word/media/") && n.endsWith(".png")).map(n => zip.file(n)!.async("nodebuffer")));
    expect(images.some(b => b.equals(Buffer.from(task.expected, "base64")))).toBe(true);
    if (task.mode === "tracked") expect(images.some(b => b.equals(originalImage))).toBe(true);
    expect(await docxXml(candidate!)).toContain("Preserve the package audit note.");
    expect(await docxXml(candidate!, "word/header1.xml")).toContain("Package register");
    expect(await docxXml(candidate!, "word/footer1.xml")).toContain("Revision G");
  }, 120_000);
});
