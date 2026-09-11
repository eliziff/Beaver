import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { beaverAuthoritiesHost } from "@/app/authorities/beaverHost";
import type { AuthoritiesProduct } from "@/app/authorities/types";
import type { WorkProductFocus } from "@/app/lib/workProducts";
import { WorkProductAssistant, WorkProductAssistantButton,
  useWorkProductAssistantState } from "@/app/components/assistant/WorkProductAssistant";
import { LibraryDocumentPicker } from "@/app/components/shared/LibraryDocumentPicker";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

export default function TableOfAuthoritiesPage() {
  const [params, setParams] = useSearchParams();
  const { profile } = useUserProfile();
  const assistant = useWorkProductAssistantState<AuthoritiesProduct>();
  const [focus, setFocus] = useState<WorkProductFocus>();
  const draftId = assistant.product?.id;
  const { onProductChange } = assistant;
  const onDraftChange = useCallback((draft: AuthoritiesProduct | undefined, synced: boolean) => {
    onProductChange(draft, synced);
    const routeId = params.get("draft");
    if (routeId === draft?.id || !routeId && !draft) return;
    const next = new URLSearchParams(params);
    if (draft) next.set("draft", draft.id); else next.delete("draft");
    setParams(next, { replace: true });
  }, [onProductChange, params, setParams]);
  return <div className="relative flex h-full min-h-0 w-full">
    <div className="min-h-0 min-w-0 flex-1">
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} LibraryPicker={LibraryDocumentPicker}
        jurisdictionOrder={profile?.jurisdictionPreference.jurisdictions}
        initialDraftId={params.get("draft") ?? undefined}
        projectId={params.get("project") || undefined}
        locked={assistant.busy}
        onFocusChange={setFocus}
        onDraftChange={onDraftChange} refreshToken={assistant.refreshToken}
        headerActions={assistant.product ? <WorkProductAssistantButton available
          expanded={assistant.expanded} onClick={() => assistant.setExpanded((open) => !open)} />
          : undefined} />
    </div>
    {draftId && <WorkProductAssistant expanded={assistant.expanded} focus={focus}
      product={assistant.product} synced={assistant.synced} chatId={assistant.chatId}
      onChatIdChange={assistant.onChatIdChange} onClose={() => assistant.setExpanded(false)}
      onBusyChange={assistant.setBusy}
      onProductUpdated={assistant.onProductUpdated} />}
  </div>;
}
