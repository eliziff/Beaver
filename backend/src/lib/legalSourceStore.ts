import { sha256 } from "./hash";
import { decodeJson as decode, encodeJson, sql, type RelationalDatabase } from "./relational";

export type LegalSourcePdfRendition = { provider: "a2aj"; identity: string;
  url: string; canonicalUrl: string; title?: string | null; version?: string | null;
  requestReference: string };
export type LegalSourcePointer = { id: string; userId: string;
  provider: "a2aj" | "journal"; docType: "cases" | "laws" | "articles";
  citation: string; language: "en" | "fr"; dataset: string | null;
  sourceId?: string | null; pdfRendition?: LegalSourcePdfRendition };
const response = (source: LegalSourcePointer) => ({
  id: source.id, provider: source.provider, doc_type: source.docType,
  citation: source.citation, language: source.language, dataset: source.dataset,
  source_id: source.sourceId ?? null, ...(source.pdfRendition ? { pdf_rendition: {
    provider: source.pdfRendition.provider, identity: source.pdfRendition.identity,
    reference_id: source.pdfRendition.requestReference,
    status_url: `/api/sources/${encodeURIComponent(source.id)}/pdf-status`,
  } } : {}) });
const sourceId = (source: Omit<LegalSourcePointer, "id" | "userId" | "pdfRendition">) =>
  sha256(JSON.stringify([source.provider, source.docType, source.language,
    source.dataset?.trim().toLowerCase() ?? "", source.sourceId?.trim().toLowerCase() ?? "",
    source.citation.trim().toLowerCase()])).slice(0, 32);

export function createLegalSourceStore(db: RelationalDatabase) {
  return {
    async list(userId: string) {
      return (await db.query<{ pointer_json: unknown }>(sql`SELECT pointer_json
        FROM library_legal_sources WHERE user_id=${userId} ORDER BY id`)).rows
        .map(({ pointer_json }) => decode(pointer_json, {} as LegalSourcePointer)).map(response);
    },
    async get(userId: string, id: string) {
      const row = (await db.query<{ pointer_json: unknown }>(sql`SELECT pointer_json
        FROM library_legal_sources WHERE user_id=${userId} AND id=${id}`)).rows[0];
      return row ? decode(row.pointer_json, null as LegalSourcePointer | null) : null;
    },
    async save(input: Omit<LegalSourcePointer, "id">) {
      return db.transaction(async (tx) => {
        const source: LegalSourcePointer = { ...input, citation: input.citation.trim(),
          dataset: input.dataset?.trim() || null, id: sourceId(input) };
        const row = (await tx.query<{ pointer_json: unknown }>(sql`SELECT pointer_json
          FROM library_legal_sources WHERE user_id=${input.userId} AND id=${source.id}`)).rows[0];
        const current = row ? decode(row.pointer_json, null as LegalSourcePointer | null) : null;
        if (current?.pdfRendition && !source.pdfRendition)
          source.pdfRendition = current.pdfRendition;
        await tx.query(sql`INSERT INTO library_legal_sources(user_id,id,pointer_json)
          VALUES(${input.userId},${source.id},${encodeJson(source)})
          ON CONFLICT(user_id,id) DO UPDATE SET pointer_json=excluded.pointer_json`);
        return response(source);
      });
    },
    async delete(userId: string, id: string) {
      return (await db.query(sql`DELETE FROM library_legal_sources
        WHERE user_id=${userId} AND id=${id}`)).changes > 0;
    },
  };
}
export type LegalSourceStore = ReturnType<typeof createLegalSourceStore>;
