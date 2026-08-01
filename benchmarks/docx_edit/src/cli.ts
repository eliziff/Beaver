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
import {
  compileAgreementSkeleton,
  pageMapFromMarkers,
  scanDocxPathology,
} from "../../../backend/scripts/docx-edit-bench-bridge";
import { FIXTURES, fixtureBytes, fixtureText } from "./fixtures";
import { loadTasks } from "./tasks";
import { selfTestAll } from "./selftest";
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

async function manifestRows() {
  const tasks = loadTasks();
  const rows: Record<string, unknown>[] = [];
  for (const spec of FIXTURES) {
    const bytes = await fixtureBytes(spec.id);
    const text = await fixtureText(spec.id);
    const skeleton = compileAgreementSkeleton(text);
    const pages = pageMapFromMarkers(text);
    const pathology = (await scanDocxPathology(bytes)) as Record<string, any>;
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
      /** Informational: the packager stamps times, so bytes are not stable. */
      bytes_sha256_sample: sha256(bytes),
      bytes_length_sample: bytes.byteLength,
      structure: {
        handles: skeleton.nodes.length,
        page_source: pages.source,
        pages: pages.pages.length,
      },
      features: {
        tracked_insertions: pathology?.tracked_changes?.insertions ?? 0,
        tracked_deletions: pathology?.tracked_changes?.deletions ?? 0,
        manual_redline_likely: pathology?.manual_redline?.likely === true,
        notes_of_caution: pathology?.notes_of_caution ?? [],
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

  if (command === "surface") {
    // Prints exactly what the model is shown. Run once per surface before a
    // campaign: the source comments are not evidence, the served schema is.
    // One surface per process: the tool module reads its shape from the
    // environment at import time, so a second surface in the same process
    // would report the first one's schema.
    const { applySurface, surfaceById } = await import("./surface");
    const surface = surfaceById(argOf("id"));
    {
      for (const [key, value] of Object.entries(surface.env)) process.env[key] = value;
      const { LOCAL_ASSISTANT_TOOLS, partitionTools } = await import(
        "../../../backend/src/lib/chat/localAssistantTools"
      );
      const tools = applySurface(LOCAL_ASSISTANT_TOOLS, surface);
      const partition = surface.tools?.no_disclosure
        ? { resident: tools, deferred: [] }
        : partitionTools(tools);
      const bytes = (list: unknown) => Buffer.byteLength(JSON.stringify(list));
      console.log(
        `\n[disclosure] resident ${partition.resident.length} tools / ${bytes(partition.resident).toLocaleString("en-CA")} schema bytes; ` +
          `deferred ${partition.deferred.length} / ${bytes(partition.deferred).toLocaleString("en-CA")}; ` +
          `full ${tools.length} / ${bytes(tools).toLocaleString("en-CA")}`,
      );
      if (partition.deferred.length) {
        console.log(`  resident: ${partition.resident.map((e) => e.function.name).join(", ")}`);
        console.log(`  deferred: ${partition.deferred.map((e) => e.function.name).join(", ")}`);
      }
      const interesting = new Set([
        "Glob",
        "Grep",
        "Read",
        "Edit",
        "library_list",
        "library_outline",
        "library_read",
        "library_find",
        "library_links",
        "library_revise_docx",
        "library_apply_text_ops",
        "ask_inputs",
      ]);
      console.log(`\n### ${surface.id}  (${tools.length} tools, env ${JSON.stringify(surface.env)})`);
      for (const entry of tools) {
        if (!interesting.has(entry.function.name)) continue;
        const properties = (entry.function.parameters?.properties ?? {}) as Record<string, any>;
        let extra = "";
        if (entry.function.name === "library_apply_text_ops") {
          const scope = properties.ops.items.properties.scope;
          extra = `  scope.kind=[${scope.properties.kind.enum.join("|")}] scope.props=[${Object.keys(scope.properties).sort().join(",")}]`;
        }
        console.log(`  ${entry.function.name.padEnd(24)} ${Object.keys(properties).sort().join(",")}${extra}`);
      }
    }
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
    process.exit(solvable === results.length && discriminating === results.length ? 0 : 1);
  }

  console.error(`unknown command '${command}'`);
  process.exit(2);
}

main().catch((error) => {
  console.error("[docx-edit-bench]", error);
  process.exit(1);
});
