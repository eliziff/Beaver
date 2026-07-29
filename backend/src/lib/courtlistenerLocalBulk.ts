import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  legalProviderDatabase,
  withReadonlySqlite,
} from "./legalDataPath";

export type LocalCourtlistenerCluster = {
  id: number;
  caseName: string | null;
  caseNameShort: string | null;
  caseNameFull: string | null;
  slug: string | null;
  dateFiled: string | null;
  filepathPdfHarvard: string | null;
};

export type LocalCourtlistenerOpinion = {
  id: number;
  clusterId: number;
  type: string | null;
  authorStr: string | null;
  perCuriam: string | null;
  joinedByStr: string | null;
  pageCount: number | null;
  downloadUrl: string | null;
  localPath: string | null;
  plainText: string | null;
  html: string | null;
  htmlLawbox: string | null;
  htmlColumbia: string | null;
  htmlAnon2020: string | null;
  xmlHarvard: string | null;
  xmlScan: string | null;
  htmlWithCitations: string | null;
};

export type LocalCourtlistenerCase = {
  cluster: LocalCourtlistenerCluster;
  citations: string[];
  opinions: LocalCourtlistenerOpinion[];
};

type Row = Record<string, unknown>;

const CLUSTER_COLUMNS = `
  id, case_name, case_name_short, case_name_full, slug, date_filed,
  filepath_pdf_harvard
`;

function courtlistenerLocalBulkPath() {
  const configured = process.env.MIKE_COURTLISTENER_BULK_DB?.trim();
  if (configured) return path.resolve(configured);
  return legalProviderDatabase("courtlistener", "courtlistener.sqlite");
}

export function courtlistenerLocalBulkAvailable() {
  return existsSync(courtlistenerLocalBulkPath());
}

function withDatabase<T>(operation: (database: DatabaseSync) => T): T | null {
  return withReadonlySqlite(courtlistenerLocalBulkPath(), operation);
}

function nullableString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cluster(row: Row): LocalCourtlistenerCluster {
  return {
    id: Number(row.id),
    caseName: nullableString(row.case_name),
    caseNameShort: nullableString(row.case_name_short),
    caseNameFull: nullableString(row.case_name_full),
    slug: nullableString(row.slug),
    dateFiled: nullableString(row.date_filed),
    filepathPdfHarvard: nullableString(row.filepath_pdf_harvard),
  };
}

function opinion(row: Row): LocalCourtlistenerOpinion {
  return {
    id: Number(row.id),
    clusterId: Number(row.cluster_id),
    type: nullableString(row.type),
    authorStr: nullableString(row.author_str),
    perCuriam: nullableString(row.per_curiam),
    joinedByStr: nullableString(row.joined_by_str),
    pageCount: nullableNumber(row.page_count),
    downloadUrl: nullableString(row.download_url),
    localPath: nullableString(row.local_path),
    plainText: nullableString(row.plain_text),
    html: nullableString(row.html),
    htmlLawbox: nullableString(row.html_lawbox),
    htmlColumbia: nullableString(row.html_columbia),
    htmlAnon2020: nullableString(row.html_anon_2020),
    xmlHarvard: nullableString(row.xml_harvard),
    xmlScan: nullableString(row.xml_scan),
    htmlWithCitations: nullableString(row.html_with_citations),
  };
}

function reporterKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function limit(value: number | undefined, fallback: number, maximum: number) {
  return Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));
}

export function lookupLocalCourtlistenerCitation(args: {
  volume: string;
  reporter: string;
  page: string;
  limit?: number;
}): LocalCourtlistenerCluster[] | null {
  const volume = args.volume.trim();
  const reporter = reporterKey(args.reporter);
  const page = args.page.trim();
  if (!volume || !reporter || !page) return [];
  return withDatabase((database) =>
    database
      .prepare(
        `SELECT DISTINCT cluster.*
         FROM citation JOIN cluster ON cluster.id = citation.cluster_id
         WHERE citation.volume = ? AND citation.reporter_key = ?
           AND citation.page = ?
         ORDER BY cluster.date_filed DESC, cluster.id
         LIMIT ?`,
      )
      .all(volume, reporter, page, limit(args.limit, 20, 100))
      .map((row) => cluster(row as Row)),
  );
}

export function getLocalCourtlistenerCase(
  clusterId: number,
): LocalCourtlistenerCase | null {
  const id = Math.trunc(clusterId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return withDatabase((database) => {
    const clusterRow = database
      .prepare(`SELECT ${CLUSTER_COLUMNS} FROM cluster WHERE id = ?`)
      .get(id) as Row | undefined;
    if (!clusterRow) return null;
    const citations = database
      .prepare(
        `SELECT volume, reporter, page FROM citation
         WHERE cluster_id = ? ORDER BY id LIMIT 100`,
      )
      .all(id)
      .map((row) => {
        const value = row as Row;
        return [value.volume, value.reporter, value.page].join(" ");
      });
    const opinions = database
      .prepare("SELECT * FROM opinion WHERE cluster_id = ? ORDER BY id")
      .all(id)
      .map((row) => opinion(row as Row));
    return { cluster: cluster(clusterRow), citations, opinions };
  });
}

function ftsQuery(query: string) {
  const tokens = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
  return tokens
    .map((token) => `"${token.replace(/"/gu, '""')}"*`)
    .join(" AND ");
}

export function searchLocalCourtlistenerCases(args: {
  query: string;
  limit?: number;
}): LocalCourtlistenerCluster[] | null {
  const query = ftsQuery(args.query);
  if (!query) return [];
  return withDatabase((database) => {
    const wanted = limit(args.limit, 10, 50);
    const matches = database
      .prepare(
        `SELECT cluster.*
         FROM cluster_search JOIN cluster ON cluster.id = cluster_search.rowid
         WHERE cluster_search MATCH ?
         ORDER BY bm25(cluster_search), cluster.date_filed DESC
         LIMIT ?`,
      )
      .all(query, wanted)
      .map((row) => cluster(row as Row));
    if (matches.length >= wanted) return matches;
    const hasOpinionSearch = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'opinion_search'",
      )
      .get();
    if (!hasOpinionSearch) return matches;
    const seen = new Set(matches.map(({ id }) => id));
    const opinionMatches = database
      .prepare(
        `SELECT cluster.*
         FROM opinion_search
         JOIN cluster ON cluster.id = CAST(opinion_search.cluster_id AS INTEGER)
         WHERE opinion_search MATCH ?
         ORDER BY bm25(opinion_search), cluster.date_filed DESC
         LIMIT ?`,
      )
      .all(query, Math.max(50, wanted * 4))
      .map((row) => cluster(row as Row))
      .filter(({ id }) => !seen.has(id));
    const uniqueOpinionMatches = [
      ...new Map(opinionMatches.map((match) => [match.id, match])).values(),
    ];
    return [...matches, ...uniqueOpinionMatches].slice(0, wanted);
  });
}
