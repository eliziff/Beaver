import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getCodexModelCatalog } from "../lib/codexCatalog";
import {
  configuredOllamaModelCatalog,
  getOllamaModelCatalog,
} from "../lib/llm/ollamaApi";

export const modelRouter = Router();

modelRouter.get("/", requireAuth, async (_req, res) => {
  const ollama = configuredOllamaModelCatalog();
  const ollamaRequest = getOllamaModelCatalog();
  const [codex, resolvedOllama] = await Promise.all([
    getCodexModelCatalog(),
    ollama ? Promise.resolve(ollama) : ollamaRequest,
  ]);
  void ollamaRequest.catch(() => undefined);
  res.json({ ...codex, ollama: resolvedOllama });
});
