import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
        VALUES(1, 'cases', 'SCC', '2024 SCC 1', '2024 CSC 1', 'Alpha', '2024-01-12',
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

  it("imports JSONL and returns API-shaped bilingual fetch/search results", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-a2aj-"));
    const input = path.join(temporaryDirectory, "records.jsonl");
    const database = path.join(temporaryDirectory, "a2aj.sqlite");
    const longText = Array.from(
      { length: 6 },
      (_, index) =>
        `[${index + 1}] ${"Substantive legal reasoning words establish this numbered judicial paragraph. ".repeat(180)}`,
    ).join("\n");
    const records = [
      {
        doc_type: "cases",
        dataset: "SCC",
        citation_en: "2024 SCC 1",
        citation_fr: "2024 CSC 1",
        citation2_en: "500 D.L.R. (4th) 10",
        name_en: "Alpha v. Beta",
        name_fr: "Alpha c. Beta",
        document_date_en: "2024-01-12",
        url_en: "https://example.test/en/alpha",
        url_fr: "https://example.test/fr/alpha",
        unofficial_text_en:
          "[1] The constitutional remedy protects Alpha Corporation.",
        unofficial_text_fr:
          "[1] Le recours constitutionnel protège Société Alpha.",
        upstream_license: "CC BY 4.0",
      },
      {
        doc_type: "cases",
        dataset: "ONCA",
        citation_en: "2023 ONCA 9",
        name_en: "Gamma v. Delta",
        document_date_en: "2023-05-20",
        unofficial_text_en: "[1] A different appellate proposition.",
      },
      {
        doc_type: "laws",
        dataset: "LEGISLATION-FED",
        citation_en: "RSC 1985, c C-46",
        name_en: "Criminal Code",
        document_date_en: "1985-01-01",
        unofficial_text_en: "Stale flat rendition.",
        unofficial_sections_en: {
          "34": "34(1) Parent defence provision.",
        },
      },
      {
        doc_type: "cases",
        dataset: "SCC",
        citation_en: "2022 SCC 88",
        name_en: "Long v. Decision",
        unofficial_text_en: longText,
      },
    ];
    await writeFile(
      input,
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
    const imported = spawnSync(
      "python",
      [
        path.resolve("scripts/import_a2aj_bulk.py"),
        input,
        "--output",
        database,
        "--fts",
      ],
      { encoding: "utf8" },
    );
    expect(imported.status, imported.stderr).toBe(0);
    process.env.MIKE_A2AJ_BULK_DB = database;
    const bulk = await import("../a2ajLocalBulk");

    expect(
      bulk.fetchLocalA2AJDocument({
        citation: "2024  CSC  1",
        language: "fr",
      }),
    ).toMatchObject({
      dataset: "SCC",
      citation: "2024 CSC 1",
      name: "Alpha c. Beta",
      url: "https://example.test/fr/alpha",
      text: "[1] Le recours constitutionnel protège Société Alpha.",
      language: "fr",
      upstreamLicense: "CC BY 4.0",
    });
    const law = bulk.fetchLocalA2AJDocument({
      citation: "RSC 1985, c C-46",
      docType: "laws",
    });
    expect(law).toMatchObject({
      docType: "laws",
      name: "Criminal Code",
      text: "Stale flat rendition.",
      sectionMap: { "34": "34(1) Parent defence provision." },
    });
    expect(
      bulk.searchLocalA2AJ({
        query: "constitutional remedy",
        dataset: "scc,onca",
      }),
    ).toMatchObject([
      {
        citation: "2024 SCC 1",
        name: "Alpha v. Beta",
        snippet: null,
      },
    ]);
    expect(
      bulk.searchLocalA2AJ({
        query: "Alpha Beta",
        searchType: "name",
        language: "fr",
      }),
    ).toMatchObject([{ citation: "2024 CSC 1", name: "Alpha c. Beta" }]);

    const batch = bulk.fetchLocalA2AJDocumentsByIds({ ids: [2, 1] });
    expect([...batch.keys()]).toEqual([2, 1]);
    expect([...batch.values()].map(({ citation }) => citation)).toEqual([
      "2023 ONCA 9",
      "2024 SCC 1",
    ]);
    const aliases = ["2024 SCC 1", "2024 CSC 1", "500 D.L.R. (4th) 10"];
    expect(bulk.a2ajCitationAliasGroups(aliases)?.map(({ keys }) => keys)).toEqual(
      aliases.map(() => ["2024csc1", "2024scc1", "500dlr4th10"]));

    const longDocument = bulk.fetchLocalA2AJDocument({
      citation: "2022 SCC 88",
    });
    expect(longDocument?.text).toHaveLength(50_000);
    expect(longDocument).not.toHaveProperty("analysis");
  });
});
