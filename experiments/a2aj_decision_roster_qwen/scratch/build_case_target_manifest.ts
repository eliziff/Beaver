import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  a2ajLocalBulkPath,
  fetchLocalA2AJDocumentsByIds,
} from "../../../backend/src/lib/a2ajLocalBulk";
import { buildCanliiCaseUrl } from "../../../backend/src/lib/canliiUrls";
import { structureNative } from "../../../backend/src/lib/structureNative";
import { withReadonlySqlite } from "../../../backend/src/lib/legalDataPath";
import { selectedCandidates } from "../runner";

const { citationLookupKey, providerCitationsInText: citationsInText,
  classifyCitatorExcerpt } = structureNative();

type CitationGroup = {
  citation: string;
  citation_key: string;
  occurrences: number;
  context_kinds: string[];
  first_start: number;
};

type SourceOption = {
  document_id: number;
  dataset: string;
  citation: string;
  name: string | null;
  date: string | null;
  source_chars: number;
  citations: CitationGroup[];
};

type TargetRow = {
  id: number;
  name_en: string | null;
  citation_en: string | null;
  citation2_en: string | null;
  citation_fr: string | null;
  citation2_fr: string | null;
};

function flag(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function positiveInteger(name: string, fallback: number) {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(name: string, fallback: number) {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a nonnegative integer`);
  return value;
}

function rank(seed: number, ...parts: Array<string | number>) {
  return createHash("sha256").update([seed, ...parts].join(":"), "utf8").digest("hex");
}

function citationGroups(text: string, citingCitation: string) {
  const citingKey = citationLookupKey(citingCitation);
  const groups = new Map<string, CitationGroup>();
  for (const match of citationsInText(text)) {
    const key = citationLookupKey(match.text);
    if (!key || key === citingKey) continue;
    const context = text.slice(Math.max(0, match.start - 220), Math.min(text.length, match.end + 320));
    const kind = classifyCitatorExcerpt(context).kind;
    const existing = groups.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (!existing.context_kinds.includes(kind)) existing.context_kinds.push(kind);
    } else {
      groups.set(key, {
        citation: match.text,
        citation_key: key,
        occurrences: 1,
        context_kinds: [kind],
        first_start: match.start,
      });
    }
  }
  return [...groups.values()];
}

function plausibleUnresolvedCitation(raw: string) {
  const citation = raw.replace(/\s+/gu, " ").trim();
  const neutral = /^(?:19|20)\d{2}\s+([A-Za-z][A-Za-z0-9-]{1,15})\s+\d+$/u.exec(citation);
  if (neutral) {
    return buildCanliiCaseUrl({ dataset: neutral[1], citations: [citation], language: "en" }) !== null;
  }
  const reporter = citation.match(/[A-Z][A-Za-z.']{1,14}/u)?.[0] ?? "";
  return reporter.includes(".") || /^[A-Z]{2,8}$/u.test(reporter);
}

function targetFor(
  lookup: { get: (...values: Array<string | number>) => unknown },
  source: SourceOption,
  seed: number,
) {
  const ranked = [...source.citations].sort((left, right) =>
    rank(seed, source.document_id, left.citation_key).localeCompare(rank(seed, source.document_id, right.citation_key))
  );
  const preferUnresolved = Number.parseInt(rank(seed, source.document_id, "resolution").slice(0, 8), 16) % 10 === 0;
  let fallback: { citation: CitationGroup; target: TargetRow | null } | null = null;
  for (const citation of ranked) {
    const target = lookup.get(citation.citation_key, source.document_id) as TargetRow | undefined;
    if (!target && !plausibleUnresolvedCitation(citation.citation)) continue;
    const candidate = { citation, target: target ?? null };
    fallback ??= candidate;
    if (preferUnresolved ? !target : Boolean(target)) return candidate;
  }
  return fallback;
}

async function scanDataset(args: {
  dataset: string;
  datasetIndex: number;
  scanCount: number;
  seed: number;
  maxSourceChars: number;
}) {
  const candidates = selectedCandidates(args.seed + args.datasetIndex + 1, args.scanCount, args.dataset);
  const documents = fetchLocalA2AJDocumentsByIds({
    ids: candidates.map(({ documentId }) => documentId),
    docType: "cases",
    language: "en",
    maxChars: args.maxSourceChars + 1,
  });
  return candidates.flatMap((candidate) => {
    const document = documents.get(candidate.documentId);
    if (!document || document.text.length < 500 || document.text.length > args.maxSourceChars) return [];
    const citations = citationGroups(document.text, candidate.citation)
      .sort((left, right) => rank(args.seed, candidate.documentId, left.citation_key)
        .localeCompare(rank(args.seed, candidate.documentId, right.citation_key)))
      .slice(0, 30);
    return citations.length ? [{
      document_id: candidate.documentId,
      dataset: candidate.dataset,
      citation: candidate.citation,
      name: candidate.name,
      date: candidate.date,
      source_chars: document.text.length,
      citations,
    } satisfies SourceOption] : [];
  });
}

async function scanWorker() {
  const options = await scanDataset({
    dataset: flag("dataset", ""),
    datasetIndex: positiveInteger("dataset-index", 1) - 1,
    scanCount: positiveInteger("scan-count", 1),
    seed: positiveInteger("seed", 1),
    maxSourceChars: positiveInteger("max-source-chars", 400_000),
  });
  const output = path.resolve(flag("out", ""));
  if (!output) throw new Error("scan worker requires --out");
  await writeFile(output, `${JSON.stringify(options)}\n`, "utf8");
}

async function runPool<T>(items: readonly T[], workers: number, task: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await task(items[index], index);
    }
  }));
}

async function runScanProcess(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "--scan-worker", ...args], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`scan worker exited ${signal ?? code}`));
    });
  });
}

async function main() {
  const requested = positiveInteger("n", 5_000);
  const seed = positiveInteger("seed", 20_260_820);
  const poolMultiplier = positiveInteger("pool-multiplier", 6);
  const maxSourceChars = positiveInteger("max-source-chars", 400_000);
  const workers = positiveInteger("workers", 8);
  const calibrationSize = nonnegativeInteger("calibration-n", 0);
  const output = path.resolve(flag("out", `case-target-${requested}-seed-${seed}.json`));
  const datasets = withReadonlySqlite(a2ajLocalBulkPath(), (database) =>
    (database.prepare(`
      SELECT dataset, COUNT(*) AS cases
      FROM document
      WHERE doc_type='cases'
        AND unofficial_text_en IS NOT NULL
        AND COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) IS NOT NULL
        AND dataset IS NOT NULL AND dataset <> ''
      GROUP BY dataset
      ORDER BY dataset
    `).all() as Array<{ dataset: string; cases: number }>).map((row) => ({
      dataset: String(row.dataset),
      cases: Number(row.cases),
    })),
  ) ?? [];
  if (!datasets.length) throw new Error(`no A2AJ datasets found in ${a2ajLocalBulkPath()}`);

  const quota = Math.ceil(requested / datasets.length);
  const scanPerDataset = quota * poolMultiplier;
  const scanDirectory = `${output}.scan`;
  await mkdir(scanDirectory, { recursive: true });
  const optionsByDataset = new Map<string, SourceOption[]>();
  let completed = 0;
  await runPool(datasets, workers, async ({ dataset }, index) => {
    const scanFile = path.join(scanDirectory, `${dataset.replace(/[^A-Za-z0-9_-]/gu, "_")}.json`);
    if (!existsSync(scanFile)) {
      await runScanProcess([
        "--dataset", dataset,
        "--dataset-index", String(index + 1),
        "--scan-count", String(scanPerDataset),
        "--seed", String(seed),
        "--max-source-chars", String(maxSourceChars),
        "--out", scanFile,
      ]);
    }
    optionsByDataset.set(dataset, JSON.parse(await readFile(scanFile, "utf8")) as SourceOption[]);
    completed += 1;
    process.stderr.write(`\rscanned ${completed}/${datasets.length} datasets`);
  });
  process.stderr.write("\n");

  const selectedByDataset = withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const lookup = database.prepare(`
      SELECT document.id, document.name_en,
             document.citation_en, document.citation2_en,
             document.citation_fr, document.citation2_fr
      FROM citation_lookup
      JOIN document ON document.id = citation_lookup.document_id
      WHERE citation_lookup.citation_key = ?
        AND document.doc_type = 'cases'
        AND document.id <> ?
      ORDER BY document.id
      LIMIT 1
    `);
    return new Map(datasets.map(({ dataset }) => {
      const selected = (optionsByDataset.get(dataset) ?? []).flatMap((source) => {
        const choice = targetFor(lookup, source, seed);
        if (!choice) return [];
        const aliases = choice.target
          ? [
              choice.target.citation_en,
              choice.target.citation2_en,
              choice.target.citation_fr,
              choice.target.citation2_fr,
            ].flatMap((citation) => citation && citation.trim() !== choice.citation.citation ? [citation.trim()] : [])
          : [];
        return [{
          document_id: source.document_id,
          target: {
            document_id: choice.target?.id ?? null,
            citation: choice.citation.citation,
            citation_aliases: [...new Set(aliases)],
            name: choice.target?.name_en ?? null,
          },
          selection_receipt: {
            source_dataset: source.dataset,
            source_chars: source.source_chars,
            target_resolved_in_a2aj: Boolean(choice.target),
            deterministic_occurrences: choice.citation.occurrences,
            context_kinds: choice.citation.context_kinds,
            first_occurrence_start: choice.citation.first_start,
          },
        }];
      });
      return [dataset, selected] as const;
    }));
  }) ?? new Map<string, Array<Record<string, unknown>>>();

  const pairs: Array<Record<string, unknown>> = [];
  for (let index = 0; pairs.length < requested; index += 1) {
    let added = false;
    for (const { dataset } of datasets) {
      const pair = selectedByDataset.get(dataset)?.[index];
      if (!pair) continue;
      pairs.push(pair);
      added = true;
      if (pairs.length === requested) break;
    }
    if (!added) break;
  }
  if (pairs.length < requested) {
    throw new Error(`found only ${pairs.length}/${requested} pairs; increase --pool-multiplier`);
  }
  const datasetCounts = Object.fromEntries(datasets.map(({ dataset }) => [
    dataset,
    pairs.filter((pair) => (pair.selection_receipt as { source_dataset?: string }).source_dataset === dataset).length,
  ]));
  const resolved = pairs.filter((pair) => (pair.selection_receipt as { target_resolved_in_a2aj?: boolean }).target_resolved_in_a2aj).length;
  const manifest = {
    format: "a2aj-case-target-pairs-v2",
    created_utc: new Date().toISOString(),
    seed,
    requested_pairs: requested,
    pairs: pairs.length,
    selection: {
      algorithm: "dataset-stratified-seeded-citing-case-and-target-v1",
      one_full_citing_decision_per_call: true,
      one_target_per_call: true,
      target_decision_text_included: false,
      max_source_chars: maxSourceChars,
      pool_multiplier: poolMultiplier,
      scan_workers: workers,
      scan_cache: scanDirectory,
      unresolved_target_goal: "seeded 10 percent when available",
    },
    resolved_targets: resolved,
    unresolved_targets: pairs.length - resolved,
    dataset_counts: datasetCounts,
    items: pairs,
  };
  // Keep the parser-facing field boring while retaining the richer manifest receipt.
  const serializable = { ...manifest, pairs: manifest.items, items: undefined };
  await writeFile(output, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
  const partitions: Record<string, string> = {};
  if (calibrationSize > 0) {
    if (calibrationSize >= pairs.length) throw new Error("--calibration-n must be smaller than --n");
    const stem = output.toLocaleLowerCase().endsWith(".json") ? output.slice(0, -5) : output;
    const calibrationOutput = `${stem}.calibration-${calibrationSize}.json`;
    const remainderOutput = `${stem}.remainder-${pairs.length - calibrationSize}.json`;
    const partition = (kind: string, rows: Array<Record<string, unknown>>) => ({
      ...serializable,
      parent_manifest: output,
      budget_partition: kind,
      requested_pairs: rows.length,
      resolved_targets: rows.filter((pair) => (pair.selection_receipt as { target_resolved_in_a2aj?: boolean }).target_resolved_in_a2aj).length,
      unresolved_targets: rows.filter((pair) => !(pair.selection_receipt as { target_resolved_in_a2aj?: boolean }).target_resolved_in_a2aj).length,
      pairs: rows,
    });
    await Promise.all([
      writeFile(calibrationOutput, `${JSON.stringify(partition("calibration", pairs.slice(0, calibrationSize)), null, 2)}\n`, "utf8"),
      writeFile(remainderOutput, `${JSON.stringify(partition("remainder", pairs.slice(calibrationSize)), null, 2)}\n`, "utf8"),
    ]);
    partitions.calibration = calibrationOutput;
    partitions.remainder = remainderOutput;
  }
  console.log(JSON.stringify({ output, partitions, pairs: pairs.length, resolved, unresolved: pairs.length - resolved, dataset_counts: datasetCounts }, null, 2));
}

(process.argv.includes("--scan-worker") ? scanWorker() : main()).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
