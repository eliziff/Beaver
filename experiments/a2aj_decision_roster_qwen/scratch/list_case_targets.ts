import { a2ajLocalBulkPath } from "../../../backend/src/lib/a2ajLocalBulk";
import { citationLookupKey, citationsInText } from "../../../backend/src/lib/citationKey";
import { classifyCitatorExcerpt } from "../../../backend/src/lib/citatorExcerpts";
import { withReadonlySqlite } from "../../../backend/src/lib/legalDataPath";
import { candidatesByDocumentIds, loadCase, parseDocumentIds } from "../runner";

async function main() {
const ids = parseDocumentIds(process.argv.slice(2).filter((value) => !value.startsWith("--")).join(","));
const loaded = await Promise.all(candidatesByDocumentIds(ids).map(async (candidate) => ({
  candidate,
  record: await loadCase(candidate),
})));
const reports = withReadonlySqlite(a2ajLocalBulkPath(), (database) => loaded.flatMap(({ candidate, record }) => {
  if (!record) return [];
  const grouped = new Map<string, { citation: string; count: number; bestKind: string; context: string }>();
  for (const match of citationsInText(record.source.text)) {
    if (match.start < (record.paragraphs[0]?.start ?? 0)) continue;
    const key = citationLookupKey(match.text);
    if (!key || key === citationLookupKey(candidate.citation)) continue;
    const context = record.source.text.slice(Math.max(0, match.start - 180), Math.min(record.source.text.length, match.end + 260));
    const kind = classifyCitatorExcerpt(context).kind;
    const prior = grouped.get(key);
    if (prior) prior.count += 1;
    else grouped.set(key, { citation: match.text, count: 1, bestKind: kind, context: context.replace(/\s+/gu, " ").trim() });
  }
  const candidates = [...grouped.values()]
    .sort((left, right) => right.count - left.count || Number(right.bestKind === "prose") - Number(left.bestKind === "prose"))
    .slice(0, 12)
    .map((item) => {
      const target = database.prepare(`
        SELECT document.id, document.name_en
        FROM citation_lookup AS lookup
        JOIN document ON document.id = lookup.document_id
        WHERE lookup.citation_key = ? AND document.doc_type = 'cases'
        ORDER BY document.id LIMIT 1
      `).get(citationLookupKey(item.citation)) as { id: number; name_en: string | null } | undefined;
      return {
        citation: item.citation,
        count: item.count,
        kind: item.bestKind,
        target_document_id: target?.id ?? null,
        target_name: target?.name_en ?? null,
        context: item.context,
      };
    });
  return [{ source: candidate, candidates, chosen: candidates.find(({ target_document_id }) => target_document_id !== null) ?? candidates[0] ?? null }];
})) ?? [];
const chosenOnly = process.argv.includes("--chosen");
for (const report of reports) console.log(JSON.stringify(chosenOnly ? { source: report.source, chosen: report.chosen } : report, null, chosenOnly ? 0 : 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
