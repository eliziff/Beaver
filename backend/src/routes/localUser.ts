import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  CLAUDE_LOW_MODELS,
  DEEPSEEK_MAIN_MODELS,
  DEFAULT_TABULAR_MODEL,
  DEFAULT_TITLE_MODEL,
  OPENAI_LOW_MODELS,
} from "../lib/llm";
import { getEnvironmentApiKeyStatus } from "../lib/userApiKeys";

export const localUserRouter = Router();

localUserRouter.use(requireAuth);

localUserRouter.get("/profile", (_req, res) => {
  const apiKeyStatus = getEnvironmentApiKeyStatus();
  const titleModel =
    (apiKeyStatus.gemini && DEFAULT_TITLE_MODEL) ||
    (apiKeyStatus.openai && OPENAI_LOW_MODELS[0]) ||
    (apiKeyStatus.deepseek && DEEPSEEK_MAIN_MODELS[0]) ||
    (apiKeyStatus.claude && CLAUDE_LOW_MODELS[0]) ||
    DEFAULT_TITLE_MODEL;
  const tabularModel =
    (apiKeyStatus.gemini && DEFAULT_TABULAR_MODEL) ||
    (apiKeyStatus.openai && OPENAI_LOW_MODELS[0]) ||
    (apiKeyStatus.deepseek && DEEPSEEK_MAIN_MODELS[0]) ||
    (apiKeyStatus.claude && "claude-sonnet-4-5") ||
    DEFAULT_TABULAR_MODEL;
  const reset = new Date();
  reset.setDate(reset.getDate() + 30);
  res.json({
    displayName: null,
    organisation: null,
    messageCreditsUsed: 0,
    creditsResetDate: reset.toISOString(),
    creditsRemaining: 999999,
    tier: "Free",
    titleModel,
    tabularModel,
    mfaOnLogin: false,
    legalResearchUs: true,
    apiKeyStatus,
  });
});

localUserRouter.get("/api-keys", (_req, res) => {
  res.json(getEnvironmentApiKeyStatus());
});

localUserRouter.use((_req, res) => {
  res.status(501).json({
    detail: "This account feature is unavailable in account-free local mode.",
  });
});
