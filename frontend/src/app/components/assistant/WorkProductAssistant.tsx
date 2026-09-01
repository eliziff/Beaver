import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import type { WorkProductContext } from "@/app/lib/workProducts";
import { AssistantDock } from "./AssistantDock";
import { ChatView } from "./ChatView";

export function useWorkProductAssistantState<T extends WorkProductContext>() {
  const [product, setProduct] = useState<T>();
  const [synced, setSynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [chatIds, setChatIds] = useState<Record<string, string>>({});
  const onProductChange = useCallback((next: T | undefined, ready: boolean) => {
    setProduct(next); setSynced(!!next && ready);
  }, []);
  const productId = product?.id;
  const onChatIdChange = useCallback((chatId: string) => {
    if (productId) setChatIds((current) => ({ ...current, [productId]: chatId }));
  }, [productId]);
  const onProductUpdated = useCallback((revision: number) =>
    setRefreshToken((value) => Math.max(value, revision)), []);
  return { product, synced, busy, setBusy, expanded, setExpanded, refreshToken, onProductChange,
    chatId: productId ? chatIds[productId] : undefined, onChatIdChange,
    onProductUpdated };
}

export function WorkProductAssistant({ product, chatId, onChatIdChange, expanded = true, onClose,
  synced = true, onBusyChange, onProductUpdated, onTurnComplete }: { product?: WorkProductContext;
  chatId?: string; onChatIdChange(id: string): void;
  expanded?: boolean; synced?: boolean; onClose(): void; onBusyChange?(busy: boolean): void;
  onProductUpdated?(revision: number): void; onTurnComplete?(): void }) {
  const assistant = useAssistantChat({ chatId, onChatIdChange, stayInPlace: true,
    projectId: product?.projectId ?? undefined,
    workProduct: product && { kind: product.kind, id: product.id, revision: product.revision } });
  const notifiedRevision = useRef(0);
  const busy = assistant.state.run !== null;
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); },
    [busy, onBusyChange]);
  useEffect(() => { notifiedRevision.current = product?.revision ?? 0; }, [product?.id, product?.revision]);
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
        handleChat={handleChat} cancel={assistant.actions.cancel}
        sendDisabled={!synced}
        onRejectedTurnRestored={assistant.actions.clearRejectedTurn}
        onRetryRejectedTurn={() => void assistant.actions.retryRejectedTurn()}
        layout="panel" features={{ contextTools: false, dock: false }} /> }]}
    activeTabId="assistant" onActivateTab={() => {}} expanded={expanded}
    showCollapsedButton={false}
    onExpandedChange={(nextExpanded) => { if (!nextExpanded) onClose(); }} />;
}

export function WorkProductAssistantButton({ available, expanded, onClick }: {
  available: boolean; expanded: boolean; onClick(): void;
}) {
  return <button type="button" disabled={!available} aria-label="Assistant"
    aria-expanded={expanded} onClick={onClick}
    className="builder-assistant-button inline-flex h-9 min-w-28 items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
    <MessageCircle aria-hidden className="size-4" />
    <span className="builder-assistant-label">Assistant</span>
  </button>;
}
