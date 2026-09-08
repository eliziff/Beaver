import { pickerModel, staticPickerModels } from "../lib/llm/models";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { codexModelCatalogSnapshot } from "../lib/codexCatalog";
import { ollamaModelCatalogSnapshot } from "../lib/llm";
import { openCodeGoModelCatalogSnapshot } from "../lib/llm/openCodeGo";
import { getReadSubagentCapability } from "../lib/chat/readSubagents";
import { asyncRoute } from "../lib/asyncRoute";
import type { UserApplication } from "../lib/userApplication";

export function createModelsRouter(user: Pick<UserApplication, "modelSettings">) {
  const router = Router();
  router.get("/", requireAuth, asyncRoute(async (_req, res) => {
    const { api_keys } = await user.modelSettings(String(res.locals.userId));
    const codex = codexModelCatalogSnapshot();
    const { serverEnabled } = await getReadSubagentCapability(codex);
    const ollama = ollamaModelCatalogSnapshot(),
      openCodeGo = openCodeGoModelCatalogSnapshot(api_keys["opencode-go"]);
    const pickerModels = [
      ...ollama.models.map(model => pickerModel({ id: `ollama:${model.name}`, group: "Desktop",
        label: model.displayName + (ollama.source === "unavailable" ? " — desktop offline" : ""),
        available: ollama.source === "live", ...(model.supportsThinking ? {
          reasoningEfforts: ["off", "low", "medium", "high"], defaultReasoningEffort: "off" } : {}) })),
      ...codex.models.map(model => pickerModel({ id: `codex:${model.slug}`, group: "Codex",
        label: model.displayName, available: codex.source === "live",
        reasoningEfforts: model.supportedReasoningLevels.map(level => level.effort),
        defaultReasoningEffort: model.defaultReasoningLevel })),
      ...openCodeGo.models.map(model => pickerModel({ id: `opencode-go/${model.id}`, group: "OpenCode Go",
        label: model.displayName, available: openCodeGo.source === "live" })),
      ...staticPickerModels(),
    ];
    res.json({ models: pickerModels,
      unavailableProviders: [codex.source === "unavailable" && "codex",
        ollama.source === "unavailable" && "ollama", openCodeGo.source === "unavailable" && "opencode-go"].filter(Boolean),
      readSubagents: { serverEnabled },
    });
  }));
  return router;
}
