import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getCodexModelCatalog } from "../lib/codexCatalog";
import { getOllamaModelCatalog } from "../lib/llm";
import { getOpenCodeGoModelCatalog } from "../lib/llm/openCodeGo";
import { getReadSubagentCapability } from "../lib/chat/readSubagents";
import { asyncRoute } from "../lib/asyncRoute";
import type { UserApplication } from "../lib/userApplication";

export function createModelsRouter(user: Pick<UserApplication, "modelSettings">) {
  const router = Router();
  router.get("/", requireAuth, asyncRoute(async (_req, res) => {
    const [codex, ollama, settings] = await Promise.all([
      getCodexModelCatalog(), getOllamaModelCatalog(),
      user.modelSettings(String(res.locals.userId)),
    ]);
    const [{ serverEnabled }, openCodeGo] = await Promise.all([
      getReadSubagentCapability(codex),
      getOpenCodeGoModelCatalog(settings.api_keys["opencode-go"]),
    ]);
    res.json({ ...codex, ollama, openCodeGo, readSubagents: { serverEnabled } });
  }));
  return router;
}
