/** Shared abort plumbing for every provider adapter. */
export function abortError(): Error {
  const error = new Error("Stream aborted.");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}
