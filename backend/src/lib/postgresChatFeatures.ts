import type { ChatApplicationFeatures } from "./chat/chatApplication";
import { createServerSupabase } from "./supabase";
import { getUserModelSettings } from "./userSettings";

export const postgresChatFeatures: Partial<ChatApplicationFeatures> = {
  async load(auth) {
    const db = createServerSupabase();
    const { api_keys, legal_research_us } = await getUserModelSettings(auth.userId, db);
    return { apiKeys: api_keys, includeResearchTools: legal_research_us };
  },
};
