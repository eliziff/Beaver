import { MessageCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { AssistantDock } from "./AssistantDock";
import { ChatView } from "./ChatView";
import type { WorkProductAssistantProps } from "./WorkProductAssistant";

export function WorkProductAssistantPanel({ product, chatId, onChatIdChange, expanded = true,
  onClose, synced = true, onBusyChange, onProductUpdated,
  onTurnComplete }: WorkProductAssistantProps) {
  const assistant = useAssistantChat({ chatId, onChatIdChange, stayInPlace: true,
    projectId: product?.projectId ?? undefined,
    workProduct: product && { kind: product.kind, id: product.id, revision: product.revision } });
  const notifiedRevision = useRef(0);
  const busy = assistant.state.run !== null;
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); },
    [busy, onBusyChange]);
  useEffect(() => { notifiedRevision.current = product?.revision ?? 0; },
    [product?.id, product?.revision]);
  const revisions = assistant.state.messages.flatMap((message) => message.role === "assistant"
    ? message.workflowRuns.flatMap((run) => product && run.status === "complete" &&
      run.work_product?.id === product.id && run.work_product.kind === product.kind
      ? [run.work_product.revision] : []) : []);
  const latestRevision = Math.max(0, ...revisions);
  useEffect(() => {
    if (latestRevision <= notifiedRevision.current) return;
    notifiedRevision.current = latestRevision;
    onProductUpdated?.(latestRevision);
  }, [latestRevision, onProductUpdated]);
  const handleChat: typeof assistant.actions.handleChat = async (...args) => {
    const result = await assistant.actions.handleChat(...args);
    onTurnComplete?.();
    return result;
  };
  return <AssistantDock tabs={[{ id: "assistant", label: "Assistant",
    icon: <MessageCircle aria-hidden className="size-4" />, content:
      <ChatView chatId={assistant.state.chatId} session={assistant.state}
        handleChat={handleChat} cancel={assistant.actions.cancel} sendDisabled={!synced}
        onRejectedTurnRestored={assistant.actions.clearRejectedTurn}
        onRetryRejectedTurn={() => void assistant.actions.retryRejectedTurn()}
        layout="panel" features={{ contextTools: false, dock: false }} /> }]}
    activeTabId="assistant" onActivateTab={() => {}} expanded={expanded}
    showCollapsedButton={false}
    onExpandedChange={(nextExpanded) => { if (!nextExpanded) onClose(); }} />;
}
