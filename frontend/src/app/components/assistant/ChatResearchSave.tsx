import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { FilePlus2, FolderKanban } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { Button } from "@/app/components/ui/button";
import { FileDirectory, type DirectoryLocation } from "@/app/components/shared/FileDirectory";
import { NewProjectModal } from "@/app/components/projects/NewProjectModal";
import { createResearchFile, getResearchFile, promoteChatResearch } from "@/app/lib/api/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import { isResearchDocument } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { createTableFromChat, getChat } from "@/app/lib/api/chat";
import { ResearchViews } from "../shared/ResearchViews";

export function ChatResearchSave({ chatId, projectId }: { chatId: string; projectId?: string }) {
  const navigate = useNavigate();
  const [intent, setIntent] = useState<"workspace" | "table">("workspace");
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Document[]>([]), [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState(false), [directoryKey, setDirectoryKey] = useState(0);
  const [location, setLocation] = useState<DirectoryLocation>(projectId ? { projectId } : { library: "files" });

  async function finish(fileId: string, view: "workspace" | "table") {
    if (view === "workspace") navigate(`/sources?research_file=${encodeURIComponent(fileId)}`);
    else {
      const table = await createTableFromChat(chatId, fileId);
      navigate(`/tabular-reviews/${encodeURIComponent(table.id)}${table.needs_arrangement ? "?chat=new" : ""}`,
        table.needs_arrangement ? { state: { tableIntent: "Arrange the linked research in this table to suit the work already requested. Reuse existing labels, passages and answers; choose useful rows, columns and grouping." } } : undefined);
    }
  }
  async function show(view: "workspace" | "table") {
    const { chat } = await getChat(chatId);
    if (chat.research_file_id) return finish(chat.research_file_id, view);
    setIntent(view);
    setOpen(true); setSelected([]); setCreating(false); setStatus(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected[0]) return setStatus("Choose a workspace");
    setSaving(true); setStatus(null);
    try {
      const destination = await getResearchFile(selected[0]!.id);
      await promoteChatResearch({ chatId, researchFileId: destination.document.id,
        versionId: destination.versionId, workingRevision: destination.workingRevision,
        includeQueries: true });
      await finish(destination.document.id, intent);
      setOpen(false);
    } catch (reason) {
      setStatus(errorMessage(reason, "Could not open research"));
    } finally { setSaving(false); }
  }

  const close = () => setOpen(false);
  return <>
    <ResearchViews workspace={() => show("workspace")} table={() => show("table")} />
    <Modal open={open && !projectOpen} onClose={close} size="lg" breadcrumbs={["Workspace"]}
      footerStatus={status && <span role="alert" className="text-sm text-red-700">{status}</span>}
      cancelAction={{ label: "Close", onClick: close, disabled: saving }}
      primaryAction={{ label: saving ? "Opening…" : `Open ${intent}`,
        type: "submit", form: "save-chat-research", disabled: saving || creating || !selected.length }}>
      <form id="save-chat-research" onSubmit={(event) => void save(event)}
        className="flex min-h-0 flex-1 flex-col gap-3 pb-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {!projectId && <Button size="compact" variant="outline" disabled={saving}
            onClick={() => { setCreating(false); setProjectOpen(true); }}>
            <FolderKanban aria-hidden className="size-3.5" /> New project
          </Button>}
          <Button size="compact" variant="outline" className="ms-auto"
            disabled={saving || creating || "projectId" in location && !location.projectId}
            onClick={() => { setCreating(true); setSelected([]); setStatus(null); }}>
            <FilePlus2 aria-hidden className="size-3.5" /> New workspace
          </Button>
        </div>
        <FileDirectory key={directoryKey} projectId={projectId} selectedDocuments={selected}
          initialLocation={location} onLocationChange={setLocation}
          onChange={setSelected} showTabs={!projectId} tabs={[["files", "Library"], ["projects", "Projects"]]}
          noun="workspaces" multiple={false} documentFilter={isResearchDocument}
          newDocument={creating ? { label: "Workspace name", filename: "Workspace.research.md",
            onCreate: async (title, location, folderId) => (await createResearchFile({ title,
              projectId: "projectId" in location ? location.projectId : null,
              ...(folderId ? { folderId } : {}) })).document,
            onCancel: () => setCreating(false) } : undefined} />
      </form>
    </Modal>
    <NewProjectModal open={projectOpen} onClose={() => setProjectOpen(false)}
      onCreated={(project) => {
        setLocation({ projectId: project.id }); setDirectoryKey((value) => value + 1);
        setSelected([]); setProjectOpen(false);
      }} />
  </>;
}
