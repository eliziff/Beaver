import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  noteUpCitations,
  type NoteUpEntry,
} from "../src/lib/caselawCitator";

type Row = Record<string, unknown>;

function graphPath() {
  const configured = process.env.MIKE_CITATOR_DB?.trim();
  if (configured) return path.resolve(configured);
  const base =
    process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "ALR Quote Verifier", "citator", "noteup.sqlite");
}

const newestOrder = (left: NoteUpEntry, right: NoteUpEntry) =>
  (left.date === null ? 1 : 0) - (right.date === null ? 1 : 0) ||
  (right.date ?? "").localeCompare(left.date ?? "");

const discussedOrder = (left: NoteUpEntry, right: NoteUpEntry) =>
  right.occurrences - left.occurrences ||
  right.distinctParagraphs - left.distinctParagraphs ||
  (right.courtLevel ?? 0) - (left.courtLevel ?? 0) ||
  newestOrder(left, right);

function ordered(entries: NoteUpEntry[], compare: (a: NoteUpEntry, b: NoteUpEntry) => number) {
  return entries.every((entry, index) => index === 0 || compare(entries[index - 1], entry) <= 0);
}

function main() {
  const database = new DatabaseSync(graphPath(), { readOnly: true });
  let citations: string[];
  try {
    citations = (
      database
        .prepare(
          `SELECT MIN(cited_citation) AS citation, COUNT(DISTINCT case_id) AS citers
           FROM edge
           WHERE cited_citation IS NOT NULL AND TRIM(cited_citation) <> ''
           GROUP BY cited_key
           HAVING COUNT(DISTINCT case_id) >= 4
           ORDER BY citers DESC, cited_key
           LIMIT 30`,
        )
        .all() as Row[]
    ).map((row) => String(row.citation));
  } finally {
    database.close();
  }

  const failures: string[] = [];
  let rows = 0;
  for (const citation of citations) {
    const newest = noteUpCitations({ citation, size: 50, sort: "newest" });
    const discussed = noteUpCitations({
      citation,
      size: 50,
      sort: "most_discussed",
    });
    if (!newest || !discussed) throw new Error("Citator graph disappeared during audit");
    rows += newest.entries.length + discussed.entries.length;
    if (!ordered(newest.entries, newestOrder)) failures.push(`${citation}:newest`);
    if (!ordered(discussed.entries, discussedOrder)) {
      failures.push(`${citation}:most_discussed`);
    }
    for (const [scope, allowed] of [
      ["scc", new Set([5])],
      ["appellate", new Set([4])],
      ["trial", new Set([2, 3])],
      ["tribunal", new Set([1])],
    ] as const) {
      const scoped = noteUpCitations({ citation, size: 50, courtScope: scope });
      if (
        !scoped ||
        scoped.entries.some(
          (entry) => entry.courtLevel === null || !allowed.has(entry.courtLevel),
        )
      ) {
        failures.push(`${citation}:${scope}`);
      }
    }
  }
  const receipt = {
    schema_version: 1,
    citations: citations.length,
    citation_sample_sha256: createHash("sha256")
      .update(citations.join("\n"))
      .digest("hex"),
    returned_rows_checked: rows,
    failures,
    passed: citations.length === 30 && failures.length === 0,
  };
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.passed) process.exitCode = 1;
}

main();
