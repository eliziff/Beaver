import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getCodexModelCatalog } from "../lib/codexCatalog";

export const codexRouter = Router();

codexRouter.get("/models", requireAuth, async (_req, res) => {
  res.json(await getCodexModelCatalog());
});
