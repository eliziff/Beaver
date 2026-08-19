import { acquireCodexAppServer } from "./llm/codexAppServer";

type CodexReasoningLevel = {
  effort: string;
  description?: string;
};

type CodexServiceTier = {
  id: string;
  name?: string;
  description?: string;
};

type CodexCatalogModel = {
  slug: string;
  displayName: string;
  description?: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: CodexReasoningLevel[];
  serviceTiers: CodexServiceTier[];
  defaultServiceTier?: string;
  visibility?: string;
  supportedInApi?: boolean;
};

export type CodexModelCatalog = {
  models: CodexCatalogModel[];
  source: "live" | "bundled" | "unavailable";
  error?: string;
};

let cached: CodexModelCatalog | null = null;
let pending: Promise<CodexModelCatalog> | null = null;

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
  const rawModels = Array.isArray(value) ? value : [];
  const models: CodexCatalogModel[] = [];
  const slugIndexes = new Map<string, number>();
  const displayIndexes = new Map<string, number>();
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
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
        typeof row.displayName === "string" && row.displayName.trim()
          ? row.displayName.trim()
          : slug,
      ...(typeof row.description === "string"
        ? { description: row.description }
        : {}),
      ...(typeof row.defaultReasoningEffort === "string"
        ? { defaultReasoningLevel: row.defaultReasoningEffort }
        : {}),
      supportedReasoningLevels: levels,
      serviceTiers: Array.isArray(row.serviceTiers)
        ? row.serviceTiers
            .map((tier) => {
              if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
                return null;
              }
              const item = tier as Record<string, unknown>;
              const id =
                typeof item.id === "string"
                  ? item.id.trim().toLowerCase()
                  : "";
              return id
                ? {
                    id,
                    ...(typeof item.name === "string" && item.name.trim()
                      ? { name: item.name.trim() }
                      : {}),
                    ...(typeof item.description === "string" &&
                    item.description.trim()
                      ? { description: item.description.trim() }
                      : {}),
                  }
                : null;
            })
            .filter((tier): tier is CodexServiceTier => !!tier)
            .filter(
              (tier, index, all) =>
                all.findIndex((item) => item.id === tier.id) === index,
            )
        : [],
      ...(typeof row.defaultServiceTier === "string" &&
      row.defaultServiceTier.trim()
        ? { defaultServiceTier: row.defaultServiceTier.trim().toLowerCase() }
        : {}),
      visibility: row.hidden === true ? "hidden" : "visible",
      supportedInApi: true,
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
        error: "Codex model catalog unavailable.",
      } satisfies CodexModelCatalog;
    } finally {
      pending = null;
    }
  })();
  return pending;
}
