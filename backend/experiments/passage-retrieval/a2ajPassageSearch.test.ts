import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  A2AJ_PASSAGE_OVERLAP,
  A2AJ_PASSAGE_TARGET,
  MissingPassageIndexError,
  searchLocalA2AJPassages,
} from "./a2ajPassageSearch";
import { citationLookupKeyNative as citationLookupKey } from "../../src/lib/structureNative";
import { ensurePassageIndex, searchPassages } from "./passageRetrieval";

const dir = mkdtempSync(path.join(os.tmpdir(), "a2aj-passage-test-"));
const sourceDb = path.join(dir, "a2aj.sqlite");
const emptyDb = path.join(dir, "unindexed.sqlite");

const filler =
  "The appellant sought judicial review of the tribunal decision below. ";
const scc =
  "ALPHA v. BETA\n\n" +
  filler.repeat(28) +
  "\n\nThe requirement of notice to the affected party was satisfied here.\n\n" +
  filler.repeat(28);
// The citing case: densest lexical match for both "notice" AND the
// citation string, which is why bm25 alone puts it above the case the
// query actually names.
const manual =
  "SERVICE AND NOTICE MANUAL\n\n" +
  ("Applying 2024 SCC 6, proper notice must be served on every party; " +
    "notice under 2024 SCC 6 is effective on receipt. ").repeat(40);

function seed(file: string) {
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE document (id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, dataset TEXT NOT NULL, citation_en TEXT, citation_fr TEXT, citation2_en TEXT, citation2_fr TEXT, name_en TEXT, name_fr TEXT, document_date_en TEXT, document_date_fr TEXT, url_en TEXT, url_fr TEXT, unofficial_text_en TEXT, unofficial_text_fr TEXT)",
  );
  db.exec(
    "CREATE TABLE citation_lookup (citation_key TEXT NOT NULL, document_id INTEGER NOT NULL, PRIMARY KEY (citation_key, document_id)) WITHOUT ROWID",
  );
  const insert = db.prepare(
    "INSERT INTO document (id, doc_type, dataset, citation_en, name_en, document_date_en, url_en, unofficial_text_en) VALUES (?, 'cases', ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    1,
    "SCC",
    "2024 SCC 6",
    "Alpha v. Beta",
    "2024-02-01",
    "https://example.test/en/alpha",
    scc,
  );
  insert.run(
    2,
    "ONCA",
    "2023 ONCA 9",
    "Service Manual Reference",
    "2023-05-20",
    "https://example.test/en/manual",
    manual,
  );
  const lookup = db.prepare(
    "INSERT INTO citation_lookup (citation_key, document_id) VALUES (?, ?)",
  );
  lookup.run(citationLookupKey("2024 SCC 6"), 1);
  lookup.run(citationLookupKey("2023 ONCA 9"), 2);
  db.close();
}

beforeAll(async () => {
  // Literal-key behaviour only: never fall through to a real citator
  // graph on the developer's box (alias expansion is covered by
  // a2ajPassageWiring.test.ts against a fixture graph).
  process.env.MIKE_CITATOR_DB = path.join(dir, "no-citator.sqlite");
  seed(sourceDb);
  seed(emptyDb);
  await ensurePassageIndex({
    sourceDb,
    target: A2AJ_PASSAGE_TARGET,
    overlap: A2AJ_PASSAGE_OVERLAP,
  });
});

afterAll(() => {
  delete process.env.MIKE_A2AJ_BULK_DB;
  delete process.env.MIKE_CITATOR_DB;
  rmSync(dir, { recursive: true, force: true });
});

describe("searchLocalA2AJPassages", () => {
  it("returns product-shaped hits carrying verbatim passage offsets", async () => {
    process.env.MIKE_A2AJ_BULK_DB = sourceDb;
    const hits = await searchLocalA2AJPassages({
      query: "notice served on every party",
      size: 4,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      docId: 2,
      citation: "2023 ONCA 9",
      name: "Service Manual Reference",
      date: "2023-05-20",
      url: "https://example.test/en/manual",
      dataset: "ONCA",
    });
    for (const hit of hits) {
      const text = hit.docId === 1 ? scc : manual;
      expect(hit.passage.text).toBe(
        text.slice(hit.passage.start, hit.passage.end),
      );
    }
  });

  it("refuses with a typed error when the sidecar is not built", async () => {
    process.env.MIKE_A2AJ_BULK_DB = emptyDb;
    await expect(
      searchLocalA2AJPassages({ query: "notice served on every party" }),
    ).rejects.toThrow(MissingPassageIndexError);
    const error = await searchLocalA2AJPassages({
      query: "notice served on every party",
    }).catch((reason: unknown) => reason as MissingPassageIndexError);
    expect(error.command).toContain(
      "experiments/passage-retrieval/build-passage-index.ts",
    );
  });

  it("prepends the citation-resolved document ahead of the bm25 ranking", async () => {
    process.env.MIKE_A2AJ_BULK_DB = sourceDb;
    const query = "what did 2024 SCC 6 say about notice";
    const ranked = await searchPassages({
      sourceDb,
      target: A2AJ_PASSAGE_TARGET,
      overlap: A2AJ_PASSAGE_OVERLAP,
      query,
      k: 4,
    });
    // Premise: lexical ranking alone puts the other document first.
    expect(ranked[0].docId).toBe(2);

    const hits = await searchLocalA2AJPassages({ query, size: 4 });
    expect(hits[0].citation).toBe("2024 SCC 6");
    expect(hits[0].passage.text).toContain("requirement of notice");
    expect(hits[0].passage.text).toBe(
      scc.slice(hits[0].passage.start, hits[0].passage.end),
    );
    expect(hits.filter((hit) => hit.docId === 1).length).toBe(
      new Set(hits.filter((hit) => hit.docId === 1).map((h) => h.passage.start))
        .size,
    );
  });
});
