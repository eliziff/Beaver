import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { legalDataHome, legalProviderDatabase } from "../legalDataPath";

describe("Mike and Table of Authorities shared-data contract", () => {
  it("resolve one A2AJ database under OPEN_LEGAL_DATA_HOME", () => {
    const override = path.join(os.tmpdir(), "open-legal-data-contract");
    const previous = process.env.OPEN_LEGAL_DATA_HOME;
    process.env.OPEN_LEGAL_DATA_HOME = override;
    try {
      const tableOfAuthorities = path.resolve(
        process.cwd(),
        "..",
        "TableOfAuthoritiesMaker",
      );
      const result = spawnSync(
        process.env.TOA_PYTHON?.trim() || "python",
        [
          "-c",
          [
            "import json",
            "from shared_legal_data import data_root, provider_directory",
            "print(json.dumps({'root': str(data_root()), 'a2aj': str(provider_directory('a2aj') / 'a2aj.sqlite')}))",
          ].join(";"),
        ],
        {
          cwd: tableOfAuthorities,
          env: process.env,
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const pythonPaths = JSON.parse(result.stdout) as {
        root: string;
        a2aj: string;
      };
      expect(path.normalize(pythonPaths.root)).toBe(
        path.normalize(legalDataHome()),
      );
      expect(path.normalize(pythonPaths.a2aj)).toBe(
        path.normalize(legalProviderDatabase("a2aj", "a2aj.sqlite")),
      );
    } finally {
      if (previous === undefined) delete process.env.OPEN_LEGAL_DATA_HOME;
      else process.env.OPEN_LEGAL_DATA_HOME = previous;
    }
  });
});
