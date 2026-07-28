import { spawn } from "node:child_process";

type CodexReasoningLevel = {
  effort: string;
  description?: string;
};

type CodexCatalogModel = {
  slug: string;
  displayName: string;
  description?: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: CodexReasoningLevel[];
  visibility?: string;
  supportedInApi?: boolean;
};

export type CodexModelCatalog = {
  models: CodexCatalogModel[];
  source: "live" | "bundled" | "unavailable";
  error?: string;
};

const CATALOG_TTL_MS = 30_000;
const CATALOG_TIMEOUT_MS = 10_000;
let cached: { expiresAt: number; value: CodexModelCatalog } | null = null;
let pending: Promise<CodexModelCatalog> | null = null;

function codexCommand() {
  return (
    process.env.CODEX_EXEC_COMMAND?.trim() ||
    (process.platform === "win32" ? "codex.cmd" : "codex")
  );
}

function normalizedDisplayName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function preferCatalogModel(
  candidate: CodexCatalogModel,
  current: CodexCatalogModel,
) {
  return candidate.slug.startsWith("gpt-") && !current.slug.startsWith("gpt-");
}

export function normalizeCodexCatalog(value: unknown): CodexModelCatalog {
  const rawModels =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { models?: unknown }).models
      : null;
  const models: CodexCatalogModel[] = [];
  const slugIndexes = new Map<string, number>();
  const displayIndexes = new Map<string, number>();
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const slug =
      typeof row.slug === "string"
        ? row.slug.trim().replace(/^codex:/i, "").toLowerCase()
        : "";
    if (!slug || slugIndexes.has(slug)) continue;
    const levels = Array.isArray(row.supported_reasoning_levels)
      ? row.supported_reasoning_levels
          .map((level) => {
            if (typeof level === "string") return { effort: level };
            if (!level || typeof level !== "object" || Array.isArray(level)) {
              return null;
            }
            const item = level as Record<string, unknown>;
            return typeof item.effort === "string" && item.effort.trim()
              ? {
                  effort: item.effort.trim(),
                  ...(typeof item.description === "string"
                    ? { description: item.description }
                    : {}),
                }
              : null;
          })
          .filter((level): level is CodexReasoningLevel => !!level)
          .filter(
            (level, index, all) =>
              all.findIndex(
                (item) =>
                  item.effort.toLowerCase() === level.effort.toLowerCase(),
              ) === index,
          )
      : [];
    const model: CodexCatalogModel = {
      slug,
      displayName:
        typeof row.display_name === "string" && row.display_name.trim()
          ? row.display_name.trim()
          : slug,
      ...(typeof row.description === "string"
        ? { description: row.description }
        : {}),
      ...(typeof row.default_reasoning_level === "string"
        ? { defaultReasoningLevel: row.default_reasoning_level }
        : {}),
      supportedReasoningLevels: levels,
      ...(typeof row.visibility === "string"
        ? { visibility: row.visibility }
        : {}),
      ...(typeof row.supported_in_api === "boolean"
        ? { supportedInApi: row.supported_in_api }
        : {}),
    };
    const displayKey = normalizedDisplayName(model.displayName);
    const displayIndex = displayIndexes.get(displayKey);
    if (displayIndex !== undefined) {
      const current = models[displayIndex];
      if (!preferCatalogModel(model, current)) continue;
      slugIndexes.delete(current.slug);
      models[displayIndex] = model;
      slugIndexes.set(slug, displayIndex);
      continue;
    }
    const nextIndex = models.length;
    models.push(model);
    slugIndexes.set(slug, nextIndex);
    displayIndexes.set(displayKey, nextIndex);
  }
  return { models, source: "live" };
}

async function runCatalog(args: string[]): Promise<CodexModelCatalog> {
  const command = codexCommand();
  const result = await new Promise<{ code: number | null; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(command, ["debug", "models", ...args], {
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
      let stdout = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Codex model catalog timed out."));
      }, CATALOG_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout = `${stdout}${chunk}`.slice(-4 * 1024 * 1024);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout });
      });
    },
  );
  if (result.code !== 0) throw new Error("Codex model catalog command failed.");
  const start = result.stdout.indexOf("{");
  const end = result.stdout.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Codex model catalog returned invalid JSON.");
  }
  return normalizeCodexCatalog(
    JSON.parse(result.stdout.slice(start, end + 1)),
  );
}

export async function getCodexModelCatalog(): Promise<CodexModelCatalog> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    try {
      const value = await runCatalog([]);
      cached = { expiresAt: Date.now() + CATALOG_TTL_MS, value };
      return value;
    } catch (liveError) {
      try {
        const value = await runCatalog(["--bundled"]);
        const bundled = { ...value, source: "bundled" as const };
        cached = { expiresAt: Date.now() + CATALOG_TTL_MS, value: bundled };
        return bundled;
      } catch (bundledError) {
        return {
          models: [],
          source: "unavailable",
          error:
            liveError instanceof Error
              ? liveError.message
              : bundledError instanceof Error
                ? bundledError.message
                : "Codex model catalog unavailable.",
        } satisfies CodexModelCatalog;
      }
    } finally {
      pending = null;
    }
  })();
  return pending;
}
