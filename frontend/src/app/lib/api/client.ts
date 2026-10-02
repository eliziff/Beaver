import { notifyApiMutation } from "./mutationEvents";
const API_BASE = "/api";
export async function uploadSignedObject(url: string, headers: Record<string, string>, file: File) {
  const response = await fetch(url, { method: "PUT", body: file, headers, credentials: "omit", redirect: "error",
    signal: AbortSignal.timeout(120_000) });
  // An immutable retry can already exist; publication still verifies its bytes on the server.
  if (!response.ok && response.status !== 412) throw new Error("File transfer failed. Retry the upload.");
}
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
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers,
  });
  if (response.ok) notifyApiMutation(path, init.method ?? "GET", init.body);
  return response;
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
/** Asked for in `Accept` by a request that reports progress (backend lib/followedRoute.ts). */
export const PROGRESS_STREAM = "application/x-beaver-progress";
/** Reads a followed response: each progress line goes to `progress` as it arrives, and the
 *  result after them comes back as a response of its own, or as the error it reports. */
async function followedResult(response: Response, progress: (message: string) => void,
  errorMessage?: string) {
  if (response.headers.get("content-type") !== PROGRESS_STREAM || !response.body) return response;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  for (;;) {
    const newline = buffer.indexOf(10);
    if (newline < 0) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The response ended before its result.");
      const joined = new Uint8Array(buffer.length + value.length);
      joined.set(buffer); joined.set(value, buffer.length); buffer = joined;
      continue;
    }
    const line = JSON.parse(decoder.decode(buffer.subarray(0, newline))) as
      { progress: string } | { result: { status: number; type: string } };
    buffer = buffer.subarray(newline + 1);
    if ("progress" in line) { progress(line.progress); continue; }
    const rest = buffer;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => { if (rest.length) controller.enqueue(rest); },
      pull: async (controller) => {
        const { value, done } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    const result = new Response(body, { status: line.result.status,
      headers: { "Content-Type": line.result.type } });
    if (!result.ok) throw await responseError(result, errorMessage);
    return result;
  }
}
/** A request that reports its progress, when `progress` is given, and then its result. */
export async function followedRequest(path: string, init: RequestInit,
  progress?: (message: string) => void) {
  if (!progress) return apiResponse(path, init);
  const headers = new Headers(init.headers); headers.set("Accept", PROGRESS_STREAM);
  return followedResult(await apiResponse(path, { ...init, headers }), progress);
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
