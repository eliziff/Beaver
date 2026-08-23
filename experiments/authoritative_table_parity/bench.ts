import { promises as fs } from "node:fs";
import path from "node:path";

const ORACLE = path.join(import.meta.dirname, "results/oracle.jsonl");

function mask(text: string, cells: any[]): string {
  let at = 0;
  let out = "";
  for (const cell of [...cells].sort((a, b) => a.start - b.start)) {
    const start = Math.max(at, cell.start);
    const end = Math.max(start, Math.min(text.length, cell.end));
    out += text.slice(at, start);
    out += text.slice(start, end).replace(/[^\n]/gu, " ");
    at = end;
  }
  return out + text.slice(at);
}

function nodes(text: string, provisions: any[], cells: any[]): any[] {
  const seen = new Set<string>();
  const occupied = new Set<string>();
  const normalized = [];
  for (const cell of cells) {
    const rowSpan = cell.rowSpan ?? 1;
    const columnSpan = cell.columnSpan ?? 1;
    if (!Number.isSafeInteger(cell.table) || cell.table < 1 ||
      !Number.isSafeInteger(cell.row) || cell.row < 1 ||
      !Number.isSafeInteger(cell.column) || cell.column < 1 ||
      !Number.isSafeInteger(rowSpan) || rowSpan < 1 ||
      !Number.isSafeInteger(columnSpan) || columnSpan < 1 ||
      !Number.isSafeInteger(cell.start) || !Number.isSafeInteger(cell.end) ||
      cell.start < 0 || cell.end < cell.start || cell.end > text.length) throw new Error("invalid");
    const label = `table:${cell.table}/row:${cell.row}/col:${cell.column}`;
    if (seen.has(label)) throw new Error(`Duplicate table-cell address: ${label}`);
    seen.add(label);
    for (let row = cell.row; row < cell.row + rowSpan; row += 1) {
      for (let column = cell.column; column < cell.column + columnSpan; column += 1) {
        const coordinate = `${cell.table}:${row}:${column}`;
        if (occupied.has(coordinate)) throw new Error(`Overlapping table-cell address: ${label}`);
        occupied.add(coordinate);
      }
    }
    normalized.push({ ...cell, rowSpan, columnSpan });
  }
  const grouped = Map.groupBy(normalized, (cell) => cell.table);
  const added: any[] = [];
  for (const [table, raw] of [...grouped].sort((a, b) => a[0] - b[0])) {
    const ordered = [...raw].sort((a, b) => a.start - b.start || a.row - b.row || a.column - b.column);
    const start = Math.min(...ordered.map((cell) => cell.start));
    const end = Math.max(...ordered.map((cell) => cell.end));
    const owner = provisions.filter((node) => node.start <= start && end <= node.end)
      .sort((a, b) => b.depth - a.depth)[0];
    const tableNode = { label: `table:${table}`, depth: (owner?.depth ?? -1) + 1, start, end };
    added.push(tableNode);
    for (const [row, rowCells] of [...Map.groupBy(ordered, (cell) => cell.row)].sort((a, b) => a[0] - b[0])) {
      const sorted = [...rowCells].sort((a, b) => a.start - b.start || a.column - b.column);
      const rowNode = {
        label: `${tableNode.label}/row:${row}`,
        depth: tableNode.depth + 1,
        start: Math.min(...sorted.map((cell) => cell.start)),
        end: Math.max(...sorted.map((cell) => cell.end)),
      };
      added.push(rowNode);
      for (const cell of sorted) {
        added.push({
          label: `${rowNode.label}/col:${cell.column}`,
          depth: rowNode.depth + 1,
          start: cell.start,
          end: cell.end,
          heading: text.slice(cell.start, cell.end).replace(/\s+/gu, " ").trim().slice(0, 80),
        });
      }
    }
  }
  return added;
}

async function main(): Promise<void> {
  const rows = (await fs.readFile(ORACLE, "utf8")).trim().split(/\r?\n/u)
    .map((line) => JSON.parse(line)).filter((row) => row.status === "table_facts");
  const runs: number[] = [];
  for (let run = 0; run < 6; run += 1) {
    const outputs: any[] = [];
    const started = performance.now();
    for (const row of rows) {
      outputs.push([mask(row.text, row.cells), nodes(row.text, row.provisions, row.cells)]);
    }
    if (run) runs.push(performance.now() - started);
    void outputs;
  }
  runs.sort((a, b) => a - b);
  console.log(JSON.stringify({ implementation: "typescript", artifacts: rows.length, nodes: rows.reduce((sum, row) => sum + row.tableNodes.length, 0), medianMs: runs[2], runs }));
}

void main();
