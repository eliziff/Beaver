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

export async function responseError(response: Response) {
  const text = await response.text();
  try {
    const value: unknown = JSON.parse(text);
    const parsed = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
    return new BeaverApiError({
      status: response.status,
      code: typeof parsed.code === "string" ? parsed.code : null,
      details: parsed,
      message: typeof parsed.detail === "string" && parsed.detail
        ? parsed.detail : `API error: ${response.status}`,
    });
  } catch {
    return new BeaverApiError({
      status: response.status,
      message: text || `API error: ${response.status}`,
    });
  }
}

export async function apiResponse(path: string, init?: RequestInit) {
  const response = await apiFetch(path, init);
  if (!response.ok) throw await responseError(response);
  return response;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiResponse(path, init);
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
