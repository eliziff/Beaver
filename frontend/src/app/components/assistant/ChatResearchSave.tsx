import { useState, type FormEvent } from "react";
import { LibraryBig } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { Button } from "@/app/components/ui/button";
import { FileDirectory } from "@/app/components/shared/FileDirectory";
import { createResearchFile, getResearchFile, promoteChatResearch } from "@/app/lib/beaverApi";
import type { Document } from "@/app/components/shared/types";
import { isResearchDocument } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";

export function ChatResearchSave({ chatId, projectId }: { chatId: string; projectId?: string }) {
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Document[]>([]), [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  function show() {
    setOpen(true); setSelected([]); setCreating(false); setStatus(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    if (creating && !title) return setStatus("Enter a workspace name");
    if (!creating && !selected[0]) return setStatus("Choose a workspace");
    setSaving(true); setStatus(null);
    try {
      const destination = creating
        ? await createResearchFile({ title, projectId: projectId ?? null })
        : await getResearchFile(selected[0]!.id);
      await promoteChatResearch({ chatId, researchFileId: destination.document.id,
        versionId: destination.versionId, workingRevision: destination.workingRevision,
        includeQueries: form.has("queries") });
      setOpen(false);
    } catch (reason) {
      setStatus(errorMessage(reason, "Could not save sources"));
    } finally { setSaving(false); }
  }

  const close = () => setOpen(false);
  return <>
    <button type="button" onClick={show}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
      <LibraryBig aria-hidden className="size-3.5" /> Save sources
    </button>
    <Modal open={open} onClose={close} size="lg" breadcrumbs={["Assistant", "Save sources"]}
      headerAction={<Button size="compact" variant="outline" disabled={saving}
        onClick={() => { setCreating((value) => !value); setSelected([]); setStatus(null); }}>
        {creating ? "Choose existing" : "New workspace"}
      </Button>}
      footerStatus={status && <span role="alert" className="text-sm text-red-700">{status}</span>}
      cancelAction={{ label: "Close", onClick: close, disabled: saving }}
      primaryAction={{ label: saving ? "Saving..." : creating ? "Create and save" : "Save to workspace",
        type: "submit", form: "save-chat-research", disabled: saving || (!creating && !selected.length) }}>
      <form id="save-chat-research" onSubmit={(event) => void save(event)}
        className="flex min-h-0 flex-1 flex-col gap-3 pb-4">
        {creating ? <label className="text-sm font-medium text-gray-700">Workspace name
          <input autoFocus required name="title" disabled={saving}
            className="mt-1 h-10 w-full rounded-md border border-gray-300 px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-sm" />
        </label> : <FileDirectory projectId={projectId} selectedDocuments={selected}
          onChange={setSelected} showTabs={!projectId} tabs={[["files", "Library"]]}
          noun="workspaces" multiple={false} documentFilter={isResearchDocument} />}
        <label className="inline-flex min-h-9 shrink-0 items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" name="queries" /> Include model queries and match receipts
        </label>
      </form>
    </Modal>
  </>;
}
