import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { constants, setPriority } from "node:os";

import {
  lookupLegalSourceDoc,
} from "../src/lib/sourceDocNativeMarkup";
import { deriveNativeMarkupSourceDoc } from "../src/lib/sourceDocStructureHost";
import type {
  SourceDoc,
  SourceDocBlock,
  SourceDocLocatorKind,
} from "../src/lib/sourceDoc";
import { shutdownSourceStructureEngine } from "../src/lib/sourceStructureEngine";

const kinds: SourceDocLocatorKind[] = [
  "paragraph",
  "page",
  "footnote",
  "section",
];
const fields = [
  "html_with_citations",
  "xml_harvard",
  "html_columbia",
  "html_lawbox",
  "html_anon_2020",
  "html",
] as const;

type KindResult = {
  blocks: number;
  keys: number;
  duplicateKeys: number;
  selected: string | null;
  result: "found" | "ambiguous" | "none";
};

type AuditRow = {
  schema: 1;
  id: number;
  clusterId: number;
  field: (typeof fields)[number] | null;
  textLength: number;
  blocks: number;
  kinds: Record<SourceDocLocatorKind, KindResult>;
  error?: string;
};

function option(name: string) {
  const position = process.argv.indexOf(name);
  return position < 0 ? null : process.argv[position + 1] ?? null;
}

const databasePath = path.resolve(
  option("--db") ??
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "OpenLegalProducts",
      "LegalData",
      "providers",
      "courtlistener",
      "courtlistener.sqlite",
    ),
);
const outputPath = path.resolve(
  option("--out") ?? ".tmp/courtlistener-structure-roundtrip.jsonl",
);
const summaryPath = `${outputPath}.summary.json`;
const limit = Math.max(0, Number(option("--limit") ?? 0) || 0);
if (process.argv.includes("--below-normal")) {
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
}
const shardCount = Math.max(1, Math.trunc(Number(option("--shard-count") ?? 1)));
const shardIndex = Math.trunc(Number(option("--shard-index") ?? 0));
if (shardIndex < 0 || shardIndex >= shardCount) {
  throw new Error("--shard-index must be within --shard-count");
}

function completedIds() {
  if (!existsSync(outputPath)) return new Set<number>();
  const ids = new Set<number>();
  let valid = "";
  for (const line of readFileSync(outputPath, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as AuditRow;
      if (row.schema !== 1 || !Number.isInteger(row.id)) throw new Error();
      ids.add(row.id);
      valid += `${line}\n`;
    } catch {
      break;
    }
  }
  const temporary = `${outputPath}.repair`;
  writeFileSync(temporary, valid, "utf8");
  renameSync(temporary, outputPath);
  return ids;
}

function materialized(doc: SourceDoc, block: SourceDocBlock) {
  return doc.text.slice(block.start, block.end).trim();
}

function verifyKind(
  doc: SourceDoc,
  kind: SourceDocLocatorKind,
  opinionId: number,
): KindResult {
  const blocks = doc.blocks.filter((block) => block.kind === kind);
  const keys = new Map<string, SourceDocBlock[]>();
  for (const block of blocks) {
    for (const label of new Set(
      [block.label, ...(block.aliases ?? []), block.anchor].filter(
        (value): value is string => Boolean(value),
      ),
    )) {
      const bucket = keys.get(label.toLowerCase());
      if (bucket) bucket.push(block);
      else keys.set(label.toLowerCase(), [block]);
    }
  }

  for (const [key, matches] of keys) {
    const indexed = doc.index.get(key);
    if (matches.length === 1) {
      if (indexed === undefined || doc.blocks[indexed] !== matches[0]) {
        throw new Error(`${kind} index does not identify ${key}`);
      }
    } else if (indexed !== undefined) {
      throw new Error(`${kind} duplicate ${key} is indexed as unique`);
    }
  }

  if (!blocks.length) {
    return { blocks: 0, keys: 0, duplicateKeys: 0, selected: null, result: "none" };
  }

  // A deterministic, corpus-wide arbitrary choice: no fixtures or hand-picked cases.
  const selected = blocks[(opinionId * 131 + kinds.indexOf(kind) * 17) % blocks.length];
  const candidates = [
    selected.label,
    ...(selected.aliases ?? []),
    ...(selected.anchor ? [selected.anchor] : []),
  ];
  const unique = candidates.find(
    (label) => keys.get(label.toLowerCase())?.length === 1,
  );
  const locator = unique ?? selected.label;
  const lookup = lookupLegalSourceDoc(doc, kind, locator, 2);

  if (unique) {
    if (
      lookup.status !== "found" ||
      !lookup.block ||
      lookup.block.label !== selected.label ||
      lookup.block.start !== selected.start ||
      lookup.block.end !== selected.end ||
      lookup.block.text !== materialized(doc, selected)
    ) {
      throw new Error(`${kind} ${locator} did not round-trip to its source block`);
    }
    const ordered = blocks.indexOf(selected);
    const before = blocks.slice(Math.max(0, ordered - 2), ordered);
    const after = blocks.slice(ordered + 1, ordered + 3);
    if (
      lookup.before.some((block, index) =>
        block.label !== before[index]?.label ||
        block.text !== (before[index] ? materialized(doc, before[index]) : ""),
      ) ||
      lookup.after.some((block, index) =>
        block.label !== after[index]?.label ||
        block.text !== (after[index] ? materialized(doc, after[index]) : ""),
      ) ||
      lookup.before.length !== before.length ||
      lookup.after.length !== after.length
    ) {
      throw new Error(`${kind} ${locator} returned incorrect context`);
    }
  } else if (lookup.status !== "ambiguous") {
    throw new Error(`${kind} duplicate ${locator} was not reported as ambiguous`);
  }

  return {
    blocks: blocks.length,
    keys: keys.size,
    duplicateKeys: [...keys.values()].filter((matches) => matches.length > 1).length,
    selected: locator,
    result: unique ? "found" : "ambiguous",
  };
}

function summarize(rows: AuditRow[], total: number) {
  return {
    schema: 1,
    database: databasePath,
    databaseOpinions: total,
    auditedOpinions: rows.length,
    errors: rows.filter((row) => row.error).length,
    sourceFields: Object.fromEntries(
      fields.map((field) => [field, rows.filter((row) => row.field === field).length]),
    ),
    structure: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        {
          opinions: rows.filter((row) => row.kinds[kind].blocks > 0).length,
          blocks: rows.reduce((sum, row) => sum + row.kinds[kind].blocks, 0),
          keys: rows.reduce((sum, row) => sum + row.kinds[kind].keys, 0),
          duplicateKeys: rows.reduce(
            (sum, row) => sum + row.kinds[kind].duplicateKeys,
            0,
          ),
          found: rows.filter((row) => row.kinds[kind].result === "found").length,
          ambiguous: rows.filter(
            (row) => row.kinds[kind].result === "ambiguous",
          ).length,
        },
      ]),
    ),
  };
}

async function main() {
mkdirSync(path.dirname(outputPath), { recursive: true });
const done = completedIds();
const database = new DatabaseSync(databasePath, { readOnly: true });
database.exec(
  "PRAGMA query_only=ON; PRAGMA mmap_size=2147418112; PRAGMA cache_size=-131072",
);
const where = shardCount === 1 ? "" : ` WHERE id % ${shardCount} = ${shardIndex}`;
const total = Number(
  (database.prepare(`SELECT count(*) AS count FROM opinion${where}`).get() as {
    count: number;
  }).count,
);
const query = database.prepare(`SELECT * FROM opinion${where} ORDER BY id`);
let processed = done.size;
let added = 0;
let errors = 0;
let buffer: string[] = [];

for (const raw of query.iterate()) {
  const row = raw as Record<string, unknown>;
  const id = Number(row.id);
  if (done.has(id)) continue;
  if (limit && added >= limit) break;
  const field = fields.find(
    (name) => typeof row[name] === "string" && Boolean(String(row[name]).trim()),
  );
  const markup = field ? String(row[field]) : "";
  const text = markup || (typeof row.plain_text === "string" ? row.plain_text : "");
  const base = {
    schema: 1 as const,
    id,
    clusterId: Number(row.cluster_id),
    field: field ?? null,
    textLength: 0,
    blocks: 0,
    kinds: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        { blocks: 0, keys: 0, duplicateKeys: 0, selected: null, result: "none" },
      ]),
    ) as Record<SourceDocLocatorKind, KindResult>,
  };
  let result: AuditRow;
  try {
    const document = await deriveNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: String(id),
      text,
      markup,
    });
    result = {
      ...base,
      textLength: document.text.length,
      blocks: document.blocks.length,
      kinds: Object.fromEntries(
        kinds.map((kind) => [kind, verifyKind(document, kind, id)]),
      ) as Record<SourceDocLocatorKind, KindResult>,
    };
  } catch (error) {
    result = {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
    errors += 1;
  }
  buffer.push(JSON.stringify(result));
  processed += 1;
  added += 1;
  if (buffer.length >= 100) {
    appendFileSync(outputPath, `${buffer.join("\n")}\n`, "utf8");
    buffer = [];
  }
  if (processed % 500 === 0) {
    process.stderr.write(`audited ${processed}/${total} opinions; new_errors=${errors}\n`);
  }
}
if (buffer.length) appendFileSync(outputPath, `${buffer.join("\n")}\n`, "utf8");
database.close();

const rows = readFileSync(outputPath, "utf8")
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as AuditRow);
const summary = summarize(rows, total);
const temporarySummary = `${summaryPath}.tmp`;
writeFileSync(temporarySummary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
renameSync(temporarySummary, summaryPath);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
await shutdownSourceStructureEngine();
}

void main();
