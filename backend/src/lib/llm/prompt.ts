import type { StreamChatParams } from "./types";

export const flattenedPrompt = (messages: StreamChatParams["messages"]) =>
  messages.length === 1 && messages[0]?.role === "user" ? messages[0].content
    : messages.map(({ role, content }) => `${role.toUpperCase()}:\n${content}`).join("\n\n");
