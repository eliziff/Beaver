import { createHash } from "node:crypto";
import { modelForProvider, pickerModel, type PickerModel } from "../lib/llm/models";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { codexModelCatalogSnapshot } from "../lib/codexCatalog";
import { ollamaModelCatalogSnapshot } from "../lib/llm";
import { buildCreatorCatalog } from "../lib/llm/catalog";
import { catalogNameForModel, modelsDevCatalogSnapshot, reasoningForModel,
  releaseForModel } from "../lib/llm/modelsDev";
import { openCodeGoModelCatalogSnapshot } from "../lib/llm/openCodeGo";
import { openRouterModelCatalogSnapshot } from "../lib/llm/openRouter";
import { getReadSubagentCapability } from "../lib/chat/readSubagents";
import { asyncRoute } from "../lib/asyncRoute";
import type { UserApplication } from "../lib/userApplication";
import { configuredAvailable, configuredModels } from "../lib/llm/registry";

/** A selection is `provider:native`; keep an id that is already composite. */
const composite = (model: PickerModel): PickerModel => ({
  ...model,
  id: model.id.startsWith(`${model.provider}:`) ? model.id : `${model.provider}:${model.id}`,
});

/** Aggregator lanes carry no effort or release metadata of their own; models.dev does. */
const withCatalogMetadata = (model: PickerModel): PickerModel => {
  const native = modelForProvider(model.id);
  const release = releaseForModel(native);
  const reasoning = reasoningForModel(native);
  return { ...model,
    ...(release && model.releasedAt !== release ? { releasedAt: release } : {}),
    ...(model.reasoningEfforts || !reasoning ? {} : reasoning) };
};

export function createModelsRouter(user: Pick<UserApplication, "modelSettings">) {
  const router = Router();
  router.get("/", requireAuth, asyncRoute(async (req, res) => {
    const { api_keys } = await user.modelSettings(String(res.locals.userId));
    const codex = codexModelCatalogSnapshot();
    const { serverEnabled } = await getReadSubagentCapability(codex);
    const ollama = ollamaModelCatalogSnapshot(),
      openCodeGo = openCodeGoModelCatalogSnapshot(api_keys["opencode-go"]),
      openRouter = openRouterModelCatalogSnapshot();
    const options = buildCreatorCatalog([
      ...ollama.models.map(model => pickerModel({ id: `ollama:${model.name}`, group: "Desktop",
        label: model.displayName, available: ollama.source === "live",
        ...(model.supportsThinking ? {
          reasoningEfforts: ["off", "low", "medium", "high"], defaultReasoningEffort: "off" } : {}) })),
      ...codex.models.map(model => pickerModel({ id: `codex:${model.slug}`, group: "OpenAI",
        label: model.displayName, available: codex.source === "live",
        reasoningEfforts: model.supportedReasoningLevels.map(level => level.effort),
        defaultReasoningEffort: model.defaultReasoningLevel })),
      ...openCodeGo.models.map(model => withCatalogMetadata(
        pickerModel({ id: `opencode-go:${model.id}`, group: "OpenCode Go",
          label: catalogNameForModel(model.id) ?? model.displayName,
          available: openCodeGo.source === "live" }))),
      ...modelsDevCatalogSnapshot().models.map(composite),
      ...openRouter.models.map(withCatalogMetadata).map(composite),
    ]);
    options.push(...configuredModels().map((model): PickerModel => ({
      id: `configured:${model.id}`, label: model.label ?? model.id,
      group: model.location === "local" ? "Desktop" : "Configured",
      provider: "configured", available: configuredAvailable(model, api_keys),
      modelKey: `configured/${model.id}`,
    })));
    const body = JSON.stringify({ models: options,
      unavailableProviders: [codex.source === "unavailable" && "codex",
        ollama.source === "unavailable" && "ollama", openCodeGo.source === "unavailable" && "opencode-go",
        openRouter.source === "unavailable" && "openrouter"].filter(Boolean),
      readSubagents: { serverEnabled },
    });
    // The catalogue changes slowly; let the browser reuse it and revalidate
    // cheaply instead of refetching on every picker open.
    const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
    res.set("Cache-Control", "private, max-age=30, stale-while-revalidate=300");
    res.set("ETag", etag);
    if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
    res.type("application/json").send(body);
  }));
  return router;
}
