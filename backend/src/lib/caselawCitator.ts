import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  citationLookupKey as sharedCitationLookupKey,
  citationsInText,
} from "./citationKey";
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
  /** distinct numbered citing paragraphs containing the citation */
  distinctParagraphs: number;
  /** deterministic court hierarchy level; null when the corpus code is unknown */
  courtLevel: number | null;
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
  /** cited-side paragraph filter, when the caller requested one */
  citedParagraph?: number;
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

export type NoteUpCourtScope =
  | "all"
  | "scc"
  | "appellate"
  | "trial"
  | "tribunal";

export type NoteUpSort = "newest" | "most_discussed";

function matchesCourt(
  court: unknown,
  scope: NoteUpCourtScope,
  code: string | null,
) {
  const candidate = String(court ?? "").trim().toUpperCase();
  if (code) return candidate === code;
  if (scope === "all") return true;
  const level = courtLevel(candidate)?.level ?? null;
  if (scope === "scc") return level === 5;
  if (scope === "appellate") return level === 4;
  if (scope === "trial") return level === 2 || level === 3;
  return level === 1;
}
export type CitationAuthorityMetric = {
  citingCases: number;
  distinctCitingParagraphs: number;
  occurrences: number;
};

let defaultAuthorityMetricsAvailable: boolean | undefined;

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
  const detected = citationsInText(value);
  if (detected.length > 1) {
    throw new Error(
      "citation must identify one citation form; multiple citations were found",
    );
  }
  // Tool inputs often carry a case name or pinpoint around the identity
  // citation. Detection and identity stay separate shared contracts: strip
  // the decoration here, then key the one detected citation exactly as the
  // corpus index does.
  const key = sharedCitationLookupKey(detected[0]?.text ?? value);
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
 * Expand citation aliases on one database handle. Invalid text produces no
 * key, and an absent graph degrades to the literal normalized key.
 */
export function citationAliasKeysBatch(citations: string[]): string[][] {
  const keys = citations.map((citation) => sharedCitationLookupKey(citation));
  if (!keys.some(Boolean)) return keys.map(() => []);
  return (
    withDatabase((database) =>
      keys.map((key) => (key ? keysForQuery(database, key) : [])),
    ) ?? keys.map((key) => (key ? [key] : []))
  );
}
/** Batch authority counts for ranked retrieval: one DB handle, no excerpts. */
export function citationAuthorityMetricsBatch(
  citations: string[],
): Array<CitationAuthorityMetric | null> {
  const keys = citations.map((citation) => sharedCitationLookupKey(citation));
  if (!keys.some(Boolean)) return keys.map(() => null);
  if (!process.env.MIKE_CITATOR_DB?.trim() && defaultAuthorityMetricsAvailable === false) {
    return keys.map(() => null);
  }
  return (
    withDatabase((database) => {
      const unique = [...new Set(keys.filter((key): key is string => !!key))];
      const placeholders = unique.map(() => "?").join(",");
      const materialized = database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='authority_metric'",
        )
        .get();
      if (!process.env.MIKE_CITATOR_DB?.trim()) {
        defaultAuthorityMetricsAvailable = !!materialized;
      }
      if (!materialized) return keys.map(() => null);
      const rows = database
        .prepare(
          `SELECT cited_key, citing_cases, citing_paragraphs, occurrences
           FROM authority_metric WHERE cited_key IN (${placeholders})`,
        )
        .all(...unique) as Row[];
      const byKey = new Map(rows.map((row) => [String(row.cited_key), row]));
      return keys.map((key) => {
        const row = key ? byKey.get(key) : null;
        return row
          ? {
              citingCases: Number(row.citing_cases),
              distinctCitingParagraphs: Number(row.citing_paragraphs),
              occurrences: Number(row.occurrences),
            }
          : null;
      });
    }) ?? keys.map(() => null)
  );
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
  citedParagraph?: number;
  size?: number;
  courtScope?: NoteUpCourtScope;
  courtCode?: string;
  sort?: NoteUpSort;
}): NoteUpResult | null {
  const key = citationLookupKey(args.citation);
  const wanted = Math.max(1, Math.min(50, Math.trunc(args.size ?? 10)));
  const courtScope = args.courtScope ?? "all";
  const courtCode = args.courtCode?.trim().toUpperCase() || null;
  const citedParagraph = args.citedParagraph === undefined
    ? null
    : Math.trunc(args.citedParagraph);
  if (citedParagraph !== null && citedParagraph < 1) {
    throw new Error("cited_paragraph must be a positive integer");
  }
  if (courtCode && courtScope !== "all") {
    throw new Error("court_code cannot be combined with a non-all court_scope");
  }
  const sort = args.sort ?? "newest";
  return withDatabase((database) => {
    const keys = keysForQuery(database, key);
    const placeholders = keys.map(() => "?").join(", ");
    const groups = (database
      .prepare(
        `SELECT case_doc.citation, case_doc.name, case_doc.court, case_doc.date,
                case_doc.url, case_doc.id AS case_id,
                COUNT(*) AS occurrences,
                COUNT(DISTINCT edge.paragraph) AS distinct_paragraphs,
                MIN(edge.text_offset) AS first_offset
         FROM edge
         JOIN case_doc ON case_doc.id = edge.case_id
         WHERE edge.cited_key IN (${placeholders})
           ${citedParagraph === null ? "" : "AND instr(',' || edge.pinpoints || ',', ?) > 0"}
         GROUP BY edge.case_id`,
      )
      .all(...keys, ...(citedParagraph === null ? [] : [`,par${citedParagraph},`])) as Row[])
      .filter((group) => matchesCourt(group.court, courtScope, courtCode));
    const byNewest = (left: Row, right: Row) =>
      (left.date === null ? 1 : 0) - (right.date === null ? 1 : 0) ||
      String(right.date ?? "").localeCompare(String(left.date ?? "")) ||
      Number(left.case_id) - Number(right.case_id);
    groups.sort((left, right) =>
      sort === "most_discussed"
        ? Number(right.occurrences) - Number(left.occurrences) ||
          Number(right.distinct_paragraphs) - Number(left.distinct_paragraphs) ||
          (courtLevel(String(right.court ?? ""))?.level ?? 0) -
            (courtLevel(String(left.court ?? ""))?.level ?? 0) ||
          byNewest(left, right)
        : byNewest(left, right),
    );
    // The page is capped; the count must not be. A note-up that reports its
    // page size as the answer understates how many citing cases matched.
    const total = groups.length;
    const firstOccurrence = database.prepare(
      `SELECT cited_citation, paragraph, pinpoints, excerpt
       FROM edge WHERE case_id = ? AND text_offset = ?`,
    );
    const entries = groups.slice(0, wanted).map((group) => {
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
        distinctParagraphs: Number(group.distinct_paragraphs),
        courtLevel: courtLevel(group.court as string | null)?.level ?? null,
        citedAs: String(first.cited_citation),
        pinpoints: (first.pinpoints as string | null) ?? null,
        excerpt: String(first.excerpt),
      };
    });
    let provider: NoteUpResult["provider"] = null;
    if (citedParagraph === null && hasProviderEdges(database)) {
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
    return {
      total,
      entries,
      ...(citedParagraph === null ? {} : { citedParagraph }),
      provider,
    };
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
  pageLabel: string | null;
  /** sha256 of `text`, for rendering receipts */
  spanSha256: string;
  /** journal_commentary.sqlite article id (public_endpoint.db space) for
   * commentary candidates — the identifier public_legal_source_fetch
   * (provider "journal") accepts so an agent can pull the article this
   * characterization is drawn from. Null for case candidates. */
  sourceArticleId: string | null;
  /** the citing case's own URL (case_doc.url) for case candidates — the
   * identifier a2aj_fetch can re-pull. Null for commentary candidates. */
  citingUrl: string | null;
};

export type NoteUpAnalysis = {
  citation: string;
  /** distinct citing cases in the edge graph (all, not just considered) */
  totalCiters: number;
  judicialDiscussion: StandsForCandidate[];
  /** null means the journal index is not installed; [] means no match */
  journalAnalysis: StandsForCandidate[] | null;
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
function commentaryCandidates(keys: string[], citedParagraph: number | null): {
  considered: number;
  rejected: number;
  usable: Array<StandsForCandidate & { occurrences: number }>;
} | null {
  const placeholders = keys.map(() => "?").join(", ");
  return withReadonlySqlite(journalCommentaryPath(), (database) => {
    const rows = database
      .prepare(
        `SELECT note.proposition, note.ref_page_label AS page_label,
                article.citation, article.name,
                article.date, article.journal_name, article.article_id,
                article.url
         FROM note_citation
         JOIN note ON note.id = note_citation.note_id
         JOIN article ON article.article_id = note.article_id
         WHERE note_citation.cited_key IN (${placeholders})
           AND note_citation.rank = 1
           AND note.pair_status = 'paired'
           AND note.proposition IS NOT NULL
           ${citedParagraph === null ? "" : "AND instr(',' || note_citation.pinpoints || ',', ?) > 0"}
         ORDER BY (article.date IS NULL), article.date DESC, note.id
         LIMIT ?`,
      )
      .all(
        ...keys,
        ...(citedParagraph === null ? [] : [`,par${citedParagraph},`]),
        STANDS_FOR_CONSIDERED,
      ) as Row[];
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
        pageLabel: (row.page_label as string | null) ?? null,
        spanSha256: createHash("sha256")
          .update(proposition, "utf8")
          .digest("hex"),
        sourceArticleId:
          row.article_id == null ? null : String(row.article_id),
        citingUrl: (row.url as string | null) ?? null,
        occurrences: 1,
      });
    }
    return { considered: rows.length, rejected, usable };
  });
}

/** Exact explanatory passages, kept in separate judicial and journal lanes. */
export function noteUpAnalysis(args: {
  citation: string;
  size?: number;
  citedParagraph?: number;
  courtScope?: NoteUpCourtScope;
  courtCode?: string;
}): NoteUpAnalysis | null {
  const key = citationLookupKey(args.citation);
  const cap = Math.max(1, Math.min(24, Math.trunc(args.size ?? 8)));
  const courtScope = args.courtScope ?? "all";
  const courtCode = args.courtCode?.trim().toUpperCase() || null;
  const citedParagraph = args.citedParagraph === undefined
    ? null
    : Math.trunc(args.citedParagraph);
  if (citedParagraph !== null && citedParagraph < 1) {
    throw new Error("cited_paragraph must be a positive integer");
  }
  if (courtCode && courtScope !== "all") {
    throw new Error("court_code cannot be combined with a non-all court_scope");
  }
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
    // The first occurrence's paragraph/excerpt ride the MIN() row rather than
    // being re-fetched per group. SQLite's documented bare-column rule gives
    // every non-aggregated column the value from the row that produced the
    // single min()/max(), and (case_id, text_offset) is unique across `edge`,
    // so the row is the same one the old per-group lookup found. That lookup
    // had no index to sit on - `edge` is indexed on (cited_key) and (case_id)
    // only - so each of the 300 probes walked ~15 sibling edge rows, dragging
    // each one's ~600-char excerpt off disk to keep one. Measured on the 40
    // most-cited keys: 63.1ms -> 36.8ms of query time per profile.
    const groups = database
      .prepare(
        `SELECT case_doc.citation, case_doc.name, case_doc.court, case_doc.date,
                case_doc.id AS case_id, case_doc.url,
                COUNT(*) AS occurrences, MIN(edge.text_offset) AS first_offset,
                edge.paragraph AS first_paragraph, edge.excerpt AS first_excerpt
         FROM edge
         JOIN case_doc ON case_doc.id = edge.case_id
         WHERE edge.cited_key IN (${placeholders})
           ${citedParagraph === null ? "" : "AND instr(',' || edge.pinpoints || ',', ?) > 0"}
         GROUP BY edge.case_id
         ORDER BY (case_doc.date IS NULL), case_doc.date DESC, case_doc.id
         LIMIT ?`,
      )
      .all(
        ...keys,
        ...(citedParagraph === null ? [] : [`,par${citedParagraph},`]),
        STANDS_FOR_CONSIDERED,
      )
      .filter((group) => matchesCourt(group.court, courtScope, courtCode)) as Row[];
    let authorityList = 0;
    let insufficient = 0;
    const usable: Array<StandsForCandidate & { occurrences: number }> = [];
    for (const group of groups) {
      const verdict = classifyCitatorExcerpt(String(group.first_excerpt));
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
        paragraph:
          group.first_paragraph === null ? null : Number(group.first_paragraph),
        pageLabel: null,
        spanSha256: createHash("sha256")
          .update(verdict.proseWindow, "utf8")
          .digest("hex"),
        sourceArticleId: null,
        citingUrl: (group.url as string | null) ?? null,
        occurrences: Number(group.occurrences),
      });
    }
    const commentary = commentaryCandidates(keys, citedParagraph);
    const byDate = (
      a: (typeof usable)[number],
      b: (typeof usable)[number],
    ) =>
      (a.citingDate === null ? 1 : 0) - (b.citingDate === null ? 1 : 0) ||
      (b.citingDate ?? "").localeCompare(a.citingDate ?? "");
    const strip = ({ occurrences: _occurrences, ...candidate }:
      StandsForCandidate & { occurrences: number }) => candidate;
    const judicialDiscussion = usable
      .sort((a, b) =>
        (b.citingLevel ?? 0) - (a.citingLevel ?? 0) ||
        b.occurrences - a.occurrences || byDate(a, b))
      .slice(0, cap)
      .map(strip);
    const journalAnalysis = commentary
      ? commentary.usable.sort(byDate).slice(0, cap).map(strip)
      : null;
    return {
      citation: args.citation,
      totalCiters,
      judicialDiscussion,
      journalAnalysis,
      excerptsConsidered: groups.length,
      excerptsRejected: { authorityList, insufficient },
      commentary: commentary
        ? { considered: commentary.considered, rejected: commentary.rejected }
        : null,
    };
  });
}
