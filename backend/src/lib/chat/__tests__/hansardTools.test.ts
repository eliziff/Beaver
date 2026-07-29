import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeHansardTool, HANSARD_TOOLS } from "../tools/hansardTools";

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

describe("hansard chat tools", () => {
  it("declares both tools and ignores foreign calls", () => {
    expect(HANSARD_TOOLS.map((tool) => tool.function.name)).toEqual([
      "hansard_search",
      "hansard_fetch",
    ]);
    expect(executeHansardTool("library_read", {})).toBeNull();
  });

  it("reports hansard_not_installed when no database exists", () => {
    process.env.MIKE_A2AJ_HANSARD_DB = path.join(
      os.tmpdir(),
      "beaver-hansard-missing",
      "nope.sqlite",
    );
    const reply = executeHansardTool("hansard_search", { query: "budget" });
    expect(reply).toMatchObject({ ok: false, error: "hansard_not_installed" });
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

    const search = executeHansardTool("hansard_search", {
      query: "speaker",
      size: 5,
    }) as { ok: boolean; hits: Array<{ id: string; snippet: string | null }> };
    expect(search.ok).toBe(true);
    expect(search.hits.length).toBeGreaterThan(0);
    const first = search.hits[0];
    expect(first.id).toBeTruthy();

    const fetched = executeHansardTool("hansard_fetch", { id: first.id }) as {
      ok: boolean;
      intervention: { id: string; text: string };
    };
    expect(fetched.ok).toBe(true);
    expect(fetched.intervention.id).toBe(first.id);
    expect(fetched.intervention.text.length).toBeGreaterThan(0);

    const missing = executeHansardTool("hansard_fetch", { id: "no-such-id" });
    expect(missing).toMatchObject({
      ok: false,
      error: "hansard_intervention_not_found",
    });
  });
});
