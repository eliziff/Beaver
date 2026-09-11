import { assistantTools, type AssistantToolsDependencies } from "./assistantTools";
import type { ChatToolContext } from "./turnEngine";
import type { BeaverTool } from "./toolRegistry";
import type { SourceWorkspaceApplication } from "../sourceWorkspaceApplication";
import { resourceReference } from "../resourceReferences";
import type { ReadSubagentAssignment } from "./assistantEvents";
import type { ResearchFile } from "../researchFile";
import { createResearchTableTool } from "./researchTableTool";

function state() {
  return {
    edits: new Map(),
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

/** The turn supplies its own scope, evidence, artifacts and edit state; the caller supplies the rest. */
type TurnOwned = "scope" | "readerAssignment" | "researchContext" | "operation" |
  "legalEvidence" | "edits" | "resolveArtifact" | "artifactFor" |
  "onResearchWorkspace" | "onMutationCommitted";

export function createChatToolRunner(options: Omit<AssistantToolsDependencies, TurnOwned> & {
  sources: SourceWorkspaceApplication;
  includeResearchTools: boolean;
  researchTables?: Pick<Parameters<typeof createResearchTableTool>[0], "application" | "getWorkspace">;
  entries?: BeaverTool<ChatToolContext>[];
  onResearchWorkspace?: (documentId: string, evidence?: ChatToolContext["evidence"]) => Promise<ResearchFile | null>;
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
    context: ChatToolContext,
  ): BeaverTool<ChatToolContext>[] => {
    const turnState = scope === "main" ? main : state();
    context.research ??= {};
    return [
      ...assistantTools<ChatToolContext>({
        ...options,
        ...artifacts,
        ...turnState,
        scope: scope === "main" ? "main" : "reader",
        ...(scope === "main" ? {} : { readerAssignment: scope }),
        researchContext: context.research,
        operation: context.operation,
        legalEvidence: evidence,
        model: context.operation.model ?? options.model,
        onMutationCommitted() {
          if (scope === "main") commitMutation();
        },
        onResearchWorkspace: scope === "main" ? async (documentId, state) => {
          const file = await options.onResearchWorkspace?.(documentId, state);
          if (file) Object.assign(context.research!, await options.sources.context(
            { userId: options.userId, userEmail: options.userEmail }, file.document.id));
          return file ?? null;
        } : undefined,
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
