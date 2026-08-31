import { MessageCircle } from "lucide-react";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import type { WorkProductKind } from "@/app/lib/workProducts";
import { AssistantDock } from "./AssistantDock";
import { ChatView } from "./ChatView";

export function WorkProductAssistant({ product, chatId, onChatIdChange, onClose,
  onTurnComplete }: { product?: { id: string; kind: WorkProductKind; revision: number;
    projectId: string | null }; chatId?: string; onChatIdChange(id: string): void;
  onClose(): void; onTurnComplete(): void }) {
  const assistant = useAssistantChat({ chatId, onChatIdChange, stayInPlace: true,
    projectId: product?.projectId ?? undefined,
    workProduct: product && { kind: product.kind, id: product.id, revision: product.revision } });
  const handleChat: typeof assistant.actions.handleChat = async (...args) => {
    const result = await assistant.actions.handleChat(...args); onTurnComplete(); return result;
  };
  return <AssistantDock tabs={[{ id: "assistant", label: "Assistant",
    icon: <MessageCircle aria-hidden className="size-4" />, content:
      <ChatView chatId={assistant.state.chatId} session={assistant.state}
        handleChat={handleChat} cancel={assistant.actions.cancel}
        onRejectedTurnRestored={assistant.actions.clearRejectedTurn}
        onRetryRejectedTurn={() => void assistant.actions.retryRejectedTurn()}
        layout="panel" features={{ contextTools: false, dock: false }} /> }]}
    activeTabId="assistant" onActivateTab={() => {}} expanded
    onExpandedChange={(expanded) => { if (!expanded) onClose(); }} />;
}

export function WorkProductAssistantButton({ ready, expanded, onClick }: {
  ready: boolean; expanded: boolean; onClick(): void;
}) {
  return <button type="button" disabled={!ready} aria-label="Assistant"
    aria-expanded={expanded} onClick={onClick}
    className="builder-assistant-button inline-flex h-9 min-w-28 items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
    <MessageCircle aria-hidden className="size-4" />
    <span className="builder-assistant-label">Assistant</span>
  </button>;
}
