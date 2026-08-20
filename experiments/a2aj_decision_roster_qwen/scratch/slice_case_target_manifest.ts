import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const [input, output, ...selectors] = process.argv.slice(2);
  if (!input || !output || !selectors.length) {
    throw new Error("usage: slice_case_target_manifest.ts <input.json> <output.json> <document-id...> | --first <count>");
  }
  const manifest = JSON.parse(await readFile(path.resolve(input), "utf8")) as Record<string, any>;
  const source = Array.isArray(manifest.pairs) ? manifest.pairs as Array<Record<string, any>> : [];
  const first = selectors[0] === "--first" ? Number(selectors[1]) : null;
  const wanted = new Set(first === null ? selectors.map(Number) : []);
  const pairs = first === null
    ? source.filter((pair) => wanted.has(Number(pair.document_id)))
    : source.slice(0, first);
  if (!pairs.length || (first === null && pairs.length !== wanted.size) || (first !== null && pairs.length !== first)) {
    throw new Error(`selected ${pairs.length} requested pairs`);
  }
  const datasetCounts: Record<string, number> = {};
  const categoryCounts: Record<string, number> = {};
  for (const pair of pairs) {
    const dataset = String(pair.source?.dataset ?? pair.selection_receipt?.source_dataset ?? "unknown");
    datasetCounts[dataset] = (datasetCounts[dataset] ?? 0) + 1;
    const category = String(pair.challenge_category ?? "unknown");
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
  }
  const resolved = pairs.filter((pair) => pair.selection_receipt?.target_resolved_in_a2aj).length;
  const pairKeys = pairs.map((pair) => [pair.challenge_id, pair.document_id, pair.target?.document_id, pair.target?.citation]);
  const selectedPairHash = createHash("sha256").update(JSON.stringify(pairKeys)).digest("hex");
  await writeFile(path.resolve(output), `${JSON.stringify({
    ...manifest,
    created_utc: new Date().toISOString(),
    requested_pairs: pairs.length,
    selection: {
      ...manifest.selection,
      parent_frozen_pair_keys_sha256: manifest.selection?.frozen_pair_keys_sha256 ?? null,
      frozen_pair_keys_sha256: selectedPairHash,
    },
    category_counts: categoryCounts,
    pairs,
    resolved_targets: resolved,
    unresolved_targets: pairs.length - resolved,
    dataset_counts: datasetCounts,
    parent_manifest: path.resolve(input),
    budget_partition: { kind: first === null ? "document_ids" : "first", pairs: pairs.length },
  }, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
