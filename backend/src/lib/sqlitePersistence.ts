import { sha256 } from "./hash";
import { localDatabaseSync, localTransaction } from "./relationalDatabase";

export type SqliteLegalSourcePdfRendition = { provider: "a2aj"; identity: string;
  url: string; canonicalUrl: string; title?: string | null; version?: string | null;
  requestReference: string };
export type SqliteLegalSourcePointer = { id: string; userId: string;
  provider: "a2aj" | "journal"; docType: "cases" | "laws" | "articles";
  citation: string; language: "en" | "fr"; dataset: string | null;
  sourceId?: string | null; pdfRendition?: SqliteLegalSourcePdfRendition };
const parse = <T>(raw: string, fallback: T): T => {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};
const response = (source: SqliteLegalSourcePointer) => ({
  id: source.id, provider: source.provider, doc_type: source.docType,
  citation: source.citation, language: source.language, dataset: source.dataset,
  source_id: source.sourceId ?? null, ...(source.pdfRendition ? { pdf_rendition: {
    provider: source.pdfRendition.provider, identity: source.pdfRendition.identity,
    reference_id: source.pdfRendition.requestReference,
    status_url: `/api/sources/${encodeURIComponent(source.id)}/pdf-status`,
  } } : {}) });
const sourceId = (source: Omit<SqliteLegalSourcePointer, "id" | "userId" | "pdfRendition">) =>
  sha256(JSON.stringify([source.provider, source.docType, source.language,
    source.dataset?.trim().toLowerCase() ?? "", source.sourceId?.trim().toLowerCase() ?? "",
    source.citation.trim().toLowerCase()])).slice(0, 32);

export async function listSqliteLegalSources(userId: string) {
  return (localDatabaseSync().prepare(`SELECT pointer_json FROM library_legal_sources
    WHERE user_id=? ORDER BY id`).all(userId) as { pointer_json: string }[])
    .map(({ pointer_json }) => parse(pointer_json, {} as SqliteLegalSourcePointer)).map(response);
}
export async function getSqliteLegalSource(userId: string, id: string) {
  const row = localDatabaseSync().prepare(`SELECT pointer_json FROM library_legal_sources
    WHERE user_id=? AND id=?`).get(userId, id) as { pointer_json: string } | undefined;
  return row ? parse(row.pointer_json, null as SqliteLegalSourcePointer | null) : null;
}
export async function saveSqliteLegalSource(input: Omit<SqliteLegalSourcePointer, "id">) {
  return localTransaction((db) => {
    const source: SqliteLegalSourcePointer = { ...input, citation: input.citation.trim(),
      dataset: input.dataset?.trim() || null, id: sourceId(input) };
    const row = db.prepare(`SELECT pointer_json FROM library_legal_sources
      WHERE user_id=? AND id=?`).get(input.userId, source.id) as { pointer_json: string } | undefined;
    const current = row ? parse(row.pointer_json, null as SqliteLegalSourcePointer | null) : null;
    if (current) {
      if (source.pdfRendition) current.pdfRendition = source.pdfRendition;
      db.prepare(`UPDATE library_legal_sources SET pointer_json=? WHERE user_id=? AND id=?`)
        .run(JSON.stringify(current), input.userId, source.id);
      return response(current);
    }
    db.prepare(`INSERT INTO library_legal_sources(user_id,id,pointer_json) VALUES(?,?,?)`)
      .run(input.userId, source.id, JSON.stringify(source));
    return response(source);
  });
}
export async function deleteSqliteLegalSource(userId: string, id: string) {
  return localDatabaseSync().prepare(`DELETE FROM library_legal_sources WHERE user_id=? AND id=?`)
    .run(userId, id).changes > 0;
}
