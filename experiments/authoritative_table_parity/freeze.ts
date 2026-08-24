import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { spreadsheetToLLMStructure } from "../../backend/src/lib/spreadsheet";
import {
  structureNative,
  type NativeDocument,
  type NativeDocumentBlock,
} from "../../backend/src/lib/structureNative";

const native = structureNative();

const ROOT = path.resolve(import.meta.dirname, "../..");
const RESULTS = path.join(import.meta.dirname, "results");
const INVENTORY = path.join(RESULTS, "inventory.json");
const ORACLE = path.join(RESULTS, "oracle.jsonl");
const RECEIPT = path.join(import.meta.dirname, "baseline.json");
const EXTENSIONS = new Set([".docx", ".xlsx", ".xls", ".ods"]);
const CORPUS_LIMIT = 500;

type Artifact = { path: string; bytes: number; sha256: string; format: string };
type TableCellSpan = {
  table: number; tableName?: string; row: number; column: number;
  address?: string; columnSpan?: number; rowSpan?: number;
  displayValue?: string;
  start: number; end: number;
};
type RawResult = Artifact & {
  status: "no_cells" | "table_facts" | "adapter_error" | "oracle_error";
  text?: string;
  cells?: TableCellSpan[];
  provisions?: unknown[];
  tableNodes?: unknown[];
  maskedText?: string;
  error?: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function framedHash(rows: Iterable<readonly [string, string]>): string {
  const hash = createHash("sha256");
  for (const [key, value] of rows) {
    for (const field of [key, value]) {
      hash.update(String(Buffer.byteLength(field)));
      hash.update(":");
      hash.update(field);
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

function artifactPaths(): string[] {
  const output = execFileSync("rg", [
    "--files",
    "--glob", "!node_modules/**",
    "--glob", "!legal-pdf-parser/target/**",
    "--glob", "!.git/**",
    "--glob", "!.worktrees/**",
    "--glob", "*.docx",
    "--glob", "*.xlsx",
    "--glob", "*.xls",
    "--glob", "*.ods",
    "--", ".",
  ], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return output.split(/\r?\n/u).filter(Boolean)
    .map((value) => value.replace(/^\.\\/u, "").replaceAll("\\", "/"))
    .filter((value) => EXTENSIONS.has(path.extname(value).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, "en"))
    .slice(0, CORPUS_LIMIT);
}

async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await task(values[index], index);
    }
  }));
  return results;
}

/** Frozen copy of the displaced private TypeScript masking oracle. */
function legacyMaskTableCells(text: string, cells: readonly TableCellSpan[]): string {
  const ordered = [...cells].sort((left, right) => left.start - right.start);
  let at = 0;
  let masked = "";
  for (const cell of ordered) {
    const start = Math.max(at, cell.start);
    const end = Math.max(start, Math.min(text.length, cell.end));
    masked += text.slice(at, start);
    masked += text.slice(start, end).replace(/[^\n]/gu, " ");
    at = end;
  }
  return masked + text.slice(at);
}

function normalizeError(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error)
    .replaceAll(ROOT.replaceAll("\\", "/"), "<root>")
    .replaceAll(ROOT, "<root>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

function projectedNode(node: Pick<NativeDocumentBlock,
  "kind" | "label" | "start" | "end" | "parentLabel">) {
  return {
    kind: node.kind,
    label: node.label,
    start: node.start,
    end: node.end,
    ...(node.parentLabel ? { parentLabel: node.parentLabel } : {}),
  };
}

function docxTableCells(document: NativeDocument): TableCellSpan[] {
  return native.documentTableCells(document).map((cell) => ({
    table: cell.table,
    tableName: cell.tableName,
    row: cell.row,
    column: cell.column,
    address: cell.address,
    displayValue: cell.displayValue,
    ...(cell.columnSpan ? { columnSpan: cell.columnSpan } : {}),
    ...(cell.rowSpan ? { rowSpan: cell.rowSpan } : {}),
    start: cell.start,
    end: cell.end,
  }));
}

async function extract(artifact: Artifact): Promise<RawResult> {
  const bytes = await fs.readFile(path.join(ROOT, artifact.path));
  let extracted: { text: string; tableCells: TableCellSpan[] };
  let document: NativeDocument | undefined;
  try {
    extracted = artifact.format === ".docx"
      ? await (async () => {
          document = await native.deriveDocxDocument(bytes, artifact.path);
          return {
            text: native.documentText(document),
            tableCells: docxTableCells(document),
          };
        })()
      : await spreadsheetToLLMStructure(bytes);
  } catch (error) {
    return { ...artifact, status: "adapter_error", error: normalizeError(error) };
  }
  if (!extracted.tableCells.length) return { ...artifact, status: "no_cells" };
  try {
    document ??= await native.deriveDocumentStructure({
      kind: "instrument", id: artifact.path, text: extracted.text,
      table_cells: extracted.tableCells, reconstruct_lineation: true,
    });
    const nodes = native.documentAnchors(document).map(projectedNode);
    return {
      ...artifact,
      status: "table_facts",
      text: extracted.text,
      cells: extracted.tableCells,
      provisions: nodes.filter((node: any) =>
        node.kind !== "table" && node.kind !== "row" && node.kind !== "cell"
      ),
      tableNodes: nodes.filter((node: any) =>
        node.kind === "table" || node.kind === "row" || node.kind === "cell"
      ),
      maskedText: legacyMaskTableCells(extracted.text, extracted.tableCells),
    };
  } catch (error) {
    return { ...artifact, status: "oracle_error", error: normalizeError(error) };
  }
}

async function readCompleted(): Promise<Map<string, RawResult>> {
  const completed = new Map<string, RawResult>();
  const raw = await fs.readFile(ORACLE, "utf8").catch(() => "");
  for (const line of raw.split(/\r?\n/u)) {
    if (!line) continue;
    const row = JSON.parse(line) as RawResult;
    if (row.status === "oracle_error") continue;
    completed.set(row.sha256, row);
  }
  return completed;
}

async function main(): Promise<void> {
  await fs.mkdir(RESULTS, { recursive: true });
  const paths = artifactPaths();
  const started = performance.now();
  const artifacts = await mapLimit(paths, 16, async (relative, index) => {
    const bytes = await fs.readFile(path.join(ROOT, relative));
    if ((index + 1) % 500 === 0) {
      process.stderr.write(`[inventory ${index + 1}/${paths.length}]\n`);
    }
    return {
      path: relative,
      bytes: bytes.length,
      sha256: sha256(bytes),
      format: path.extname(relative).toLowerCase(),
    };
  });
  await fs.writeFile(INVENTORY, `${JSON.stringify(artifacts)}\n`);

  const unique = [...new Map(artifacts.map((row) => [row.sha256, row])).values()]
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const completed = await readCompleted();
  let writer = Promise.resolve();
  let checked = completed.size;
  await mapLimit(unique.filter((row) => !completed.has(row.sha256)), 4, async (artifact) => {
    const result = await extract(artifact);
    completed.set(artifact.sha256, result);
    writer = writer.then(() => fs.appendFile(ORACLE, `${JSON.stringify(result)}\n`));
    await writer;
    checked += 1;
    if (checked % 25 === 0) {
      const facts = [...completed.values()].filter((row) => row.status === "table_facts").length;
      const errors = [...completed.values()].filter((row) => row.status.endsWith("_error")).length;
      process.stderr.write(
        `[extract ${checked}/${unique.length}] table=${facts} errors=${errors} ` +
        `elapsed=${((performance.now() - started) / 1_000).toFixed(1)}s\n`,
      );
    }
  });
  await writer;

  const results = unique.map((artifact) => completed.get(artifact.sha256)!);
  const tableFacts = results.filter((row) => row.status === "table_facts");
  const errors = results.filter((row) => row.status.endsWith("_error"));
  const byFormat = Object.fromEntries([...EXTENSIONS].sort().map((format) => {
    const pathsForFormat = artifacts.filter((row) => row.format === format);
    const uniqueForFormat = results.filter((row) => row.format === format);
    return [format.slice(1), {
      paths: pathsForFormat.length,
      unique: uniqueForFormat.length,
      bytes: pathsForFormat.reduce((sum, row) => sum + row.bytes, 0),
      tableArtifacts: tableFacts.filter((row) => row.format === format).length,
      errors: errors.filter((row) => row.format === format).length,
    }];
  }));
  const receipt = {
    schemaVersion: "beaver.authoritative-table-freeze.v1",
    inventory: {
      paths: artifacts.length,
      unique: unique.length,
      bytes: artifacts.reduce((sum, row) => sum + row.bytes, 0),
      sha256: framedHash(artifacts.map((row) => [
        row.path,
        `${row.sha256}:${row.bytes}:${row.format}`,
      ] as const)),
      byFormat,
    },
    extraction: {
      tableArtifacts: tableFacts.length,
      noCellArtifacts: results.filter((row) => row.status === "no_cells").length,
      errors: errors.length,
      cells: tableFacts.reduce((sum, row) => sum + row.cells!.length, 0),
      tables: tableFacts.reduce((sum, row) =>
        sum + new Set(row.cells!.map((cell) => cell.table)).size, 0),
      tableNodes: tableFacts.reduce((sum, row) => sum + row.tableNodes!.length, 0),
      oracleSha256: framedHash(tableFacts.map((row) => [row.sha256, hashJson({
        text: row.text,
        cells: row.cells,
        provisions: row.provisions,
        tableNodes: row.tableNodes,
        maskedText: row.maskedText,
      })] as const)),
      projectionSha256: framedHash(tableFacts.map((row) =>
        [row.sha256, hashJson(row.tableNodes)] as const
      )),
      maskedInputSha256: framedHash(tableFacts.map((row) =>
        [row.sha256, sha256(row.maskedText!)] as const
      )),
      errorGroups: Object.entries(Object.groupBy(errors, (row) => row.error ?? "unknown"))
        .map(([message, rows]) => ({ message, count: rows!.length, samples: rows!.slice(0, 3).map((row) => row.path) }))
        .sort((left, right) => right.count - left.count || left.message.localeCompare(right.message, "en"))
        .slice(0, 40),
    },
  };
  await fs.writeFile(RECEIPT, `${JSON.stringify(receipt)}\n`);
  process.stderr.write(
    `[complete ${unique.length}/${unique.length}] table=${tableFacts.length} ` +
    `errors=${errors.length} elapsed=${((performance.now() - started) / 1_000).toFixed(1)}s\n`,
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
