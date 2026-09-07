import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const checker = readFileSync(new URL("./check-docs.mjs", import.meta.url), "utf8");
function check(files = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "beaver-docs-"));
  try {
    mkdirSync(path.join(root, "docs/harvey-labs/protocols"), { recursive: true });
    for (const [name, content] of Object.entries({
      "docs/scripts/check-docs.mjs": checker,
      "docs/README.md": "# Documentation\n",
      "docs/roadmap/master-plan.md": "# Remaining work\n",
      "docs/harvey-labs/README.md": "Runner version | Result | Decision | Reproduction\n",
      "README.md": "[Documentation](docs/README.md)\n",
      ...files,
    })) {
      const file = path.join(root, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const result = spawnSync(process.execPath, [path.join(root, "docs/scripts/check-docs.mjs")], {
      encoding: "utf8", timeout: 10_000,
    });
    if (result.error) throw result.error;
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts linked documentation with optional root guides absent", () => {
  const result = check();
  assert.equal(result.status, 0, result.stderr);
});

test("checks each root guide rather than only documents beneath docs", () => {
  for (const name of ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md", "SECURITY.md"]) {
    const result = check({ [name]: "[Missing guide](missing.md)\n" });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`broken link: ${name} -> missing.md`), result.stderr);
  }
});

test("rejects a loose top-level plan", () => {
  const result = check({ "docs/second-plan.md": "# Competing plan\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uncatalogued top-level document/);
});

test("requires remaining-work spokes to be linked by the master plan", () => {
  const result = check({ "docs/roadmap/feature.md": "# Feature\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /roadmap spoke missing from master-plan hub/);
});
