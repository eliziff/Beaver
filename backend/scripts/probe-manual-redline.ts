/**
 * Differential probe: a manual redline (red ink + strikethrough, no
 * tracked changes) through mammoth raw text, mammoth HTML, and pandoc.
 * The danger case: struck-through (deleted) text read back as operative.
 *   npx tsx scripts/probe-manual-redline.ts
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const { Document, Packer, Paragraph, TextRun } = await import("docx");
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [
              new TextRun("The Tenant shall pay Rent of "),
              new TextRun({ text: "$117,000", strike: true }),
              new TextRun({ text: " $125,000", color: "FF0000" }),
              new TextRun(" per annum. "),
              new TextRun({
                text: "This indemnity survives termination.",
                strike: true,
                color: "FF0000",
              }),
            ],
          }),
        ],
      },
    ],
  });
  const file = path.join(os.tmpdir(), "beaver-manual-redline-probe.docx");
  writeFileSync(file, await Packer.toBuffer(doc));

  const mammoth = await import("mammoth");
  console.log("=== mammoth raw text ===");
  console.log((await mammoth.extractRawText({ path: file })).value.trim());
  console.log("=== mammoth HTML ===");
  console.log((await mammoth.convertToHtml({ path: file })).value.trim());
  const pandoc = `${process.env.LOCALAPPDATA}\\Pandoc\\pandoc.exe`;
  const run = spawnSync(pandoc, ["-f", "docx", "-t", "plain", file], {
    encoding: "utf8",
  });
  console.log("=== pandoc plain ===");
  console.log(run.status === 0 ? run.stdout.trim() : `FAILED: ${run.stderr}`);
}

void main();
