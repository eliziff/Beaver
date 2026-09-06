import type { WorkProductKind } from "@/app/lib/workProducts";
import {
  post,
  apiRequest,
  pagePath,
  segment,
  patch,
  remove,
  apiFetch,
  streamRequest,
} from "@/app/lib/api/client";
import type { AssistantTranscriptMessage } from "@/app/lib/assistantSession";
import type { ResearchSelection } from "@/app/lib/researchFiles";

export interface Chat {
  search_hit?: { message_id: string | null; snippet: string };
  tabular_review_id?: string | null;
  research_file_id?: string | null;
  research_selection?: ResearchSelection | null;
  updated_at?: string;
  draft?: ChatDraft | null;
  id: string;
  project_id: string | null;
  user_id: string;
  transcript_version?: number;
  turn_in_progress?: boolean;
  model?: string | null;
  reasoning_effort?: string | null;
  creator_display_name?: string | null;
  title: string | null;
  created_at: string;
  deleted_at?: string | null;
}
export type WorkflowOperationName =
  | "create_table_of_authorities"
  | "update_work_product";
export type WorkflowRunEvent = {
  type: "workflow_run";
  id: string;
  tool: WorkflowOperationName;
  status: string;
  stage: string;
  progress?: number;
  message?: string;
  counts?: { label: string; value: number }[];
  error?: string;
  outputs?: { name: string; url?: string }[];
  app_url?: string;
  job_id?: string;
  version_number?: number | null;
  work_product?: {
    kind: WorkProductKind;
    id: string;
    revision: number;
  };
  requested_action?: "open" | "refresh" | "build";
};
export type AskInputsEvent = {
  type: "ask_inputs";
  items: (
    | {
        id: string;
        kind: "choice";
        question: string;
        options: { value: string }[];
      }
    | {
        id: string;
        kind: "documents";
        document_types: string[];
      }
  )[];
};
export type AskInputsResponseEvent = {
  type: "ask_inputs_response";
  responses: (
    | {
        id: string;
        kind: "choice";
        answer?: string;
      }
    | {
        id: string;
        kind: "documents";
        documents: { document_id: string; filename: string }[];
      }
  )[];
};
export interface Message {
  research_file_id?: string | null;
  research_selection?: ResearchSelection | null;
  id?: string;
  role: "user";
  content: string;
  files?: { filename: string; document_id: string }[];
  workflow?: { id: string; variant_id?: string; title: string };
  model?: string;
  reasoningEffort?: string;
  editMode?: "manual" | "auto";
  turnId?: string;
}
export type ChatDraft = Message & { documents?: import("./documents").Document[] };
export const saveChatDraft = (id: string, draft: ChatDraft | null) =>
  patch(`/chat/${segment(id)}`, { draft });
export const createChat = (payload?: {
  project_id?: string;
  tabular_review_id?: string;
  research_file_id?: string;
  research_selection?: ResearchSelection;
}) => post<{ id: string }>("/chat/create", payload ?? {});
export type ChatSearchOptions = {
  search?: string;
  search_scope?: "all" | "titles" | "transcripts";
  search_context?: "assistant" | "reviews" | "all";
  created_from?: string;
  created_to?: string;
  sort?: "newest" | "oldest";
};
export const listChats = (options?: ChatSearchOptions & {
  limit?: number;
  offset?: number;
  tabular_review_id?: string;
}, signal?: AbortSignal) => apiRequest<Chat[]>(pagePath("/chat", options ?? {}), { signal });
export const listProjectChats = (projectId: string) =>
  apiRequest<Chat[]>(`/projects/${segment(projectId)}/chats`);
export type ChatDetail = { chat: Chat; messages: AssistantTranscriptMessage[] };
export function getChat(chatId: string): Promise<ChatDetail>;
export function getChat(chatId: string, afterVersion: number): Promise<ChatDetail | undefined>;
export function getChat(chatId: string, afterVersion?: number) {
  return apiRequest<ChatDetail | undefined>(
    pagePath(`/chat/${segment(chatId)}`, { after_version: afterVersion }));
}
export const renameChat = (chatId: string, title: string) =>
  patch<void>(`/chat/${segment(chatId)}`, { title });
export const updateChatProject = (
  chatId: string,
  projectId: string | null,
) => patch<{ id: string; title: string | null; project_id: string | null }>(
  `/chat/${segment(chatId)}`, { project_id: projectId },
);
export const deleteChat = (chatId: string) => remove<void>(`/chat/${segment(chatId)}`);
export const listDeletedChats = () => apiRequest<Chat[]>("/chat/recycling-bin");
export const restoreChat = (chatId: string) => post<void>(`/chat/${segment(chatId)}/restore`);
export const permanentlyDeleteChat = (chatId: string) =>
  remove<void>(`/chat/${segment(chatId)}/permanent`);
export const stopChat = (chatId: string) =>
  post<{ stopped: boolean }>(`/chat/${segment(chatId)}/stop`);
export const stopChatJob = (jobId: string) =>
  post<{ stopped: boolean }>(`/chat/jobs/${segment(jobId)}/stop`);
export const submitChatClientToolResult = (
  jobId: string,
  callId: string,
  result: unknown,
) => post<void>(`/chat/jobs/${segment(jobId)}/tool-result`, { callId, result });
export const streamActiveChat = (chatId: string, signal: AbortSignal) =>
  apiFetch(`/chat/${segment(chatId)}/stream`, {
    headers: { Accept: "text/event-stream" }, signal,
  });
export const streamChatJob = (jobId: string, signal: AbortSignal) =>
  apiFetch(`/chat/jobs/${segment(jobId)}/stream`, {
    headers: { Accept: "text/event-stream" }, signal,
  });
export const steerChat = (chatId: string, id: string, text: string) =>
  post<{ steered: true }>(`/chat/${segment(chatId)}/steer`, { id, text });
export const compactChat = (chatId: string, model: string) =>
  post<{ compacted: true; transcriptVersion?: number }>(
    `/chat/${segment(chatId)}/compact`,
    { model },
  );
export const generateChatTitle = (chatId: string, message: string) =>
  post<{ title: string }>(`/chat/${segment(chatId)}/generate-title`, { message });
type StreamCurrentTurn =
  | {
      kind: "message";
      turn_id?: string;
      content: string;
      files?: { document_id: string }[];
      workflow?: { id: string; variant_id?: string };
    }
  | {
      kind: "ask_inputs_response";
      responses: (
        | { id: string; kind: "choice"; answer?: string }
        | { id: string; kind: "documents"; documents: { document_id: string }[] }
      )[];
    };
export const streamChat = (payload: {
  research_file_id?: string | null;
  research_selection?: ResearchSelection | null;
  current_turn: StreamCurrentTurn;
  expected_version: number;
  chat_id?: string;
  project_id?: string;
  tabular_review_id?: string;
  model?: string;
  reasoning_effort?: string;
  edit_mode?: "manual" | "auto";
  jurisdiction_preference?: {
    mode: "ask" | "presume";
    jurisdictions: string[];
  };
  subagent_mode?: "none" | "beaver" | "native";
  subagent_model?: string;
  subagent_effort?: string;
  activity_detail?: "auto" | "standard" | "tools" | "trace";
  time_zone?: string;
  displayed_doc?: { document_id: string };
  word_context?: { document_name: string };
  work_product?: { kind: WorkProductKind; id: string; revision: number;
    focus?: { item_id: string; selection?: { start: number; end: number } } };
  signal?: AbortSignal;
}) => {
  const { signal, ...body } = payload;
  return streamRequest("/chat", body, {
    signal, accept: "text/event-stream", allowStatuses: [409],
  });
};
