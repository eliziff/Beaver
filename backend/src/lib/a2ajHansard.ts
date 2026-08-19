import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "./hash";
import { legalProviderDatabase, withReadonlySqlite } from "./legalDataPath";
import type {
  LegalSourceProvider,
  LegalSourceReference,
} from "./legalSources";

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

let searchConnection:
  | { filename: string; database: DatabaseSync }
  | undefined;

function withSearchDatabase<T>(operation: (database: DatabaseSync) => T): T | null {
  const filename = hansardDatabasePath();
  if (process.env.MIKE_A2AJ_HANSARD_DB?.trim()) {
    return withReadonlySqlite(filename, operation);
  }
  if (!existsSync(filename)) return null;
  if (searchConnection?.filename !== filename) {
    searchConnection?.database.close();
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filename, { readOnly: true });
    database.exec(
      "PRAGMA query_only=ON; PRAGMA mmap_size=2147418112; PRAGMA cache_size=-65536",
    );
    searchConnection = { filename, database };
  }
  return operation(searchConnection.database);
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

function searchHit(row: Row): HansardSearchHit | null {
  const id = string(row, "source_id");
  if (!id) return null;
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
    sourceUrl: string(row, "source_url"),
    upstreamLicense: string(row, "upstream_license"),
    snippet: null,
  };
}

function searchTokens(query: string) {
  return query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
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
  querySyntax?: "terms" | "fts5";
}): HansardSearchHit[] | null {
  const query = args.query.trim();
  if (!query) throw new Error("query is required");
  const tokens = searchTokens(query);
  if (!tokens.length) return [];
  const wanted = Math.max(1, Math.min(50, Math.trunc(args.size ?? 10)));
  return withSearchDatabase((database) => {
    const filters = ["intervention_search MATCH ?"];
    const values: Array<string | number> = [
      args.querySyntax === "fts5"
        ? query
        : tokens.map((token) => `"${token}"`).join(" AND "),
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
          : "rank";
    values.push(wanted);
    return database
      .prepare(
        `SELECT intervention.source_id, intervention.date,
                intervention.jurisdiction, intervention.chamber,
                intervention.language, intervention.order_of_business,
                intervention.subject_of_business, intervention.speaker,
                intervention.intervention_type, intervention.upstream_license,
                intervention.source_url
         FROM intervention_search
         JOIN intervention ON intervention.id = intervention_search.rowid
         WHERE ${filters.join(" AND ")}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...values)
      .map((row) => searchHit(row as Row))
      .filter((row): row is HansardSearchHit => !!row);
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

function hansardReference(intervention: HansardIntervention) {
  const language =
    intervention.language === "en" || intervention.language === "fr"
      ? intervention.language
      : undefined;
  return {
    provider: "hansard",
    id: intervention.id,
    kind: "hansard",
    title:
      intervention.subjectOfBusiness ??
      intervention.orderOfBusiness ??
      intervention.speaker,
    date: intervention.date,
    collection: intervention.chamber,
    language,
    url: intervention.sourceUrl,
  } satisfies LegalSourceReference;
}

export const hansardLegalSourceProvider: LegalSourceProvider<
  string,
  HansardIntervention
> = {
  id: "hansard",
  canSearch: (request) => request.kinds.includes("hansard"),
  async search(request) {
    const jurisdiction = request.jurisdiction
      ?.toLocaleLowerCase()
      .replace(/[^a-z]/gu, "");
    if (
      request.court ||
      request.collection ||
      ["us", "usa", "unitedstates", "unitedstatesofamerica"].includes(
        jurisdiction ?? "",
      )
    ) {
      throw new Error("only installed Canadian Hansard collections are searchable");
    }
    const rows = searchLocalHansard({
      query: request.text,
      size: request.perProviderLimit ?? request.limit,
      speaker: request.speaker,
      startDate: request.dateFrom,
      endDate: request.dateTo,
      sortResults:
        request.sort === "newest"
          ? "newest_first"
          : request.sort === "oldest"
            ? "oldest_first"
            : "default",
      querySyntax: request.syntax,
    });
    if (rows === null) throw new Error("corpus not installed");
    return rows.map((row) => ({
      provider: "hansard",
      id: row.id,
      kind: "hansard" as const,
      title: row.subjectOfBusiness ?? row.orderOfBusiness,
      date: row.date,
      collection: row.chamber,
      url: row.sourceUrl,
      snippet: row.snippet,
      speaker: row.speaker,
    }));
  },
  async readPassage(request) {
    if (request.locator) return [];
    const intervention = fetchLocalHansardIntervention({ id: request.source.id });
    if (!intervention) return [];
    const digest = sha256(intervention.text);
    return [{
      source: hansardReference(intervention),
      locator: { requested: null, label: intervention.id },
      role: "document",
      text: intervention.text,
      textSha256: digest,
      documentSha256: digest,
      revision: digest,
      blockArtifact: intervention.text,
      documentArtifact: intervention.text,
      native: intervention,
    }];
  },
};
