/**
 * Beaver-CAN schema and three-task vertical slice (Issue 2).
 *
 * Proves the done-criteria: the three development task fixtures validate end
 * to end; the committed JSON Schema files match the zod source of truth; and
 * intentionally corrupted tasks, gold, manifests, and sources fail validation
 * for the expected reason.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BEAVER_CAN_DIR,
  beaverCanGoldSchema,
  beaverCanJsonSchemas,
  beaverCanSourceManifestSchema,
  beaverCanTaskSchema,
  checkBeaverCanGold,
  listBeaverCanDevTaskDirs,
  loadBeaverCanTaskDir,
  type BeaverCanGold,
} from "../beaverCan";

const RESEARCH = path.join(BEAVER_CAN_DIR, "tasks", "dev", "CAN-RESEARCH-001");
const CONTEXT = path.join(BEAVER_CAN_DIR, "tasks", "dev", "CAN-CONTEXT-001");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Copy a task dir to a temp location so a corruption test can edit files. */
function corruptedCopy(taskDir: string): string {
  const parent = mkdtempSync(path.join(tmpdir(), "beaver-can-"));
  tempDirs.push(parent);
  const copy = path.join(parent, path.basename(taskDir));
  cpSync(taskDir, copy, { recursive: true });
  return copy;
}

function editJson(
  taskDir: string,
  file: string,
  edit: (value: any) => void,
): void {
  const filePath = path.join(taskDir, file);
  const value = JSON.parse(readFileSync(filePath, "utf8"));
  edit(value);
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

describe("beaver-can fixtures", () => {
  it("ships the original vertical-slice development tasks", () => {
    // Issue 6 grows the dev set beyond the vertical slice; the slice itself
    // must never disappear.
    expect(
      listBeaverCanDevTaskDirs().map((dir) => path.basename(dir)),
    ).toEqual(
      expect.arrayContaining([
        "CAN-CONTEXT-001",
        "CAN-RESEARCH-001",
        "CAN-RETRIEVAL-001",
      ]),
    );
  });

  it("validates every development task end to end", () => {
    for (const dir of listBeaverCanDevTaskDirs()) {
      const loaded = loadBeaverCanTaskDir(dir);
      expect(loaded.task.id).toBe(path.basename(dir));
      expect(loaded.sources.length).toBe(loaded.task.source_ids.length);
    }
  });

  it("covers the three task types with the required task shapes", () => {
    const byId = new Map(
      listBeaverCanDevTaskDirs().map((dir) => {
        const loaded = loadBeaverCanTaskDir(dir);
        return [loaded.task.id, loaded] as const;
      }),
    );
    expect(byId.get("CAN-RESEARCH-001")?.task.task_type).toBe(
      "closed_source_research",
    );
    expect(byId.get("CAN-RETRIEVAL-001")?.task.task_type).toBe("retrieval");

    const retrieval = byId.get("CAN-RETRIEVAL-001");
    expect(
      retrieval?.sources.filter((source) => source.role === "distractor")
        .length,
    ).toBeGreaterThanOrEqual(3);

    const context = byId.get("CAN-CONTEXT-001");
    expect(context?.task.task_type).toBe("long_thread");
    // §4 vertical slice: superseded instruction, replacement document, early
    // formatting requirement, surviving quotation, seeded identifier.
    expect(context?.task.fatal_errors).toContain("superseded_instruction");
    expect(context?.task.fatal_errors).toContain("seeded_identifier_leak");
    expect(context?.gold.required_quotations?.length).toBe(1);
    expect(context?.gold.seeded_identifiers?.length).toBe(1);
    expect(
      context?.sources.find((source) => source.source_id === "SRC-002"),
    ).toMatchObject({ role: "matter_document" });
    expect(context?.prompt).toContain("MEMORANDUM OF LAW");
  });

  it("keeps the committed JSON Schema files in sync with the zod contracts", () => {
    const generated = beaverCanJsonSchemas();
    for (const [name, schema] of [
      ["task.schema.json", generated.task],
      ["gold.schema.json", generated.gold],
      ["source_manifest.schema.json", generated.source_manifest],
    ] as const) {
      expect(
        JSON.parse(readFileSync(path.join(BEAVER_CAN_DIR, name), "utf8")),
        `${name} drifted — regenerate from beaverCanJsonSchemas()`,
      ).toEqual(schema);
    }
  });
});

describe("beaver-can schema strictness", () => {
  const validTask = () =>
    JSON.parse(readFileSync(path.join(RESEARCH, "task.json"), "utf8"));
  const validGold = () =>
    JSON.parse(readFileSync(path.join(RESEARCH, "gold.json"), "utf8"));

  it("rejects unknown keys on task, gold, and manifest", () => {
    expect(
      beaverCanTaskSchema.safeParse({ ...validTask(), extra: 1 }).success,
    ).toBe(false);
    expect(
      beaverCanGoldSchema.safeParse({ ...validGold(), model_answer: "prose" })
        .success,
    ).toBe(false);
    const manifest = JSON.parse(
      readFileSync(path.join(RESEARCH, "sources", "manifest.json"), "utf8"),
    );
    expect(
      beaverCanSourceManifestSchema.safeParse({ ...manifest, notes: "x" })
        .success,
    ).toBe(false);
  });

  it("rejects malformed task fields", () => {
    for (const edit of [
      { id: "RESEARCH-1" },
      { jurisdiction: "US-NY" },
      { law_as_of: "June 30, 2026" },
      { task_type: "open_research" },
      { source_ids: [] },
      { fatal_errors: ["hallucination"] },
      { deliverable: { type: "memorandum", required_filename: "../answer.docx" } },
    ]) {
      expect(
        beaverCanTaskSchema.safeParse({ ...validTask(), ...edit }).success,
        JSON.stringify(edit),
      ).toBe(false);
    }
  });

  it("rejects malformed gold fields", () => {
    for (const edit of [
      { required_issues: ["ISSUE-1"] },
      { required_authorities: [] },
      {
        required_authorities: [
          { source_id: "SRC-001", proposition_id: "PROP-01", acceptable_pinpoints: [] },
        ],
      },
      { required_conclusions: [{ id: "CONCLUSION-01", acceptable: ["maybe"] }] },
      { forbidden_claims: ["do not fabricate"] },
    ]) {
      expect(
        beaverCanGoldSchema.safeParse({ ...validGold(), ...edit }).success,
        JSON.stringify(edit),
      ).toBe(false);
    }
  });
});

describe("beaver-can corrupted fixtures fail for the expected reason", () => {
  const loadResearch = () => loadBeaverCanTaskDir(RESEARCH);

  it("gold pinpoint that does not exist in the source", () => {
    const { task, gold, sources } = loadResearch();
    const corrupted = structuredClone(gold) as BeaverCanGold;
    corrupted.required_authorities[0].acceptable_pinpoints = ["231(99)"];
    expect(() => checkBeaverCanGold(RESEARCH, task, corrupted, sources)).toThrow(
      /pinpoint 231\(99\).*does not exist/u,
    );
  });

  it("gold authority outside the source packet", () => {
    const { task, gold, sources } = loadResearch();
    const corrupted = structuredClone(gold) as BeaverCanGold;
    corrupted.required_authorities[0].source_id = "SRC-009";
    expect(() => checkBeaverCanGold(RESEARCH, task, corrupted, sources)).toThrow(
      /SRC-009 is not in the source packet/u,
    );
  });

  it("gold quotation tampered so it no longer occurs at its pinpoint", () => {
    const { task, gold, sources } = loadBeaverCanTaskDir(CONTEXT);
    const corrupted = structuredClone(gold) as BeaverCanGold;
    corrupted.required_quotations![0].quote =
      "An occupier of premises owes an absolute duty to insure that persons entering on the premises are safe.";
    expect(() => checkBeaverCanGold(CONTEXT, task, corrupted, sources)).toThrow(
      /quote not found at any acceptable pinpoint of SRC-001/u,
    );
  });

  it("seeded identifier that is not actually seeded in any source", () => {
    const { task, gold, sources } = loadBeaverCanTaskDir(CONTEXT);
    const corrupted = structuredClone(gold) as BeaverCanGold;
    corrupted.seeded_identifiers = ["SEED-NOT-PLANTED-ANYWHERE"];
    expect(() => checkBeaverCanGold(CONTEXT, task, corrupted, sources)).toThrow(
      /not seeded in any packet source/u,
    );
  });

  it("gold id without a definition, and orphan definitions", () => {
    const { task, gold, sources } = loadResearch();
    const missing = structuredClone(gold) as BeaverCanGold;
    delete missing.definitions["CLAIM-01"];
    expect(() => checkBeaverCanGold(RESEARCH, task, missing, sources)).toThrow(
      /missing definition for CLAIM-01/u,
    );
    const orphan = structuredClone(gold) as BeaverCanGold;
    orphan.definitions["CLAIM-99"] = "never referenced";
    expect(() => checkBeaverCanGold(RESEARCH, task, orphan, sources)).toThrow(
      /CLAIM-99 is defined but never referenced/u,
    );
  });

  it("tampered source content no longer matches the manifest hash", () => {
    const copy = corruptedCopy(CONTEXT);
    const report = path.join(copy, "sources", "incident-report-v2.md");
    writeFileSync(
      report,
      readFileSync(report, "utf8").replace("2026-03-14", "2026-03-15"),
      "utf8",
    );
    expect(() => loadBeaverCanTaskDir(copy)).toThrow(/content hash .* != manifest sha256/u);
  });

  it("manifest that drops a packet source", () => {
    const copy = corruptedCopy(RESEARCH);
    editJson(copy, path.join("sources", "manifest.json"), (manifest) => {
      manifest.sources.pop();
    });
    expect(() => loadBeaverCanTaskDir(copy)).toThrow(/!= task source_ids/u);
  });

  it("task file with an out-of-contract field", () => {
    const copy = corruptedCopy(RESEARCH);
    editJson(copy, "task.json", (task) => {
      task.allow_web_search = true;
    });
    expect(() => loadBeaverCanTaskDir(copy)).toThrow(/allow_web_search/u);
  });

  it("long-thread prompt stripped of its scripted turns", () => {
    const copy = corruptedCopy(CONTEXT);
    const prompt = path.join(copy, "prompt.md");
    writeFileSync(
      prompt,
      readFileSync(prompt, "utf8").replaceAll("## TURN-", "## STEP-"),
      "utf8",
    );
    expect(() => loadBeaverCanTaskDir(copy)).toThrow(
      /must script at least two ## TURN-nn headings/u,
    );
  });
});
