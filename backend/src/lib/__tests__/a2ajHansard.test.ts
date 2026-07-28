import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Fixture rows are six verbatim interventions captured from the real
 * huggingface.co/datasets/a2aj/hansard datasets-server on 2026-07-28 (capture
 * metadata inside the file). The test drives the actual import script over
 * them and searches through the product surface; nothing touches the network.
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
  it("imports captured rows and searches interventions", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-hansard-"),
    );
    const input = path.join(temporaryDirectory, "rows.jsonl");
    const database = path.join(temporaryDirectory, "hansard.sqlite");
    await writeFile(
      input,
      fixture.rows.map((row) => JSON.stringify(row)).join("\n"),
    );
    const imported = spawnSync(
      "python",
      [
        path.resolve("scripts/import_a2aj_hansard.py"),
        input,
        "--output",
        database,
      ],
      { encoding: "utf8" },
    );
    expect(imported.status, imported.stderr).toBe(0);
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
        snippet: expect.stringContaining("auto workers"),
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
