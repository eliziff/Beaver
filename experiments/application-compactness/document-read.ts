import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { sha256 } from "../../backend/src/lib/hash";
import { Document, Packer, Paragraph } from "../../backend/node_modules/docx";

const label = process.argv[2] ?? "candidate";
if (!/^[a-z0-9-]+$/u.test(label)) throw new Error("Invalid result label");
const output = path.join(__dirname, "results", `${label}-document-read.json`);
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, medianMs: sorted[Math.ceil(sorted.length * .5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] };
};

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beaver-read-benchmark-"));
  process.env.MIKE_LOCAL_DATA_DIR = directory;
  const [{ documentProjectionService }, { structureNative }] = await Promise.all([
    import("../../backend/src/lib/documentProjectionService"),
    import("../../backend/src/lib/structureNative"),
  ]);
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children:
    Array.from({ length: 1200 }, (_, i) => new Paragraph(
      `${i + 1}. The agreement requires written notice. ${"The notice identifies the obligation and the relevant date. ".repeat(8)}`))
  }] }));
  const file = path.join(directory, "agreement.docx");
  await writeFile(file, bytes);
  const sourceSha256 = sha256(bytes), outcomes: Record<string, unknown> = {};
  const receipt = async () => writeFile(output, JSON.stringify({ label,
    measuredAt: new Date().toISOString(), sourceBytes: bytes.length, sourceSha256,
    node: process.version, outcomes }, null, 2));
  for (const concurrency of [1, 4]) {
    const elapsed: number[] = [], sourceTimes: number[] = [], readCounts: number[] = [];
    let expectedText: string | undefined;
    for (let sample = 0; sample < 45; sample++) {
      let sourceTime = 0, reads = 0;
      const input = { documentId: randomUUID(), versionId: "version-1", fileType: "docx",
        sourceSha256, readBytes: async () => {
          const started = performance.now(); reads++;
          const content = await readFile(file);
          // Same checksum validation performed by the document store's source reader.
          assert.equal(sha256(content), sourceSha256);
          sourceTime += performance.now() - started;
          return content;
        } };
      const start = performance.now();
      const documents = await Promise.all(Array.from({ length: concurrency }, () =>
        documentProjectionService.read(input)));
      const total = performance.now() - start;
      const text = sha256(Buffer.from(structureNative().documentText(documents[0])));
      expectedText ??= text;
      assert.equal(text, expectedText);
      for (const document of documents) assert.equal(document, documents[0]);
      if (sample >= 5) { elapsed.push(total); sourceTimes.push(sourceTime); readCounts.push(reads); }
      if (sample % 10 === 0) console.log(`${label}: ${concurrency} readers, sample ${sample}/45`);
    }
    outcomes[`open-${concurrency}`] = { elapsed: summary(elapsed),
      source: summary(sourceTimes), sourceReads: readCounts,
      textSha256: expectedText };
    await receipt();
  }
  console.log(JSON.stringify(outcomes, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
