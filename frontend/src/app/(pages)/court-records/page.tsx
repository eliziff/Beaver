import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { WorkProductAssistant, WorkProductAssistantButton,
  useWorkProductAssistantState } from "@/app/components/assistant/WorkProductAssistant";
import { CourtRecordsWorkspace } from "@/app/court-records/CourtRecordsWorkspace";
import { beaverCourtRecordsHost } from "@/app/court-records/beaverHost";
import type { CourtRecordDraft } from "@/app/court-records/types";
import type { WorkProduct } from "@/app/lib/workProducts";

export default function CourtRecordsPage() {
  const [params, setParams] = useSearchParams();
  const assistant = useWorkProductAssistantState<WorkProduct<CourtRecordDraft>>();
  const { onProductChange } = assistant;
  const onDraftChange = useCallback((draft: WorkProduct<CourtRecordDraft> | undefined,
    synced: boolean) => {
    onProductChange(draft, synced);
    if (!synced) return;
    const routeId = params.get("draft");
    if (routeId === draft?.id || !routeId && !draft) return;
    const next = new URLSearchParams(params);
    if (draft) next.set("draft", draft.id); else next.delete("draft");
    setParams(next, { replace: true });
  }, [onProductChange, params, setParams]);
  const draftId = assistant.product?.id;
  return <div className="relative flex h-full min-h-0 w-full">
    <div className="min-h-0 min-w-0 flex-1">
      <CourtRecordsWorkspace
        host={beaverCourtRecordsHost}
        locked={assistant.busy}
        initialDraftId={params.get("draft") ?? undefined}
        onDraftChange={onDraftChange}
        refreshToken={assistant.refreshToken}
        headerActions={<WorkProductAssistantButton available={!!assistant.product}
          expanded={assistant.expanded} onClick={() => assistant.setExpanded((open) => !open)} />}
      />
    </div>
    {draftId && <WorkProductAssistant key={draftId} expanded={assistant.expanded}
      product={assistant.product} synced={assistant.synced} chatId={assistant.chatId}
      onChatIdChange={assistant.onChatIdChange} onClose={() => assistant.setExpanded(false)}
      onBusyChange={assistant.setBusy}
      onProductUpdated={assistant.onProductUpdated} />}
  </div>;
}
