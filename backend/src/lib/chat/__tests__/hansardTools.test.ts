import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  legalSourceOperations,
} from "../../legalSourceApplication";

const fixture = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "__tests__",
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

describe("Hansard legal-source adapter", () => {
  it("reports the unavailable provider when no database exists", async () => {
    process.env.MIKE_A2AJ_HANSARD_DB = path.join(
      os.tmpdir(),
      "beaver-hansard-missing",
      "nope.sqlite",
    );
    const reply = await legalSourceOperations.search({
      text: "budget",
      kinds: ["hansard"],
      providers: ["hansard"],
    });
    expect(reply.results).toEqual([]);
    expect(reply.unavailable).toEqual([{ provider: "hansard", message: "not_installed" }]);
  });

  it("searches and fetches through the imported store", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-hansard-tools-"),
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

    const search = await legalSourceOperations.search({
      text: "speaker",
      kinds: ["hansard"],
      providers: ["hansard"],
      limit: 5,
    });
    expect(search.results.length).toBeGreaterThan(0);
    const first = search.results[0];
    expect(first.id).toBeTruthy();

    const fetched = await legalSourceOperations.readPassage({ source: first });
    expect(fetched.status).toBe("found");
    if (fetched.status === "found") {
      expect(fetched.values[0].source.id).toBe(first.id);
      expect(fetched.values[0].text.length).toBeGreaterThan(0);
    }
    expect(await legalSourceOperations.readPassage({
      source: { provider: "hansard", id: "no-such-id", kind: "hansard" },
    })).toMatchObject({ status: "not_found" });
  });
});
