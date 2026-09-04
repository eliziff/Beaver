import { useSearchParams } from "react-router-dom";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { beaverAuthoritiesHost } from "@/app/authorities/beaverHost";
import type { AuthoritiesProduct } from "@/app/authorities/types";
import { WorkProductAssistant, WorkProductAssistantButton,
  useWorkProductAssistantState } from "@/app/components/assistant/WorkProductAssistant";
import { LibraryDocumentPicker } from "@/app/components/shared/LibraryDocumentPicker";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

export default function TableOfAuthoritiesPage() {
  const [params, setParams] = useSearchParams();
  const { profile } = useUserProfile();
  const assistant = useWorkProductAssistantState<AuthoritiesProduct>();
  const draftId = assistant.product?.id;
  const replaceDraft = (id?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("draft", id); else next.delete("draft");
    setParams(next, { replace: true });
  };
  return <div className="relative flex h-full min-h-0 w-full">
    <div className="min-h-0 min-w-0 flex-1">
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} LibraryPicker={LibraryDocumentPicker}
        jurisdictionOrder={profile?.jurisdictionPreference.jurisdictions}
        route={{ draftId: params.get("draft") ?? "",
          projectId: params.get("project") || undefined, replaceDraft }}
        locked={assistant.busy}
        onDraftChange={assistant.onProductChange} refreshToken={assistant.refreshToken}
        headerActions={<WorkProductAssistantButton available={!!assistant.product}
          expanded={assistant.expanded} onClick={() => assistant.setExpanded((open) => !open)} />} />
    </div>
    {draftId && <WorkProductAssistant expanded={assistant.expanded}
      product={assistant.product} synced={assistant.synced} chatId={assistant.chatId}
      onChatIdChange={assistant.onChatIdChange} onClose={() => assistant.setExpanded(false)}
      onBusyChange={assistant.setBusy}
      onProductUpdated={assistant.onProductUpdated} />}
  </div>;
}
