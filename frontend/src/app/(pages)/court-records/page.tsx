import { useCallback } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { WorkProductAssistant, WorkProductAssistantButton,
  useWorkProductAssistantState } from "@/app/components/assistant/WorkProductAssistant";
import { CourtRecordsWorkspace } from "@/app/court-records/CourtRecordsWorkspace";
import { beaverCourtRecordsHost } from "@/app/court-records/beaverHost";
import type { CourtRecordDraft } from "@/app/court-records/types";
import type { WorkProduct } from "@/app/lib/workProducts";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

export default function CourtRecordsPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { profile } = useUserProfile();
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
        initialDocuments={location.state?.documents}
        onDocumentsConsumed={() => navigate(location.pathname + location.search,
          { replace: true, state: null })}
        projectId={params.get("project") || undefined}
        onDraftChange={onDraftChange}
        refreshToken={assistant.refreshToken}
        jurisdictionOrder={profile?.jurisdictionPreference.jurisdictions}
        headerActions={assistant.product ? <WorkProductAssistantButton available
          expanded={assistant.expanded} onClick={() => assistant.setExpanded((open) => !open)} />
          : undefined}
      />
    </div>
    {draftId && <WorkProductAssistant key={draftId} expanded={assistant.expanded}
      product={assistant.product} synced={assistant.synced} chatId={assistant.chatId}
      onChatIdChange={assistant.onChatIdChange} onClose={() => assistant.setExpanded(false)}
      onBusyChange={assistant.setBusy}
      onProductUpdated={assistant.onProductUpdated} />}
  </div>;
}
