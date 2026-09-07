import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { assistantIntent } from "../assistant/assistantIntent";
import { createPortal } from "react-dom";
import { Ellipsis, FilePlus2, FolderKanban, FolderPlus } from "lucide-react";
import { Modal } from "../modals/Modal";
import { NewProjectModal } from "../projects/NewProjectModal";
import { FileDirectory, type DirectoryLocation } from "../shared/FileDirectory";
import { ActionMenu } from "../ui/action-menu";
import { directoryResource, type Document } from "@/app/lib/api/documents";
import { createResearchFile } from "@/app/lib/api/researchFiles";
import { isResearchDocument, type ResearchFile } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { ResearchWorkspaceViews } from "./ResearchWorkspaceViews";
import { useSourcesWorkspace } from "./SourcesWorkspace";
const fileTitle = (file: ResearchFile | null) => file?.document.filename
  .replace(/\.research\.md$/iu, "") ?? "Workspace";

export function ResearchWorkspacePicker({ projectId, rail, onHistory }: { projectId?: string; rail?: HTMLElement | null; onHistory: () => void }) {
  const workspace = useSourcesWorkspace(), { file } = workspace, navigate = useNavigate();
  const [open, setOpen] = useState(false), [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
  const [createOpen, setCreateOpen] = useState(false), [renameOpen, setRenameOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false), [projectOpen, setProjectOpen] = useState(false),
    [directoryKey, setDirectoryKey] = useState(0), [folderError, setFolderError] = useState(""),
    [openLocation, setOpenLocation] = useState<DirectoryLocation>(() => projectId ?? file?.document.project_id
      ? { projectId: projectId ?? file!.document.project_id! } : { library: "files" });
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const returnToPicker = useRef(false);
  const directory = useMemo(() => directoryResource(file?.document.project_id
    ? { projectId: file.document.project_id } : { library: "files" }), [file?.document.project_id]);
  useEffect(() => { if (open) setSelectedDocuments(file ? [file.document] : []); }, [open, file]);
  async function choose(id: string) {
    setBusy(true); setStatus("");
    try { await workspace.open(id); setOpen(false); }
    catch (reason) { setStatus(errorMessage(reason, "Could not open research")); }
    finally { setBusy(false); }
  }
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!file) return; const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    if (!title) return; setBusy(true); setStatus("");
    try { await directory.renameDocument(file.document.id, `${title.replace(/\.research\.md$/iu, "")}.research.md`);
      await workspace.refresh(); setRenameOpen(false); }
    catch (reason) { setStatus(errorMessage(reason, "Could not rename workspace")); }
    finally { setBusy(false); }
  }
  async function createLibraryFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    const activeProject = projectId ?? ("projectId" in openLocation ? openLocation.projectId : null);
    if (!name) return; setBusy(true); setFolderError("");
    try { await directoryResource(activeProject ? { projectId: activeProject } : { library: "files" }).createFolder(name, null);
      setDirectoryKey((value) => value + 1); setFolderOpen(false); setOpen(true); returnToPicker.current = false; }
    catch (reason) { setFolderError(errorMessage(reason, "Could not create folder")); }
    finally { setBusy(false); }
  }
  const newWorkspace = () => { setOpen(true); setCreateOpen(true); setSelectedDocuments([]); };
  const closePicker = () => { setOpen(false); setCreateOpen(false); };
  const newFolder = () => { setFolderError(""); setFolderOpen(true); };
  const closeFolder = () => { setFolderOpen(false); if (returnToPicker.current) { returnToPicker.current = false; setOpen(true); } };
  const selector = file ? <div className="flex min-w-0 max-w-full items-center gap-2">
    <span className="min-w-0 truncate text-base font-semibold text-gray-900" title={fileTitle(file)}>{fileTitle(file)}</span>
    <ActionMenu label="Workspace options" className="shrink-0" items={[
    { label: "Rename", onSelect: () => setRenameOpen(true) },
    { label: "History", onSelect: onHistory },
    { label: "Suggest organization…", onSelect: () => {
      setStatus(""); void workspace.chat().then(({ path }) => navigate(path, { state: { assistantIntent: assistantIntent(
        "Suggest a simpler organization of this research using its existing sources and saved highlights. Keep whole-source labels separate from highlight types. Present the changes as a proposal for me to approve; do not apply them or save additional passages.") } }))
        .catch((reason) => setStatus(errorMessage(reason, "Could not open research chat")));
    } },
    { label: "Open another", onSelect: () => setOpen(true) },
    { label: "New workspace", onSelect: () => { returnToPicker.current = false; newWorkspace(); } },
  ]} triggerClassName="grid size-8 place-items-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
    <Ellipsis className="size-4" aria-hidden="true" />
  </ActionMenu><ResearchWorkspaceViews /></div> : <span className="text-base font-semibold text-gray-900">Workspaces</span>;

  return <>
    {rail === undefined ? <div className="flex min-h-11 shrink-0 items-center pb-2">{selector}</div>
      : rail ? createPortal(selector, rail) : null}
    {!file && <div className="py-4">
        <p className="text-sm leading-5 text-gray-600">Keep sources, passages, labels, searches, and notes together.</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setOpen(true)} className="h-9 rounded-md bg-gray-900 px-3 text-sm font-medium text-white hover:bg-gray-700">Open</button>
          <button type="button" onClick={() => { returnToPicker.current = false; newWorkspace(); }} className="ms-auto h-9 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-50">New workspace</button>
        </div>
    </div>}
    <Modal open={open} onClose={closePicker} size="lg" className="!h-[min(30rem,calc(100dvh-2rem))]" breadcrumbs={["Workspaces"]}
      footerStatus={status && <span role="alert" className="text-sm text-red-700">{status}</span>}
      primaryAction={{ label: busy ? "Opening..." : "Open",
        onClick: () => { const document = selectedDocuments.find(isResearchDocument); if (document) void choose(document.id); },
        disabled: busy || createOpen || !selectedDocuments.some(isResearchDocument) }}>
      <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" disabled={!projectId && "projectId" in openLocation && !openLocation.projectId}
          onClick={() => { returnToPicker.current = true; setOpen(false); newFolder(); }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"><FolderPlus className="size-3.5" />New folder</button>
        <button type="button" onClick={() => { returnToPicker.current = true; setOpen(false); setProjectOpen(true); }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"><FolderKanban className="size-3.5" />New project</button>
        <button type="button" disabled={createOpen || (!projectId && "projectId" in openLocation && !openLocation.projectId)} onClick={newWorkspace}
          className="ms-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"><FilePlus2 aria-hidden className="size-3.5" />New workspace</button>
      </div>
      <FileDirectory key={directoryKey} selectedDocuments={selectedDocuments} onChange={setSelectedDocuments}
        showTabs={!projectId} projectId={projectId} initialLocation={openLocation}
        tabs={[["files", "Library"], ["projects", "Projects"]]} noun="workspaces" multiple={false}
        documentFilter={isResearchDocument} onLocationChange={setOpenLocation}
        newDocument={createOpen ? { label: "Workspace name", filename: "Workspace.research.md",
          onCreate: async (title, location, folderId) => (await createResearchFile({ title,
            projectId: "projectId" in location ? location.projectId : undefined,
            ...(folderId ? { folderId } : {}) })).document,
          onCancel: () => setCreateOpen(false) } : undefined} />
      </div>
    </Modal>
    <Modal open={renameOpen} onClose={() => setRenameOpen(false)} size="sm" fit
      breadcrumbs={["Workspace", "Rename"]}
      primaryAction={{ label: busy ? "Renaming..." : "Rename", type: "submit", form: "research-rename", disabled: busy }}>
      <form id="research-rename" onSubmit={rename} className="pb-5">
        <label className="grid gap-1 text-xs font-medium text-gray-700">Workspace name
          <input required autoFocus name="title" defaultValue={file ? fileTitle(file) : ""} className="h-9 rounded-md border border-gray-300 px-2 text-sm font-normal text-gray-900" />
        </label>
      </form>
    </Modal>
    <Modal open={folderOpen} onClose={closeFolder} size="sm" className="!h-[min(15rem,calc(100dvh-2rem))]"
      breadcrumbs={["projectId" in openLocation ? "Projects" : "Library", "New folder"]}
      primaryAction={{ label: busy ? "Creating..." : "Create folder", type: "submit", form: "research-new-folder",
        disabled: busy }}>
      <form id="research-new-folder" onSubmit={createLibraryFolder} className="pb-5">
        <label className="grid gap-1 text-xs font-medium text-gray-600">Folder name
          <input required autoFocus name="name" className="h-9 rounded-md border border-gray-300 px-2 text-sm font-normal text-gray-900" />
        </label>
        {folderError && <p role="alert" className="mt-2 text-xs text-red-700">{folderError}</p>}
      </form>
    </Modal>
    <NewProjectModal open={projectOpen} onClose={() => { setProjectOpen(false); if (returnToPicker.current) {
      returnToPicker.current = false; setOpen(true); } }} onCreated={(project) => {
      setOpenLocation({ projectId: project.id });
      setDirectoryKey((value) => value + 1); setProjectOpen(false); setOpen(true); returnToPicker.current = false; }} />

  </>;
}
