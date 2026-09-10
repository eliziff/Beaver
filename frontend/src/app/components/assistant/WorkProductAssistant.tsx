import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import type { WorkProductContext, WorkProductFocus,
  WorkProductRefresh } from "@/app/lib/workProducts";
import { Button } from "@/app/components/ui/button";
import { listChats } from "@/app/lib/api/chat";
import { WorkProductAssistantPanel } from "./WorkProductAssistantPanel";

export type WorkProductAssistantProps = { product?: WorkProductContext & { title?: string };
  focus?: WorkProductFocus;
  chatId?: string; onChatIdChange(id: string): void;
  expanded?: boolean; synced?: boolean; onClose(): void; onBusyChange?(busy: boolean): void;
  onProductUpdated?(revision: number): void; onTurnComplete?(): void };

export function useWorkProductAssistantState<T extends WorkProductContext>() {
  const [product, setProduct] = useState<T>();
  const [synced, setSynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [refreshToken, setRefreshToken] = useState<WorkProductRefresh>();
  const refreshSequence = useRef(0);
  const [chatIds, setChatIds] = useState<Record<string, string>>({});
  const onProductChange = useCallback((next: T | undefined, ready: boolean) => {
    setProduct(next); setSynced(!!next && ready);
  }, []);
  const productId = product?.id;
  const onChatIdChange = useCallback((chatId: string) => {
    if (productId) setChatIds((current) => ({ ...current, [productId]: chatId }));
  }, [productId]);
  // Reopening a draft resumes the chat the last turn bound to it.
  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    void listChats({ work_product_id: productId, limit: 1 }).then((chats) => {
      const resumed = chats[0]?.id;
      if (cancelled || !resumed) return;
      setChatIds((current) => current[productId] ? current : { ...current, [productId]: resumed });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [productId]);
  const onProductUpdated = useCallback((revision: number) => {
    if (!productId) return;
    setSynced(false); setRefreshToken({ id: productId, revision,
      sequence: ++refreshSequence.current });
  }, [productId]);
  return { product, synced, busy, setBusy, expanded, setExpanded, refreshToken, onProductChange,
    chatId: productId ? chatIds[productId] : undefined, onChatIdChange,
    onProductUpdated };
}

export function WorkProductAssistant(props: WorkProductAssistantProps) {
  const expanded = props.expanded ?? true;
  const key = props.product ? `${props.product.kind}:${props.product.id}` : "unbound";
  return <WorkProductAssistantPanel key={key} {...props} expanded={expanded} />;
}

export function WorkProductAssistantButton({ available, expanded, onClick }: {
  available: boolean; expanded: boolean; onClick(): void;
}) {
  return <Button variant="outline" disabled={!available} aria-label="Assistant"
    aria-expanded={expanded} onClick={onClick}
    className="builder-assistant-button min-w-28 border-gray-200 text-gray-700 disabled:cursor-default">
    <MessageCircle aria-hidden className="size-4" />
    <span className="builder-assistant-label">Assistant</span>
  </Button>;
}
