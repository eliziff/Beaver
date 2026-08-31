import type { ApplicationScope } from "./applicationError";
import type { DocumentFile, DocumentProvenance, DocumentStore } from "./documentStore";
import type { LibraryStore } from "./libraryStore";
import type { ProjectStore } from "./projectStore";
import type { UserPreferencesRepository, WorkflowFileTarget } from "./userPreferences";

export type FileWorkflow = "court-records" | "authorities";
const names: Record<FileWorkflow, string> = {
  "court-records": "Court Records",
  authorities: "Authorities",
};

export function createWorkflowFiles(
  documents: DocumentStore,
  library: LibraryStore,
  preferences: UserPreferencesRepository,
  projects: ProjectStore,
) {
  const pending = new Map<string, Promise<WorkflowFileTarget>>();
  const defaultFolder = (scope: ApplicationScope, workflow: FileWorkflow) =>
    library.ensureRootFolder({ ...scope, kind: "file" }, names[workflow], workflow);
  const projectFolder = (scope: ApplicationScope, projectId: string,
    workflow: FileWorkflow) =>
    projects.ensureRootFolder(scope, projectId, names[workflow], workflow);

  async function available(scope: ApplicationScope, configured: WorkflowFileTarget | null) {
    if (configured?.kind === "library") {
      return await library.folder({ ...scope, kind: "file" }, configured.folderId)
        ? configured : null;
    }
    return configured?.kind === "project" &&
      await projects.getFolder(scope, configured.projectId, configured.folderId)
      ? configured : null;
  }

  async function resolveTarget(scope: ApplicationScope, workflow: FileWorkflow,
    context: { projectId?: string | null } = {}) {
    const current = await preferences.get(scope.userId);
    const configured = current.workflowFileTargets[workflow];
    const usable = await available(scope, configured);
    if (usable) return usable;
    if (context.projectId) {
      const folder = await projectFolder(scope, context.projectId, workflow);
      return { kind: "project", projectId: context.projectId,
        folderId: folder.id } satisfies WorkflowFileTarget;
    }
    const folder = await defaultFolder(scope, workflow);
    return { kind: "library", folderId: folder.id } satisfies WorkflowFileTarget;
  }

  function target(scope: ApplicationScope, workflow: FileWorkflow,
    context: { projectId?: string | null } = {}) {
    const key = context.projectId
      ? `project\0${scope.userId}\0${context.projectId}\0${workflow}`
      : `library\0${scope.userId}\0${workflow}`;
    const active = pending.get(key);
    if (active) return active;
    const operation = resolveTarget(scope, workflow, context)
      .finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }

  return Object.freeze({
    target,
    async create(scope: ApplicationScope, workflow: FileWorkflow,
      file: DocumentFile & { provenance?: DocumentProvenance },
      context: { projectId?: string | null } = {}) {
      const destination = await target(scope, workflow, context);
      return documents.create(scope, { ...file, folderId: destination.folderId,
        ...(destination.kind === "project"
          ? { projectId: destination.projectId }
          : { libraryKind: "file" as const }) });
    },
  });
}

export type WorkflowFiles = ReturnType<typeof createWorkflowFiles>;
