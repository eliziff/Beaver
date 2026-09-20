import { modelMessages } from "./sdk";
import type { StreamChatParams } from "./types";

export const flattenedPrompt = (messages: StreamChatParams["messages"]) =>
  messages.length === 1 && messages[0]?.role === "user" ? messages[0].content
    : messages.map(message => message.modelState
      ? modelMessages([message], "portable").map(({ role, content }) => `${role.toUpperCase()}:\n${
        typeof content === "string" ? content : JSON.stringify(content)}`).join("\n\n")
      : `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
