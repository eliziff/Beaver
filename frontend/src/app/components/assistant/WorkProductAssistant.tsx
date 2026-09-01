import { lazy, Suspense, useCallback, useEffect, useState, type CSSProperties } from "react";
import { MessageCircle } from "lucide-react";
import type { WorkProductContext } from "@/app/lib/workProducts";

export type WorkProductAssistantProps = { product?: WorkProductContext;
  chatId?: string; onChatIdChange(id: string): void;
  expanded?: boolean; synced?: boolean; onClose(): void; onBusyChange?(busy: boolean): void;
  onProductUpdated?(revision: number): void; onTurnComplete?(): void };

let panelPromise: Promise<{ default: typeof import("./WorkProductAssistantPanel")["WorkProductAssistantPanel"] }> | undefined;
const loadPanel = () => panelPromise ??= import("./WorkProductAssistantPanel")
  .then(({ WorkProductAssistantPanel: defaultPanel }) => ({ default: defaultPanel }));
const AssistantPanel = lazy(loadPanel);

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

export function WorkProductAssistant(props: WorkProductAssistantProps) {
  const expanded = props.expanded ?? true;
  const [activated, setActivated] = useState(expanded);
  useEffect(() => {
    const preload = () => void loadPanel().catch(() => { panelPromise = undefined; });
    if (window.requestIdleCallback) {
      const request = window.requestIdleCallback(preload, { timeout: 1_000 });
      return () => window.cancelIdleCallback?.(request);
    }
    const timeout = window.setTimeout(preload, 0);
    return () => window.clearTimeout(timeout);
  }, []);
  useEffect(() => { if (expanded) setActivated(true); }, [expanded]);
  if (!activated && !expanded) return null;
  return <Suspense fallback={expanded ? <DockLoadingShell /> : null}>
    <AssistantPanel {...props} expanded={expanded} />
  </Suspense>;
}

function DockLoadingShell() {
  return <aside aria-label="Assistant dock" aria-busy="true"
    style={{ "--assistant-dock-width": "480px" } as CSSProperties}
    className="absolute inset-0 z-40 flex h-full w-full min-h-0 shrink-0 flex-col overflow-hidden border border-gray-300 bg-app-surface shadow-lg xl:relative xl:inset-auto xl:my-3 xl:me-3 xl:h-[calc(100dvh-1.5rem)] xl:w-[min(var(--assistant-dock-width),50%)] xl:rounded-2xl" />;
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
