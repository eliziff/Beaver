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

export const api = {
  library: (kind: string) => request<LibraryCollection>(`/library/${kind}`),
  chats: () => request<Chat[]>("/chat?limit=20"),
  createChat: (content: string) =>
    request<{ id: string }>("/chat/create", {
      method: "POST",
      body: JSON.stringify({}),
    }).then(({ id }) => ({ id, content })),
};
