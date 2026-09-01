import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { beaverAuthoritiesHost } from "@/app/authorities/beaverHost";
import type { AuthoritiesProduct } from "@/app/authorities/types";
import { WorkProductAssistant, WorkProductAssistantButton,
  useWorkProductAssistantState } from "@/app/components/assistant/WorkProductAssistant";

export default function TableOfAuthoritiesPage() {
  const assistant = useWorkProductAssistantState<AuthoritiesProduct>();
  const draftId = assistant.product?.id;
  return <div className="relative flex h-full min-h-0 w-full">
    <div className="min-w-0 flex-1">
      <AuthoritiesWorkspace host={beaverAuthoritiesHost}
        locked={assistant.busy}
        onDraftChange={assistant.onProductChange} refreshToken={assistant.refreshToken}
        headerActions={<WorkProductAssistantButton available={!!assistant.product}
          expanded={assistant.expanded} onClick={() => assistant.setExpanded((open) => !open)} />} />
    </div>
    {draftId && <WorkProductAssistant key={draftId} expanded={assistant.expanded}
      product={assistant.product} synced={assistant.synced} chatId={assistant.chatId}
      onChatIdChange={assistant.onChatIdChange} onClose={() => assistant.setExpanded(false)}
      onBusyChange={assistant.setBusy}
      onProductUpdated={assistant.onProductUpdated} />}
  </div>;
}
