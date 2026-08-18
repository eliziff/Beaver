import { createAssistantTools } from "./assistantTools";
import type { ChatToolContext } from "./turnEngine";
import type { BeaverTool } from "./toolRegistry";
import type { TabularCellStore, WorkflowStore } from "./types";
import type { EditMode } from "../docxTrackedChanges";
import type { DocumentStore } from "../documentStore";
import type { LibraryStore } from "../libraryStore";
import type { ProjectStore } from "../projectStore";

function state() {
  return {
    courtlistener: { casesByClusterId: new Map() },
    pdfHandles: new Set<string>(),
    edits: new Map(),
    reads: new Map(),
    workingSets: new Map(),
  };
}

export function createChatToolRunner(options: {
  userId: string;
  userEmail?: string;
  projectId: string | null;
  allowedDocumentIds?: Set<string>;
  documentNames?: ReadonlyMap<string, string>;
  tabular?: TabularCellStore;
  documents: DocumentStore;
  library: LibraryStore;
  projects: ProjectStore;
  workflows?: WorkflowStore;
  entries?: BeaverTool<ChatToolContext>[];
  excludeToolNames?: ReadonlySet<string>;
  editMode?: EditMode;
  timeZone?: string;
  onMutationCommitted: () => void;
}) {
  const main = state();
  const artifacts = new Map<string, string>();
  const artifactByDocument = new Map<string, string>();
  let artifactNumber = 0;
  let mutationCommitted = false;

  const artifactFor = (documentId: string) => {
    const existing = artifactByDocument.get(documentId);
    if (existing) return existing;
    const handle = `draft-${++artifactNumber}`;
    artifacts.set(handle, documentId);
    artifactByDocument.set(documentId, handle);
    return handle;
  };

  const createTools = (
    evidence: ChatToolContext["evidence"],
    scope: "main" | "reader",
  ): BeaverTool<ChatToolContext>[] => {
    const turnState = scope === "main" ? main : state();
    return [
      ...createAssistantTools<ChatToolContext>({
        userId: options.userId,
        scope,
        tabular: options.tabular,
        documentNames: options.documentNames,
        resolveArtifact: (value) => artifacts.get(value),
        artifactFor,
        onMutationCommitted() {
          if (scope === "main" && !mutationCommitted) {
            mutationCommitted = true;
            options.onMutationCommitted();
          }
        },
        options: {
          userEmail: options.userEmail,
          ...turnState,
          documents: options.documents,
          library: options.library,
          projects: options.projects,
          workflows: options.workflows,
          allowedDocumentIds: options.allowedDocumentIds,
          matterId: options.projectId,
          legalEvidence: evidence,
          editMode: options.editMode,
          timeZone: options.timeZone,
        },
      }),
      ...(options.entries ?? []).filter((entry) =>
        !options.excludeToolNames?.has(entry.name)),
    ].filter((entry) => !options.excludeToolNames?.has(entry.name));
  };

  return {
    createTools,
    pdfHandles: main.pdfHandles,
    mutationCommitted: () => mutationCommitted,
  };
}
