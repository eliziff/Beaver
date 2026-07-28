/** Shared abort plumbing for every provider adapter. */
export function abortError(): Error {
  const error = new Error("Stream aborted.");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; message?: unknown };
  return record.name === "AbortError" || record.message === "Stream aborted.";
}
