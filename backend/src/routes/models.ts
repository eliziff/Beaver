import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { codexModelCatalogSnapshot } from "../lib/codexCatalog";
import { ollamaModelCatalogSnapshot } from "../lib/llm/ollamaModels";
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
    res.json({
      ...codex, ollama: ollamaModelCatalogSnapshot(),
      openCodeGo: openCodeGoModelCatalogSnapshot(api_keys["opencode-go"]),
      readSubagents: { serverEnabled },
    });
  }));
  return router;
}
