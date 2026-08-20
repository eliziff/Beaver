/**
 * Product passage lane over the local A2AJ bulk store: the entry point
 * that puts `passageRetrieval` on the search path without touching the
 * document-level lane (`searchLocalA2AJ` is unchanged).
 *
 * Two lanes, deterministic first. A citation short-circuit resolves
 * citation-shaped substrings of the query through `citation_lookup` —
 * widened by the citator's resolution evidence, so a query citing the
 * French twin or a parallel reporter cite reaches the same decision —
 * and PREPENDS those documents' best passages ahead of the bm25 ranking:
 * an exact identity match beats a ranked guess. The ranked lane is
 * `searchPassages` (OR-semantics weighted bm25, verbatim char offsets).
 *
 * An optional third stage reranks the pooled candidates with one
 * listwise model call (`rerankPassages`); it only reorders verbatim
 * slices and degrades to lexical order on failure, which is why this
 * entry point is async even though both retrieval lanes are sync.
 *
 * The derived sidecar is NEVER built inline: the product db is
 * 5.5 GB-scale and a build would hang a user request. A missing sidecar
 * is a typed refusal naming the build command, not a silent build.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { a2ajLocalBulkPath } from "../../src/lib/a2ajLocalBulk";
import { citationAliasKeysBatch } from "../../src/lib/caselawCitator";
import { citationLookupKey, citationsInText } from "../../src/lib/citationKey";
import { withReadonlySqlite } from "../../src/lib/legalDataPath";
import {
  passageIndexPath,
  passageQueryTokens,
  searchPassages,
  type PassageHit,
} from "./passageRetrieval";
import { rerankPassages } from "./retrievalRerank";

type Row = Record<string, unknown>;
type Language = "en" | "fr";
type DocType = "cases" | "laws";
type ChunkMode = "chars" | "clause";

/** Chunk parameters of the product sidecar; shared with the builder
 * script so query and build agree on the sidecar identity. */
export const A2AJ_PASSAGE_TARGET = 1600;
export const A2AJ_PASSAGE_OVERLAP = 120;

export class MissingPassageIndexError extends Error {
  constructor(
    readonly sourceDb: string,
    readonly indexDb: string,
    readonly command: string,
  ) {
    super(
      `passage index not built for ${sourceDb} (expected ${indexDb}); run: ${command}`,
    );
    this.name = "MissingPassageIndexError";
  }
}

export type A2AJPassageResult = {
  docId: number;
  citation: string;
  name: string | null;
  date: string | null;
  url: string | null;
  dataset: string;
  /** Verbatim `documentText.slice(start, end)`. */
  passage: { text: string; start: number; end: number };
};

function buildCommand(sourceDb: string, docType?: DocType, mode?: ChunkMode) {
  return [
    "npx tsx experiments/passage-retrieval/build-passage-index.ts",
    `--db "${sourceDb}"`,
    `--target ${A2AJ_PASSAGE_TARGET}`,
    `--overlap ${A2AJ_PASSAGE_OVERLAP}`,
    ...(docType ? [`--doc-type ${docType}`] : []),
    ...(mode ? [`--mode ${mode}`] : []),
  ].join(" ");
}

function indexOptionsFor(args?: { docType?: DocType; mode?: ChunkMode }) {
  return {
    sourceDb: a2ajLocalBulkPath(),
    target: A2AJ_PASSAGE_TARGET,
    overlap: A2AJ_PASSAGE_OVERLAP,
    docType: args?.docType,
    mode: args?.mode,
  };
}

function string(row: Row, field: string) {
  const value = row[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function languageField(row: Row, field: string, language: Language) {
  return (
    string(row, `${field}_${language}`) ??
    string(row, `${field}_${language === "en" ? "fr" : "en"}`)
  );
}

/**
 * Citation-shaped substrings of a natural-language query come from the
 * shared detector (`citationsInText`). The whole query and its
 * comma/semicolon fragments are tried too, so a query that IS a citation
 * ("RSA 2000, c A-4.2") resolves without a shape rule for every reporter.
 */
function citationKeys(query: string) {
  const fragments = [
    query,
    ...query.split(/[,;]/u),
    ...citationsInText(query).map(({ text }) => text),
  ];
  const candidates: Array<{ text: string; key: string }> = [];
  for (const fragment of fragments) {
    const trimmed = fragment.trim();
    if (trimmed.length < 6) continue;
    const key = citationLookupKey(trimmed);
    if (key) candidates.push({ text: trimmed, key });
  }
  // Alias expansion through the citator's resolution evidence: the
  // French twin and parallel reporter cites of the SAME decision, only
  // where that evidence is unambiguous. No citator graph installed (or
  // an ambiguous key) degrades to the literal key alone. Batched: the
  // per-citation call opens and closes the 2.3 GB graph each time, and
  // one query offers ~7 citation-shaped fragments (13.76 -> 2.17 ms).
  const aliases = citationAliasKeysBatch(candidates.map((c) => c.text));
  const keys = new Set<string>();
  candidates.forEach((candidate, index) => {
    keys.add(candidate.key);
    for (const alias of aliases[index]) keys.add(alias);
  });
  return [...keys];
}

/** The bm25 side of the query: everything the citation short-circuit
 * already consumed is blanked out, so the ranked lane scores the prose. */
function residualTokens(query: string) {
  let residual = query;
  for (const { start, end } of citationsInText(query).reverse()) {
    residual = `${residual.slice(0, start)} ${residual.slice(end)}`;
  }
  return passageQueryTokens(residual);
}

function citationDocIds(
  source: DatabaseSync,
  keys: string[],
  docType?: DocType,
) {
  if (!keys.length) return [];
  const filters = [`lookup.citation_key IN (${keys.map(() => "?").join(", ")})`];
  const values: string[] = [...keys];
  if (docType) {
    filters.push("document.doc_type = ?");
    values.push(docType);
  }
  return (
    source
      .prepare(
        `SELECT document.id AS id
         FROM citation_lookup AS lookup
         JOIN document ON document.id = lookup.document_id
         WHERE ${filters.join(" AND ")}
         ORDER BY document.id
         LIMIT 8`,
      )
      .all(...values) as Row[]
  ).map((row) => row.id as number);
}

/** Best passage inside one already-resolved document: top bm25 passage
 * on the text column for the non-citation part of the query, else the
 * document's first chunk. */
function bestPassage(
  index: DatabaseSync,
  docId: number,
  language: Language,
  tokens: string[],
) {
  if (tokens.length) {
    const row = index
      .prepare(
        `SELECT passage.start, passage.end
         FROM passage_search
         JOIN passage ON passage.id = passage_search.rowid
         WHERE passage_search MATCH ? AND passage.doc_id = ?
           AND passage.language = ?
         ORDER BY bm25(passage_search, 1.0, 0.0, 0.0, 0.0)
         LIMIT 1`,
      )
      .get(tokens.map((token) => `"${token}"*`).join(" OR "), docId, language) as
      | Row
      | undefined;
    if (row) return row as { start: number; end: number };
  }
  return index
    .prepare(
      "SELECT start, end FROM passage WHERE doc_id = ? AND language = ? ORDER BY start LIMIT 1",
    )
    .get(docId, language) as { start: number; end: number } | undefined;
}

export async function searchLocalA2AJPassages(args: {
  query: string;
  docType?: DocType;
  language?: Language;
  size?: number;
  /** Chunking of the sidecar to query; part of its identity, so a
   * clause-mode query needs a clause-mode build. Default "chars". */
  mode?: ChunkMode;
  /** bm25 weight on the document name/citation columns (text = 1). */
  nameWeight?: number;
  /** Widen the returned candidate pool to this many hits for a
   * downstream `rerankPassages` call, which cuts back to `size`. */
  rerankHits?: number;
  /** Max hits credited to any one document — the diversity policy. Low
   * spreads results across documents (corpus-wide search); high keeps the
   * best passages wherever they fall (document-scoped grounding). Defaults
   * to 2, or 24 when reranking. */
  perDocCap?: number;
  /** Listwise LLM rerank over a widened pool, cut back to `size`.
   * Defaults to MIKE_RETRIEVAL_RERANK_MODEL when set. Rerank failures
   * degrade to lexical order inside `rerankPassages`. */
  rerank?: { model: string };
}): Promise<A2AJPassageResult[]> {
  const query = args.query.trim();
  if (!query) throw new Error("query is required");
  const sourceDb = a2ajLocalBulkPath();
  if (!existsSync(sourceDb))
    throw new Error(`A2AJ bulk database not found at ${sourceDb}`);
  const language = args.language === "fr" ? "fr" : "en";
  const size = Math.max(1, Math.min(50, Math.trunc(args.size ?? 8)));
  const rerankModel =
    args.rerank?.model ?? process.env.MIKE_RETRIEVAL_RERANK_MODEL?.trim();
  // Reranking earns a wide pool with a loose per-document cap: the model
  // is the one that judges document diversity, not the bm25 cap.
  const wanted = rerankModel
    ? Math.max(48, size * 8)
    : Math.max(size, Math.min(50, Math.trunc(args.rerankHits ?? size)));
  // Max hits per document. Spelled out here because it used to be
  // `rerankModel ? 24 : undefined`, which meant you could not change
  // reranking without also changing document diversity — a confound sitting
  // under every rerank measurement this codebase has taken.
  //
  // UNVERIFIED DEFAULT, stated honestly: 24 (reranked) is deliberate — the
  // reranker judges diversity, so bm25 should not. The un-reranked 2 is NOT
  // a considered search policy; it is `searchPassages`' own `?? 2`, which
  // entered in 3997cf12 with the *benchmark ablation harness* and carries no
  // rationale, unlike every other default in that function. Preserved here
  // only so this refactor changes no behaviour.
  //
  // It is very likely wrong for corpus-wide search, and it is NOT safe to
  // copy the benchmark's answer: on LegalBench-RAG uncapping takes maud
  // lexical recall 0.0210 -> 0.1672 at k=6, but only because every query
  // there names its one gold document, so gold is concentrated by
  // construction. Corpus-wide search over 225k documents plausibly wants the
  // opposite. Owed: a real measurement on a text-bearing product corpus (the
  // local A2AJ store is metadata_only, so this cannot be measured today).
  const perDocCap = args.perDocCap ?? (rerankModel ? 24 : 2);
  const indexOptions = {
    sourceDb,
    target: A2AJ_PASSAGE_TARGET,
    overlap: A2AJ_PASSAGE_OVERLAP,
    docType: args.docType,
    mode: args.mode,
  };
  const indexDb = passageIndexPath(indexOptions);
  if (!existsSync(indexDb))
    throw new MissingPassageIndexError(
      sourceDb,
      indexDb,
      buildCommand(sourceDb, args.docType, args.mode),
    );

  const ranked = await searchPassages({
    ...indexOptions,
    query,
    language,
    k: wanted,
    nameWeight: args.nameWeight,
    perDocCap: perDocCap,
  });
  const pool =
    withReadonlySqlite(sourceDb, (source) => {
      const pinned = pinnedHits(source, indexDb, {
        query,
        language,
        docType: args.docType,
      });
      const seen = new Set<string>();
      const results: A2AJPassageResult[] = [];
      // Metadata is short strings, and the same document supplies many
      // hits (perDocCap 24 when reranking). `SELECT *` carried both
      // unofficial_text bodies, both section maps and both cases_cited
      // lists — hundreds of KB per hit — to keep a citation, a name, a
      // date and a URL; unmemoized, that whole payload came back once per
      // hit. Narrow columns + a per-call memo: same row, same values, so
      // results and ordering are unchanged, and the cache dies with the
      // call. Measured 158 -> 42 ms/query over 300 queries.
      const metadata = source.prepare(
        `SELECT citation_en, citation_fr, citation2_en, citation2_fr,
                name_en, name_fr, document_date_en, document_date_fr,
                url_en, url_fr, dataset
         FROM document WHERE id = ? LIMIT 1`,
      );
      const metadataById = new Map<number, Row | undefined>();
      const documentMetadata = (docId: number) => {
        if (metadataById.has(docId)) return metadataById.get(docId);
        const fetched = metadata.get(docId) as Row | undefined;
        metadataById.set(docId, fetched);
        return fetched;
      };
      for (const hit of [...pinned, ...ranked]) {
        if (results.length >= wanted) break;
        const key = `${hit.docId}:${hit.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = documentMetadata(hit.docId);
        const citation =
          row &&
          (languageField(row, "citation", language) ??
            languageField(row, "citation2", language));
        if (!row || !citation) continue;
        results.push({
          docId: hit.docId,
          citation,
          name: languageField(row, "name", language),
          date: languageField(row, "document_date", language),
          url: languageField(row, "url", language),
          dataset: string(row, "dataset") ?? "",
          passage: { text: hit.text, start: hit.start, end: hit.end },
        });
      }
      return results;
    }) ?? [];
  if (!rerankModel) return pool.slice(0, size);
  // rerankPassages short-circuits (no model call) when the pool already
  // fits, and falls back to lexical order on any ranker failure.
  const { hits } = await rerankPassages({
    query,
    model: rerankModel,
    top: size,
    hits: pool.map((result, rank) => ({
      docId: result.docId,
      citation: result.citation,
      name: result.name,
      language,
      start: result.passage.start,
      end: result.passage.end,
      text: result.passage.text,
      rank,
    })),
  });
  const byKey = new Map(
    pool.map((result) => [`${result.docId}:${result.passage.start}`, result]),
  );
  return hits
    .map((hit) => byKey.get(`${hit.docId}:${hit.start}`))
    .filter((result): result is A2AJPassageResult => !!result);
}

function pinnedHits(
  source: DatabaseSync,
  indexDb: string,
  args: { query: string; language: Language; docType?: DocType },
): PassageHit[] {
  const docIds = citationDocIds(source, citationKeys(args.query), args.docType);
  if (!docIds.length) return [];
  const tokens = residualTokens(args.query);
  const index = new DatabaseSync(indexDb, { readOnly: true });
  try {
    const textStmt = source.prepare(
      `SELECT unofficial_text_${args.language} AS text FROM document WHERE id = ?`,
    );
    const hits: PassageHit[] = [];
    for (const docId of docIds) {
      const span = bestPassage(index, docId, args.language, tokens);
      const doc = textStmt.get(docId) as { text?: string } | undefined;
      if (!span || typeof doc?.text !== "string") continue;
      hits.push({
        docId,
        citation: "",
        name: null,
        language: args.language,
        start: span.start,
        end: span.end,
        text: doc.text.slice(span.start, span.end),
        rank: hits.length,
      });
    }
    return hits;
  } finally {
    index.close();
  }
}
