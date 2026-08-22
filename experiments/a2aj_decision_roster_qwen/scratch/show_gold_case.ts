import { readFile } from "node:fs/promises";

import { modelSourceLines } from "../../../backend/experiments/a2aj-decision-roster/caseTargetMvpReduced.ts";

async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error("usage: show_gold_case.ts <source-only-packet.json>");
  const packet = JSON.parse(await readFile(filename, "utf8"));
  const lines = modelSourceLines(packet.source_text);
  const occurrences = new Map<number, string[]>();
  for (const item of packet.occurrence_contract.occurrences) {
    const line = lines.find(({ start, end }) => item.start >= start && item.end <= end)?.line;
    if (line) occurrences.set(line, [...(occurrences.get(line) ?? []), `${item.id}=${JSON.stringify(item.quote)}`]);
  }
  console.log(JSON.stringify({ document_id: packet.document_id, source: packet.source, target: packet.target }, null, 2));
  for (const item of lines) {
    const marker = occurrences.get(item.line);
    console.log(`${String(item.line).padStart(5, "0")}${marker ? ` [${marker.join(", ")}]` : ""} | ${packet.source_text.slice(item.start, item.end)}`);
  }
}

void main();
