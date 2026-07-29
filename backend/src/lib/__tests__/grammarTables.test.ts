import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GRAMMAR_TABLE_FORMAT,
  canonicalizeGroups,
  compileGrammarEntry,
  expandGrammarPattern,
  expandWhitespaceEscapes,
  runGrammarVectors,
  validateGrammarEntry,
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

const pythonCheck = (dir: string) =>
  spawnSync(
    "python",
    ["-X", "utf8", "-m", "legalpdf.grammar_tables", "--check", dir],
    { cwd: ENGINE_SRC, encoding: "utf8", timeout: 60_000 },
  );

describe("grammar table validator", () => {
  it("bans the divergent constructs", () => {
    expect(validateGrammarPattern("(?P<x>a)")).not.toHaveLength(0);
    expect(validateGrammarPattern("\\p{L}+")).not.toHaveLength(0);
    expect(validateGrammarPattern("(?i)case")).not.toHaveLength(0);
    expect(validateGrammarPattern("(?i:case)")).not.toHaveLength(0);
    expect(validateGrammarPattern("\\u{1F600}")).not.toHaveLength(0);
  });

  it("accepts the shared dialect, including lookbehind and \\uXXXX", () => {
    expect(
      validateGrammarPattern("\\b(?<year>\\d{4})\\s+(?:SCC|FCA)\\s+\\d+\\b"),
    ).toHaveLength(0);
    expect(validateGrammarPattern("(?=x)(?!y)a")).toHaveLength(0);
    expect(validateGrammarPattern("(?<![\\w.])\\d+")).toHaveLength(0);
    expect(validateGrammarPattern("(?<=[.!?])\\s+see")).toHaveLength(0);
    expect(validateGrammarPattern("\\u00b6\\s?(?<para>\\d+)")).toHaveLength(0);
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

describe("defs expansion", () => {
  it("splices {{name}} fragments to a fixpoint", () => {
    expect(
      expandGrammarPattern("{{num}}(?:-{{num}})?", { num: "\\d{1,4}" }),
    ).toBe("\\d{1,4}(?:-\\d{1,4})?");
    expect(
      expandGrammarPattern("{{outer}}", { outer: "a{{inner}}z", inner: "b" }),
    ).toBe("abz");
  });

  it("throws on unknown names and on cycles", () => {
    expect(() => expandGrammarPattern("{{missing}}", {})).toThrow(
      /not defined/,
    );
    expect(() =>
      expandGrammarPattern("{{a}}", { a: "{{b}}", b: "{{a}}" }),
    ).toThrow(/cycle/);
  });

  it("validates and compiles through defs, so bans cannot hide in a def", () => {
    const entry = {
      id: "t.defs",
      pattern: "(?<v>{{num}})",
      flags: "",
      canonical: {},
      vectors: [],
    };
    expect(validateGrammarEntry(entry, { num: "\\d+" })).toHaveLength(0);
    const re = compileGrammarEntry(entry, { num: "\\d+" });
    expect(re.exec("para 42")?.groups?.v).toBe("42");
    expect(validateGrammarEntry(entry, { num: "(?i)\\d+" })).not.toHaveLength(
      0,
    );
  });
});

describe("whitespace expansion reproduces the source's Unicode \\s", () => {
  const entry = {
    id: "t.ws",
    pattern: "a\\s+b",
    flags: "",
    canonical: {},
    vectors: [],
  };

  it("matches NBSP and the \\x1c separators, refuses U+FEFF", () => {
    const re = compileGrammarEntry(entry);
    const test = (input: string) => {
      re.lastIndex = 0; // compiled global for iteration; .test is stateful
      return re.test(input);
    };
    expect(test("a b")).toBe(true);
    expect(test("a b")).toBe(true);
    expect(test("ab")).toBe(true);
    expect(test("a﻿b")).toBe(false);
  });

  it("expands inside character classes without brackets", () => {
    const expanded = expandWhitespaceEscapes("\\d[\\d\\s,-]*");
    expect(expanded.startsWith("\\d[\\d \\t")).toBe(true);
    const re = new RegExp(expanded, "g");
    expect("12, 34".match(re)?.[0]).toBe("12, 34");
  });

  it("refuses \\S inside a character class", () => {
    expect(() => expandWhitespaceEscapes("[\\S]")).toThrow(/character class/);
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
    const run = pythonCheck(TABLE_DIR);
    expect(
      run.status,
      `python check failed:\n${run.stdout}\n${run.stderr}`,
    ).toBe(0);
    expect(run.stdout).toContain("ok (");
  });
});

describe("the Python round-trip is the lookbehind gate", () => {
  it("holds fixed-width lookbehind and defs, refuses variable-width", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grammar-gate-"));
    try {
      writeFileSync(
        path.join(dir, "ok.json"),
        JSON.stringify({
          format: GRAMMAR_TABLE_FORMAT,
          defs: { num: "\\d{1,3}" },
          entries: [
            {
              id: "t.lookbehind.fixed",
              pattern: "(?<![\\w.]){{num}}\\s+OK\\b",
              flags: "",
              canonical: {},
              vectors: [
                { input: "see 42 OK", groups: {} },
                { input: "x.42 OK", groups: null },
              ],
            },
          ],
        }),
      );
      const ok = pythonCheck(dir);
      expect(ok.status, `${ok.stdout}\n${ok.stderr}`).toBe(0);

      // JS RegExp accepts arbitrary-width lookbehind; the shared dialect
      // must not, and it is Python's compile that enforces it.
      expect(() => new RegExp("(?<=ab|c)x")).not.toThrow();
      writeFileSync(
        path.join(dir, "variable.json"),
        JSON.stringify({
          format: GRAMMAR_TABLE_FORMAT,
          entries: [
            {
              id: "t.lookbehind.variable",
              pattern: "(?<=ab|c)x",
              flags: "",
              canonical: {},
              vectors: [{ input: "abx", groups: {} }],
            },
          ],
        }),
      );
      const bad = pythonCheck(dir);
      expect(bad.status).not.toBe(0);
      expect(bad.stdout).toContain("does not compile in Python");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
