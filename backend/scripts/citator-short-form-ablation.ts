import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SAMPLE_SIZE = 200;
const SAMPLE_SEED = "citator-short-form-dev-v1";

type Row = Record<string, unknown>;

function databasePath() {
  const configured = process.env.MIKE_CITATOR_DB?.trim();
  if (configured) return path.resolve(configured);
  const localAppData =
    process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "ALR Quote Verifier", "citator", "noteup.sqlite");
}

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function main() {
  const dbPath = databasePath();
  if (!existsSync(dbPath)) throw new Error(`Citator graph not found: ${dbPath}`);
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // A deterministic sparse scan avoids sorting the multi-million-row edge
    // table while still giving the frozen hash selector a broad candidate pool.
    const pool = database
      .prepare(
        `SELECT edge.case_id, edge.cited_key, TRIM(edge.cited_short) AS cited_short
         FROM edge
         WHERE edge.cited_short IS NOT NULL
           AND TRIM(edge.cited_short) <> ''
           AND edge.id % 7919 = 0
         GROUP BY edge.case_id, edge.cited_key, TRIM(edge.cited_short)
         LIMIT 5000`,
      )
      .all() as Row[];
    const sample = pool
      .map((row) => ({
        caseId: Number(row.case_id),
        citedKey: String(row.cited_key),
        short: String(row.cited_short),
        order: digest(
          `${SAMPLE_SEED}:${row.case_id}:${row.cited_key}:${row.cited_short}`,
        ),
      }))
      .sort((left, right) => left.order.localeCompare(right.order))
      .slice(0, SAMPLE_SIZE);
    if (sample.length < SAMPLE_SIZE) {
      throw new Error(`Only ${sample.length} eligible pairs; expected ${SAMPLE_SIZE}`);
    }

    const keysForShort = database.prepare(
      `SELECT DISTINCT cited_key FROM edge
       WHERE case_id = ? AND LOWER(TRIM(cited_short)) = LOWER(TRIM(?))`,
    );
    const targetsForKey = database.prepare(
      `SELECT DISTINCT path, file_row_number FROM resolution WHERE cited_key = ?`,
    );
    let unique = 0;
    let ambiguous = 0;
    let unresolved = 0;
    for (const pair of sample) {
      const keys = keysForShort.all(pair.caseId, pair.short) as Row[];
      const targets = new Set<string>();
      let missing = false;
      for (const key of keys) {
        const resolved = targetsForKey.all(String(key.cited_key)) as Row[];
        if (!resolved.length) missing = true;
        for (const target of resolved) {
          targets.add(`${target.path}:${target.file_row_number}`);
        }
      }
      if (missing || !targets.size) unresolved += 1;
      else if (targets.size === 1) unique += 1;
      else ambiguous += 1;
    }
    const adjudicated = unique + ambiguous;
    const precision = adjudicated ? unique / adjudicated : 0;
    const receipt = {
      schema_version: 1,
      experiment: "citator-short-form-unique-mapping",
      seed: SAMPLE_SEED,
      sample_size: sample.length,
      sample_sha256: digest(
        sample
          .map((pair) => `${pair.caseId}:${pair.citedKey}:${pair.short}`)
          .join("\n"),
      ),
      graph_bytes: statSync(dbPath).size,
      counts: { unique, ambiguous, unresolved, adjudicated },
      adjudicated_precision: precision,
      promotion_gate: {
        minimum_precision: 0.95,
        minimum_adjudicated: 100,
        eligible: precision >= 0.95 && adjudicated >= 100,
      },
      interpretation:
        "Eligibility permits a later live ablation; it does not add short-form edges to production retrieval.",
    };
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    database.close();
  }
}

main();
