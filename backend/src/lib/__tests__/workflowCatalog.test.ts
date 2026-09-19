import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../localDatabase";
import { createFilesystemObjectStorage } from "../storage";
import { createWorkflowCatalog, validateWorkflowCatalog } from "../workflowCatalog";
import { createWorkflowCatalogRepository } from "../relationalWorkflowCatalogRepository";
import { SYSTEM_WORKFLOWS, SYSTEM_WORKFLOW_SNAPSHOT, assistantWorkflows } from "../systemWorkflows";
import { sha256 } from "../hash";

let database: LocalDatabase, directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "beaver-catalog-"));
  const native = new DatabaseSync(":memory:");
  native.exec(/-- BEAVER_CORE_BEGIN\s*([\s\S]*?)\s*-- BEAVER_CORE_END/u
    .exec(readFileSync("schema.sql", "utf8"))![1]);
  database = new LocalDatabase(native);
});
afterEach(async () => { await database.close(); await rm(directory, { recursive: true, force: true }); });
const snapshot = () => ({ schemaVersion: 1 as const, sourceCommit: "a".repeat(40),
  workflows: structuredClone(SYSTEM_WORKFLOWS), assets: [] as Array<{
    workflowId: string; filename: string; sha256: string; sizeBytes: number; contentType: string;
  }> });
const load = () => createWorkflowCatalog(createWorkflowCatalogRepository(database), createFilesystemObjectStorage(directory));

describe("installed workflow catalogue", () => {
  it("ships every bundled template with verified bytes without an object-store installation", async () => {
    const catalog = load(), bundled = await catalog.current();
    expect(bundled.assets.length).toBeGreaterThan(0);
    for (const reference of bundled.assets) {
      const asset = await catalog.asset(reference.workflowId, reference.filename);
      expect(sha256(asset!.bytes)).toBe(reference.sha256);
      const zip = await (await import("jszip")).default.loadAsync(asset!.bytes);
      expect(zip.file("word/document.xml")).not.toBeNull();
    }
  });
  it("uses the bundled snapshot until an explicit installation and reopens the selected instructions offline", async () => {
    const catalog = load();
    expect((await catalog.current()).sourceCommit).toBe(SYSTEM_WORKFLOW_SNAPSHOT.sourceCommit);
    expect(await catalog.workflows()).toEqual(SYSTEM_WORKFLOWS);
    const candidate = snapshot();
    const workflow = candidate.workflows.find((item) => item.launcher.kind === "instructions")!;
    if (workflow.launcher.kind !== "instructions") throw new Error("Missing fixture");
    workflow.launcher.variants[0].skill_md = "Use the updated instructions.";
    const bytes = Buffer.from("Reference agreement");
    candidate.assets.push({ workflowId: workflow.id, filename: "Agreement.txt", sha256: sha256(bytes),
      sizeBytes: bytes.length, contentType: "text/plain" });
    await catalog.install(candidate, async () => bytes);
    const reopened = load();
    expect((await reopened.current())?.sourceCommit).toBe(candidate.sourceCommit);
    expect(assistantWorkflows(await reopened.workflows()).find((item) => item.id === workflow.id)?.skill_md)
      .toBe("Use the updated instructions.");
    expect((await reopened.asset(workflow.id, "Agreement.txt"))?.bytes).toEqual(bytes);
    const assistants = await reopened.assistants();
    expect(await assistants.get(workflow.launcher.variants[0].id)?.references?.[0].read())
      .toBe("Reference agreement");
    // A running turn retains its captured revision when an operator installs another.
    await catalog.install(snapshot(), async () => Buffer.alloc(0));
    expect(await assistants.get(workflow.launcher.variants[0].id)?.references?.[0].read())
      .toBe("Reference agreement");
    expect(await reopened.asset("missing", "Agreement.txt")).toBeNull();
  });

  it("leaves the active revision untouched when an asset fails verification", async () => {
    const catalog = load(), original = snapshot();
    await catalog.install(original, async () => Buffer.alloc(0));
    const candidate = snapshot(); candidate.sourceCommit = "b".repeat(40);
    candidate.assets.push({ workflowId: original.workflows[0].id, filename: "Reference.txt",
      sha256: sha256("expected"), sizeBytes: 8, contentType: "text/plain" });
    await expect(catalog.install(candidate, async () => Buffer.from("tampered"))).rejects.toThrow("integrity");
    expect((await catalog.current())?.sourceCommit).toBe(original.sourceCommit);
  });

  it("rejects duplicate recipes, unbound assets and removal of application launchers", () => {
    const duplicate = snapshot(); duplicate.workflows.push(duplicate.workflows[0]);
    expect(() => validateWorkflowCatalog(duplicate)).toThrow("Duplicate workflow");
    const missing = snapshot(); missing.workflows = missing.workflows.filter((item) => item.id !== "authorities");
    expect(() => validateWorkflowCatalog(missing)).toThrow("authorities");
    const unbound = snapshot(); unbound.assets.push({ workflowId: "missing", filename: "reference.txt",
      sha256: sha256("x"), sizeBytes: 1, contentType: "text/plain" });
    expect(() => validateWorkflowCatalog(unbound)).toThrow("binding");
  });
});
