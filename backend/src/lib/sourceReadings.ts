import { canonicalJsonSha256 } from "./hash";

type Reading = { signal?: AbortSignal; progress?: (done: number, total: number) => void };
export type SourceReadings = ReturnType<typeof sourceReadings>;

const abortable = <T>(result: Promise<T>, signal?: AbortSignal) => !signal ? result
  : new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    result.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });

/**
 * What sources were read to, kept in memory by all a reading is of: the source's bytes and every
 * other input of the read, so the same reading is never done twice while it is kept. The least
 * recently used go once those kept pass `limit` characters. A reading still running is joined,
 * its progress heard by each reader; it stops only when no reader is left. Each reader gets its
 * own copy.
 */
export function sourceReadings(limit = 32_000_000) {
  const kept = new Map<string, { value: unknown; size: number }>();
  const running = new Map<string, { result: Promise<unknown>; readers: number; stop: AbortController;
    listeners: Set<NonNullable<Reading["progress"]>> }>();
  let size = 0;
  return async <T, R extends Reading>(key: unknown, input: R, read: (input: R) => Promise<T>): Promise<T> => {
    const id = canonicalJsonSha256(key), hit = kept.get(id);
    if (hit) { kept.delete(id); kept.set(id, hit); return structuredClone(hit.value) as T; }
    let job = running.get(id);
    if (!job || job.stop.signal.aborted) {
      const stop = new AbortController(), listeners = new Set<NonNullable<Reading["progress"]>>();
      const result = read({ ...input, signal: stop.signal,
        progress: (done: number, total: number) => listeners.forEach((listener) => listener(done, total)) } as R)
        .then((value) => {
          const cost = JSON.stringify(value)?.length ?? 0;
          if (cost <= limit) {
            kept.set(id, { value, size: cost }); size += cost;
            for (const [old, entry] of kept) {
              if (size <= limit) break;
              kept.delete(old); size -= entry.size;
            }
          }
          return value;
        }).finally(() => { if (running.get(id) === job) running.delete(id); });
      job = { result, readers: 0, stop, listeners };
      running.set(id, job);
    }
    const current = job;
    current.readers += 1;
    if (input.progress) current.listeners.add(input.progress);
    try {
      return structuredClone(await abortable(current.result, input.signal)) as T;
    } finally {
      if (input.progress) current.listeners.delete(input.progress);
      if (--current.readers === 0) current.stop.abort();
    }
  };
}
