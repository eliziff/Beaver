/**
 * Passage-level retrieval over the local legal bulk stores.
 *
 * Replaces the four measured defects of the document-level path
 * (`searchLocalA2AJ`) that the LegalBench-RAG bed exposed (Stage 14/15,
 * docs/legal-grounding-experiments-2026-07-30.md): a 12-token query cap
 * that discarded the question, AND-conjunction that zeroed a document
 * for one absent token, whole-document bm25 with no passage ranking,
 * and a snippet window anchored at the first token hit (usually the
 * header). Design follows the canonical lexical rung: boundary-aware
 * chunking with exact char offsets, OR-semantics bm25 over passages,
 * and document name/citation fields carried on every passage row so a
 * query that names its document boosts that document's passages via
 * bm25 column weights. `rrfFuse` is the standing fusion point for a
 * future dense lane (hybrid BM25+dense with reciprocal rank fusion).
 *
 * The index is a DERIVED sidecar sqlite next to the source db (the
 * provider db is never written), keyed by chunk parameters; build once,
 * query many (local-data-stores doctrine). Every returned passage is a
 * VERBATIM slice of the source document text: `text.slice(start, end)`
 * — consumers get exact coordinates and never re-locate by search.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type ChunkSpan = { start: number; end: number };

export type ChunkOptions = {
  /** Target chunk size in chars (soft; breaks prefer structure). */
  target?: number;
  /** Chars of tail overlap carried into the next chunk. */
  overlap?: number;
};

const chunkDefaults = { target: 1000, overlap: 120 };

/**
 * Boundary-aware chunker (recursive-splitter family): break preferences
 * paragraph gap > newline > sentence end > word gap > hard cut, chosen
 * within [start + target/2, start + target]. Invariants (unit-tested):
 * spans cover the text, starts strictly increase, every span is a
 * verbatim slice, overlap never exceeds the configured tail.
 */
export function chunkText(text: string, options?: ChunkOptions): ChunkSpan[] {
  const target = Math.max(200, options?.target ?? chunkDefaults.target);
  const overlap = Math.min(
    Math.max(0, options?.overlap ?? chunkDefaults.overlap),
    Math.floor(target / 4),
  );
  const spans: ChunkSpan[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(text.length, start + target);
    const end =
      hardEnd >= text.length
        ? hardEnd
        : (structuralBreak(text, start + Math.floor(target / 2), hardEnd) ??
          hardEnd);
    spans.push({ start, end });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return spans;
}

function structuralBreak(text: string, from: number, to: number) {
  const window = text.slice(from, to);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= 0) return from + paragraph + 2;
  const line = window.lastIndexOf("\n");
  if (line >= 0) return from + line + 1;
  const sentence = window.search(/[.!?]["')\]]?\s(?!.*[.!?]["')\]]?\s)/su);
  if (sentence >= 0) {
    const match = /[.!?]["')\]]?\s/su.exec(window.slice(sentence));
    if (match) return from + sentence + match[0].length;
  }
  const word = window.lastIndexOf(" ");
  if (word >= 0) return from + word + 1;
  return null;
}

/** Minimal function-word set; bm25 already downweights common terms —
 * this only trims degenerate OR fan-out on natural-language queries. */
const STOPWORDS = new Set(
  "a an and are as at be by for in is it its of on or that the this to was were with".split(
    " ",
  ),
);

export function passageQueryTokens(query: string): string[] {
  const tokens =
    query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  return [
    ...new Set(
      tokens.filter((token) => token.length >= 2 && !STOPWORDS.has(token)),
    ),
  ].slice(0, 32);
}

/**
 * Reciprocal rank fusion over ranked lists keyed by item id:
 * score(d) = Σ 1/(k + rank_i(d)). Rank-based, so incompatible score
 * scales (bm25 vs cosine) fuse cleanly. The standing plug-point for a
 * dense lane; also usable to fuse AND- and OR-lane lexical runs.
 */
export function rrfFuse<T>(
  lists: Array<Array<{ id: string; item: T }>>,
  k = 60,
): Array<{ id: string; item: T; score: number }> {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach(({ id, item }, rank) => {
      const entry = scores.get(id) ?? { item, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scores.set(id, entry);
    });
  }
  return [...scores.entries()]
    .map(([id, { item, score }]) => ({ id, item, score }))
    .sort((left, right) => right.score - left.score);
}

export type PassageIndexOptions = ChunkOptions & {
  sourceDb: string;
  /** Sidecar path; defaults beside the source keyed by chunk params. */
  indexDb?: string;
  docType?: "cases" | "laws";
};

function paramsKey(options: PassageIndexOptions) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        target: options.target ?? chunkDefaults.target,
        overlap: options.overlap ?? chunkDefaults.overlap,
        docType: options.docType ?? null,
        v: 1,
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

export function passageIndexPath(options: PassageIndexOptions) {
  return (
    options.indexDb ?? `${options.sourceDb}.passages-${paramsKey(options)}.sqlite`
  );
}

/**
 * Build (or reuse) the derived passage index. Reads the source db
 * read-only; writes only the sidecar. Idempotent per parameter set.
 */
export function ensurePassageIndex(options: PassageIndexOptions): {
  indexDb: string;
  passages: number;
  documents: number;
  built: boolean;
} {
  const indexDb = passageIndexPath(options);
  if (existsSync(indexDb)) {
    const existing = new DatabaseSync(indexDb, { readOnly: true });
    try {
      const meta = existing
        .prepare("SELECT value FROM meta WHERE key = 'params'")
        .get() as { value?: string } | undefined;
      const counts = existing
        .prepare(
          "SELECT COUNT(*) AS passages, COUNT(DISTINCT doc_id) AS documents FROM passage",
        )
        .get() as { passages: number; documents: number };
      if (meta?.value === paramsKey(options))
        return { indexDb, built: false, ...counts };
    } catch {
      // Corrupt or foreign sidecar: rebuild below.
    } finally {
      existing.close();
    }
  }
  const source = new DatabaseSync(options.sourceDb, { readOnly: true });
  const index = new DatabaseSync(indexDb);
  try {
    index.exec("PRAGMA journal_mode = WAL");
    index.exec("DROP TABLE IF EXISTS passage");
    index.exec("DROP TABLE IF EXISTS passage_search");
    index.exec("DROP TABLE IF EXISTS meta");
    index.exec(
      "CREATE TABLE passage (id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, language TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL)",
    );
    index.exec(
      "CREATE VIRTUAL TABLE passage_search USING fts5(text, name, citation, tokenize='unicode61')",
    );
    index.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    const filters = options.docType ? "WHERE doc_type = ?" : "";
    const rows = source
      .prepare(
        `SELECT id, doc_type, citation_en, citation_fr, name_en, name_fr,
                unofficial_text_en, unofficial_text_fr
         FROM document ${filters}`,
      )
      .all(...(options.docType ? [options.docType] : [])) as Array<
      Record<string, unknown>
    >;
    const insertPassage = index.prepare(
      "INSERT INTO passage (doc_id, language, start, end) VALUES (?, ?, ?, ?)",
    );
    const insertSearch = index.prepare(
      "INSERT INTO passage_search (rowid, text, name, citation) VALUES (?, ?, ?, ?)",
    );
    let passages = 0;
    let documents = 0;
    index.exec("BEGIN");
    for (const row of rows) {
      let counted = false;
      for (const language of ["en", "fr"] as const) {
        const text = row[`unofficial_text_${language}`];
        if (typeof text !== "string" || !text.trim()) continue;
        const name = [row[`name_${language}`], row[`citation_${language}`]]
          .filter((value) => typeof value === "string" && value)
          .join(" ");
        const citation =
          typeof row[`citation_${language}`] === "string"
            ? (row[`citation_${language}`] as string)
            : "";
        if (!counted) {
          documents += 1;
          counted = true;
        }
        for (const span of chunkText(text, options)) {
          const result = insertPassage.run(
            row.id as number,
            language,
            span.start,
            span.end,
          );
          insertSearch.run(
            result.lastInsertRowid as number,
            text.slice(span.start, span.end),
            name,
            citation,
          );
          passages += 1;
        }
      }
    }
    index
      .prepare("INSERT INTO meta (key, value) VALUES ('params', ?)")
      .run(paramsKey(options));
    index.exec("COMMIT");
    return { indexDb, passages, documents, built: true };
  } finally {
    source.close();
    index.close();
  }
}

export type PassageHit = {
  docId: number;
  citation: string;
  name: string | null;
  language: "en" | "fr";
  start: number;
  end: number;
  /** Verbatim `documentText.slice(start, end)`. */
  text: string;
  rank: number;
};

export type PassageSearchOptions = {
  sourceDb: string;
  query: string;
  indexDb?: string;
  docType?: "cases" | "laws";
  language?: "en" | "fr";
  k?: number;
  /** bm25 weight on the document name/citation columns (text = 1). */
  nameWeight?: number;
  /** Max passages returned per document (diversity cap). */
  perDocCap?: number;
} & ChunkOptions;

/** OR-semantics weighted-bm25 passage search over the derived index. */
export function searchPassages(options: PassageSearchOptions): PassageHit[] {
  const tokens = passageQueryTokens(options.query);
  if (!tokens.length) return [];
  const { indexDb } = ensurePassageIndex(options);
  const k = Math.max(1, Math.min(50, options.k ?? 8));
  const nameWeight = options.nameWeight ?? 4;
  const perDocCap = Math.max(1, options.perDocCap ?? 2);
  const language = options.language ?? "en";
  const match = tokens.map((token) => `"${token}"*`).join(" OR ");
  const index = new DatabaseSync(indexDb, { readOnly: true });
  const source = new DatabaseSync(options.sourceDb, { readOnly: true });
  try {
    const rows = index
      .prepare(
        `SELECT passage.doc_id, passage.language, passage.start, passage.end,
                passage_search.citation, passage_search.name,
                bm25(passage_search, 1.0, ?, ?) AS score
         FROM passage_search
         JOIN passage ON passage.id = passage_search.rowid
         WHERE passage_search MATCH ? AND passage.language = ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(nameWeight, nameWeight, match, language, k * perDocCap * 4) as Array<
      Record<string, unknown>
    >;
    const perDoc = new Map<number, number>();
    const hits: PassageHit[] = [];
    const textStmt = source.prepare(
      `SELECT unofficial_text_${language} AS text FROM document WHERE id = ?`,
    );
    for (const row of rows) {
      if (hits.length >= k) break;
      const docId = row.doc_id as number;
      const used = perDoc.get(docId) ?? 0;
      if (used >= perDocCap) continue;
      const doc = textStmt.get(docId) as { text?: string } | undefined;
      if (typeof doc?.text !== "string") continue;
      perDoc.set(docId, used + 1);
      hits.push({
        docId,
        citation: String(row.citation ?? ""),
        name: row.name ? String(row.name) : null,
        language,
        start: row.start as number,
        end: row.end as number,
        text: doc.text.slice(row.start as number, row.end as number),
        rank: hits.length,
      });
    }
    return hits;
  } finally {
    index.close();
    source.close();
  }
}
