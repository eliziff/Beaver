import type { LegalResearchQueryReceipt } from "../researchContract";
import { researchSourceKey } from "../resourceReferences";
import { modelToolData } from "./toolRegistry";

export type QueryHistorySource = () => Iterable<LegalResearchQueryReceipt> | Promise<Iterable<LegalResearchQueryReceipt>>;

const term = (query: LegalResearchQueryReceipt) => String(query.input.pattern ?? query.input.query ?? "");
export const queryResources = (query: LegalResearchQueryReceipt) => [
  ...(typeof query.input.resource === "string" ? [query.input.resource] : []),
  ...(query.scan?.sources.map(source => source.resource) ?? []),
  ...Object.values((query as import("../researchContract").ResearchQueryReceipt).sourceReferences ?? {}).map(researchSourceKey),
  ...query.results.flatMap(result => "resource" in result ? [result.resource] : []),
];
const queryHistoryPreview = (query: LegalResearchQueryReceipt) => ({
  query_id: query.query_id, tool: query.tool, query: term(query).slice(0, 160),
  ...(typeof query.input.resource === "string" ? { resource: query.input.resource } : {}),
  ...(query.reader_id ? { reader_id: query.reader_id } : {}),
  results: query.results.length,
  ...(query.scan ? { total_matches: query.scan.total_matches, truncated: query.scan.truncated,
    ...(query.scan.headnote_matches ? { headnote_matches: query.scan.headnote_matches } : {}) } : {}),
  ...(query.unavailable?.length ? { unavailable: query.unavailable } : {}),
  ...(query.input.coverage ? { coverage: query.input.coverage } : {}),
});

/** Search the receipt log only when requested; it is not appended to every prompt. */
export function readQueryHistory(queries: Iterable<LegalResearchQueryReceipt>, args: {
  file_path?: string; pattern?: string; section?: string; offset?: number; limit?: number; start_char?: number;
}) {
  const all = [...queries], offset = Math.max(0, (args.offset ?? 1) - 1),
    limit = Math.max(1, Math.min(50, args.limit ?? 20));
  if (args.file_path?.startsWith("q_")) {
    const query = all.find(query => query.query_id === args.file_path);
    if (!query) return { ok: false, error: "Search receipt not found" };
    const { call_id: _call, model: _model, executor_version: _executor, ...stored } = query;
    const value = modelToolData({ ...stored, results: query.results.slice(offset, offset + limit),
      total: query.results.length, next_offset: offset + limit < query.results.length ? offset + limit + 1 : null });
    const json = JSON.stringify(value), start = args.start_char ?? 0;
    if (!start && json.length <= 48_000) return value;
    const shown = json.slice(start, start + 24_000), end = start + shown.length;
    return { query_id: query.query_id, encoding: "json", json: shown, text_length: json.length,
      next_read: end < json.length ? { ...args, start_char: end } : null };
  }
  const pattern = args.pattern?.toLowerCase(), selected = all.filter(query =>
    (!pattern || term(query).toLowerCase().includes(pattern)) &&
    (!args.section || query.reader_id === args.section || queryResources(query).includes(args.section)));
  const items = selected.slice(offset, offset + limit).map(queryHistoryPreview);
  while (items.length > 1 && JSON.stringify(items).length > 48_000) items.pop();
  const next = offset + items.length;
  return { total: selected.length, items, next_offset: next < selected.length ? next + 1 : null };
}

/** Reuse only a proved zero literal match in the same version and the same searched range. */
export function previousEmptyScan(queries: Iterable<LegalResearchQueryReceipt>,
  input: Record<string, unknown>, sources: NonNullable<LegalResearchQueryReceipt["scan"]>["sources"]) {
  const revisions = (values: typeof sources) => JSON.stringify(values.map(({ resource, source_sha256 }) =>
    [resource, source_sha256]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])));
  const key = revisions(sources), needle = String(input.pattern).trim().replace(/\s+/gu, " ");
  return [...queries].reverse().find(query => query.tool === "Read" &&
    query.executor_version === "legal-source-pattern-v1" && query.scan?.total_matches === 0 &&
    !query.scan.truncated && !query.unavailable?.length && revisions(query.scan.sources) === key &&
    String(query.input.pattern).trim().replace(/\s+/gu, " ") === needle &&
    ["resource", "locator_kind", "locator", "end_locator", "context_blocks", "search_scope"].every(field =>
      (query.input[field] ?? (field === "context_blocks" ? 0 : "")) ===
      (input[field] ?? (field === "context_blocks" ? 0 : ""))));
}
