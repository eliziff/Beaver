/// <reference types="vite/client" />

type RuntimeConfig = { apiBase?: string; token?: string };

declare global {
  interface Window { __BEAVER_CONFIG__?: RuntimeConfig }
}

const base = () =>
  (window.__BEAVER_CONFIG__?.apiBase ?? import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/u, "");

function token() {
  return window.__BEAVER_CONFIG__?.token || localStorage.getItem("beaver_access_token") || "";
}

async function request<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (token()) headers.set("Authorization", `Bearer ${token()}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`${base()}${path}`, { ...init, headers, credentials: "include" });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response.status === 204 ? (undefined as T) : (await response.json() as T);
}

export type Chat = { id: string; title?: string | null; updated_at?: string };
export type ChatTranscript = { chat: Chat & { transcript_version?: number }; messages: { role: "user" | "assistant"; content: unknown }[] };
export type Project = { id: string; name: string; practice?: string | null; cm_number?: string | null };
export type TabularReview = { id: string; title?: string | null; project_id?: string | null; columns_config?: { index: number; name: string; prompt: string }[] | null; document_count?: number; updated_at?: string; created_at?: string };
export type TabularReviewDetail = { review: TabularReview; cells: unknown[]; documents: { id: string; filename?: string | null }[] };
export type LibraryDocument = { id: string; filename?: string | null; file_type?: string | null; updated_at?: string | null };
export type LibraryCollection = { documents: LibraryDocument[]; folders: { id: string; name: string }[] };
export type StreamEvent = { type?: string; text?: string; message?: string; chatId?: string; transcriptVersion?: number };
export type AuthoritiesStatus = { available: boolean; running: boolean; url: string };

export const api = {
  chats: () => request<Chat[]>("/chat?limit=20"),
  chat: (id: string) => request<ChatTranscript>(`/chat/${encodeURIComponent(id)}`),
  projects: () => request<Project[]>("/projects"),
  createProject: (name: string) => request<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  tabularReviews: () => request<TabularReview[]>("/tabular-review"),
  tabularReview: (id: string) => request<TabularReviewDetail>(`/tabular-review/${encodeURIComponent(id)}`),
  authoritiesStatus: () => request<AuthoritiesStatus>("/table-of-authorities/status"),
  launchAuthorities: () => request<{ ok: boolean; url: string }>("/table-of-authorities/launch", { method: "POST" }),
  library: (kind: string) => request<LibraryCollection>(`/library/${kind}`),
  upload: (kind: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<LibraryDocument>(`/library/${kind}/documents`, { method: "POST", body });
  },
  stream: async (options: { chatId: string | null; version: number; content: string; onEvent: (event: StreamEvent) => void }) => {
    const response = await fetch(`${base()}/chat`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json", ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
      body: JSON.stringify({
        chat_id: options.chatId,
        expected_version: options.version,
        current_turn: { kind: "message", turn_id: crypto.randomUUID(), content: options.content },
      }),
    });
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
    if (!response.body) throw new Error("The runtime returned no stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        try { options.onEvent(JSON.parse(raw) as StreamEvent); } catch { /* ignore malformed transport noise */ }
      }
      if (chunk.done) break;
    }
  },
};
