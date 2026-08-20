import { acquireCodexAppServer } from "./llm/codexAppServer";

type CodexCatalogModel = {
  slug: string;
  displayName: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: { effort: string }[];
};

export type CodexModelCatalog = {
  models: CodexCatalogModel[];
  source: "live" | "unavailable";
};

let cached: CodexModelCatalog | null = null;
let pending: Promise<CodexModelCatalog> | null = null;

export function normalizeCodexCatalog(value: unknown): CodexModelCatalog {
  const rawModels = Array.isArray(value) ? value : [];
  const models: CodexCatalogModel[] = [];
  const slugIndexes = new Map<string, number>();
  const displayIndexes = new Map<string, number>();
  for (const raw of rawModels) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const slug =
      typeof row.model === "string"
        ? row.model.trim().replace(/^codex:/i, "").toLowerCase()
        : "";
    if (!slug || slugIndexes.has(slug)) continue;
    const levels = Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts
          .map((level) => {
            if (typeof level === "string") return { effort: level };
            if (!level || typeof level !== "object" || Array.isArray(level)) {
              return null;
            }
            const item = level as Record<string, unknown>;
            return typeof item.reasoningEffort === "string" &&
              item.reasoningEffort.trim()
              ? {
                  effort: item.reasoningEffort.trim(),
                }
              : null;
          })
          .filter((level): level is { effort: string } => !!level)
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
        typeof row.displayName === "string" && row.displayName.trim()
          ? row.displayName.trim()
          : slug,
      ...(typeof row.defaultReasoningEffort === "string"
        ? { defaultReasoningLevel: row.defaultReasoningEffort }
        : {}),
      supportedReasoningLevels: levels,
    };
    const displayKey = model.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const displayIndex = displayIndexes.get(displayKey);
    if (displayIndex !== undefined) {
      const current = models[displayIndex];
      if (!model.slug.startsWith("gpt-") || current.slug.startsWith("gpt-")) continue;
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

async function runCatalog(): Promise<CodexModelCatalog> {
  const server = await acquireCodexAppServer(process.env.CODEX_API_KEY?.trim());
  const models: unknown[] = [];
  let cursor: string | null = null;
  do {
    const page: { data?: unknown; nextCursor?: unknown } =
      await server.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: true,
      });
    if (Array.isArray(page.data)) models.push(...page.data);
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
  } while (cursor);
  return normalizeCodexCatalog(models);
}

export async function getCodexModelCatalog(): Promise<CodexModelCatalog> {
  if (cached) return cached;
  if (pending) return pending;
  pending = (async () => {
    try {
      const value = await runCatalog();
      cached = value;
      return cached;
    } catch {
      return {
        models: [],
        source: "unavailable",
      } satisfies CodexModelCatalog;
    } finally {
      pending = null;
    }
  })();
  return pending;
}
