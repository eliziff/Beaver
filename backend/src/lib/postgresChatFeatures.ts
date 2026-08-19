import { recordChatTurn } from "./audit";
import type { ChatApplicationFeatures } from "./chat/chatApplication";
import type { ChatToolContext } from "./chat/turnEngine";
import { toolText, type BeaverTool } from "./chat/toolRegistry";
import { buildUserMcpTools, executeMcpToolCall } from "./mcp/servers";
import { createServerSupabase } from "./supabase";
import { getUserModelSettings } from "./userSettings";

export const postgresChatFeatures: Partial<ChatApplicationFeatures> = {
  async load(auth) {
    const db = createServerSupabase();
    const [{ api_keys, legal_research_us }, schemas] = await Promise.all([
      getUserModelSettings(auth.userId, db),
      buildUserMcpTools(auth.userId, db)]);
    const extraTools: BeaverTool<ChatToolContext>[] = schemas.map((schema) => ({ ...schema,
      activity: () => `Using ${schema.name}`,
      async execute(input, context, signal) {
        context.emit({ type: "mcp_tool_start", name: schema.name });
        const { content, event } = await executeMcpToolCall(
          auth.userId, schema.name, input, db, signal);
        context.emit({ type: "mcp_tool_result", name: schema.name,
          connector_name: event.connector_name, tool_name: event.tool_name,
          status: event.status, error: event.error });
        return { result: toolText(content, event.status === "error"), events: [event] };
      },
    }));
    return { apiKeys: api_keys, includeResearchTools: legal_research_us, extraTools };
  },
  audit(auth, input) {
    void recordChatTurn(createServerSupabase(), { userId: auth.userId,
      userEmail: auth.userEmail, chatId: input.chatId, projectId: input.projectId,
      title: input.title, model: input.model,
      ...(input.status ? { status: input.status } : {}) }, input.events);
  },
};
