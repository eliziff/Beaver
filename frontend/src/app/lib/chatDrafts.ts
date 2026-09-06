import { getChat, saveChatDraft, type ChatDraft } from "./api/chat";

// Keep pending writes available across route changes and serialize each chat's writes.
const drafts = new Map<string, ChatDraft | null>();
const writes = new Map<string, Promise<unknown>>();
export function currentChatDraft(id: string | null | undefined, fallback?: ChatDraft | null) {
    return id && drafts.has(id) ? drafts.get(id) ?? null : fallback;
}
export function writeChatDraft(id: string, draft: ChatDraft | null) {
    drafts.set(id, draft);
    const write = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => saveChatDraft(id, draft));
    writes.set(id, write);
    return write.finally(() => {
        if (writes.get(id) === write) {
            writes.delete(id);
            // A failed write remains recoverable in this session.
        }
    });
}
export async function readChatDraft(id: string) {
    if (drafts.has(id)) return drafts.get(id) ?? null;
    const result = await getChat(id);
    return drafts.has(id) ? drafts.get(id) ?? null : result.chat.draft ?? null;
}
