type Entry = {
  expires: number;
  bytes: number;
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

function trim() {
  while (cachedBytes > MAX_CACHE_BYTES) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) return;
    remove(oldest);
  }
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
  const key = JSON.stringify([
    params.scope, params.kind, params.key, params.version,
  ]);
  const hit = entries.get(key);
  if (hit && hit.expires > Date.now()) {
    entries.delete(key);
    entries.set(key, hit);
    return structuredClone(await hit.value) as T;
  }
  remove(key);

  const value = Promise.resolve().then(params.produce);
  const entry: Entry = {
    expires: Infinity,
    bytes: 0,
    value,
  };
  entries.set(key, entry);
  try {
    const resolved = await value;
    if (entries.get(key) !== entry) return resolved;
    try {
      const serialized = JSON.stringify(resolved);
      entry.bytes = Buffer.byteLength(serialized);
      entry.value = Promise.resolve(JSON.parse(serialized));
    } catch {
      remove(key);
      return resolved;
    }
    entry.expires = params.ttlMs === undefined
      ? Infinity
      : Date.now() + params.ttlMs;
    if (entry.bytes > MAX_ENTRY_BYTES) remove(key);
    else { cachedBytes += entry.bytes; trim(); }
    return resolved;
  } catch (error) {
    if (entries.get(key) === entry) remove(key);
    throw error;
  }
}
