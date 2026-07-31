import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { citationLookupKey as sharedCitationLookupKey } from "./citationKey";
import { classifyCitatorExcerpt } from "./citatorExcerpts";
import { courtLevel } from "./courtLevels";
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
  /**
   * The corpus's own curated citation graph (cases_cited/cases_citing
   * columns), stored verbatim at build time; null when the graph on disk
   * predates provider edges (schema 1).
   */
  provider: {
    /** distinct in-corpus cases whose curated cited-list names this citation */
    citingInCorpus: number;
    /** citations the corpus records as citing this case - may lie outside the corpus */
    citingReported: string[];
  } | null;
};

export type CitatorGraphStats = {
  cases_indexed: number;
  edges: number;
  distinct_cited: number;
  /** curated provider_edge rows; null when the graph predates them */
  provider_edges: number | null;
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
function hasProviderEdges(database: DatabaseSync) {
  return Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_edge'",
      )
      .get(),
  );
}

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
 * `keysForQuery` for callers outside the graph: the key of `citation`
 * plus its resolution-proven twins. Scanner contract, so it differs from
 * the lookup surfaces here in two ways — text that normalizes to nothing
 * returns [] instead of throwing (a substring scan hands in arbitrary
 * text), and an absent citator graph degrades silently to the literal
 * key rather than to null.
 */
export function citationAliasKeys(citation: string): string[] {
  const key = sharedCitationLookupKey(citation);
  if (!key) return [];
  return withDatabase((database) => keysForQuery(database, key)) ?? [key];
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
    let provider: NoteUpResult["provider"] = null;
    if (hasProviderEdges(database)) {
      const citingInCorpus = Number(
        (
          database
            .prepare(
              `SELECT COUNT(DISTINCT case_id) AS n FROM provider_edge
               WHERE direction = 'cited' AND citation_key IN (${placeholders})`,
            )
            .get(...keys) as Row
        ).n,
      );
      const reported = database
        .prepare(
          `SELECT DISTINCT provider_edge.citation
           FROM provider_edge
           JOIN case_key ON case_key.case_id = provider_edge.case_id
           WHERE provider_edge.direction = 'citing'
             AND case_key.citation_key IN (${placeholders})
           ORDER BY provider_edge.citation LIMIT 50`,
        )
        .all(...keys) as Row[];
      provider = {
        citingInCorpus,
        citingReported: reported.map((row) => String(row.citation)),
      };
    }
    return { total, entries, provider };
  });
}

export type StandsForCandidate = {
  /**
   * case = another court's citing prose (edge graph); commentary = a
   * journal author's proposition sentence whose footnote cites the case
   * (journal_commentary.sqlite, built by scripts/pair_journal_footnotes.py)
   */
  sourceKind: "case" | "commentary";
  /** journal name for commentary candidates; null for case candidates */
  journalName: string | null;
  /** the attested characterization text (the excerpt's prose window) */
  text: string;
  /** prose = clean citing prose; mixed = prose window extracted from around citations */
  excerptKind: "prose" | "mixed";
  citingCitation: string | null;
  citingName: string | null;
  citingCourt: string | null;
  /** courtLevels level of the citing court; null when unmapped */
  citingLevel: number | null;
  citingDate: string | null;
  paragraph: number | null;
  /** sha256 of `text`, for rendering receipts */
  spanSha256: string;
};

/**
 * Candidate ordering policies (Stage 9 H19 ablation — registered as a
 * live experimental variable, never assume one is right):
 * - authority: citing-court level, citer occurrences, recency;
 *   commentary carries no court level and sorts last.
 * - banded_recency: band = court level; commentary joins the HIGHEST
 *   band present in the profile; newest-first within every band.
 * - flat_recency: newest first regardless of source kind.
 */
export type StandsForRankPolicy =
  | "authority"
  | "banded_recency"
  | "flat_recency";

export type StandsForProfile = {
  citation: string;
  rankPolicy: StandsForRankPolicy;
  /** distinct citing cases in the edge graph (all, not just considered) */
  totalCiters: number;
  candidates: StandsForCandidate[];
  /** rich >= 3 usable candidates, thin 1-2, none 0 (typed refusal downstream) */
  tier: "rich" | "thin" | "none";
  excerptsConsidered: number;
  excerptsRejected: { authorityList: number; insufficient: number };
  /** journal-commentary source counts; null when no commentary DB is installed */
  commentary: { considered: number; rejected: number } | null;
};

const STANDS_FOR_CONSIDERED = 300;

function journalCommentaryPath() {
  const configured = process.env.MIKE_JOURNAL_COMMENTARY_DB?.trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(citatorDatabasePath()), "journal_commentary.sqlite");
}

/**
 * Commentary candidates for a set of citation keys: rank-1 (primary
 * authority) citations of PAIRED notes whose proposition sentence
 * survived extraction — the journal author's own characterization of
 * what the cited case supports, verified by their footnote. The same
 * prose-vs-authority-list classifier gates the proposition, so TOC
 * fragments and citation strings never become characterizations.
 */
function commentaryCandidates(keys: string[]): {
  considered: number;
  rejected: number;
  usable: Array<StandsForCandidate & { occurrences: number }>;
} | null {
  const placeholders = keys.map(() => "?").join(", ");
  return withReadonlySqlite(journalCommentaryPath(), (database) => {
    const rows = database
      .prepare(
        `SELECT note.proposition, article.citation, article.name,
                article.date, article.journal_name
         FROM note_citation
         JOIN note ON note.id = note_citation.note_id
         JOIN article ON article.article_id = note.article_id
         WHERE note_citation.cited_key IN (${placeholders})
           AND note_citation.rank = 1
           AND note.pair_status = 'paired'
           AND note.proposition IS NOT NULL
         ORDER BY (article.date IS NULL), article.date DESC, note.id
         LIMIT ?`,
      )
      .all(...keys, STANDS_FOR_CONSIDERED) as Row[];
    let rejected = 0;
    const usable: Array<StandsForCandidate & { occurrences: number }> = [];
    for (const row of rows) {
      // The classifier GATES commentary but never rewrites it: its prose
      // window trims a word off both ends because citator excerpts
      // truncate mid-word, while a paired proposition is sentence-exact
      // already - the verbatim text the widened tier will hash against.
      const proposition = String(row.proposition).trim();
      const verdict = classifyCitatorExcerpt(proposition);
      if (
        (verdict.kind !== "prose" && verdict.kind !== "mixed") ||
        !verdict.proseWindow
      ) {
        rejected += 1;
        continue;
      }
      usable.push({
        sourceKind: "commentary",
        journalName: (row.journal_name as string | null) ?? null,
        text: proposition,
        excerptKind: verdict.kind,
        citingCitation: (row.citation as string | null) ?? null,
        citingName: (row.name as string | null) ?? null,
        citingCourt: null,
        citingLevel: null,
        citingDate: (row.date as string | null) ?? null,
        paragraph: null,
        spanSha256: createHash("sha256")
          .update(proposition, "utf8")
          .digest("hex"),
        occurrences: 1,
      });
    }
    return { considered: rows.length, rejected, usable };
  });
}

/**
 * Ranked attested characterizations of a cited case, drawn from what
 * OTHER courts' prose says when citing it (H12; research plan D2).
 * Excerpts pass the deterministic prose-vs-authority-list classifier;
 * candidates rank by citing-court level, then citing-case occurrence
 * count, then recency. A case nobody characterizes in prose returns
 * tier "none" — the caller's contract must then refuse composed
 * characterizations, never invent one. Null when no graph is installed.
 */
export function standsForProfile(args: {
  citation: string;
  size?: number;
  rankPolicy?: StandsForRankPolicy;
}): StandsForProfile | null {
  const key = citationLookupKey(args.citation);
  const cap = Math.max(1, Math.min(24, Math.trunc(args.size ?? 8)));
  const rankPolicy = args.rankPolicy ?? "authority";
  return withDatabase((database) => {
    const keys = keysForQuery(database, key);
    const placeholders = keys.map(() => "?").join(", ");
    const totalCiters = Number(
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
                case_doc.id AS case_id,
                COUNT(*) AS occurrences, MIN(edge.text_offset) AS first_offset
         FROM edge
         JOIN case_doc ON case_doc.id = edge.case_id
         WHERE edge.cited_key IN (${placeholders})
         GROUP BY edge.case_id
         ORDER BY (case_doc.date IS NULL), case_doc.date DESC, case_doc.id
         LIMIT ?`,
      )
      .all(...keys, STANDS_FOR_CONSIDERED) as Row[];
    const firstOccurrence = database.prepare(
      `SELECT paragraph, excerpt FROM edge WHERE case_id = ? AND text_offset = ?`,
    );
    let authorityList = 0;
    let insufficient = 0;
    const usable: Array<StandsForCandidate & { occurrences: number }> = [];
    for (const group of groups) {
      const first = firstOccurrence.get(
        group.case_id as number,
        group.first_offset as number,
      ) as Row;
      const verdict = classifyCitatorExcerpt(String(first.excerpt));
      if (verdict.kind === "authority_list") {
        authorityList += 1;
        continue;
      }
      if (verdict.kind === "insufficient" || !verdict.proseWindow) {
        insufficient += 1;
        continue;
      }
      usable.push({
        sourceKind: "case",
        journalName: null,
        text: verdict.proseWindow,
        excerptKind: verdict.kind,
        citingCitation: (group.citation as string | null) ?? null,
        citingName: (group.name as string | null) ?? null,
        citingCourt: (group.court as string | null) ?? null,
        citingLevel: courtLevel(group.court as string | null)?.level ?? null,
        citingDate: (group.date as string | null) ?? null,
        paragraph: first.paragraph === null ? null : Number(first.paragraph),
        spanSha256: createHash("sha256")
          .update(verdict.proseWindow, "utf8")
          .digest("hex"),
        occurrences: Number(group.occurrences),
      });
    }
    const commentary = commentaryCandidates(keys);
    if (commentary) usable.push(...commentary.usable);
    // Policies reorder the SAME usable set — the classifier gates and
    // the cap are policy-independent, so only rank moves (H19).
    const byDate = (
      a: (typeof usable)[number],
      b: (typeof usable)[number],
    ) =>
      (a.citingDate === null ? 1 : 0) - (b.citingDate === null ? 1 : 0) ||
      (b.citingDate ?? "").localeCompare(a.citingDate ?? "");
    if (rankPolicy === "flat_recency") {
      usable.sort(
        (a, b) =>
          byDate(a, b) ||
          b.occurrences - a.occurrences ||
          (b.citingLevel ?? 0) - (a.citingLevel ?? 0),
      );
    } else if (rankPolicy === "banded_recency") {
      const topLevel = usable.reduce(
        (top, candidate) => Math.max(top, candidate.citingLevel ?? 0),
        0,
      );
      const band = (candidate: (typeof usable)[number]) =>
        candidate.sourceKind === "commentary"
          ? topLevel || 1
          : (candidate.citingLevel ?? 0);
      usable.sort(
        (a, b) =>
          band(b) - band(a) || byDate(a, b) || b.occurrences - a.occurrences,
      );
    } else {
      usable.sort(
        (a, b) =>
          (b.citingLevel ?? 0) - (a.citingLevel ?? 0) ||
          b.occurrences - a.occurrences ||
          (b.citingDate ?? "").localeCompare(a.citingDate ?? ""),
      );
    }
    const candidates = usable
      .slice(0, cap)
      .map(({ occurrences: _occurrences, ...candidate }) => candidate);
    return {
      citation: args.citation,
      rankPolicy,
      totalCiters,
      candidates,
      tier: usable.length >= 3 ? "rich" : usable.length ? "thin" : "none",
      excerptsConsidered: groups.length,
      excerptsRejected: { authorityList, insufficient },
      commentary: commentary
        ? { considered: commentary.considered, rejected: commentary.rejected }
        : null,
    };
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
      provider_edges: hasProviderEdges(database)
        ? Number(
            (database.prepare("SELECT COUNT(*) AS n FROM provider_edge").get() as Row)
              .n,
          )
        : null,
    };
  });
}
