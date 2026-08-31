import { useState, type FormEvent } from "react";
import { LibraryBig } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { createResearchSet, listResearchSets, promoteChatResearch } from "@/app/lib/beaverApi";
import type { ResearchSetMetadata } from "@/app/lib/researchSets";
import { errorMessage } from "@/app/lib/utils";

export function ChatResearchSave({ chatId, projectId }: { chatId: string; projectId?: string }) {
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false);
  const [sets, setSets] = useState<ResearchSetMetadata[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function show() {
    setOpen(true); setSets(null); setStatus(null);
    try {
      const loaded = (await listResearchSets()).filter(({ projectId: id }) =>
        id === null || Boolean(projectId) && id === projectId);
      setSets(loaded);
    } catch (reason) {
      setSets([]); setStatus(errorMessage(reason, "Could not load saved research"));
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    setSaving(true); setStatus(null);
    try {
      const destinationId = String(form.get("destination"));
      const destination = destinationId === "new"
        ? await createResearchSet({ title: "Saved research", projectId: projectId ?? null })
        : sets?.find(({ id }) => id === destinationId);
      if (!destination) throw new Error("Choose where to save this research");
      await promoteChatResearch({ chatId, researchSetId: destination.id,
        revision: destination.revision, includeQueries: form.has("queries") });
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
        form: "save-chat-research", disabled: saving || sets === null }}>
      <p className="text-sm leading-6 text-gray-600">Save referenced legal sources and passages.</p>
      <form id="save-chat-research" onSubmit={(event) => void save(event)} className="mt-4 space-y-3">
        <label className="block text-xs font-medium text-gray-700">Destination
          <select key={sets?.[0]?.id ?? "new"} name="destination"
            defaultValue={sets?.[0]?.id ?? "new"}
            disabled={sets === null || saving}
            className="mt-1 h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm">
            {sets?.map((set) => <option key={set.id} value={set.id}>{set.title}</option>)}
            <option value="new">New Saved research</option>
          </select>
        </label>
        <label className="inline-flex min-h-9 items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" name="queries" /> Include model queries and match receipts
        </label>
      </form>
    </Modal>
  </>;
}
