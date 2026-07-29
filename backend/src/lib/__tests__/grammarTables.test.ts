import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GRAMMAR_TABLE_FORMAT,
  canonicalizeGroups,
  runGrammarVectors,
  validateGrammarPattern,
  type GrammarTable,
} from "../detect/grammarTables";

const TABLE_DIR = path.join(__dirname, "../../../../shared/grammar-tables");
const ENGINE_SRC = path.join(
  __dirname,
  "../../../../universal-legal-pdf-engine/src",
);

const loadTables = (): Array<[string, GrammarTable]> =>
  readdirSync(TABLE_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [
      name,
      JSON.parse(readFileSync(path.join(TABLE_DIR, name), "utf8")),
    ]);

describe("grammar table validator", () => {
  it("bans the divergent constructs", () => {
    expect(validateGrammarPattern("(?P<x>a)")).not.toHaveLength(0);
    expect(validateGrammarPattern("(?<=a)b")).not.toHaveLength(0);
    expect(validateGrammarPattern("(?<!a)b")).not.toHaveLength(0);
    expect(validateGrammarPattern("\\p{L}+")).not.toHaveLength(0);
    expect(validateGrammarPattern("(?i)case")).not.toHaveLength(0);
    expect(validateGrammarPattern("(?i:case)")).not.toHaveLength(0);
  });

  it("accepts the shared dialect", () => {
    expect(
      validateGrammarPattern("\\b(?<year>\\d{4})\\s+(?:SCC|FCA)\\s+\\d+\\b"),
    ).toHaveLength(0);
    expect(validateGrammarPattern("(?=x)(?!y)a")).toHaveLength(0);
  });
});

describe("canonicalization", () => {
  it("lowercases, strips, then maps", () => {
    expect(
      canonicalizeGroups(
        { court: "C.S.C" },
        {
          lowercase: ["court"],
          strip: { court: "." },
          map: { court: { csc: "scc" } },
        },
      ),
    ).toEqual({ court: "scc" });
  });
});

describe("shared tables", () => {
  const tables = loadTables();

  it("exist and carry the format tag", () => {
    expect(tables.length).toBeGreaterThan(0);
    for (const [, table] of tables) {
      expect(table.format).toBe(GRAMMAR_TABLE_FORMAT);
    }
  });

  it("pass every vector in JS", () => {
    for (const [name, table] of tables) {
      const failures = runGrammarVectors(table);
      expect(failures, `${name}: ${JSON.stringify(failures)}`).toHaveLength(0);
    }
  });

  it("pass every vector in Python (round-trip)", () => {
    const run = spawnSync(
      "python",
      ["-X", "utf8", "-m", "legalpdf.grammar_tables", "--check", TABLE_DIR],
      { cwd: ENGINE_SRC, encoding: "utf8", timeout: 60_000 },
    );
    expect(
      run.status,
      `python check failed:\n${run.stdout}\n${run.stderr}`,
    ).toBe(0);
    expect(run.stdout).toContain("ok (");
  });
});
