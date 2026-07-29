import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { citationLookupKey as sharedCitationLookupKey } from "./citationKey";
import { withReadonlySqlite } from "./legalDataPath";

/**
 * Read surface for the Stage 1 citator note-up graph built by
 * scripts/build_citator_graph.py over the local A2AJ case corpus
 * (docs/citator-good-law-research.md, "Stage 1 - exact note-up graph").
 * Every edge is a literal citation occurrence in a citing case's text with
 * its paragraph number, offset, cited-side pinpoints, and a bounded excerpt.
 * There are no treatment labels here and none are implied.
 *
 * Node identity is citationLookupKey below - a faithful TypeScript port of
 * the corpus-proven normalization in ALR-Quote-Verifier local_a2aj.py
 * (_citation_lookup_key), which is also the key space of the corpus lookup
 * index. It equates punctuation/whitespace/case variants of one form
 * ("2015 SCC 5" == "2015 S.C.C. 5", "[2015] 1 SCR 331" == "[2015] 1 S.C.R.
 * 331") and never conflates distinct forms: the French twin "2015 CSC 5"
 * and the S.C.R. parallel citation are distinct keys. Where the build's
 * `resolution` table proves - from the corpus's own citation index - that
 * several keys are the same decision, noteUpCitations unions edges across
 * those keys; when resolution is absent or ambiguous it stays with the
 * literal key and never guesses.
 */

type Row = Record<string, unknown>;

export type NoteUpEntry = {
  /** citing case's own citation as recorded in the corpus */
  citation: string | null;
  name: string | null;
  court: string | null;
  date: string | null;
  url: string | null;
  /** citing decision paragraph number of the first occurrence, when known */
  paragraph: number | null;
  /** occurrences of the cited decision inside this citing case */
  occurrences: number;
  /** how the citing text wrote the first occurrence, e.g. "2015 CSC 5" */
  citedAs: string;
  /** cited-side pinpoints of the first occurrence, e.g. "par86" */
  pinpoints: string | null;
  /** bounded context (max ~600 chars) around the first occurrence */
  excerpt: string;
};

export type NoteUpResult = {
  /** every citing case in the graph, not just the page returned */
  total: number;
  entries: NoteUpEntry[];
};

export type CitatorGraphStats = {
  cases_indexed: number;
  edges: number;
  distinct_cited: number;
};

function citatorDatabasePath() {
  const configured = process.env.MIKE_CITATOR_DB?.trim();
  if (configured) return path.resolve(configured);
  const localAppData =
    process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "ALR Quote Verifier", "citator", "noteup.sqlite");
}

function withDatabase<T>(operation: (database: DatabaseSync) => T): T | null {
  return withReadonlySqlite(citatorDatabasePath(), operation);
}

/**
 * Graph node key for a citation string: the shared corpus-identity port
 * (citationKey.ts), wrapped with this surface's typed refusal when no key
 * survives normalization.
 */
export function citationLookupKey(value: string): string {
  const key = sharedCitationLookupKey(value);
  if (!key) {
    throw new Error(
      "citation is required (no letters or digits survive normalization)",
    );
  }
  return key;
}

/**
 * The set of keys to search for one queried key: the key itself, plus - only
 * when the corpus resolution evidence maps the key to exactly one decision -
 * every other key of that same decision (its French twin, parallel reporter
 * citation, and so on). Zero or multiple candidate decisions leave the query
 * on the literal key alone.
 */
function keysForQuery(database: DatabaseSync, key: string): string[] {
  const targets = database
    .prepare(
      "SELECT DISTINCT path, file_row_number FROM resolution WHERE cited_key = ?",
    )
    .all(key) as Row[];
  if (targets.length !== 1) return [key];
  const aliases = database
    .prepare(
      "SELECT DISTINCT cited_key FROM resolution WHERE path = ? AND file_row_number = ?",
    )
    .all(targets[0].path as string, targets[0].file_row_number as number) as Row[];
  const keys = new Set<string>([key]);
  for (const alias of aliases) keys.add(String(alias.cited_key));
  return [...keys];
}

/**
 * Later cases citing the given citation, newest first, one entry per citing
 * case (its excerpt/pinpoints are the first occurrence in that case).
 * Returns null when no note-up graph has been built, mirroring
 * searchLocalHansard, so callers can distinguish "not installed" from "no
 * hits". Throws on input that normalizes to nothing; arbitrary non-citation
 * text simply finds no edges (the key space is corpus-native). Pass the
 * citation itself ("2016 SCC 27", "[2019] 4 S.C.R. 653"), not a prose
 * reference around it - "R. v. Jordan, 2016 SCC 27" keys the whole string,
 * exactly like the corpus lookup contract this key is ported from.
 */
export function noteUpCitations(args: {
  citation: string;
  size?: number;
}): NoteUpResult | null {
  const key = citationLookupKey(args.citation);
  const wanted = Math.max(1, Math.min(50, Math.trunc(args.size ?? 10)));
  return withDatabase((database) => {
    const keys = keysForQuery(database, key);
    const placeholders = keys.map(() => "?").join(", ");
    // The page is capped; the count must not be. A note-up that reports its
    // page size as the answer understates how heavily a case has been cited.
    const total = Number(
      (
        database
          .prepare(
            `SELECT COUNT(DISTINCT case_id) AS total
             FROM edge WHERE cited_key IN (${placeholders})`,
          )
          .get(...keys) as Row
      ).total,
    );
    const groups = database
      .prepare(
        `SELECT case_doc.citation, case_doc.name, case_doc.court, case_doc.date,
                case_doc.url, case_doc.id AS case_id,
                COUNT(*) AS occurrences, MIN(edge.text_offset) AS first_offset
         FROM edge
         JOIN case_doc ON case_doc.id = edge.case_id
         WHERE edge.cited_key IN (${placeholders})
         GROUP BY edge.case_id
         ORDER BY (case_doc.date IS NULL), case_doc.date DESC, case_doc.id
         LIMIT ?`,
      )
      .all(...keys, wanted) as Row[];
    const firstOccurrence = database.prepare(
      `SELECT cited_citation, paragraph, pinpoints, excerpt
       FROM edge WHERE case_id = ? AND text_offset = ?`,
    );
    const entries = groups.map((group) => {
      const first = firstOccurrence.get(
        group.case_id as number,
        group.first_offset as number,
      ) as Row;
      return {
        citation: (group.citation as string | null) ?? null,
        name: (group.name as string | null) ?? null,
        court: (group.court as string | null) ?? null,
        date: (group.date as string | null) ?? null,
        url: (group.url as string | null) ?? null,
        paragraph: first.paragraph === null ? null : Number(first.paragraph),
        occurrences: Number(group.occurrences),
        citedAs: String(first.cited_citation),
        pinpoints: (first.pinpoints as string | null) ?? null,
        excerpt: String(first.excerpt),
      };
    });
    return { total, entries };
  });
}

/** Whole-graph counts; null when no note-up graph has been built. */
export function graphStats(): CitatorGraphStats | null {
  return withDatabase((database) => {
    const row = database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM case_doc) AS cases_indexed,
                (SELECT COUNT(*) FROM edge) AS edges,
                (SELECT COUNT(DISTINCT cited_key) FROM edge) AS distinct_cited`,
      )
      .get() as Row;
    return {
      cases_indexed: Number(row.cases_indexed),
      edges: Number(row.edges),
      distinct_cited: Number(row.distinct_cited),
    };
  });
}
