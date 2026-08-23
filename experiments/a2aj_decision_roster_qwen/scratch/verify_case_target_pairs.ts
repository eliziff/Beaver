import path from "node:path";

import { candidatesFromPairFile, loadCase } from "../runner";

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: verify_case_target_pairs.ts <pair-file.json>");
  const candidates = await candidatesFromPairFile(path.resolve(file));
  const results = await Promise.all(candidates.map(async (candidate) => {
    const record = await loadCase(candidate);
    if (!record) throw new Error(`could not load citing document ${candidate.documentId}`);
    return {
      document_id: candidate.documentId,
      citing_citation: candidate.citation,
      target_citation: candidate.target?.citation ?? null,
      target_occurrences: record.targetOccurrences.length,
      source_chars: record.source.text.length,
      source_sha256: record.sourceSha256,
    };
  }));
  console.log(JSON.stringify({ pairs: results.length, results }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
