import { useState, type FormEvent } from "react";
import { LibraryBig } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { createResearchFile, getResearchFile, listResearchFiles, promoteChatResearch } from "@/app/lib/beaverApi";
import type { Document } from "@/app/components/shared/types";
import { errorMessage } from "@/app/lib/utils";

export function ChatResearchSave({ chatId, projectId }: { chatId: string; projectId?: string }) {
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<Document[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function show() {
    setOpen(true); setFiles(null); setStatus(null);
    try {
      const [library, project] = await Promise.all([
        listResearchFiles(), projectId ? listResearchFiles(projectId) : Promise.resolve([]),
      ]);
      setFiles([...project, ...library]);
    } catch (reason) {
      setFiles([]); setStatus(errorMessage(reason, "Could not load saved research"));
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    setSaving(true); setStatus(null);
    try {
      const id = String(form.get("destination"));
      if (id !== "new" && !files?.some((file) => file.id === id))
        throw new Error("Choose where to save this research");
      const destination = id === "new"
        ? await createResearchFile({ title: "Research", projectId: projectId ?? null })
        : await getResearchFile(id);
      await promoteChatResearch({ chatId, researchFileId: destination.document.id,
        versionId: destination.versionId, includeQueries: form.has("queries") });
      setOpen(false);
    } catch (reason) {
      setStatus(errorMessage(reason, "Could not save chat research"));
    } finally { setSaving(false); }
  }

  const close = () => setOpen(false);
  return <>
    <button type="button" onClick={() => void show()}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
      <LibraryBig aria-hidden className="size-3.5" /> Save research
    </button>
    <Modal open={open} onClose={close} size="sm" breadcrumbs={["Assistant", "Save research"]}
      footerStatus={status && <span role="status" className="text-sm text-gray-600">{status}</span>}
      cancelAction={{ label: "Close", onClick: close, disabled: saving }}
      primaryAction={{ label: saving ? "Saving..." : "Save research", type: "submit",
        form: "save-chat-research", disabled: saving || files === null }}>
      <form id="save-chat-research" onSubmit={(event) => void save(event)} className="space-y-3">
        <label className="block text-xs font-medium text-gray-700">Destination
          <select key={files?.[0]?.id ?? "new"} name="destination"
            defaultValue={files?.[0]?.id ?? "new"}
            disabled={files === null || saving}
            className="mt-1 h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm">
            {files?.map((file) => <option key={file.id} value={file.id}>{file.filename.replace(/\.research\.md$/iu, "")}</option>)}
            <option value="new">New research file</option>
          </select>
        </label>
        <label className="inline-flex min-h-9 items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" name="queries" /> Include model queries and match receipts
        </label>
      </form>
    </Modal>
  </>;
}
