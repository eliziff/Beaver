import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getCodexModelCatalog } from "../lib/codexCatalog";
import { getOllamaModelCatalog } from "../lib/llm";
import { getReadSubagentCapability } from "../lib/chat/readSubagents";
import { asyncRoute } from "../lib/asyncRoute";

export const modelRouter = Router();

modelRouter.get("/", requireAuth, asyncRoute(async (_req, res) => {
  const [codex, ollama] = await Promise.all([
    getCodexModelCatalog(),
    getOllamaModelCatalog(),
  ]);
  const { serverEnabled } = await getReadSubagentCapability(codex);
  res.json({ ...codex, ollama, readSubagents: { serverEnabled } });
}));
