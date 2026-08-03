#!/usr/bin/env node

import { withReadonlySqlite } from "../../../backend/src/lib/legalDataPath";
import { a2ajLocalBulkPath } from "../../../backend/src/lib/a2ajLocalBulk";
import { loadCase } from "../runner";
import { analyzeOpinionStructure } from "../../../backend/src/lib/legalOpinionBoundaries";

async function candidateById(documentId: number) {
  return withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const row = database.prepare(`
      SELECT id, dataset, COALESCE(NULLIF(citation_en,''),NULLIF(citation2_en,'')) AS citation,
             name_en, document_date_en FROM document WHERE id=? AND doc_type='cases'
    `).get(documentId) as Record<string, unknown> | undefined;
    return row ? {
      documentId: Number(row.id),
      dataset: String(row.dataset ?? ""),
      citation: String(row.citation ?? ""),
      name: row.name_en ? String(row.name_en) : null,
      date: row.document_date_en ? String(row.document_date_en) : null,
    } : null;
  });
}

async function check(documentId: number) {
  const candidate = await candidateById(documentId);
  if (!candidate) throw new Error(`not found: ${documentId}`);
  const record = await loadCase(candidate);
  if (!record) throw new Error(`load failed: ${documentId}`);
  const structure = analyzeOpinionStructure({ text: record.source.text });
  console.log(`--- id=${documentId} ${candidate.citation} status=${structure.status}`);
  console.log(`    panel: ${structure.panel.join(" | ") || "(empty)"}`);
  for (const binding of structure.bindings) {
    console.log(
      `    binding ${binding.role}: ${binding.names.length ? binding.names.join(", ") : "(none)"}${binding.from !== null ? ` [${binding.from}-${binding.to}]` : ""} :: ${binding.line}`,
    );
  }
  if (structure.refusals.length) {
    for (const refusal of structure.refusals) console.log(`    refusal: ${refusal}`);
  }
}

async function main() {
  const ids = (process.argv[2] ?? "195832 190870 190440 188586 192756 193176")
    .split(/\s+/u)
    .map(Number);
  for (const id of ids) await check(id);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
