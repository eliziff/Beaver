import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { compileA2AJSourceDoc } from "../sourceDocA2AJ";

const backend = path.resolve(__dirname, "../../..");
const text = Array.from(
  { length: 5 },
  (_, index) =>
    `[${index + 1}] This paragraph contains enough ordinary substantive ` +
    "words to establish one complete decision paragraph for the comparator.",
).join("\n");
const request = {
  citation: "2026 TEST 1",
  dataset: "TEST",
  docType: "cases" as const,
  text,
};
const actual = compileA2AJSourceDoc(request).blocks
  .filter((block) => block.kind === "paragraph" && !block.parentLabel)
  .map(({ label, start, end }) => ({ label, start, end }));

function row(reference: typeof actual) {
  return {
    sourceKind: "case",
    dataset: "TEST",
    language: "en",
    citation: request.citation,
    alternateCitation: "",
    name: "",
    chars: text.length,
    sectionMap: null,
    referenceSource: "alr_compatibility",
    reference: { paragraph: reference, page: [], section: [] },
    text,
  };
}

function run(rows: ReturnType<typeof row>[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "skeleton-diff-"));
  const probe = path.join(directory, "probe.jsonl");
  try {
    writeFileSync(
      probe,
      `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`,
      "utf8",
    );
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/skeleton-oracle-diff.ts", probe],
      { cwd: backend, encoding: "utf8" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("classifies only complete additions and gapless interval refinements", () => {
  expect(actual).toHaveLength(5);
  const additive = actual.filter((_, index) => index % 2 === 0);
  const refined = [
    { ...actual[0], end: actual[2].end },
    ...actual.slice(3),
  ];
  const accepted = run([row(actual), row(additive), row(refined)]);

  expect(accepted.status, accepted.stderr).toBe(0);
  expect(accepted.stdout).toContain(
    "alr_compatibility\tTEST\t4\t1\t1\t0\t0",
  );
  expect(accepted.stdout).toContain(
    "1 additive result(s); 1 strict refinement(s)",
  );

  const lost = [
    ...actual,
    { label: "par6", start: text.length, end: text.length + 1 },
  ];
  const changed = [{ ...actual[0], start: actual[0].start + 1 }, ...actual.slice(1)];
  const overrun = [
    { ...actual[0], end: actual[2].end + 1 },
    ...actual.slice(4),
  ];
  const rejected = run([row(lost), row(changed), row(overrun)]);

  expect(rejected.status).toBe(1);
  expect(rejected.stdout).toContain(
    "alr_compatibility\tTEST\t3\t0\t0\t1\t2",
  );
  expect(rejected.stderr).toContain(
    "0 additive gain(s), 0 strict refinement(s), 1 loss(es), " +
      "2 changed result(s); 3 policy failure(s)",
  );
});
