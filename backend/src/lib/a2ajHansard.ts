import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { legalProviderDatabase, withReadonlySqlite } from "./legalDataPath";

/**
 * Local A2AJ Hansard store (huggingface.co/datasets/a2aj/hansard, imported by
 * scripts/import_a2aj_hansard.py). One row per intervention - a single speech
 * or procedural entry in the Ontario Legislative Assembly - so unlike the
 * cases/laws plane there is no citation or section structure to compile;
 * interventions are searchable, fetchable text sources pinned by their
 * upstream ID and source_url.
 */

type Row = Record<string, unknown>;

export type HansardIntervention = {
  id: string;
  date: string | null;
  jurisdiction: string | null;
  chamber: string | null;
  language: string | null;
  orderOfBusiness: string | null;
  subjectOfBusiness: string | null;
  speaker: string | null;
  interventionType: string | null;
  text: string;
  sourceUrl: string | null;
  upstreamLicense: string | null;
};

export type HansardSearchHit = Omit<HansardIntervention, "text"> & {
  snippet: string | null;
};

function hansardDatabasePath() {
  const configured = process.env.MIKE_A2AJ_HANSARD_DB?.trim();
  if (configured) return path.resolve(configured);
  return legalProviderDatabase("a2aj", "hansard.sqlite");
}

function withDatabase<T>(operation: (database: DatabaseSync) => T): T | null {
  return withReadonlySqlite(hansardDatabasePath(), operation);
}

function string(row: Row, field: string) {
  const value = row[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function intervention(row: Row): HansardIntervention | null {
  const id = string(row, "source_id");
  const text = string(row, "text");
  if (!id || !text) return null;
  return {
    id,
    date: string(row, "date"),
    jurisdiction: string(row, "jurisdiction"),
    chamber: string(row, "chamber"),
    language: string(row, "language"),
    orderOfBusiness: string(row, "order_of_business"),
    subjectOfBusiness: string(row, "subject_of_business"),
    speaker: string(row, "speaker"),
    interventionType: string(row, "intervention_type"),
    text,
    sourceUrl: string(row, "source_url"),
    upstreamLicense: string(row, "upstream_license"),
  };
}

function searchTokens(query: string) {
  return query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
}

function snippet(text: string, tokens: string[]) {
  const lower = text.toLocaleLowerCase();
  const position = tokens
    .map((token) => lower.indexOf(token.toLocaleLowerCase()))
    .find((index) => index >= 0);
  const start = Math.max(0, (position ?? 0) - 200);
  return text.slice(start, start + 1_200);
}

/**
 * Returns null when no Hansard database has been imported, mirroring
 * searchLocalA2AJ, so callers can distinguish "not installed" from "no hits".
 */
export function searchLocalHansard(args: {
  query: string;
  size?: number;
  speaker?: string;
  startDate?: string;
  endDate?: string;
  sortResults?: "default" | "newest_first" | "oldest_first";
}): HansardSearchHit[] | null {
  const query = args.query.trim();
  if (!query) throw new Error("query is required");
  const tokens = searchTokens(query);
  if (!tokens.length) return [];
  const wanted = Math.max(1, Math.min(50, Math.trunc(args.size ?? 10)));
  return withDatabase((database) => {
    const filters = ["intervention_search MATCH ?"];
    const values: Array<string | number> = [
      tokens.map((token) => `"${token}"*`).join(" AND "),
    ];
    if (args.speaker?.trim()) {
      filters.push("LOWER(intervention.speaker) LIKE ?");
      values.push(`%${args.speaker.trim().toLocaleLowerCase()}%`);
    }
    if (args.startDate?.trim()) {
      filters.push("intervention.date >= ?");
      values.push(args.startDate.trim());
    }
    if (args.endDate?.trim()) {
      filters.push("intervention.date <= ?");
      values.push(args.endDate.trim());
    }
    const order =
      args.sortResults === "newest_first"
        ? "intervention.date DESC, intervention.id"
        : args.sortResults === "oldest_first"
          ? "intervention.date ASC, intervention.id"
          : "bm25(intervention_search), intervention.date DESC, intervention.id";
    values.push(wanted);
    return database
      .prepare(
        `SELECT intervention.*
         FROM intervention_search
         JOIN intervention ON intervention.id = intervention_search.rowid
         WHERE ${filters.join(" AND ")}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...values)
      .flatMap((row) => {
        const full = intervention(row as Row);
        if (!full) return [];
        const { text, ...rest } = full;
        return [{ ...rest, snippet: snippet(text, tokens) }];
      });
  });
}

export function fetchLocalHansardIntervention(args: {
  id: string;
}): HansardIntervention | null {
  const id = args.id.trim();
  if (!id) throw new Error("id is required");
  return withDatabase((database) => {
    const row = database
      .prepare(
        "SELECT * FROM intervention WHERE source_id = ? ORDER BY id LIMIT 1",
      )
      .get(id) as Row | undefined;
    return row ? intervention(row) : null;
  });
}
