// Retain only fully verified immutable bytes, never access decisions. Each caller
// must reauthorize its exact version before and after using this working set.
export function verifiedDownloadCache() {
  const entries = new Map<string, { bytes: Buffer; verifiedAt: number }>();
  const pending = new Map<string, Promise<Buffer | null>>();
  const maxBytes = 128 * 1024 * 1024, maxEntries = 8, maxAge = 60_000;
  let retained = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (entry) { retained -= entry.bytes.length; entries.delete(key); }
  }
  return async (key: string, load: () => Promise<Buffer | null>) => {
    for (const [name, entry] of entries) if (Date.now() - entry.verifiedAt >= maxAge) remove(name);
    const hit = entries.get(key);
    if (hit) { entries.delete(key); entries.set(key, hit); return hit.bytes; }
    const existing = pending.get(key);
    if (existing) return existing;
    const task = load().then(bytes => {
      if (bytes && bytes.length <= maxBytes) {
        while (entries.size && (entries.size >= maxEntries || retained + bytes.length > maxBytes))
          remove(entries.keys().next().value!);
        entries.set(key, { bytes, verifiedAt: Date.now() }); retained += bytes.length;
      }
      return bytes;
    }).finally(() => { pending.delete(key); });
    pending.set(key, task);
    return task;
  };
}
