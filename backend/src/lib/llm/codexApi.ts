import { borrowCodexKey } from "./codexAuth";
import { codexApiModelSlug } from "./models";
import { streamResponsesApi } from "./openai";
import type { StreamChatParams, StreamChatResult } from "./types";

/**
 * Direct Responses-API calls to the Codex subscription backend — no Codex
 * harness, so the request carries only our own instructions and tools
 * (~50 tokens of overhead vs ~16k through exec/app-server). Undocumented
 * endpoint with no SLA; the app-server path stays the default for chat.
 */
const CODEX_BACKEND_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";

export async function streamCodexApi(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const slug = codexApiModelSlug(params.model);
  if (!slug) throw new Error(`Not a codex-api model: ${params.model}`);
  const { accessToken, accountId } = await borrowCodexKey();
  return streamResponsesApi(
    { ...params, model: slug },
    {
      endpoint: CODEX_BACKEND_RESPONSES_URL,
      provider: "Codex API",
      apiKey: accessToken,
      persistent: false,
      codexBackend: true,
      ...(accountId ? { headers: { "ChatGPT-Account-ID": accountId } } : {}),
    },
  );
}
