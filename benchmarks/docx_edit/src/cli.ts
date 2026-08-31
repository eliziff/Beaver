/**
 * docx-edit-bench CLI. Run from the backend workspace, which owns the
 * node_modules the fixture builders resolve through:
 *
 *   npx tsx ../benchmarks/docx_edit/src/cli.ts self-test
 *   npx tsx ../benchmarks/docx_edit/src/cli.ts manifest --write
 *   npx tsx ../benchmarks/docx_edit/src/cli.ts list
 *   npx tsx ../benchmarks/docx_edit/src/cli.ts dump --fixture sunrise-spa
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { openDocxSession } from "../../../backend/scripts/docx-edit-bench-bridge";
import { FIXTURES, fixtureBytes, fixtureText } from "./fixtures";
import { loadTasks } from "./tasks";
import { selfTestAll, selfTestFixturePackages } from "./selftest";
import { BENCH_VERSION, MANIFEST_SCHEMA } from "./types";

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Key-sorted at every depth, so a manifest diff is a real change. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const argOf = (name: string, fallback = "") => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const listArg = (name: string) =>
  argOf(name)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

async function countPackageEntries(
  session: { readText(path: string): Promise<string | null> },
  part: string,
  element: string,
  minimumId: number,
) {
  const xml = await session.readText(part);
  if (!xml) return 0;
  const pattern = new RegExp(
    `<w:${element}\\b[^>]*\\bw:id=["'](-?\\d+)["']`,
    "gu",
  );
  return [...xml.matchAll(pattern)].filter(
    (match) => Number(match[1]) >= minimumId,
  ).length;
}

async function manifestRows() {
  const tasks = loadTasks();
  const rows: Record<string, unknown>[] = [];
  for (const spec of FIXTURES) {
    const bytes = await fixtureBytes(spec.id);
    const text = await fixtureText(spec.id);
    const session = await openDocxSession(bytes);
    const document = await session.document(spec.id);
    const pageMarkers = [...text.matchAll(/^\[page\s+([^\]]+)\]\s*$/gimu)];
    const manualRedlineLikely = document.paragraphs.some((paragraph) =>
      paragraph.events.some(
        (event) =>
          event.kind === "run" &&
          (event.run.strike || event.run.color?.toUpperCase() === "FF0000"),
      ),
    );
    const [footnotes, endnotes, comments] = await Promise.all([
      countPackageEntries(session, "word/footnotes.xml", "footnote", 1),
      countPackageEntries(session, "word/endnotes.xml", "endnote", 1),
      countPackageEntries(session, "word/comments.xml", "comment", 0),
    ]);
    rows.push({
      schema: MANIFEST_SCHEMA,
      benchmark_version: BENCH_VERSION,
      kind: "fixture",
      id: spec.id,
      filename: spec.filename,
      family: spec.family,
      character: spec.character,
      jurisdiction: spec.jurisdiction ?? null,
      /** Real-world documents carry their source and licence; generated ones do not. */
      real_world: spec.family === "real",
      provenance: spec.provenance ?? null,
      /** Authoritative identity: the plane checks and tools both see. */
      text_sha256: sha256(text),
      text_chars: text.length,
      text_lines: text.split("\n").length,
      structure: {
        paragraphs: document.paragraphs.length,
        blocks: document.blocks.length,
        tables: document.blocks.filter((block) => block.kind === "tbl").length,
        page_source: pageMarkers.length ? "markers" : "unpaginated",
        pages: pageMarkers.length,
      },
      features: {
        tracked_insertions: document.trackedChanges.filter(
          (change) => change.kind === "ins",
        ).length,
        tracked_deletions: document.trackedChanges.filter(
          (change) => change.kind === "del",
        ).length,
        manual_redline_likely: manualRedlineLikely,
        headers: session.paths.filter((entry) =>
          /^word\/header\d+\.xml$/u.test(entry),
        ).length,
        footers: session.paths.filter((entry) =>
          /^word\/footer\d+\.xml$/u.test(entry),
        ).length,
        footnotes,
        endnotes,
        comments,
      },
      used_by_tasks: tasks
        .filter((task) => task.fixtures.includes(spec.id))
        .map((task) => task.id),
    });
  }
  for (const task of tasks) {
    rows.push({
      schema: MANIFEST_SCHEMA,
      benchmark_version: BENCH_VERSION,
      kind: "task",
      id: task.id,
      set: task.set ?? "v1",
      task_version: task.version,
      jurisdiction: task.jurisdiction ?? null,
      practice_area: task.practice_area ?? null,
      difficulty: task.difficulty,
      floor_task: task.floor_task === true,
      categories: task.categories,
      expected: task.expected,
      fixtures: task.fixtures,
      target_fixture: task.target_fixture,
      instruction_sha256: sha256(task.instruction),
      checks_sha256: sha256(JSON.stringify(task.checks)),
      targets: task.checks.targets.length,
      guards: task.checks.guards.length,
      near_misses: task.near_misses.length,
    });
  }
  return rows;
}

async function main() {
  const command = process.argv[2] ?? "list";

  if (command === "list") {
    const tasks = loadTasks();
    console.log(`${BENCH_VERSION}: ${tasks.length} tasks, ${FIXTURES.length} fixtures`);
    for (const task of tasks) {
      console.log(
        `${task.id.padEnd(28)} ${task.difficulty.padEnd(8)} ${task.expected.padEnd(6)} ` +
          `${String(task.checks.targets.length).padStart(2)}T/${String(task.checks.guards.length).padStart(2)}G ` +
          `${task.categories.join(",")}`,
      );
    }
    return;
  }

  if (command === "dump") {
    const id = argOf("fixture");
    const text = await fixtureText(id);
    console.log(
      text
        .split("\n")
        .map((line, index) => `${String(index + 1).padStart(4)}|${line}`)
        .join("\n"),
    );
    return;
  }

  if (command === "manifest") {
    const rows = await manifestRows();
    const body = rows.map((row) => canonicalJson(row)).join("\n");
    if (process.argv.includes("--write")) {
      const target = path.join(__dirname, "..", "manifest.jsonl");
      writeFileSync(target, `${body}\n`, "utf8");
      console.log(`wrote ${rows.length} rows to ${target}`);
    } else {
      console.log(body);
    }
    return;
  }

  if (command === "self-test") {
    const packages = await selfTestFixturePackages();
    console.log(
      `${packages.failures.length ? "FAIL" : "ok  "} ${packages.checked - packages.failures.length}/${packages.checked} fixture packages survive a no-op DOCX session unchanged.\n`,
    );
    for (const id of packages.failures) console.log(`      package changed: ${id}`);
    const results = await selfTestAll(listArg("task"));
    const verbose = process.argv.includes("--verbose");
    let solvable = 0;
    let discriminating = 0;
    const neverFired: string[] = [];
    for (const result of results) {
      const wrongCases = result.cases.filter((entry) => entry.expected === "fail");
      const caught = wrongCases.filter((entry) => entry.ok).length;
      const flag = result.solvable && result.discriminating ? "ok  " : "FAIL";
      console.log(
        `${flag} ${result.task_id.padEnd(28)} solvable=${result.solvable ? "yes" : "NO "} ` +
          `wrong-results-caught=${caught}/${wrongCases.length} ` +
          `${result.sites_never_fired.length ? `unexercised=${result.sites_never_fired.length}` : ""}`,
      );
      if (result.solvable) solvable += 1;
      if (result.discriminating) discriminating += 1;
      for (const id of result.sites_never_fired) neverFired.push(`${result.task_id}/${id}`);
      if (!result.solvable) {
        for (const note of result.solvability_notes) console.log(`      solvability: ${note}`);
      }
      for (const entry of wrongCases.filter((c) => !c.ok)) {
        console.log(`      NOT CAUGHT: ${entry.case_id} — ${entry.why}`);
      }
      if (verbose) {
        for (const entry of result.cases) {
          console.log(
            `      ${entry.case_id.padEnd(30)} ${entry.expected}->${entry.actual} fired=[${entry.fired.join(", ")}]`,
          );
        }
      }
    }
    console.log(
      `\n${results.length} tasks: ${solvable} with a verified reference solution, ` +
        `${discriminating} rejecting every wrong result.`,
    );
    if (neverFired.length) {
      console.log(
        `\n${neverFired.length} site check(s) never observed failing (no demonstrated sensitivity):`,
      );
      for (const id of neverFired) console.log(`  ${id}`);
    }
    process.exit(
      !packages.failures.length &&
        solvable === results.length &&
        discriminating === results.length
        ? 0
        : 1,
    );
  }

  console.error(`unknown command '${command}'`);
  process.exit(2);
}

main().catch((error) => {
  console.error("[docx-edit-bench]", error);
  process.exit(1);
});
