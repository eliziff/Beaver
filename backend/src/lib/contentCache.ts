import { promises as fs } from "node:fs";
import path from "node:path";
import { mikeLocalDataHome } from "./legalDataPath";
import { devLog } from "./chat/types";
import { sha256 } from "./hash";

/**
 * Content-addressed keyed cache (evaluation-context plan §12 — the
 * "downloaded authority" family; DocumentProjectionService covers document
 * family). Key = caller-chosen request identity + version, scoped so
 * matter-scoped material is never shared across scopes. TTL bounds
 * staleness for sources that can change (consolidated statutes, search
 * results); immutable authorities may omit it. Cache failures fall back
 * to a real fetch; correctness never depends on a hit.
 */

const cacheRoot = () => path.join(mikeLocalDataHome(), "content-cache");

const scopeDir = (kind: string, scope: string) =>
  path.join(
    cacheRoot(),
    kind.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40),
    `${scope.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)}-${sha256(scope).slice(0, 8)}`,
  );

type Entry = { at: number; key: string; value: unknown };

// Oversized bodies (bulk PDFs rendered to text) stay uncached; the cache
// is for the frequent small-to-medium authority payloads.
const MAX_ENTRY_BYTES = 2_000_000;

export async function cachedContent<T>(params: {
  scope: string;
  kind: string;
  key: string;
  version: number;
  /** Milliseconds an entry stays fresh; omit for immortal entries. */
  ttlMs?: number;
  produce: () => Promise<T>;
}): Promise<T> {
  const { scope, kind, key, version, ttlMs, produce } = params;
  // Consumer tests stub fetch and assert call sequences; a persistent
  // cache would swallow those calls. The cache's own tests opt back in.
  if (
    process.env.NODE_ENV === "test" &&
    process.env.MIKE_CONTENT_CACHE_IN_TESTS !== "1"
  ) {
    return produce();
  }
  const file = path.join(
    scopeDir(kind, scope),
    `${sha256(key)}.v${version}.json`,
  );
  try {
    const entry = JSON.parse(await fs.readFile(file, "utf8")) as Entry;
    if (
      entry.key === key &&
      (ttlMs === undefined || Date.now() - entry.at < ttlMs)
    ) {
      devLog(`[content-cache] hit ${kind} sha256=${sha256(key).slice(0, 12)}`);
      return entry.value as T;
    }
  } catch {
    // Miss or unreadable entry: fall through to a real produce.
  }
  const value = await produce();
  try {
    const serialized = JSON.stringify({
      at: Date.now(),
      key,
      value,
    } satisfies Entry);
    if (serialized.length <= MAX_ENTRY_BYTES) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Write-then-rename so a concurrent reader never sees a torn entry.
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, serialized);
      await fs.rename(tmp, file);
    }
  } catch {
    // Cache write failures never affect the produced result.
  }
  return value;
}

/** Delete one kind's entries, or the entire content cache when omitted. */
export async function clearContentCache(kind?: string): Promise<void> {
  const target =
    kind === undefined
      ? cacheRoot()
      : path.join(cacheRoot(), kind.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40));
  await fs.rm(target, { recursive: true, force: true });
}
