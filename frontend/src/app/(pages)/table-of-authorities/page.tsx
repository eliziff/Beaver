import { useState } from "react";
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
        onFocusChange={setFocus}
        onDraftChange={assistant.onProductChange} refreshToken={assistant.refreshToken}
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
