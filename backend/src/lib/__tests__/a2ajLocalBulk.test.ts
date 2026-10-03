import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_A2AJ_BULK_DB;
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local A2AJ bulk data", () => {
  it("retains the legislation publisher alongside its lookup metadata", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-a2aj-"));
    const filename = path.join(temporaryDirectory, "a2aj.sqlite");
    const database = new DatabaseSync(filename);
    try {
      const fields = ["citation", "citation2", "name", "document_date", "url",
        "unofficial_text", "unofficial_sections"].flatMap(field => [`${field}_en`, `${field}_fr`]);
      database.exec(`CREATE TABLE document(id INTEGER PRIMARY KEY, doc_type, dataset,
        ${fields.join(",")}, upstream_license);
        INSERT INTO document(id, doc_type, dataset, citation_en, name_en, url_en, unofficial_text_en)
        VALUES(1, 'laws', 'LEGISLATION-FED', 'RSC 1985, c F-7', 'Federal Courts Act',
          'https://laws-lois.justice.gc.ca/eng/XML/F-7.xml', '18. Judicial review.');`);
      process.env.MIKE_A2AJ_BULK_DB = filename;
      const bulk = await import("../a2ajLocalBulk");
      expect(bulk.fetchLocalA2AJDocumentsByIds({ ids: [1], docType: "laws" }).get(1))
        .toMatchObject({ citation: "RSC 1985, c F-7", text: "18. Judicial review.",
          publisherUrl: "https://laws-lois.justice.gc.ca/eng/XML/F-7.xml" });
    } finally { database.close(); }
  });

  it("preserves metadata language, text fallback and missing-index behavior", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-a2aj-"));
    const filename = path.join(temporaryDirectory, "a2aj.sqlite");
    const database = new DatabaseSync(filename);
    try {
      const fields = ["citation", "citation2", "name", "document_date", "url",
        "unofficial_text", "unofficial_sections"].flatMap((field) => [`${field}_en`, `${field}_fr`]);
      database.exec(`CREATE TABLE document(id INTEGER PRIMARY KEY, doc_type, dataset,
        ${fields.join(",")}, upstream_license);
        CREATE VIRTUAL TABLE document_search USING fts5(name_en, name_fr, unofficial_text_en);
        INSERT INTO document(id, doc_type, dataset, citation_en, citation_fr, name_en,
          document_date_en, unofficial_text_en, unofficial_sections_en)
        VALUES(1, 'cases', 'SCC', '2024 SCC 1', '2024 CSC 1', 'Alpha', '2024-01-12T00:00:00+00:00',
          'constitutional remedy', '{"1":"section one"}');
        INSERT INTO document(id, doc_type, dataset, citation2_en, name_en)
          VALUES(2, 'cases', 'ONCA', '2023 ONCA 9', 'Alpha');
        INSERT INTO document(id, doc_type, dataset, name_en, unofficial_text_en)
          VALUES(3, 'cases', 'SCC', 'Alpha', 'missing citation');
        INSERT INTO document_search(rowid, name_en, unofficial_text_en)
          SELECT id, name_en, unofficial_text_en FROM document;`);
      process.env.MIKE_A2AJ_BULK_DB = filename;
      const bulk = await import("../a2ajLocalBulk");
      const hits = bulk.searchLocalA2AJ({ query: "Alpha", language: "fr", sortResults: "newest_first" });
      expect(hits).toEqual([
        { dataset: "SCC", citation: "2024 CSC 1", alternateCitation: null, name: "Alpha",
          date: "2024-01-12", url: null, snippet: null },
        { dataset: "ONCA", citation: "2023 ONCA 9", alternateCitation: "2023 ONCA 9", name: "Alpha",
          date: null, url: null, snippet: null },
      ]);
      expect(bulk.searchLocalA2AJ({ query: "Alpha", startDate: "2024-01-12",
        endDate: "2024-01-12" })).toMatchObject([{ citation: "2024 SCC 1", date: "2024-01-12" }]);
      const batch = bulk.fetchLocalA2AJDocumentsByIds({ ids: [3, 2, 1], language: "fr", maxChars: 5 });
      expect([...batch.keys()]).toEqual([1]);
      expect(batch.get(1)).toMatchObject({ citation: "2024 SCC 1", language: "en",
        text: "const", sectionMap: { "1": "section one" } });
      database.exec("DROP TABLE document_search");
      expect(bulk.searchLocalA2AJ({ query: "Alpha" })).toBeNull();
      expect(bulk.searchLocalA2AJ({ query: "Alpha", querySyntax: "fts5" })).toBeNull();
    } finally {
      database.close();
    }
  });
});
