import { a2ajLocalBulkPath, fetchLocalA2AJDocumentById } from "../../backend/src/lib/a2ajLocalBulk";
import { withReadonlySqlite } from "../../backend/src/lib/legalDataPath";
import { a2ajLegalSourceProvider } from "../../backend/src/lib/legalSources/a2aj";

const citations = ["2006 BCCA 127", "2008 FCA 24", "2021 SCC 46", "2021 SCC 47", "2003 BCCA 332"];

const ids = withReadonlySqlite(a2ajLocalBulkPath(), (database) =>
  citations.map((citation) => {
    const row = database
      .prepare("SELECT document.id, document.dataset FROM citation_lookup JOIN document ON document.id = citation_lookup.document_id WHERE citation_lookup.citation_key = ? AND document.doc_type='cases' LIMIT 1")
      .get(citation.toLowerCase().replace(/[^\w]+/gu, "")) as Record<string, unknown> | undefined;
    return row ? { id: Number(row.id), dataset: String(row.dataset ?? "") } : null;
  }),
) ?? [];

for (const entry of ids) {
  if (!entry) continue;
  const document = fetchLocalA2AJDocumentById({ id: entry.id, docType: "cases", language: "en", maxChars: Number.MAX_SAFE_INTEGER });
  if (!document) continue;
  const source = a2ajLegalSourceProvider.source(document);
  const paragraphs = source.blocks.filter((b) => b.kind === "paragraph");
  const text = document.text;
  console.log(`\n========== ${document.citation} (${entry.dataset}) ${document.name ?? ""} paragraphs=${paragraphs.length} text=${text.length}`);
  for (let i = 0; i < paragraphs.length; i += 1) {
    const block = paragraphs[i];
    const head = text.slice(block.start, Math.min(block.end, block.start + 90)).replace(/\s+/gu, " ").trim();
    const before = i > 0 ? text.slice(paragraphs[i - 1].end, block.start).replace(/\s+/gu, " ").trim().slice(0, 130) : "—header—";
    console.log(`${block.label} | ${head}`);
    if (before) console.log(`      ^before: ${before}`);
  }
}
