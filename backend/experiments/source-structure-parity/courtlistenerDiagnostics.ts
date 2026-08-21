import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants, setPriority } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

type Tuple = [string, string, number, number, string, string | null, string | null, string[]];
type Candidate = { source_id: string; structure?: Tuple[]; canonical_sha256?: string };
type Drift = { source_id: string; changes: { canonical_sha256: { baseline: string; candidate: string } } };

setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL);

const args = new Map<string, string>();
for (let at = 2; at < process.argv.length; at += 2) {
  if (!process.argv[at]?.startsWith("--") || !process.argv[at + 1]) {
    throw new Error("Expected flag-value pairs");
  }
  args.set(process.argv[at].slice(2), process.argv[at + 1]);
}
const required = (name: string) => {
  const value = args.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return path.resolve(value);
};
const candidateRoot = required("candidate");
const originalModule = required("original-module");
const output = required("output");
const reportFile = args.get("report") ? path.resolve(args.get("report")!) : null;
const baselineRoot = reportFile ? null : required("baseline");
const database = path.resolve(args.get("database") ?? path.join(
  process.env.LOCALAPPDATA ?? "", "OpenLegalProducts", "LegalData", "providers",
  "courtlistener", "courtlistener.sqlite",
));
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(child) : [child];
  });
}

function receiptRows(root: string) {
  const rows = new Map<string, Candidate & { status?: string; failure?: string }>();
  for (const file of filesBelow(root).filter((value) => value.endsWith(".jsonl.gz"))) {
    for (const line of gunzipSync(readFileSync(file)).toString("utf8").trim().split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line) as Candidate & { provider?: string };
      if (row.provider === "courtlistener") rows.set(row.source_id, row);
    }
  }
  return rows;
}
const allCandidates = receiptRows(candidateRoot);
let report: { rows: Drift[] };
if (reportFile) report = JSON.parse(readFileSync(reportFile, "utf8")) as { rows: Drift[] };
else {
  const baseline = receiptRows(baselineRoot!);
  if (baseline.size !== 55_504 || allCandidates.size !== 55_504) {
    throw new Error(`Receipt denominator baseline=${baseline.size} candidate=${allCandidates.size}`);
  }
  const rows: Drift[] = [];
  for (const [id, oldRow] of baseline) {
    const newRow = allCandidates.get(id);
    if (!newRow) throw new Error(`Missing candidate ${id}`);
    if (oldRow.status !== newRow.status || oldRow.failure !== newRow.failure ||
        oldRow.canonical_sha256 !== newRow.canonical_sha256) {
      if (!oldRow.canonical_sha256 || !newRow.canonical_sha256) {
        throw new Error(`Non-output status drift ${id}`);
      }
      rows.push({ source_id: id, changes: { canonical_sha256: {
        baseline: oldRow.canonical_sha256, candidate: newRow.canonical_sha256,
      } } });
    }
  }
  report = { rows };
}
const wanted = new Map(report.rows.map((row) => [row.source_id, row]));
const candidates = new Map([...allCandidates].filter(([id]) => wanted.has(id)));
if (candidates.size !== wanted.size) throw new Error(`Candidate tuples ${candidates.size}/${wanted.size}`);

const { compileNativeMarkupSourceDoc } = createRequire(__filename)(originalModule) as {
  compileNativeMarkupSourceDoc: (input: Record<string, unknown>) => {
    text: string;
    blocks: Array<{ kind: string; label: string; start: number; end: number; origin: string;
      parentLabel?: string; anchor?: string; aliases?: string[] }>;
    [key: string]: unknown;
  };
};
const db = new DatabaseSync(database, { readOnly: true });
const fields = ["html_with_citations", "xml_harvard", "html_columbia", "html_lawbox",
  "html_anon_2020", "html"];
const decodeHtml = (value: string) => value.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_match, code) =>
    String.fromCharCode(Number.parseInt(code, 10)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
    String.fromCharCode(Number.parseInt(code, 16)));
const opinionText = (value: string | null) => value ? decodeHtml(value
  .replace(/<page-number[^>]*>(.*?)<\/page-number>/gis, "$1")
  .replace(/<\/p>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(div|section|opinion|blockquote|li|h[1-6])>/gi, "\n")
  .replace(/<[^>]+>/g, "").replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n").trim()) : null;
const tuple = (block: ReturnType<typeof compileNativeMarkupSourceDoc>["blocks"][number]): Tuple => [
  block.kind, block.label, block.start, block.end, block.origin,
  block.parentLabel ?? null, block.anchor ?? null, block.aliases ?? [],
];
const identity = (item: Tuple) => `${item[0]}\0${item[1]}\0${item[4]}`;

function classify(oldTuples: Tuple[], newTuples: Tuple[]) {
  const oldGroups = new Map<string, Tuple[]>(), newGroups = new Map<string, Tuple[]>();
  for (const [groups, values] of [[oldGroups, oldTuples], [newGroups, newTuples]] as const) {
    for (const value of values) groups.set(identity(value), [...(groups.get(identity(value)) ?? []), value]);
  }
  const classes = new Set<string>();
  const counts: Record<string, Record<string, number>> = {};
  const positions: number[] = [];
  const add = (kind: string, change: string, amount = 1) => {
    counts[kind] ??= {};
    counts[kind][change] = (counts[kind][change] ?? 0) + amount;
  };
  for (const key of new Set([...oldGroups.keys(), ...newGroups.keys()])) {
    const before = oldGroups.get(key) ?? [], after = newGroups.get(key) ?? [];
    const kind = (before[0] ?? after[0])[0], paired = Math.min(before.length, after.length);
    if (before.length !== after.length) {
      classes.add("candidate_selection");
      if (before.length > paired) add(kind, "removed", before.length - paired);
      if (after.length > paired) add(kind, "added", after.length - paired);
      [...before.slice(paired), ...after.slice(paired)].forEach((item) => positions.push(item[2]));
    }
    for (let at = 0; at < paired; at += 1) {
      const left = before[at], right = after[at];
      const disjoint = left[3] <= right[2] || right[3] <= left[2];
      if (disjoint) {
        classes.add("candidate_selection");
        add(kind, "removed"); add(kind, "added");
        positions.push(left[2], left[3], right[2], right[3]);
        continue;
      }
      if (left[2] !== right[2] || left[3] !== right[3]) {
        classes.add("range"); add(kind, "range");
        positions.push(left[2], left[3], right[2], right[3]);
      }
      if (left[5] !== right[5]) { classes.add("hierarchy"); add(kind, "hierarchy"); }
      if (left[6] !== right[6]) { classes.add("native_projection"); add(kind, "anchor"); }
      if (JSON.stringify(left[7]) !== JSON.stringify(right[7])) {
        classes.add("native_projection"); add(kind, "aliases");
      }
      if (left[4] === "native" && JSON.stringify(left) !== JSON.stringify(right)) {
        classes.add("native_projection"); add(kind, "native_tuple");
      }
    }
  }
  const oldOrder = oldTuples.map(identity), newOrder = newTuples.map(identity);
  if (!classes.has("candidate_selection") && oldOrder.length === newOrder.length && JSON.stringify([...oldOrder].sort()) ===
      JSON.stringify([...newOrder].sort()) && JSON.stringify(oldOrder) !== JSON.stringify(newOrder)) {
    classes.add("ordering");
  }
  return { classes: [...classes].sort(), counts, positions: [...new Set(positions)].sort((a, b) => a - b) };
}

const results: unknown[] = [];
for (let at = 0; at < report.rows.length; at += 250) {
  const batch = report.rows.slice(at, at + 250);
  const placeholders = batch.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM opinion WHERE id IN (${placeholders})`)
    .all(...batch.map((row) => Number(row.source_id))) as Array<Record<string, unknown>>;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const drift of batch) {
    const row = byId.get(drift.source_id);
    if (!row) throw new Error(`Missing opinion ${drift.source_id}`);
    const markup = fields.map((field) => row[field]).find((value) =>
      typeof value === "string" && value.trim()) as string | undefined;
    const plain = typeof row.plain_text === "string" && row.plain_text.trim()
      ? row.plain_text : null;
    const input = { provider: "courtlistener", id: drift.source_id,
      text: markup ? "" : opinionText(plain) ?? "", markup: markup ?? null };
    let oldDoc = compileNativeMarkupSourceDoc(input);
    if (!oldDoc.text && markup) oldDoc = compileNativeMarkupSourceDoc({
      ...input, text: opinionText(markup) ?? "",
    });
    const oldSha = sha(JSON.stringify(oldDoc));
    if (oldSha !== drift.changes.canonical_sha256.baseline) {
      throw new Error(`Original oracle mismatch ${drift.source_id}: ${oldSha}`);
    }
    const oldTuples = oldDoc.blocks.map(tuple);
    const candidate = candidates.get(drift.source_id)!;
    const newTuples = candidate.structure ?? [];
    const diagnosis = classify(oldTuples, newTuples);
    const excerpts = diagnosis.positions.slice(0, 12).map((position) => ({
      position,
      start: Math.max(0, position - 100),
      end: Math.min(oldDoc.text.length, position + 220),
      text: oldDoc.text.slice(Math.max(0, position - 100), Math.min(oldDoc.text.length, position + 220)),
    }));
    results.push({ id: drift.source_id, classes: diagnosis.classes, counts: diagnosis.counts,
      excerpt_positions: diagnosis.positions.length, excerpts, old: oldTuples, current: newTuples });
  }
  process.stderr.write(`courtlistener diagnostics ${Math.min(at + batch.length, report.rows.length)}/${report.rows.length}\n`);
}
db.close();
const groups = new Map<string, { count: number; ids: string[]; classes: string[];
  counts: Record<string, Record<string, number>> }>();
for (const value of results as Array<{ id: string; classes: string[];
  counts: Record<string, Record<string, number>> }>) {
  const key = JSON.stringify({ classes: value.classes, counts: value.counts });
  const group = groups.get(key) ?? { count: 0, ids: [], classes: value.classes, counts: value.counts };
  group.count += 1;
  if (group.ids.length < 25) group.ids.push(value.id);
  groups.set(key, group);
}
mkdirSync(path.dirname(output), { recursive: true });
const details = gzipSync(Buffer.from(results.map((value) => JSON.stringify(value)).join("\n") + "\n"), { level: 9 });
writeFileSync(output, details);
const candidateRoots = filesBelow(candidateRoot).filter((value) => value.endsWith("summary.json"))
  .map((file) => JSON.parse(readFileSync(file, "utf8")).manifest_root_sha256 as string)
  .filter(Boolean).sort();
const summary = {
  schema_version: "courtlistener-structure-parity-diagnostics.v1",
  denominator: 55_504,
  mismatches: results.length,
  exact: 55_504 - results.length,
  report_sha256: reportFile ? sha(readFileSync(reportFile)) : sha(JSON.stringify(report)),
  candidate_manifest_sha256: sha(JSON.stringify(candidateRoots)),
  details_sha256: sha(details),
  details_bytes: details.length,
  groups: [...groups.values()].sort((left, right) => right.count - left.count),
};
writeFileSync(output.replace(/\.jsonl\.gz$/u, ".summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
