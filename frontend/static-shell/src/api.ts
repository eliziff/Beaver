type RuntimeConfig = { apiBase?: string };

declare global {
  interface Window {
    __BEAVER_CONFIG__?: RuntimeConfig;
  }
}

const apiBase =
  window.__BEAVER_CONFIG__?.apiBase ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export type LibraryDocument = {
  id: string;
  filename?: string | null;
  file_type?: string | null;
  updated_at?: string | null;
};

export type LibraryCollection = {
  documents: LibraryDocument[];
  folders: { id: string; name: string }[];
};

export type Chat = { id: string; title?: string | null; updated_at?: string };

export type StreamEvent = { type?: string; text?: string; chatId?: string; error?: string };

async function* stream(path: string, body: unknown): AsyncGenerator<StreamEvent> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) throw new Error((await response.text()) || `HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const part = await reader.read();
    buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((value) => value.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return;
      try { yield JSON.parse(data) as StreamEvent; } catch { /* ignore malformed frames */ }
    }
    if (part.done) return;
  }
}

export const api = {
  library: (kind: string) => request<LibraryCollection>(`/library/${kind}`),
  upload: async (kind: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    const response = await fetch(`${apiBase}/library/${kind}/documents`, { method: "POST", body });
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
    return response.json() as Promise<LibraryDocument>;
  },
  chats: () => request<Chat[]>("/chat?limit=20"),
  streamChat: (messages: { role: string; content: string }[]) =>
    stream("/chat", { messages }),
};
