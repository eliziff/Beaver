import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      structure: { source: "flat_text" },
    });
    expect(bulk.getLocalA2AJSectionMap(law!)?.["34"]).toBe(
      "34(1) Parent defence provision.",
    );
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

    const longDocument = bulk.fetchLocalA2AJDocument({
      citation: "2022 SCC 88",
    });
    expect(longDocument?.text).toHaveLength(50_000);
    expect(longDocument?.structure.status).toBe("unavailable");
  });
});
