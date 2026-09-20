import { useEffect, useState } from "react";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { createChat } from "@/app/lib/api/chat";
import { getWorkspaceViews } from "@/app/lib/api/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { ChatView } from "../assistant/ChatView";
import { useSourcesWorkspace } from "./SourcesWorkspace";

/** Research-bound conversations use the same transcript as the full chat page. */
export function ResearchChatPanel() {
  const { file, refresh } = useSourcesWorkspace();
  const [chatId, setChatId] = useState<string>();
  const [chats, setChats] = useState<{ id: string; title: string | null }[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const assistant = useAssistantChat({ chatId, stayInPlace: true, onChatIdChange: setChatId,
    projectId: file?.document.project_id ?? undefined });
  const id = file?.document.id;
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setChatId(undefined);
    if (!id) { setLoading(false); return; }
    void getWorkspaceViews(id).then(({ chats }) => {
      if (cancelled) return;
      setChats(chats); setChatId(chats[0]?.id); setLoading(false);
    }).catch((reason) => { if (!cancelled) { setError(errorMessage(reason, "Could not load chats")); setLoading(false); } });
    return () => { cancelled = true; };
  }, [id]);
  async function start() {
    if (!file) return;
    setLoading(true); setError("");
    try {
      const chat = await createChat({ research_file_id: file.document.id, research_selection: { target: "sources" },
        ...(file.document.project_id ? { project_id: file.document.project_id } : {}) });
      setChats((current) => [{ id: chat.id, title: null }, ...current]); setChatId(chat.id);
    } catch (reason) { setError(errorMessage(reason, "Could not create chat")); }
    finally { setLoading(false); }
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center gap-2 p-2">
      <select aria-label="Workspace chat" value={chatId ?? ""} disabled={loading || !!assistant.state.run}
        onChange={(event) => setChatId(event.target.value || undefined)} className="min-w-0 flex-1 rounded border border-gray-300 bg-white p-1 text-sm">
        {!chatId && <option value="">Choose a chat</option>}
        {chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title || "Chat"}</option>)}
      </select>
      <button type="button" onClick={() => void start()} disabled={loading || !file || !!assistant.state.run}
        className="rounded border border-gray-300 px-2 py-1 text-sm disabled:opacity-50">New chat</button>
    </div>
    {error && <p role="alert" className="px-3 text-sm text-red-700">{error}</p>}
    {file && <p className="px-3 text-xs text-gray-500">Whole workspace</p>}
    {loading ? <p role="status" className="p-3 text-sm">Opening chat…</p> : chatId ? <ChatView
      chatId={chatId} researchFileId={id} projectId={file?.document.project_id ?? undefined}
      session={assistant.state} ready={assistant.chatLoad.status === "loaded"}
      handleChat={async (message, options) => {
        const result = await assistant.actions.handleChat({ ...message, research_file_id: id,
          research_selection: { target: "sources" } }, options);
        await refresh(); return result;
      }}
      cancel={assistant.actions.cancel} onRejectedTurnRestored={assistant.actions.clearRejectedTurn}
      onRetryRejectedTurn={() => void assistant.actions.retryRejectedTurn()} layout="panel"
      features={{ contextTools: false, dock: false }} />
      : <p className="p-3 text-sm text-gray-600">Start a chat about this workspace.</p>}
  </div>;
}
