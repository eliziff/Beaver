import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSegmentedToggle } from "@/app/components/modals/ModalSegmentedToggle";
import { ProjectChoiceList } from "@/app/components/projects/ProjectChoiceList";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import type { Folder } from "@/app/components/shared/types";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
import {
    directoryResource,
    getLibraryFolder,
    getProject,
    getProjectFolder,
    type WorkflowFileTarget,
} from "@/app/lib/beaverApi";

type Workflow = "court-records" | "authorities";
const workflows: Array<{ id: Workflow; label: string; defaultFolder: string }> = [
    { id: "court-records", label: "Court Records", defaultFolder: "Court Records" },
    { id: "authorities", label: "Authorities", defaultFolder: "Authorities" },
];

export function WorkflowFileTargetSettings() {
    const { profile, updateProfile } = useUserProfile();
    const [editing, setEditing] = useState<Workflow | null>(null);
    const targets = profile?.workflowFileTargets ?? {
        "court-records": null, authorities: null,
    };
    const selected = workflows.find(({ id }) => id === editing);

    async function save(target: WorkflowFileTarget) {
        if (!profile || !editing) return false;
        const saved = await updateProfile({ workflowFileTargets: {
            ...profile.workflowFileTargets, [editing]: target,
        } });
        if (saved) setEditing(null);
        return saved;
    }

    return <>
        <div className="divide-y divide-gray-200">
            {workflows.map((workflow) => <TargetRow key={workflow.id}
                {...workflow} target={targets[workflow.id]}
                disabled={!profile} onChoose={() => setEditing(workflow.id)} />)}
        </div>
        {selected && <TargetPicker key={selected.id} title={selected.label}
            current={targets[selected.id]} onClose={() => setEditing(null)} onSave={save} />}
    </>;
}

function TargetRow({ label, defaultFolder, target, disabled, onChoose }: {
    label: string; defaultFolder: string; target: WorkflowFileTarget | null;
    disabled: boolean; onChoose: () => void;
}) {
    const [location, setLocation] = useState(target
        ? "Loading location…" : `Library / ${defaultFolder}`);
    useEffect(() => {
        if (!target) { setLocation(`Library / ${defaultFolder}`); return; }
        let active = true;
        const request = target.kind === "library"
            ? getLibraryFolder(target.folderId).then(({ name }) => `Library / ${name}`)
            : Promise.all([getProject(target.projectId),
                getProjectFolder(target.projectId, target.folderId)])
                .then(([project, folder]) => `${project.name} / ${folder.name}`);
        request.then((value) => { if (active) setLocation(value); })
            .catch(() => { if (active) setLocation("Folder unavailable"); });
        return () => { active = false; };
    }, [defaultFolder, target]);
    return <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">{label}</p>
            <p className="mt-0.5 break-words text-sm text-gray-500" role="status">{location}</p>
        </div>
        <button type="button" disabled={disabled} onClick={onChoose}
            className="min-h-10 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:opacity-50">
            Choose folder
        </button>
    </div>;
}

function TargetPicker({ title, current, onClose, onSave }: {
    title: string; current: WorkflowFileTarget | null; onClose: () => void;
    onSave: (target: WorkflowFileTarget) => Promise<boolean>;
}) {
    const [kind, setKind] = useState<"library" | "project">(current?.kind ?? "library");
    const [projectId, setProjectId] = useState(current?.kind === "project"
        ? current.projectId : "");
    const [folder, setFolder] = useState<Folder | null>(null);
    const [saving, setSaving] = useState(false), [error, setError] = useState("");
    async function choose() {
        if (!folder || saving) return;
        setSaving(true); setError("");
        const target: WorkflowFileTarget = kind === "library"
            ? { kind, folderId: folder.id }
            : { kind, projectId, folderId: folder.id };
        if (!await onSave(target)) { setError("Unable to save. Try again."); setSaving(false); }
    }
    return <Modal open onClose={onClose} breadcrumbs={["Settings", title, "File location"]}
        size="md" className="!h-[min(32rem,calc(100dvh-2rem))]"
        footerStatus={<span role="status" className="text-sm text-red-700">{error}</span>}
        cancelAction={{ label: "Cancel", onClick: onClose }}
        primaryAction={{ label: "Use folder", onClick: () => void choose(),
            disabled: !folder || saving }}>
        <fieldset className="mb-3 shrink-0">
            <legend className="sr-only">Location type</legend>
            <ModalSegmentedToggle value={kind} options={[
                { value: "library", label: "Library" },
                { value: "project", label: "Project" },
            ]} onChange={(value) => {
                setKind(value); setProjectId(""); setFolder(null); setError("");
            }} />
        </fieldset>
        {kind === "project" && !projectId
            ? <ProjectChoiceList value={null} onChange={(id) => setProjectId(id)} />
            : <FolderBrowser key={`${kind}:${projectId}`} projectId={kind === "project"
                ? projectId : null} onSelect={setFolder}
                onChangeProject={kind === "project" ? () => {
                    setProjectId(""); setFolder(null);
                } : undefined} />}
    </Modal>;
}

function FolderBrowser({ projectId, onSelect, onChangeProject }: {
    projectId: string | null; onSelect: (folder: Folder | null) => void;
    onChangeProject?: () => void;
}) {
    const [path, setPath] = useState<Folder[]>([]), parent = path.at(-1) ?? null;
    const resource = useMemo(() => directoryResource(projectId
        ? { projectId } : { library: "files" }), [projectId]);
    const page = usePagedQuery((cursor, signal) => resource.list({
        parent_id: parent?.id ?? null, cursor, limit: 100,
    }, signal), [resource, parent?.id], true);
    const folders = page.items.flatMap((item) => item.kind === "folder" ? [item.folder] : []);
    function move(next: Folder[]) { setPath(next); onSelect(next.at(-1) ?? null); }
    return <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-gray-300 p-1"
        aria-busy={page.loading}>
        <div className="flex min-h-10 items-center gap-1 px-1">
            {(path.length > 0 || onChangeProject) && <button type="button"
                aria-label={`Back to ${path.length > 1 ? path.at(-2)?.name : projectId ? "projects" : "Library"}`}
                onClick={() => path.length ? move(path.slice(0, -1)) : onChangeProject?.()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900">
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>}
            <p className="min-w-0 break-words px-1 text-sm font-medium text-gray-800">
                {parent?.name ?? (projectId ? "Project folders" : "Library folders")}
            </p>
        </div>
        {folders.map((folder) => <button type="button" key={folder.id}
            onClick={() => move([...path, folder])}
            className="flex min-h-10 w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-gray-800 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900">
            <FolderSvgIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 break-words">{folder.name}</span>
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>)}
        {page.hasMore && <button type="button" disabled={page.loading}
            onClick={() => void page.loadMore()}
            className="min-h-10 w-full rounded px-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50">
            {page.loading ? "Loading…" : "Load more"}
        </button>}
        {page.loading && !folders.length && <p role="status"
            className="px-3 py-8 text-center text-sm text-gray-500">Loading folders…</p>}
        {page.error && !page.loading && <button type="button" onClick={() => void page.reload()}
            className="min-h-10 w-full rounded px-3 text-sm text-red-700 hover:bg-red-50">
            Unable to load folders. Try again
        </button>}
        {!page.loading && !page.error && !folders.length && <p className="px-3 py-8 text-center text-sm text-gray-500">
            {parent ? "No folders here" : "No folders yet"}
        </p>}
    </div>;
}
