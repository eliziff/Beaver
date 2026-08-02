import { promises as fs } from "node:fs";
import path from "node:path";
import { mikeLocalDataHome } from "./legalDataPath";
import { devLog } from "./chat/types";
import { sha256 } from "./hash";

/**
 * Content-addressed parse cache (evaluation-context plan §12 Phase 1,
 * Issue 11). Key = source SHA-256 + parser name + parser version, so changing
 * content or bumping a parser version naturally misses. Entries are scoped
 * (owning user or document) so matter-scoped content is never shared across
 * scopes. Cache failures fall back to a real parse; correctness never depends
 * on a hit.
 */

const cacheRoot = () => path.join(mikeLocalDataHome(), "parse-cache");

// Readable prefix for debugging plus a scope hash so sanitization can never
// collapse two distinct scopes into one directory.
const scopeDir = (scope: string) =>
  path.join(
    cacheRoot(),
    `${scope.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)}-${sha256(scope).slice(0, 8)}`,
  );

type Entry = { ms: number; bytes: number; text: string };

export async function cachedParse(params: {
  scope: string;
  parser: string;
  version: number;
  bytes: Buffer;
  parse: () => Promise<string>;
}): Promise<string> {
  const { scope, parser, version, bytes, parse } = params;
  const hash = sha256(bytes);
  const file = path.join(scopeDir(scope), `${hash}.${parser}.v${version}.json`);
  try {
    const entry = JSON.parse(await fs.readFile(file, "utf8")) as Entry;
    if (typeof entry.text === "string") {
      devLog(
        `[parse-cache] hit ${parser}@v${version} sha256=${hash.slice(0, 12)} ` +
          `${entry.bytes}B, saved ~${Math.round(entry.ms)}ms`,
      );
      return entry.text;
    }
  } catch {
    // Miss or unreadable entry: fall through to a real parse.
  }
  const started = performance.now();
  const text = await parse();
  const ms = performance.now() - started;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename so a concurrent reader never sees a torn entry.
    const tmp = `${file}.${process.pid}.tmp`;
    const entry: Entry = { ms, bytes: bytes.length, text };
    await fs.writeFile(tmp, JSON.stringify(entry));
    await fs.rename(tmp, file);
  } catch {
    // Cache write failures never affect the parse result.
  }
  return text;
}

/** Delete cached parses for one scope, or the entire cache when omitted. */
export async function clearParseCache(scope?: string): Promise<void> {
  const target = scope === undefined ? cacheRoot() : scopeDir(scope);
  await fs.rm(target, { recursive: true, force: true });
}
