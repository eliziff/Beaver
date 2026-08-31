import { useCallback, useState } from "react";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { beaverAuthoritiesHost } from "@/app/authorities/beaverHost";
import type { AuthoritiesProduct } from "@/app/authorities/types";
import { WorkProductAssistant, WorkProductAssistantButton } from "@/app/components/assistant/WorkProductAssistant";

export default function TableOfAuthoritiesPage() {
  const [readyDraft, setReadyDraft] = useState<AuthoritiesProduct>();
  const [draftId, setDraftId] = useState("");
  const [chatIds, setChatIds] = useState<Record<string, string>>({});
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const onDraftChange = useCallback((draft?: AuthoritiesProduct) => {
    setReadyDraft(draft);
    if (draft) setDraftId(draft.id);
  }, []);
  return <div className="relative flex h-full min-h-0 w-full">
    <div className="min-w-0 flex-1">
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} onDraftChange={onDraftChange}
        refreshToken={refreshToken}
        headerActions={<WorkProductAssistantButton ready={!!readyDraft}
          expanded={assistantOpen} onClick={() => setAssistantOpen(true)} />} />
    </div>
    {assistantOpen && draftId && <WorkProductAssistant key={draftId}
      product={readyDraft} chatId={chatIds[draftId]}
      onChatIdChange={(chatId) => setChatIds((current) => ({ ...current, [draftId]: chatId }))}
      onClose={() => setAssistantOpen(false)}
      onTurnComplete={() => setRefreshToken((current) => current + 1)} />}
  </div>;
}
