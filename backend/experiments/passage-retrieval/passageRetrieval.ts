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
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  deriveDocumentNative,
  documentAnchorsNative,
  documentTextNative,
  type NativeDocument,
} from "../../src/lib/structureNative";

export type ChunkSpan = { start: number; end: number };

export type ChunkOptions = {
  /** Target chunk size in chars (soft; breaks prefer structure). */
  target?: number;
  /** Chars of tail overlap carried into the next chunk. */
  overlap?: number;
  /** "chars": boundary-preferring character windows. "clause": spans
   * snap to clause/section starts (the skeleton doctrine — retrieval
   * unit = citable unit), packing whole clauses up to target. */
  mode?: "chars" | "clause";
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

/**
 * Skeleton-aligned chunking: every span STARTS at a clause boundary
 * (or 0); whole clauses pack greedily up to `target`; a single clause
 * longer than 2×target subdivides with the character chunker. No
 * overlap — clause units don't straddle, so boundary overlap has
 * nothing to recover.
 */
export async function clauseChunkText(
  text: string,
  options?: ChunkOptions,
): Promise<ChunkSpan[]> {
  const document = await deriveDocumentNative({
    kind: "instrument", id: "passage", text,
    reconstruct_lineation: true, source_doc: true,
  });
  return structuralChunkText(document, options, "section");
}

function structuralChunkText(
  doc: NativeDocument,
  options: ChunkOptions | undefined,
  kind: "paragraph" | "section",
): ChunkSpan[] {
  const text = documentTextNative(doc);
  const blocks = documentAnchorsNative(doc);
  const target = Math.max(200, options?.target ?? chunkDefaults.target);
  const starts = [
    ...new Set([
      0,
      ...blocks
        .filter((block) => block.kind === kind)
        .map((block) => block.start),
    ]),
  ].sort((left, right) => left - right);
  if (starts.length < 3) return chunkText(text, options);
  const spans: ChunkSpan[] = [];
  let chunkStart = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const clauseEnd = starts[index + 1] ?? text.length;
    if (clauseEnd - chunkStart >= target || clauseEnd === text.length) {
      if (clauseEnd - chunkStart > target * 2) {
        // Flush what precedes, then subdivide the oversized clause.
        if (starts[index] > chunkStart)
          spans.push({ start: chunkStart, end: starts[index] });
        const clauseStart = Math.max(chunkStart, starts[index]);
        for (const sub of chunkText(
          text.slice(clauseStart, clauseEnd),
          { target, overlap: 0 },
        ))
          spans.push({
            start: clauseStart + sub.start,
            end: clauseStart + sub.end,
          });
      } else {
        spans.push({ start: chunkStart, end: clauseEnd });
      }
      chunkStart = clauseEnd;
    }
  }
  return spans.filter((span) => span.end > span.start);
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
 * Adjacent content-word pairs of the query, for FTS5 phrase terms
 * ("change of control" queries reward passages containing the phrase,
 * not just the scattered words). Pairs must be adjacent in the ORIGINAL
 * query — pairing the stopword-filtered token stream would fabricate
 * phrases ("party allowed" from "party is allowed") that the corpus
 * never contains.
 */
export function passageQueryPhrases(query: string): string[] {
  const words =
    query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  const phrases: string[] = [];
  for (let i = 0; i + 1 < words.length; i += 1) {
    const [a, b] = [words[i], words[i + 1]];
    if (a.length < 2 || b.length < 2 || STOPWORDS.has(a) || STOPWORDS.has(b))
      continue;
    phrases.push(`${a} ${b}`);
  }
  return [...new Set(phrases)].slice(0, 16);
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
  /** Offline LLM-written situating headers (contextual-retrieval
   * pattern), JSONL rows {doc_id, language, start, end, header} keyed
   * to THIS parameter set's chunk spans. When set, the header replaces
   * the regex heading path in the FTS `context` column (fallback:
   * heading path) and the sidecar is keyed by the file's content hash.
   * Unset = byte-identical params key to before this option existed. */
  contextJsonl?: string;
};

/**
 * Content digest of a context sidecar file, cached per (path, mtime,
 * size). `paramsKey` runs on EVERY searchPassages call — twice, once for
 * the sidecar path and once for the params comparison — so an uncached
 * digest re-read and re-hashed the whole enrichment file per query:
 * measured 3.12 ms per pass over a 2.5 MB headers file, 6.2 ms of every
 * 70.8 ms context-arm query, to recompute a constant. The stat guard
 * keeps the key content-addressed: a headers file rewritten between
 * calls changes size or mtime and is re-hashed.
 */
const contextDigests = new Map<
  string,
  { key: string; mtimeMs: number; size: number }
>();

function contextDigest(file: string): string {
  const stats = statSync(file);
  const cached = contextDigests.get(file);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size)
    return cached.key;
  const key = createHash("sha256")
    .update(readFileSync(file))
    .digest("hex")
    .slice(0, 12);
  contextDigests.set(file, { key, mtimeMs: stats.mtimeMs, size: stats.size });
  return key;
}

function paramsKey(options: PassageIndexOptions) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        target: options.target ?? chunkDefaults.target,
        overlap: options.overlap ?? chunkDefaults.overlap,
        docType: options.docType ?? null,
        mode: options.mode ?? "chars",
        v: 4,
        ...(options.contextJsonl
          ? { ctx: contextDigest(options.contextJsonl) }
          : {}),
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

/** Enrichment headers keyed by passage coordinates. */
function loadContextHeaders(
  contextJsonl: string | undefined,
): Map<string, string> {
  const headers = new Map<string, string>();
  if (!contextJsonl) return headers;
  for (const line of readFileSync(contextJsonl, "utf8")
    .split("\n")
    .filter(Boolean)) {
    const row = JSON.parse(line) as {
      doc_id: number;
      language: string;
      start: number;
      end: number;
      header?: string;
      error?: string;
    };
    if (row.error || !row.header) continue;
    headers.set(
      `${row.doc_id}|${row.language}|${row.start}|${row.end}`,
      row.header,
    );
  }
  return headers;
}

export function passageIndexPath(options: PassageIndexOptions) {
  return (
    options.indexDb ?? `${options.sourceDb}.passages-${paramsKey(options)}.sqlite`
  );
}

/**
 * True for a TRANSIENT sqlite contention failure — another connection
 * held the lock — as opposed to a damaged or foreign database file.
 *
 * node:sqlite raises `Error { code: "ERR_SQLITE_ERROR", errcode, errstr }`;
 * `errcode` is the extended result code, whose low byte is the primary
 * code (SQLITE_BUSY = 5, so 261 = SQLITE_BUSY_RECOVERY and 517 =
 * SQLITE_BUSY_SNAPSHOT all classify here; SQLITE_LOCKED = 6 is the
 * same-process form and is equally transient). Message matching is the
 * fallback for wrapped errors that lost the numeric field.
 *
 * The distinction is load-bearing: `ensurePassageIndex` treats an
 * unreadable sidecar as corruption and reindexes from scratch, so
 * misreading a one-off "database is locked" as corruption destroys and
 * rebuilds a perfectly healthy index (observed twice on 2026-07-31; on
 * the 5.5 GB product corpus that is hours of work thrown away).
 */
export function isSqliteLockError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { errcode, message } = error as {
    errcode?: unknown;
    message?: unknown;
  };
  if (typeof errcode === "number") {
    const primary = errcode & 0xff;
    return primary === 5 || primary === 6;
  }
  return (
    typeof message === "string" &&
    /\bdatabase (?:table )?is locked\b/iu.test(message)
  );
}

/**
 * Build (or reuse) the derived passage index. Reads the source db
 * read-only; writes only the sidecar. Idempotent per parameter set.
 */
export async function ensurePassageIndex(options: PassageIndexOptions): Promise<{
  indexDb: string;
  passages: number;
  documents: number;
  built: boolean;
}> {
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
    } catch (error) {
      // A concurrent reader/writer makes this probe fail TRANSIENTLY
      // (SQLITE_BUSY). That is not corruption, and falling through would
      // DROP the tables and reindex a healthy sidecar — so rethrow and let
      // the caller retry. Only a genuinely unreadable (corrupt or foreign)
      // sidecar reaches the rebuild below.
      if (isSqliteLockError(error)) throw error;
    } finally {
      existing.close();
    }
  }
  const contextHeaders = loadContextHeaders(options.contextJsonl);
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
      "CREATE VIRTUAL TABLE passage_search USING fts5(text, name, citation, context, tokenize='unicode61')",
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
      "INSERT INTO passage_search (rowid, text, name, citation, context) VALUES (?, ?, ?, ?, ?)",
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
        const sourceKind = row.doc_type === "laws" || row.doc_type === "cases"
          ? row.doc_type : options.docType ?? "cases";
        const sourceDoc = await deriveDocumentNative({
          kind: "a2aj", source_doc: true,
          input: { citation, source_kind: sourceKind, text, name },
        });
        const spans =
          options.mode === "clause"
            ? structuralChunkText(
                sourceDoc,
                options,
                sourceKind === "laws" ? "section" : "paragraph",
              )
            : chunkText(text, options);
        for (const span of spans) {
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
            contextHeaders.get(
              `${row.id}|${language}|${span.start}|${span.end}`,
            ) ?? headingPath(sourceDoc, span.start),
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

/** Context comes from the same compiled structure that owns chunk joints. */
function headingPath(doc: NativeDocument, start: number): string {
  const text = documentTextNative(doc);
  return documentAnchorsNative(doc)
    .filter(
      (block) =>
        block.start <= start &&
        !block.parentLabel &&
        (block.kind === "section" || block.kind === "paragraph"),
    )
    .slice(-2)
    .map((block) => text.slice(block.start, block.end).trim().split(/\r?\n/u, 1)[0])
    .filter(Boolean)
    .map((line) => line.slice(0, 120))
    .join(" — ");
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
  /** bm25 weight on the heading-path context column (text = 1). */
  contextWeight?: number;
  /** Max passages returned per document (diversity cap). */
  perDocCap?: number;
  /** Add adjacent content-word pairs as FTS5 phrase OR-terms. */
  phrases?: boolean;
  /** See PassageIndexOptions.contextJsonl (selects/keys the sidecar). */
  contextJsonl?: string;
} & ChunkOptions;

/**
 * Apply the per-document diversity cap to a ranked list this module did
 * not produce (an injected/precomputed pool), then truncate to `k`.
 *
 * Same rule as the loop inside `searchPassages`: walk in rank order, skip
 * a passage once its document has contributed `perDocCap` of them, stop at
 * `k`. Exists so an arm that injects a pool is capped identically to an
 * arm that retrieves one — an injected pool that took `slice(0, k)` while
 * the lexical arm capped at 2 was the Stage 18 perDocCap confound, where
 * the cap alone can decide a maud cell (gold concentrates inside a single
 * 300 KB agreement).
 */
export function capHitsPerDoc<T extends { citation: string }>(
  hits: T[],
  perDocCap: number,
  k: number,
): T[] {
  const cap = Math.max(1, perDocCap);
  const used = new Map<string, number>();
  const kept: T[] = [];
  for (const hit of hits) {
    if (kept.length >= k) break;
    const seen = used.get(hit.citation) ?? 0;
    if (seen >= cap) continue;
    used.set(hit.citation, seen + 1);
    kept.push(hit);
  }
  return kept;
}

/** OR-semantics weighted-bm25 passage search over the derived index. */
export async function searchPassages(
  options: PassageSearchOptions,
): Promise<PassageHit[]> {
  const tokens = passageQueryTokens(options.query);
  if (!tokens.length) return [];
  const { indexDb } = await ensurePassageIndex(options);
  const k = Math.max(1, Math.min(50, options.k ?? 8));
  const nameWeight = options.nameWeight ?? 4;
  // Default 0 (column ignored): measured slightly NEGATIVE on
  // LegalBench (R@4 0.2865 -> 0.2763 at weight 2) where headings are
  // regex-guessed from plain text. Enable per-call where a real
  // skeleton supplies the heading path (product corpora).
  const contextWeight = options.contextWeight ?? 0;
  const perDocCap = Math.max(1, options.perDocCap ?? 2);
  const language = options.language ?? "en";
  const phraseTerms = options.phrases
    ? passageQueryPhrases(options.query).map((phrase) => `"${phrase}"`)
    : [];
  const match = [...tokens.map((token) => `"${token}"*`), ...phraseTerms].join(
    " OR ",
  );
  const index = new DatabaseSync(indexDb, { readOnly: true });
  const source = new DatabaseSync(options.sourceDb, { readOnly: true });
  try {
    // The ranked query carries NO fts5 content columns. An fts5 column read
    // materializes the whole stored row — the passage text and its context
    // header — so selecting citation/name here paid ~1.6 KB per candidate
    // over a candidate pool of k*perDocCap*4 (4608 rows at the crowned
    // config, nearly the whole 5,966-row mini index) to keep two short
    // strings for the <=k rows that survive the perDocCap filter. Measured
    // 50.4 -> 23.5 ms/query for the query alone, 81 -> 49 ms/query end to
    // end. The labels are fetched below, per surviving row, from the same
    // table — identical strings, so hits and ordering are unchanged.
    const rows = index
      .prepare(
        `SELECT passage.id, passage.doc_id, passage.language,
                passage.start, passage.end,
                bm25(passage_search, 1.0, ?, ?, ?) AS score
         FROM passage_search
         JOIN passage ON passage.id = passage_search.rowid
         WHERE passage_search MATCH ? AND passage.language = ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(
        nameWeight,
        nameWeight,
        contextWeight,
        match,
        language,
        k * perDocCap * 4,
      ) as Array<
      Record<string, unknown>
    >;
    const labelStmt = index.prepare(
      "SELECT citation, name FROM passage_search WHERE rowid = ?",
    );
    const perDoc = new Map<number, number>();
    const hits: PassageHit[] = [];
    const textStmt = source.prepare(
      `SELECT unofficial_text_${language} AS text FROM document WHERE id = ?`,
    );
    // Document bodies are fetched once per call, not once per hit. Every hit
    // needs only its own ~1.6 KB slice, but the row carries the WHOLE
    // document: with perDocCap 24 over a 330 KB merger agreement, the
    // unmemoized path pulled the same body 24 times — ~16 MB allocated per
    // query to keep ~77 KB. Measured: it exhausted a 2 GB heap partway
    // through a 776-query sweep. Pure memo, so hits and ordering are
    // unchanged; the cache dies with the call, so nothing can go stale.
    const bodies = new Map<number, string | null>();
    const documentText = (docId: number): string | null => {
      const cached = bodies.get(docId);
      if (cached !== undefined) return cached;
      const row = textStmt.get(docId) as { text?: string } | undefined;
      const text = typeof row?.text === "string" ? row.text : null;
      bodies.set(docId, text);
      return text;
    };
    for (const row of rows) {
      if (hits.length >= k) break;
      const docId = row.doc_id as number;
      const used = perDoc.get(docId) ?? 0;
      if (used >= perDocCap) continue;
      const text = documentText(docId);
      if (text === null) continue;
      const doc = { text };
      perDoc.set(docId, used + 1);
      const label = labelStmt.get(row.id as number) as
        | { citation?: unknown; name?: unknown }
        | undefined;
      hits.push({
        docId,
        citation: String(label?.citation ?? ""),
        name: label?.name ? String(label.name) : null,
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
