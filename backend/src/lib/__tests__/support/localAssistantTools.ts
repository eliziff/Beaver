import type { NormalizedToolCall } from "../../llm";
import {
  localLibraryStore, localDocuments, localProjects,
} from "./localDocumentFixtures";
import { assistantTools } from "../../chat/assistantTools";
import { createArtifactRegistry } from "../../chat/chatToolRunner";
import { createSourceWorkspaceApplication } from "../../sourceWorkspaceApplication";
import {
  LOAD_TOOLS_NAME,
  TurnToolRegistry,
  type BeaverOutcome,
} from "../../chat/toolRegistry";

type ToolOptions = Parameters<typeof assistantTools>[0];
type LocalOptions = Partial<Omit<
  ToolOptions,
  | "userId"
  | "documents"
  | "library"
  | "projects"
  | "scope"
  | "resolveArtifact"
  | "artifactFor"
  | "onMutationCommitted"
>> & Partial<Pick<ToolOptions, "documents" | "library" | "projects">>;

export const localAssistantToolRegistry = (
  userId: string,
  options: LocalOptions = {},
) => new TurnToolRegistry(assistantTools<Record<string, never>>({
    userId,
    documents: localDocuments,
    sources: createSourceWorkspaceApplication(options.documents ?? localDocuments, {
      chats: {} as never, tables: {} as never, projects: {} as never, library: {} as never,
      preferences: {} as never, tabular: async () => { throw new Error("No table view in this fixture"); },
    }),
    library: localLibraryStore,
    projects: localProjects,
    workProducts: {} as never,
    authorities: {} as never,
    scope: "main",
    ...createArtifactRegistry(),
    onMutationCommitted: () => undefined,
    ...options,
  }));

export const runLocalAssistantTools = async (
  userId: string,
  calls: NormalizedToolCall[],
  options: LocalOptions = {},
) => {
  const registry = localAssistantToolRegistry(userId, options);
  const specialists = calls.map(({ name }) => name)
    .filter((name) => registry.specialists().includes(name));
  if (specialists.length) {
    await registry.run([{
      id: "load-test-tools",
      name: LOAD_TOOLS_NAME,
      input: { names: [...new Set(specialists)] },
    }], {});
  }
  const outcomes = new Map<string, BeaverOutcome>();
  const results = await registry.run(calls, {}, undefined,
    (call, outcome) => { outcomes.set(call.id, outcome); });
  return results.map((result) => {
    const outcome = outcomes.get(result.tool_use_id)!;
    return {
      ...result,
      ...(outcome.mutated && { mutated: true }),
      ...(outcome.terminal && { terminal: true }),
      ...(outcome.events?.length && { events: outcome.events }),
      ...(outcome.evidence?.length && { evidence: outcome.evidence }),
      ...(outcome.queryReceipts?.length && { queryReceipts: outcome.queryReceipts }),
    };
  });
};
