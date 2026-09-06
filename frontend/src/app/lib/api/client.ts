const API_BASE = "/api";
const isWordSurface = () => typeof window !== "undefined" &&
  (window.location.pathname.startsWith("/word") ||
    new URLSearchParams(window.location.search).get("surface") === "word");
export class BeaverApiError extends Error {
  status: number;
  code: string | null;
  details: Record<string, unknown> | null;
  constructor(args: { message: string; status: number; code?: string | null;
    details?: Record<string, unknown> | null }) {
    super(args.message);
    this.name = "BeaverApiError";
    this.status = args.status;
    this.code = args.code ?? null;
    this.details = args.details ?? null;
  }
}
export async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers({ Accept: "application/json" });
  if (isWordSurface()) headers.set("X-Beaver-Surface", "word");
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers,
  });
}
async function responseError(response: Response, fallback?: string) {
  const text = await response.text();
  try {
    const value: unknown = JSON.parse(text);
    const parsed = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
    return new BeaverApiError({
      status: response.status,
      code: typeof parsed.code === "string" ? parsed.code : null,
      details: parsed,
      message: typeof parsed.detail === "string" && (parsed.detail || fallback !== undefined)
        ? parsed.detail : fallback ?? `API error: ${response.status}`,
    });
  } catch {
    return new BeaverApiError({
      status: response.status,
      message: fallback ?? (text || `API error: ${response.status}`),
    });
  }
}
export async function apiResponse(path: string, init?: RequestInit, errorMessage?: string) {
  const response = await apiFetch(path, init);
  if (!response.ok) throw await responseError(response, errorMessage);
  return response;
}
export async function apiRequest<T>(path: string, init?: RequestInit, errorMessage?: string): Promise<T> {
  const response = await apiResponse(path, init, errorMessage);
  if (response.status === 204 || response.headers.get("content-length") === "0")
    return undefined as T;
  return (await response.json()) as T;
}
export async function apiBlobRequest(path: string, init?: RequestInit) {
  const response = await apiResponse(path, init);
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
  return { blob: await response.blob(), filename: filenameMatch?.[1] ?? null };
}
export async function fetchBytes(resource: URL, label = "Resource") {
  const response = await fetch(resource);
  if (!response.ok) throw new Error(`${label} could not be loaded.`);
  return new Uint8Array(await response.arrayBuffer());
}
export const segment = (value: string | number) => encodeURIComponent(String(value));
const JSON_HEADERS = { "Content-Type": "application/json" };
export function mutationInit(method: RequestInit["method"], body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}
export const post = <T>(path: string, body?: unknown) => apiRequest<T>(path, mutationInit("POST", body));
export const patch = <T>(path: string, body: unknown) => apiRequest<T>(path, mutationInit("PATCH", body));
export const put = <T>(path: string, body: unknown) => apiRequest<T>(path, mutationInit("PUT", body));
export const remove = <T>(path: string, body?: unknown) =>
  apiRequest<T>(path, mutationInit("DELETE", body));
export function multipartRequest<T>(
  path: string, file: File,
  options?: { method?: string; filename?: string; fields?: Record<string, string> },
) {
  const form = new FormData();
  form.append("file", file);
  if (options?.filename) form.append("filename", options.filename);
  for (const [name, value] of Object.entries(options?.fields ?? {})) {
    form.append(name, value);
  }
  return apiRequest<T>(path, {
    method: options?.method ?? "POST",
    body: form,
  });
}
export function streamRequest(
  path: string, body: unknown,
  options?: {
    signal?: AbortSignal; accept?: string; allowStatuses?: number[];
  },
) {
  return apiFetch(path, {
    ...mutationInit("POST", body),
    headers: {
      ...JSON_HEADERS,
      Accept: options?.accept ?? "application/json",
    },
    signal: options?.signal,
  }).then(async (response) => {
    if (!response.ok && !options?.allowStatuses?.includes(response.status)) {
      throw await responseError(response);
    }
    return response;
  });
}
export type Page<T> = { items: T[]; next_cursor: string | null };
export type PageQuery = { q?: string; cursor?: string | null; limit?: number };
export function pagePath(path: string, query: object = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}
