import { describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "./documentStore";
import type { LibraryStore } from "./libraryStore";
import type { ProjectStore } from "./projectStore";
import { DEFAULT_USER_PREFERENCES, type UserPreferencesRepository } from "./userPreferences";
import { createWorkflowFiles } from "./workflowFiles";

const scope = { userId: "owner" };

function setup(targets = structuredClone(DEFAULT_USER_PREFERENCES.workflowFileTargets)) {
  let preferences = { ...structuredClone(DEFAULT_USER_PREFERENCES),
    workflowFileTargets: targets };
  const preferenceStore = {
    get: vi.fn(async () => structuredClone(preferences)),
    update: vi.fn(async (_userId, patch) => {
      preferences = { ...preferences, ...structuredClone(patch) };
      return structuredClone(preferences);
    }),
  } as UserPreferencesRepository;
  const library = {
    folder: vi.fn(async () => null),
    page: vi.fn(async () => ({ items: [], nextAfter: null })),
    createFolder: vi.fn(async (_scope, name) => ({ id: `folder-${name}`,
      name, parent_folder_id: null })),
    ensureRootFolder: vi.fn(async (_scope, name) => ({ id: `folder-${name}`,
      name, parent_folder_id: null })),
  } as unknown as LibraryStore;
  const projects = { getFolder: vi.fn(async () => null),
    ensureRootFolder: vi.fn(async (_scope, _projectId, name) => ({ id: `folder-${name}`,
      name, parent_folder_id: null })) } as unknown as ProjectStore;
  return { library, projects, preferenceStore,
    files: createWorkflowFiles({} as DocumentStore, library, preferenceStore, projects) };
}

describe("workflow file targets", () => {
  it("coalesces concurrent first use into one contained workflow folder", async () => {
    const { files, library } = setup();
    const [first, second] = await Promise.all([
      files.target(scope, "court-records"), files.target(scope, "court-records"),
    ]);
    expect(first).toEqual({ kind: "library", folderId: "folder-Court Records" });
    expect(second).toEqual(first);
    expect(library.ensureRootFolder).toHaveBeenCalledOnce();
  });

  it("uses named automatic folders without turning them into explicit settings", async () => {
    const { files, library, preferenceStore } = setup();
    await expect(Promise.all([
      files.target(scope, "court-records"), files.target(scope, "authorities"),
    ])).resolves.toEqual([
      { kind: "library", folderId: "folder-Court Records" },
      { kind: "library", folderId: "folder-Authorities" },
    ]);
    expect(library.ensureRootFolder).toHaveBeenCalledTimes(2);
    await expect(preferenceStore.get(scope.userId)).resolves.toMatchObject({
      workflowFileTargets: { "court-records": null, authorities: null },
    });
  });

  it("falls back from a deleted configured folder without changing the setting", async () => {
    const authorities = { kind: "library" as const, folderId: "authorities-folder" };
    const { files, library, preferenceStore } = setup({
      "court-records": { kind: "library", folderId: "deleted-folder" }, authorities,
    });
    await expect(files.target(scope, "court-records")).resolves.toEqual({
      kind: "library", folderId: "folder-Court Records",
    });
    expect(library.folder).toHaveBeenCalledWith(expect.objectContaining({ kind: "file" }),
      "deleted-folder");
    await expect(preferenceStore.get(scope.userId)).resolves.toMatchObject({
      workflowFileTargets: {
        "court-records": { kind: "library", folderId: "deleted-folder" },
        authorities,
      },
    });
  });

  it("reuses an accessible configured project target", async () => {
    const project = { kind: "project" as const, projectId: "matter-1",
      folderId: "court-folder" };
    const setupResult = setup({ "court-records": project, authorities: null });
    vi.mocked(setupResult.projects.getFolder).mockResolvedValue({ id: "court-folder",
      name: "Court Records", parent_folder_id: null });
    await expect(setupResult.files.target(scope, "court-records")).resolves.toEqual(project);
    expect(setupResult.library.ensureRootFolder).not.toHaveBeenCalled();
  });

  it("honours the configured Library target inside a project workflow", async () => {
    const configured = { kind: "library" as const, folderId: "filing-output" };
    const setupResult = setup({ "court-records": configured, authorities: null });
    vi.mocked(setupResult.library.folder).mockResolvedValue({ id: configured.folderId,
      name: "Filings", parent_folder_id: null });

    await expect(setupResult.files.target(scope, "court-records", {
      projectId: "matter-1",
    })).resolves.toEqual(configured);
    expect(setupResult.projects.ensureRootFolder).not.toHaveBeenCalled();
  });
});
