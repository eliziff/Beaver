import { statSync } from "node:fs";
import { withSearchReadonlySqlite } from "./legalDataPath";
import { hydrateSourceDoc, sourceDocEngineVersion, type NativeSourceDoc } from "./structureNative";

const decode = (value: unknown) => JSON.parse(Buffer.from(value as Uint8Array).toString("utf8"));
const validated = new Set<string>();

export function readCachedSourceDoc(
  cache: string, source: string, provider: string, sourceId: string, text: string,
) {
  return withSearchReadonlySqlite(cache, true, (database) => {
    const key = `${cache}\0${source}`;
    if (!validated.has(key)) {
      const metadata = Object.fromEntries((database.prepare("SELECT key,value FROM source_doc_meta")
        .all() as Array<{ key: string; value: string }>).map(({ key, value }) => [key, value]));
      const stat = statSync(source);
      if (metadata.store_schema !== "1" || metadata.provider !== provider ||
          metadata.complete !== "1" ||
          metadata.engine_version !== String(sourceDocEngineVersion()) ||
          metadata.source_size !== String(stat.size) ||
          metadata.source_mtime_ms !== String(Math.trunc(stat.mtimeMs))) return null;
      validated.add(key);
    }
    const row = database.prepare(`SELECT document,index_entries FROM source_doc
      WHERE provider=? AND source_id=?`).get(provider, sourceId) as
      { document: Uint8Array; index_entries: Uint8Array } | undefined;
    return row ? hydrateSourceDoc({ document: decode(row.document),
      index: decode(row.index_entries) } as NativeSourceDoc, text) : null;
  });
}
