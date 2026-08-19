#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { a2ajLocalBulkPath } from "../../../backend/src/lib/a2ajLocalBulk";
import { compileA2AJSourceDoc } from "../../../backend/src/lib/sourceDocA2AJ";

const rows = readFileSync(path.join(__dirname, "..", "seeds", "1.SCC.jsonl"), "utf8")
  .split(/\r?\n/u)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as { documentId: number; sourceSha256: string });

const db = new DatabaseSync(a2ajLocalBulkPath(), { readOnly: true });
for (const row of rows.slice(0, 3)) {
  const dbRow = db
    .prepare("SELECT unofficial_text_en, citation_en, citation2_en, url_en, dataset, name_en FROM document WHERE id = ?")
    .get(row.documentId) as Record<string, unknown>;
  const raw = String(dbRow.unofficial_text_en);
  const compiled = compileA2AJSourceDoc({
    citation: String(dbRow.citation_en ?? dbRow.citation2_en ?? ""),
    docType: "cases",
    text: raw,
    url: dbRow.url_en ? String(dbRow.url_en) : null,
    alternateCitation: dbRow.citation2_en ? String(dbRow.citation2_en) : null,
    dataset: dbRow.dataset ? String(dbRow.dataset) : null,
    name: dbRow.name_en ? String(dbRow.name_en) : null,
  });
  const shaRaw = createHash("sha256").update(raw, "utf8").digest("hex");
  const shaLF = createHash('sha256').update(raw.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  const shaTrim = createHash('sha256').update(raw.trim(), 'utf8').digest('hex');
  const shaNoBom = createHash('sha256').update(raw.replace(/^\uFEFF/, ''), 'utf8').digest('hex');
  console.log('  lf:      ' + shaLF.slice(0, 16) + '...');
  console.log('  trim:    ' + shaTrim.slice(0, 16) + '...');
  console.log('  noBom:   ' + shaNoBom.slice(0, 16) + '...');
  const shaCompiled = createHash("sha256").update(compiled.text, "utf8").digest("hex");
  console.log(`id=${row.documentId}`);
  console.log(`  ledger:  ${row.sourceSha256.slice(0, 16)}...`);
  console.log(`  raw:     ${shaRaw.slice(0, 16)}...`);
  console.log(`  compiled:${shaCompiled.slice(0, 16)}...`);
}
db.close();



