import type { NormalizedToolCall } from "../llm";
import { localLibraryStore, localDocuments } from "../localLibraryStore";
import { localProjects } from "../localProjectStore";
import {
  runAssistantTools,
  type AssistantToolOptions,
} from "./assistantTools";

export * from "./assistantTools";

type LocalOptions = Omit<
  AssistantToolOptions,
  "documents" | "library" | "projects"
> & Partial<Pick<
  AssistantToolOptions,
  "documents" | "library" | "projects"
>>;

export const runLocalAssistantTools = (
  userId: string,
  calls: NormalizedToolCall[],
  options: LocalOptions = {},
) => runAssistantTools(userId, calls, {
  documents: localDocuments,
  library: localLibraryStore,
  projects: localProjects,
  ...options,
});
