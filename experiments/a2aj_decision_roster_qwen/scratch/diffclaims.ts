#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deriveA2AJSourceDoc } from "../../../backend/src/lib/sourceDocA2AJ";
import { shutdownSourceStructureEngine } from "../../../backend/src/lib/sourceStructureEngine";
import {
  analyzeOpinionStructure,
  partitionOpinionStructure,
} from "../../../backend/experiments/a2aj-decision-roster/legalOpinionBoundaries";

const DB = path.join(
  process.env.LOCALAPPDATA!,
  "OpenLegalProducts",
  "LegalData",
  "providers",
  "a2aj",
  "a2aj.sqlite",
);

async function main() {
const db = new DatabaseSync(DB, { readOnly: true });
const row = db
  .prepare("SELECT id, unofficial_text_en, citation_en, citation2_en, url_en, dataset, name_en FROM document WHERE id = ?")
  .get(193988) as Record<string, unknown>;
const string = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const text = string(row.unofficial_text_en)!;
const citation = string(row.citation_en) ?? string(row.citation2_en)!;
const job = {
  documentId: 193988,
  citation,
  dataset: string(row.dataset) ?? "",
  name: string(row.name_en),
  text,
  url: string(row.url_en),
  alternateCitation: string(row.citation2_en),
};
const source = await deriveA2AJSourceDoc({
  citation: job.citation,
  docType: "cases",
  text: job.text,
  url: job.url,
  alternateCitation: job.alternateCitation,
  dataset: job.dataset,
  name: job.name,
});
const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
const structure = analyzeOpinionStructure({
  text: source.text,
  firstParagraphStart: paragraphs[0]?.start ?? 0,
});
const partition = partitionOpinionStructure(
  structure,
  paragraphs.map((block) => {
    const match = /^par(\d+)$/u.exec(block.label);
    return match ? Number(match[1]) : Number(block.label) || 0;
  }),
);
const claims = {
  status: structure.status,
  panel: [...structure.panel],
  bindings: structure.bindings.map((binding) => ({
    role: binding.role,
    names: [...binding.names],
    from: binding.from,
    to: binding.to,
    page: binding.page,
    line: binding.line ?? "",
  })),
  markers: structure.bodyMarkers.map((marker) => ({
    paragraph: marker.paragraph,
    kind: marker.kind,
    name: marker.name ?? null,
    role: marker.role ?? null,
    line: marker.line ?? "",
  })),
  refusals: [...structure.refusals],
  partition: { status: partition.status, note: partition.note ?? null },
};

const ledger = readFileSync(path.join(__dirname, "..", "seeds", "1.SCC.jsonl"), "utf8")
  .split(/\r?\n/u)
  .map((line) => (line.trim() ? JSON.parse(line) : null))
  .find((row2) => row2?.documentId === 193988);

const a = JSON.stringify(ledger.claims);
const b = JSON.stringify(claims);
console.log("ledger sha:", ledger.sourceSha256);
console.log("computed sha:", createHash("sha256").update(text, "utf8").digest("hex"));
console.log("identical:", a === b);
if (a !== b) {
  let first = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      first = i;
      break;
    }
  }
  console.log("first diff at:", first);
  console.log("ledger   :", JSON.stringify(a.slice(Math.max(0, first - 60), first + 80)));
  console.log("computed :", JSON.stringify(b.slice(Math.max(0, first - 60), first + 80)));
}
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await shutdownSourceStructureEngine();
  }
})();
