/**
 * Differential probe: what do mammoth and pandoc each emit for a DOCX
 * whose section numbers exist only as Word auto-numbering (w:numPr),
 * with none typed in the text? Decides what the extraction layer must
 * synthesize itself.
 *   npx tsx scripts/probe-numbering-fidelity.ts
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const { AlignmentType, Document, LevelFormat, Packer, Paragraph, TextRun } =
    await import("docx");
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "sections",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
            },
            {
              level: 1,
              format: LevelFormat.DECIMAL,
              text: "%1.%2",
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [
      {
        children: [
          new Paragraph({
            numbering: { reference: "sections", level: 0 },
            children: [new TextRun("Definitions")],
          }),
          new Paragraph({
            numbering: { reference: "sections", level: 1 },
            children: [
              new TextRun(
                "Rent means the annual basic rent payable under this lease.",
              ),
            ],
          }),
          new Paragraph({
            numbering: { reference: "sections", level: 0 },
            children: [new TextRun("Payment")],
          }),
          new Paragraph({
            numbering: { reference: "sections", level: 1 },
            children: [
              new TextRun(
                "The Tenant shall pay Rent of $117,000 per annum in equal monthly instalments.",
              ),
            ],
          }),
        ],
      },
    ],
  });
  const file = path.join(os.tmpdir(), "beaver-autonumber-probe.docx");
  writeFileSync(file, await Packer.toBuffer(doc));

  const mammoth = await import("mammoth");
  const converted = await mammoth.convertToHtml({ path: file });
  console.log("=== mammoth HTML ===");
  console.log(converted.value);

  const pandoc = `${process.env.LOCALAPPDATA}\\Pandoc\\pandoc.exe`;
  for (const target of ["markdown", "plain"]) {
    const run = spawnSync(pandoc, ["-f", "docx", "-t", target, file], {
      encoding: "utf8",
    });
    console.log(`=== pandoc ${target} ===`);
    console.log(run.status === 0 ? run.stdout : `FAILED: ${run.stderr}`);
  }
}

void main();
