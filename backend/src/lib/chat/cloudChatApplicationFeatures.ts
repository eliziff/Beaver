import type { ChatApplicationFeatures } from "./chatApplication";
import type { ChatToolContext } from "./turnEngine";
import type { BeaverTool } from "./toolRegistry";
import { toolText } from "./toolRegistry";
import { createServerSupabase } from "../supabase";
import { getUserModelSettings } from "../userSettings";
import { recordChatTurn } from "../audit";
import { buildWorkflowStore } from "./contextBuilders";
import { buildUserMcpTools, executeMcpToolCall } from "../mcp/servers";

export const cloudChatApplicationFeatures: ChatApplicationFeatures = {
  async load(auth) {
    const db = createServerSupabase();
    const [{ api_keys, legal_research_us }, workflows, schemas] = await Promise.all([
      getUserModelSettings(auth.userId, db),
      buildWorkflowStore(auth.userId, auth.userEmail, db),
      buildUserMcpTools(auth.userId, db),
    ]);
    const extraTools: BeaverTool<ChatToolContext>[] = schemas.map((schema) => ({
      ...schema,
      activity: () => `Using ${schema.name}`,
      async execute(input, context, signal) {
        context.emit({ type: "mcp_tool_start", name: schema.name });
        const { content, event } = await executeMcpToolCall(
          auth.userId,
          schema.name,
          input,
          db,
          signal,
        );
        context.emit({
          type: "mcp_tool_result",
          name: schema.name,
          connector_name: event.connector_name,
          tool_name: event.tool_name,
          status: event.status,
          error: event.error,
        });
        return {
          result: toolText(content, event.status === "error"),
          events: [event],
        };
      },
    }));
    return {
      apiKeys: api_keys,
      includeResearchTools: legal_research_us,
      workflows,
      extraTools,
    };
  },
  audit(auth, input) {
    const db = createServerSupabase();
    void recordChatTurn(db, {
      userId: auth.userId,
      userEmail: auth.userEmail,
      chatId: input.chatId,
      projectId: input.projectId,
      title: input.title,
      model: input.model,
      ...(input.status ? { status: input.status } : {}),
    }, input.events);
  },
};
