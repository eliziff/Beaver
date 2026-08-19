import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadCase } from "../runner";

async function main() {
  const datasets = [
    "SCC", "BCCA", "BCSC", "ONCA", "NSCA", "NSSC", "YKCA", "FCA",
    "FC", "TCC", "CHRT", "CITT", "RAD", "RPD", "FPSLREB",
  ];
  const manifestPath = path.resolve(process.argv[2] ?? "experiments/a2aj_decision_roster_qwen/runs/selection-fast-15k.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    seed: number;
    cases: Array<{ document_id: number; dataset: string; citation: string; name: string | null; date: string | null }>;
  };

  const rows: unknown[] = [];
  for (const dataset of datasets) {
    let accepted = 0;
    for (const candidate of manifest.cases) {
      if (candidate.dataset !== dataset) continue;
      const record = await loadCase({
        documentId: candidate.document_id,
        dataset: candidate.dataset,
        citation: candidate.citation,
        name: candidate.name,
        date: candidate.date?.slice(0, 10) ?? null,
      });
      if (!record || record.source.text.length > 160_000 || record.citationEdges.length < 2) continue;
      rows.push({
        document_id: candidate.document_id,
        dataset,
        citation: candidate.citation,
        name: candidate.name,
        date: candidate.date?.slice(0, 10) ?? null,
        source_chars: record.source.text.length,
        paragraph_count: record.paragraphs.length,
        deterministic_status: record.deterministic.status,
        deterministic_opinions: record.deterministic.opinions.length,
        sampled_citations: record.citationEdges.map(({ citation }) => citation),
      });
      accepted += 1;
      if (accepted === 3) break;
    }
  }

  console.log(JSON.stringify({ source_seed: manifest.seed, rows }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
