import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-preferences-"));
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
  vi.stubEnv("AUTH_MODE", "local");
});

afterEach(async () => {
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

describe("shared user preferences repository", () => {
  it("persists onboarding and preserves fields omitted by later patches", async () => {
    let databaseModule = await import("../relationalDatabase");
    let repositoryModule = await import("../relationalUserPreferencesRepository");
    let repository = repositoryModule.createUserPreferencesRepository(
      await databaseModule.relationalDatabase(),
    );

    await repository.update("user-1", {
      displayName: "Ada",
      practiceAreas: ["appeals", "employment"],
      onboardingCompleted: true,
      features: { authorities: false },
      workflowFileTargets: {
        "court-records": { kind: "library", folderId: "court-folder" },
        authorities: { kind: "project", projectId: "matter-1", folderId: "authorities-folder" },
      },
      filingContact: { name: "Ada Lawyer", address: "1 Court Street",
        phone: "555-0100", fax: "", email: "ada@example.test" },
    });
    await repository.update("user-1", { organisation: "Example LLP" });

    expect(await repository.get("user-1")).toMatchObject({
      displayName: "Ada",
      organisation: "Example LLP",
      practiceAreas: ["appeals", "employment"],
      onboardingCompleted: true,
      features: { authorities: false },
      workflowFileTargets: {
        "court-records": { kind: "library", folderId: "court-folder" },
        authorities: { kind: "project", projectId: "matter-1", folderId: "authorities-folder" },
      },
      filingContact: { name: "Ada Lawyer", address: "1 Court Street",
        phone: "555-0100", email: "ada@example.test" },
    });

    await databaseModule.closeRelationalDatabase();
    vi.resetModules();
    databaseModule = await import("../relationalDatabase");
    repositoryModule = await import("../relationalUserPreferencesRepository");
    repository = repositoryModule.createUserPreferencesRepository(
      await databaseModule.relationalDatabase(),
    );
    await expect(repository.get("user-1")).resolves.toMatchObject({
      displayName: "Ada",
      organisation: "Example LLP",
      onboardingCompleted: true,
      features: { authorities: false },
      workflowFileTargets: {
        "court-records": { kind: "library", folderId: "court-folder" },
        authorities: { kind: "project", projectId: "matter-1", folderId: "authorities-folder" },
      },
      filingContact: { name: "Ada Lawyer", address: "1 Court Street",
        phone: "555-0100", email: "ada@example.test" },
    });
  });
});
