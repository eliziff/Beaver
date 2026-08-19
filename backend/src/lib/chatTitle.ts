import type { ChatScope } from "./chatStore";
import { completeText } from "./llm";
import { getUserModelSettings } from "./userSettings";

export async function generateChatTitle(scope: ChatScope, message: string) {
  const { title_model, api_keys } = await getUserModelSettings(scope.userId);
  return completeText({ model: title_model, maxTokens: 64, apiKeys: api_keys,
    user: `Generate a concise 3–6 word topic title. Omit generic labels such as "Legal Assistant", "AI", or "Chat". If the message has no identifiable topic, return "Misc. Query". Return only the title.\n\nMessage: ${message.slice(0, 500)}` });
}
