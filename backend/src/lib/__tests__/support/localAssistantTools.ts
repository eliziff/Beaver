import type { NormalizedToolCall } from "../../llm";
import {
  localLibraryStore, localDocuments, localProjects,
} from "./localDocumentFixtures";
import { assistantTools } from "../../chat/assistantTools";
import {
  LOAD_TOOLS_NAME,
  TurnToolRegistry,
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
    library: localLibraryStore,
    projects: localProjects,
    scope: "main",
    resolveArtifact: () => undefined,
    artifactFor: () => "",
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
  const batch = await registry.run(calls, {});
  return batch.results.map((result, index) => {
    const outcome = batch.outcomes[index];
    return {
      ...result,
      ...(outcome.mutated && { mutated: true }),
      ...(outcome.terminal && { terminal: true }),
      ...(outcome.events?.length && { events: outcome.events }),
      ...(outcome.evidence?.length && { evidence: outcome.evidence }),
    };
  });
};
