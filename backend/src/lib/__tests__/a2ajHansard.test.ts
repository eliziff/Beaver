import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Fixture rows are six verbatim interventions captured from the real
 * huggingface.co/datasets/a2aj/hansard datasets-server on 2026-07-28 (capture
 * metadata inside the file). The test reads their indexed SQLite representation through the product
 * surface; importer transformation belongs to the dataset producer.
 */
const fixture = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      "fixtures",
      "hansard",
      "a2aj-hansard-ontario-2025-05-01.json",
    ),
    "utf8",
  ),
) as { rows: Array<Record<string, unknown>> };

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_A2AJ_HANSARD_DB;
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local A2AJ Hansard store", () => {
  it("queries indexed public rows and fetches interventions", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-hansard-"),
    );
    const database = path.join(temporaryDirectory, "hansard.sqlite");
    const connection = new DatabaseSync(database);
    try {
      connection.exec(`CREATE TABLE intervention(id INTEGER PRIMARY KEY, source_id, date,
        jurisdiction, chamber, language, order_of_business, subject_of_business, speaker,
        intervention_type, text, upstream_license, source_url);
        CREATE VIRTUAL TABLE intervention_search USING fts5(speaker, subject_of_business,
          order_of_business, text, content='intervention', content_rowid='id');`);
      const insert = connection.prepare("INSERT INTO intervention VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (const [index, row] of fixture.rows.entries()) insert.run(index + 1,
        ...["ID", "Date", "jurisdiction", "chamber", "language", "OrderofBusiness",
          "SubjectofBusiness", "PersonSpeaking", "intervention_type", "Intervention",
          "upstream_license", "source_url"].map(field => String(row[field] ?? "")));
      connection.exec(`INSERT INTO intervention_search(rowid,speaker,subject_of_business,order_of_business,text)
        SELECT id,speaker,subject_of_business,order_of_business,text FROM intervention;`);
    } finally { connection.close(); }
    process.env.MIKE_A2AJ_HANSARD_DB = database;
    const hansard = await import("../a2ajHansard");

    const hits = hansard.searchLocalHansard({ query: "automotive industry" });
    expect(hits).toMatchObject([
      {
        id: expect.stringMatching(/^20250501-/u),
        date: "2025-05-01",
        jurisdiction: "ontario",
        chamber: "legislative_assembly",
        subjectOfBusiness: "Automotive industry",
        orderOfBusiness: "Question Period",
        interventionType: "speech",
        sourceUrl: expect.stringContaining("ola.org"),
        speaker: "Ms. Marit Stiles",
        // Matched through the subject_of_business FTS column; the snippet is
        // the opening window of the intervention text itself.
        snippet: null,
      },
      { subjectOfBusiness: "Automotive industry" },
    ]);

    expect(
      hansard.searchLocalHansard({
        query: "automotive",
        speaker: "bethlenfalvy",
      }),
    ).toMatchObject([{ speaker: "Hon. Peter Bethlenfalvy" }]);
    expect(
      hansard.searchLocalHansard({ query: "mental health", endDate: "2025-04-30" }),
    ).toEqual([]);

    const full = hansard.fetchLocalHansardIntervention({
      id: "20250501-0000031",
    });
    expect(full).toMatchObject({
      speaker: "Mr. Sol Mamakwa",
      subjectOfBusiness: "United Nations Permanent Forum on Indigenous Issues",
      upstreamLicense: expect.stringContaining("perma.cc"),
    });
    expect(full!.text.length).toBeGreaterThan(1_000);
  });

  it("returns null when no Hansard database is installed", async () => {
    process.env.MIKE_A2AJ_HANSARD_DB = path.join(
      os.tmpdir(),
      "beaver-hansard-missing",
      "absent.sqlite",
    );
    const hansard = await import("../a2ajHansard");
    expect(hansard.searchLocalHansard({ query: "anything" })).toBeNull();
    expect(
      hansard.fetchLocalHansardIntervention({ id: "20250501-0000001" }),
    ).toBeNull();
  });
});
