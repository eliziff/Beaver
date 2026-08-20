import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { shutdownSourceStructureEngine } from "../../../backend/src/lib/sourceStructureEngine";
import { candidatesFromPairFile, loadCase } from "../runner";

async function outputs(files: string[]) {
  const byDocument = new Map<number, unknown>();
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(path.resolve(file), "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.kind === "model_output" && typeof event.raw_model_output === "string") {
        byDocument.set(Number(event.document), JSON.parse(event.raw_model_output));
      }
    }
  }
  return byDocument;
}

async function main() {
  const pairFile = process.argv[2];
  const outputIndex = process.argv.indexOf("--out");
  const candidatesIndex = process.argv.indexOf("--candidate-outputs");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
  const candidateFiles = candidatesIndex >= 0 ? (process.argv[candidatesIndex + 1] ?? "").split(",").filter(Boolean) : [];
  if (!pairFile || !output || !candidateFiles.length) {
    throw new Error("usage: build_manual_gold_packets.ts <pairs.json> --candidate-outputs <a,b> --out <directory>");
  }
  const rawByDocument = await outputs(candidateFiles);
  const candidates = await candidatesFromPairFile(path.resolve(pairFile));
  await mkdir(path.resolve(output), { recursive: true });
  for (const candidate of candidates) {
    const record = await loadCase(candidate);
    if (!record) throw new Error(`missing case ${candidate.documentId}`);
    const packet = [
      `# ${candidate.citation} (${candidate.documentId})`,
      "## Target",
      "```json",
      JSON.stringify(candidate.target, null, 2),
      "```",
      "## Deterministic target occurrences",
      "```json",
      JSON.stringify(record.targetOccurrences, null, 2),
      "```",
      "## Luna candidate",
      "```json",
      JSON.stringify(rawByDocument.get(candidate.documentId) ?? null, null, 2),
      "```",
      "## Complete citing decision",
      "```text",
      record.source.text,
      "```",
      "",
    ].join("\n");
    await writeFile(path.join(path.resolve(output), `${candidate.documentId}.md`), packet, "utf8");
  }
  console.log(`wrote ${candidates.length} packets to ${path.resolve(output)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}).finally(shutdownSourceStructureEngine);
