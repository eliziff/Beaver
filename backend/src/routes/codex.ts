import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getCodexModelCatalog } from "../lib/codexCatalog";

export const codexRouter = Router();

codexRouter.get("/models", requireAuth, async (_req, res) => {
  const [catalog] = await Promise.all([
    getCodexModelCatalog(),
    import("../lib/llm/codex"),
  ]);
  res.json(catalog);
});
