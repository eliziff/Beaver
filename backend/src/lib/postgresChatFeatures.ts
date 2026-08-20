import { recordChatTurn } from "./audit";
import type { ChatApplicationFeatures } from "./chat/chatApplication";
import { createServerSupabase } from "./supabase";
import { getUserModelSettings } from "./userSettings";

export const postgresChatFeatures: Partial<ChatApplicationFeatures> = {
  async load(auth) {
    const db = createServerSupabase();
    const { api_keys, legal_research_us } = await getUserModelSettings(auth.userId, db);
    return { apiKeys: api_keys, includeResearchTools: legal_research_us };
  },
  audit(auth, input) {
    void recordChatTurn(createServerSupabase(), { userId: auth.userId,
      userEmail: auth.userEmail, chatId: input.chatId, projectId: input.projectId,
      title: input.title, model: input.model,
      ...(input.status ? { status: input.status } : {}) }, input.events);
  },
};
