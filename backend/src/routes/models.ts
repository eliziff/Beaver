import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getCodexModelCatalog } from "../lib/codexCatalog";
import { getOllamaModelCatalog } from "../lib/llm/ollamaApi";

export const modelRouter = Router();

modelRouter.get("/", requireAuth, async (_req, res) => {
  const [codex, ollama] = await Promise.all([
    getCodexModelCatalog(),
    getOllamaModelCatalog(),
  ]);
  res.json({ ...codex, ollama });
});
