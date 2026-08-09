import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getCodexModelCatalog } from "../lib/codexCatalog";
import { getOllamaModelCatalog } from "../lib/llm/ollamaApi";
import { getReadSubagentCapability } from "../lib/chat/readSubagents";

export const modelRouter = Router();

modelRouter.get("/", requireAuth, async (_req, res) => {
  const [codex, ollama] = await Promise.all([
    getCodexModelCatalog(),
    getOllamaModelCatalog(),
  ]);
  const readSubagents = await getReadSubagentCapability(codex);
  res.json({ ...codex, ollama, readSubagents });
});
