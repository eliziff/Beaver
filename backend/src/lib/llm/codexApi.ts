import { borrowCodexKey } from "./codexAuth";
import { codexModelSlug } from "./models";
import { streamResponsesApi } from "./openai";
import type { StreamChatParams, StreamChatResult } from "./types";

/**
 * Direct Responses-API calls to the Codex subscription backend
 * (chatgpt.com/backend-api/codex) — flat-rate via the user's ChatGPT login,
 * with only our own instructions and tools in the request (~50 tokens of
 * overhead vs ~16k through the Codex CLI harness this replaced).
 * Undocumented endpoint with no SLA; auth is borrowed from the Codex CLI.
 */
const CODEX_BACKEND_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";

export async function streamCodexApi(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const slug = codexModelSlug(params.model);
  if (!slug) throw new Error(`Not a codex model: ${params.model}`);
  const { accessToken, accountId } = await borrowCodexKey();
  return streamResponsesApi(
    { ...params, model: slug },
    {
      endpoint: CODEX_BACKEND_RESPONSES_URL,
      provider: "Codex API",
      apiKey: accessToken,
      persistent: false,
      codexBackend: true,
      reasoningSummary: true,
      ...(accountId ? { headers: { "ChatGPT-Account-ID": accountId } } : {}),
    },
  );
}
