type Entry = {
  expires: number;
  bytes: number; // Zero until this entry is admitted to the byte budget.
  value: Promise<unknown>;
};

const entries = new Map<string, Entry>();
const MAX_ENTRY_BYTES = 2_000_000;
const MAX_CACHE_BYTES = 32_000_000;
let cachedBytes = 0;

function remove(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  cachedBytes -= entry.bytes;
  entries.delete(key);
}

/** Bounded, process-local cache for public provider responses. */
export async function cachedContent<T>(params: {
  scope: string;
  kind: string;
  key: string;
  version: number;
  ttlMs?: number;
  produce: () => Promise<T>;
}): Promise<T> {
  const key = JSON.stringify([params.scope, params.kind, params.key, params.version]);
  const hit = entries.get(key);
  if (hit && hit.expires > Date.now()) {
    entries.delete(key);
    entries.set(key, hit);
    return structuredClone(await hit.value) as T;
  }
  remove(key);

  const value = Promise.resolve().then(params.produce);
  const entry: Entry = { expires: Infinity, bytes: 0, value };
  entries.set(key, entry);
  try {
    const resolved = await value;
    if (entries.get(key) !== entry) return resolved;
    let snapshot: unknown, bytes: number;
    try {
      const serialized = JSON.stringify(resolved);
      bytes = Buffer.byteLength(serialized);
      if (bytes > MAX_ENTRY_BYTES) return resolved;
      snapshot = JSON.parse(serialized);
    } catch {
      return resolved;
    }
    entry.value = Promise.resolve(snapshot);
    entry.expires = params.ttlMs === undefined ? Infinity : Date.now() + params.ttlMs;
    entry.bytes = bytes;
    cachedBytes += bytes;
    while (cachedBytes > MAX_CACHE_BYTES) remove(entries.keys().next().value!);
    return resolved;
  } finally {
    if (!entry.bytes && entries.get(key) === entry) remove(key);
  }
}
