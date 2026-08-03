import { a2ajLocalBulkPath, fetchLocalA2AJDocumentById } from "../../backend/src/lib/a2ajLocalBulk";
import { withReadonlySqlite } from "../../backend/src/lib/legalDataPath";
import { getA2AJDocumentSourceDoc } from "../../backend/src/lib/a2aj";

const citations = ["2006 BCCA 127", "2008 FCA 24", "2021 SCC 46", "2021 SCC 47", "2003 BCCA 332", "2015 BCCA 52"];

const ids = withReadonlySqlite(a2ajLocalBulkPath(), (database) =>
  citations.map((citation) => {
    const row = database
      .prepare("SELECT document.id FROM citation_lookup JOIN document ON document.id = citation_lookup.document_id WHERE citation_lookup.citation_key = ? AND document.doc_type='cases' LIMIT 1")
      .get(citation.toLowerCase().replace(/[^\w]+/gu, "")) as Record<string, unknown> | undefined;
    return row ? Number(row.id) : null;
  }),
) ?? [];

for (const id of ids) {
  if (!id) continue;
  const document = fetchLocalA2AJDocumentById({ id, docType: "cases", language: "en", maxChars: Number.MAX_SAFE_INTEGER });
  if (!document) continue;
  const source = getA2AJDocumentSourceDoc(document);
  const paragraphs = source.blocks.filter((b) => b.kind === "paragraph");
  const headerEnd = paragraphs.length ? Math.min(paragraphs[0].start, 8_000) : 8_000;
  console.log(`\n========== ${document.citation} header (${headerEnd} chars) ==========`);
  console.log(document.text.slice(0, headerEnd));
}
