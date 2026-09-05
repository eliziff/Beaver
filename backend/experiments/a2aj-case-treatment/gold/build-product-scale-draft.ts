import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PRODUCT_GOLD_VERSION, productGoldErrors, type ProductGoldRecord } from "../productGold";

type LegacyRecord = {
  document_id: number;
  citation: string;
  annotation: {
    structure: {
      opinions: Array<{
        opinion_id: string;
        boundary: ProductGoldRecord["structure"]["opinions"][number]["boundary"];
        collective_author?: { name: string } | null;
        result_position: ProductGoldRecord["structure"]["opinions"][number]["result_position"];
      }>;
      participants: Array<{
        name: string;
        result_position: ProductGoldRecord["structure"]["participants"][number]["result_position"];
        opinion_links: ProductGoldRecord["structure"]["participants"][number]["opinion_links"];
      }>;
      nonparticipants: Array<{ name: string }>;
    };
    analysis: {
      cited_decisions: Array<{
        identifying_span: { start_quote: string; end_quote: string };
        procedural_relationship: { actions: ProductGoldRecord["direct_outcomes"][number]["actions"] } | null;
        treatments: ProductGoldRecord["treatments"];
      }>;
    };
  };
};

type Selection = { document_ids: number[] };
const here = path.resolve("backend/experiments/a2aj-case-treatment/gold");
const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return path.resolve(index < 0 ? fallback : process.argv[index + 1] ?? fallback);
};
const readJsonl = async <T>(file: string) => (await readFile(file, "utf8"))
  .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as T);
const citedDecision = ({ start_quote, end_quote }: { start_quote: string; end_quote: string }) =>
  start_quote === end_quote ? start_quote : `${start_quote}, ${end_quote}`;
const writer = (record: LegacyRecord, opinionId: string) => record.annotation.structure.participants.find(({ opinion_links }) =>
  opinion_links.some(({ opinion_id, relation }) => opinion_id === opinionId && relation === "wrote"))?.name ?? null;

function spans(value: unknown): Array<{ start_line: number; end_line: number; start_quote: string; end_quote: string }> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(spans);
  const item = value as Record<string, unknown>;
  const found = typeof item.start_line === "number" && typeof item.end_line === "number" &&
    typeof item.start_quote === "string" && typeof item.end_quote === "string" ? [item as ReturnType<typeof spans>[number]] : [];
  return [...found, ...Object.values(item).flatMap(spans)];
}

async function validateSpans(record: LegacyRecord, packetsDirectory: string) {
  const text = await readFile(path.join(packetsDirectory, `${record.document_id}.txt`), "utf8");
  const lines = new Map([...text.matchAll(/^(\d{5}) \| (.*)$/gmu)].map((match) => [Number(match[1]), match[2]]));
  const sourceSpans = spans(record.annotation);
  const invalid = sourceSpans.filter((span) =>
    !lines.get(span.start_line)?.includes(span.start_quote) || !lines.get(span.end_line)?.includes(span.end_quote));
  if (invalid.length) throw new Error(`${record.document_id}: ${invalid.length} source spans no longer resolve`);
  return sourceSpans.length;
}

function project(record: LegacyRecord): ProductGoldRecord {
  const decisions = record.annotation.analysis.cited_decisions;
  return {
    contract_version: PRODUCT_GOLD_VERSION,
    document_id: record.document_id,
    citation: record.citation,
    structure: {
      opinions: record.annotation.structure.opinions.map((opinion) => ({
        opinion_id: opinion.opinion_id,
        boundary: opinion.boundary,
        writer: writer(record, opinion.opinion_id),
        collective_author: opinion.collective_author?.name ?? null,
        result_position: opinion.result_position,
      })),
      participants: record.annotation.structure.participants.map(({ name, result_position, opinion_links }) => ({
        name,
        result_position,
        opinion_links: opinion_links.map(({ opinion_id, relation }) => ({ opinion_id, relation })),
      })),
      nonparticipants: record.annotation.structure.nonparticipants.map(({ name }) => name),
    },
    direct_outcomes: decisions.flatMap((decision) => decision.procedural_relationship?.actions.length ? [{
      cited_decision: citedDecision(decision.identifying_span),
      actions: decision.procedural_relationship.actions.map(({ action, affected_part }) => ({ action, affected_part })),
    }] : []),
    reported_history: [],
    treatments: decisions.flatMap((decision) => decision.treatments.map(({ opinion_id, signals, other_signal, proposition, treatment }) => ({
      cited_decision: citedDecision(decision.identifying_span),
      opinion_id,
      signals,
      other_signal,
      proposition,
      treatment,
    }))),
  };
}

async function main() {
  const selectionFile = argument("--selection", path.join(here, "selection-scaled-100.json"));
  const auditedSelectionFile = argument("--audited-selection", path.join(here, "selection-scaled-30.json"));
  const legacyFile = argument("--legacy", path.join(here, "gold.jsonl"));
  const auditedFile = argument("--audited", path.join(here, "gold-product-30-v1.jsonl"));
  const packetsDirectory = argument("--packets-dir", path.resolve("backend/experiments/a2aj-case-treatment/runs/product-gold-scale-direct/packets"));
  const destination = argument("--out", path.join(here, "gold-product-100-draft.jsonl"));
  if (destination === auditedFile || path.basename(destination).toLocaleLowerCase() === "gold-product-30-v1.jsonl") {
    throw new Error("refusing to overwrite audited gold-product-30-v1.jsonl");
  }

  const selection = JSON.parse(await readFile(selectionFile, "utf8")) as Selection;
  const auditedSelection = JSON.parse(await readFile(auditedSelectionFile, "utf8")) as Selection;
  const legacy = await readJsonl<LegacyRecord>(legacyFile);
  const audited = await readJsonl<ProductGoldRecord>(auditedFile);
  if (selection.document_ids.length !== 100 || new Set(selection.document_ids).size !== 100) throw new Error("selection must contain 100 unique cases");
  if (audited.length !== 30 || audited.map(({ document_id }) => document_id).join(",") !== auditedSelection.document_ids.join(",")) {
    throw new Error("audited product gold must match the audited 30-case selection in order");
  }

  const auditedById = new Map(audited.map((record) => [record.document_id, record]));
  const legacyById = new Map(legacy.map((record) => [record.document_id, record]));
  const projected = selection.document_ids.filter((documentId) => !auditedById.has(documentId)).map((documentId) => {
    const source = legacyById.get(documentId);
    if (!source) throw new Error(`legacy gold has no record for ${documentId}`);
    return source;
  });
  const validatedSpans = (await Promise.all(projected.map((record) => validateSpans(record, packetsDirectory))))
    .reduce((sum, count) => sum + count, 0);
  const records = selection.document_ids.map((documentId) => {
    const existing = auditedById.get(documentId);
    if (existing) return existing;
    const source = legacyById.get(documentId);
    if (!source) throw new Error(`legacy gold has no record for ${documentId}`);
    return project(source);
  });
  const errors = records.flatMap((record) => productGoldErrors(record).map((error) => `${record.document_id}: ${error}`));
  if (errors.length) throw new Error(errors.join("\n"));

  await writeFile(destination, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    destination,
    cases: records.length,
    audited_cases: records.filter(({ document_id }) => auditedById.has(document_id)).length,
    projected_cases: records.filter(({ document_id }) => !auditedById.has(document_id)).length,
    treatments: records.reduce((sum, record) => sum + record.treatments.length, 0),
    direct_outcomes: records.reduce((sum, record) => sum + record.direct_outcomes.length, 0),
    reported_history: records.reduce((sum, record) => sum + record.reported_history.length, 0),
    validated_spans: validatedSpans,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
