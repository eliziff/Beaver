#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { a2ajLocalBulkPath } from "../../../backend/src/lib/a2ajLocalBulk";
import { compileA2AJSourceDoc } from "../../../backend/src/lib/sourceDocA2AJ";
import {
  analyzeOpinionStructure,
  partitionOpinionStructure,
} from "../../../backend/src/lib/legalOpinionBoundaries";
import type { Claims } from "../seedtypes";

const rows = readFileSync(path.join(__dirname, "..", "seeds", "1.SCC.jsonl"), "utf8")
  .split(/\r?\n/u)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as { documentId: number; sourceSha256: string; claims: Claims });

const db = new DatabaseSync(a2ajLocalBulkPath(), { readOnly: true });
let claimsSame = 0;
let claimsDiff = 0;
for (const row of rows) {
  const dbRow = db
    .prepare("SELECT unofficial_text_en, citation_en, citation2_en, url_en, dataset, name_en FROM document WHERE id = ?")
    .get(row.documentId) as Record<string, unknown>;
  const text = String(dbRow.unofficial_text_en);
  const source = compileA2AJSourceDoc({
    citation: String(dbRow.citation_en ?? dbRow.citation2_en ?? ""),
    docType: "cases",
    text,
    url: dbRow.url_en ? String(dbRow.url_en) : null,
    alternateCitation: dbRow.citation2_en ? String(dbRow.citation2_en) : null,
    dataset: dbRow.dataset ? String(dbRow.dataset) : null,
    name: dbRow.name_en ? String(dbRow.name_en) : null,
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
  const claims: Claims = {
    status: structure.status,
    panel: [...structure.panel],
    bindings: structure.bindings.map((binding) => ({
      role: binding.role,
      names: [...binding.names],
      from: binding.from,
      to: binding.to,
      page: binding.page,
      line: binding.line,
    })),
    markers: structure.bodyMarkers.map((marker) => ({
      paragraph: marker.paragraph,
      kind: marker.kind,
      name: marker.name,
      role: marker.role,
    })),
    refusals: [...structure.refusals],
    partition: { status: partition.status, note: partition.note ?? null },
  };
  if (JSON.stringify(claims) === JSON.stringify(row.claims)) claimsSame += 1;
  else claimsDiff += 1;
  console.log(`id=${row.documentId} claims${JSON.stringify(claims) === JSON.stringify(row.claims) ? " SAME" : " DIFFER"} text=${(text.length / 1024).toFixed(1)}KB`);
}
db.close();
console.log(`claims same=${claimsSame} diff=${claimsDiff}`);
