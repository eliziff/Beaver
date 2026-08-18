import type { NormalizedToolCall } from "../../llm";
import {
  localLibraryStore, localDocuments, localProjects,
} from "./localDocumentFixtures";
import {
  executeAssistantTool,
  type AssistantToolOptions,
} from "../../chat/assistantTools";
import { toolResultText } from "../../chat/toolRegistry";

export * from "../../chat/assistantTools";

type LocalOptions = Omit<AssistantToolOptions, "documents" | "library" | "projects"> &
  Partial<Pick<AssistantToolOptions, "documents" | "library" | "projects">>;

export const runLocalAssistantTools = async (
  userId: string,
  calls: NormalizedToolCall[],
  options: LocalOptions = {},
) => Promise.all(calls.map(async (call) => {
  const outcome = await executeAssistantTool(userId, call, {
    documents: localDocuments,
    library: localLibraryStore,
    projects: localProjects,
    ...options,
  });
  return {
    tool_use_id: call.id,
    content: toolResultText(outcome.result),
    ...outcome.metadata,
    ...(outcome.mutated && { mutated: true }),
    ...(outcome.events?.length && { events: outcome.events }),
    ...(outcome.evidence?.length && { evidence: outcome.evidence }),
  };
}));
