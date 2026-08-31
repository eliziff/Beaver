import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { WorkProductAssistant, WorkProductAssistantButton } from "@/app/components/assistant/WorkProductAssistant";
import { CourtRecordsWorkspace } from "@/app/court-records/CourtRecordsWorkspace";
import { beaverCourtRecordsHost } from "@/app/court-records/beaverHost";
import type { CourtRecordDraft } from "@/app/court-records/types";
import type { WorkProduct } from "@/app/lib/workProducts";

export default function CourtRecordsPage() {
  const [params] = useSearchParams();
  const [readyDraft, setReadyDraft] = useState<WorkProduct<CourtRecordDraft>>();
  const [draftId, setDraftId] = useState("");
  const [chatIds, setChatIds] = useState<Record<string, string>>({});
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const onDraftChange = useCallback((draft?: WorkProduct<CourtRecordDraft>) => {
    setReadyDraft(draft);
    if (draft) setDraftId(draft.id);
  }, []);
  return <div className="relative flex h-full min-h-0 w-full">
    <div className="min-w-0 flex-1">
      <CourtRecordsWorkspace
        host={beaverCourtRecordsHost}
        initialDraftId={params.get("draft") ?? undefined}
        onDraftChange={onDraftChange}
        refreshToken={refreshToken}
        headerActions={<WorkProductAssistantButton ready={!!readyDraft}
          expanded={assistantOpen} onClick={() => setAssistantOpen(true)} />}
      />
    </div>
    {assistantOpen && draftId && <WorkProductAssistant key={draftId}
      product={readyDraft} chatId={chatIds[draftId]}
      onChatIdChange={(chatId) => setChatIds((current) => ({ ...current, [draftId]: chatId }))}
      onClose={() => setAssistantOpen(false)}
      onTurnComplete={() => setRefreshToken((current) => current + 1)} />}
  </div>;
}
