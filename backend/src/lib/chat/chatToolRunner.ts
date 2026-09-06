import { assistantTools, type WorkProductFocus } from "./assistantTools";
import type { ChatToolContext } from "./turnEngine";
import type { BeaverTool } from "./toolRegistry";
import type { DocIndex, TabularCellStore, WorkflowStore } from "./types";
import type { DraftingStyleSettings } from "../draftingStyle";
import type { EditMode } from "../docxTrackedChanges";
import type { DocumentStore } from "../documentStore";
import type { LibraryStore } from "../libraryStore";
import type { ProjectStore } from "../projectStore";
import { resourceReference } from "../resourceReferences";
import type { ReadSubagentAssignment } from "./assistantEvents";
import type { AuthoritiesWorkspaceApplication } from "../authoritiesWorkspaceApplication";
import type { CourtRecordsApplication } from "../courtRecordsApplication";
import type { FeaturePreferences } from "../userPreferences";
import type { WorkProductApplication } from "../workProductApplication";
import type { AuditStore } from "../audit";
import type { ResearchFile } from "../researchFile";
import { createResearchTableTool } from "./researchTableTool";

function state() {
  return {
    edits: new Map(),
    servedDraftingCache: new Map(),
  };
}

export function createArtifactRegistry() {
  const artifacts = new Map<string, string>(), handles = new Map<string, string>();
  return {
    resolveArtifact: (value: string) => artifacts.get(value),
    artifactFor(documentId: string, versionId: string) {
      const handle = handles.get(documentId) ?? `draft-${handles.size + 1}`;
      handles.set(documentId, handle);
      artifacts.set(handle, resourceReference.document(documentId, versionId));
      return handle;
    },
  };
}

export function createChatToolRunner(options: {
  userId: string;
  userEmail?: string;
  projectId: string | null;
  allowedDocumentIds?: Set<string>;
  documentNames?: ReadonlyMap<string, string>;
  docIndex?: DocIndex;
  tabular?: TabularCellStore;
  resolveTabular?: (reviewId: string) => Promise<TabularCellStore | null>;
  researchTables?: Pick<Parameters<typeof createResearchTableTool>[0], "application" | "getWorkspace">;
  documents: DocumentStore;
  library: LibraryStore;
  projects: ProjectStore;
  workProducts: Pick<WorkProductApplication, "create" | "get" | "list" | "resolve">;
  model?: string;
  turnId?: string;
  chatId?: string;
  audit?: AuditStore["record"];
  onResearchWorkspace?: (documentId: string, evidence?: ChatToolContext["evidence"]) => Promise<ResearchFile | null>;
  authorities: Pick<AuthoritiesWorkspaceApplication,
    "importDraft" | "act" | "refresh" | "refreshInput" | "prepareSources" |
      "discrepancies" | "build" |
      "addReceipts" | "attachLibraryPdf">;
  authoritiesId?: string;
  authoritiesRevision?: number;
  workProductFocus?: WorkProductFocus;
  courtRecords?: Pick<CourtRecordsApplication, "bindOutput" | "updateDraft">;
  courtRecordId?: string;
  courtRecordRevision?: number;
  productFeatures?: FeaturePreferences;
  draftingStyle?: DraftingStyleSettings;
  workflows?: WorkflowStore;
  entries?: BeaverTool<ChatToolContext>[];
  includeResearchTools: boolean;
  editMode?: EditMode;
  timeZone?: string;
  onMutationCommitted: () => void;
}) {
  const main = state();
  const artifacts = createArtifactRegistry();
  let mutationCommitted = false;
  const commitMutation = () => {
    if (mutationCommitted) return;
    mutationCommitted = true;
    options.onMutationCommitted();
  };

  const createTools = (
    evidence: ChatToolContext["evidence"],
    scope: "main" | ReadSubagentAssignment,
  ): BeaverTool<ChatToolContext>[] => {
    const turnState = scope === "main" ? main : state();
    return [
      ...assistantTools<ChatToolContext>({
        userId: options.userId,
        scope: scope === "main" ? "main" : "reader",
        ...(scope === "main" ? {} : { readerAssignment: scope }),
        tabular: options.tabular,
        resolveTabular: options.resolveTabular,
        documentNames: options.documentNames,
        docIndex: options.docIndex,
        ...artifacts,
        onMutationCommitted() {
          if (scope === "main") commitMutation();
        },
        userEmail: options.userEmail,
        ...turnState,
        documents: options.documents,
        library: options.library,
        projects: options.projects,
        workProducts: options.workProducts,
        model: options.model,
        turnId: options.turnId,
        chatId: options.chatId,
        audit: options.audit,
        onResearchWorkspace: scope === "main" ? options.onResearchWorkspace : undefined,
        authorities: options.authorities,
        authoritiesId: options.authoritiesId,
        authoritiesRevision: options.authoritiesRevision,
        workProductFocus: options.workProductFocus,
        courtRecords: options.courtRecords,
        courtRecord: options.courtRecordId && options.courtRecordRevision
          ? { id: options.courtRecordId, revision: options.courtRecordRevision } : undefined,
        productFeatures: options.productFeatures,
        includeResearchTools: options.includeResearchTools,
        draftingStyle: options.draftingStyle,
        workflows: options.workflows,
        allowedDocumentIds: options.allowedDocumentIds,
        matterId: options.projectId,
        legalEvidence: evidence,
        editMode: options.editMode,
        timeZone: options.timeZone,
      }),
      ...(scope === "main" && options.researchTables ? [createResearchTableTool<ChatToolContext>({
        ...options.researchTables,
        scope: { userId: options.userId, userEmail: options.userEmail },
        model: options.model,
        onMutationCommitted: commitMutation,
      })] : []),
      ...(options.entries ?? []),
    ].filter((entry) => options.includeResearchTools || !entry.research);
  };

  return {
    createTools,
    commitMutation,
    mutationCommitted: () => mutationCommitted,
  };
}
