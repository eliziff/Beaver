export type AssistantIntent = { id: string; text: string };
export const assistantIntent = (text: string): AssistantIntent => ({ id: crypto.randomUUID(), text });
