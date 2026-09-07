import { createCatalogCache } from "./catalogCache";
import { acquireCodexAppServer } from "./llm/codexAppServer";
import { jsonRecord, trimmedText } from "./value";

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

const INTERNAL_CODEX_MODELS = new Set([
  "codex-auto-review", "gpt-auto-review", "gpt-reserve",
]);

export function normalizeCodexCatalog(value: unknown): CodexModelCatalog {
  const modelsByDisplay = new Map<string, CodexCatalogModel>();
  const slugs = new Set<string>();
  for (const raw of Array.isArray(value) ? value : []) {
    const row = jsonRecord(raw);
    if (!row) continue;
    const slug = trimmedText(row.model).replace(/^codex:/i, "").toLowerCase();
    if (!slug || INTERNAL_CODEX_MODELS.has(slug) || slugs.has(slug)) continue;
    const levels = new Map<string, { effort: string }>();
    for (const level of Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : []) {
      // String-form efforts are verbatim; object-form efforts are trimmed.
      const effort = typeof level === "string" ? level
        : trimmedText(jsonRecord(level)?.reasoningEffort) || null;
      if (effort === null) continue;
      const key = effort.toLowerCase();
      if (!levels.has(key)) levels.set(key, { effort });
    }
    const model: CodexCatalogModel = {
      slug,
      displayName: trimmedText(row.displayName) || slug,
      ...(typeof row.defaultReasoningEffort === "string"
        ? { defaultReasoningLevel: row.defaultReasoningEffort }
        : {}),
      supportedReasoningLevels: [...levels.values()],
    };
    const displayKey = model.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const current = modelsByDisplay.get(displayKey);
    if (current) {
      if (!slug.startsWith("gpt-") || current.slug.startsWith("gpt-")) continue;
      slugs.delete(current.slug);
    }
    // Replacing a value retains the first display occurrence's catalogue position.
    modelsByDisplay.set(displayKey, model);
    slugs.add(slug);
  }
  return { models: [...modelsByDisplay.values()], source: "live" };
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

const cache = createCatalogCache<CodexModelCatalog>(runCatalog, {
  models: [], source: "unavailable",
});
export const getCodexModelCatalog = () => cache.resolve();
export const codexModelCatalogSnapshot = () => cache.snapshot();
