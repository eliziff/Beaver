import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSegmentedToggle } from "@/app/components/modals/ModalSegmentedToggle";
import { ProjectChoiceList } from "@/app/components/projects/ProjectChoiceList";
import { FolderBrowser } from "@/app/components/shared/FolderBrowser";
import { type Folder, directoryResource, getLibraryFolder, getProjectFolder } from "@/app/lib/api/documents";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

import { getProject } from "@/app/lib/api/projects";
import type { WorkflowFileTarget } from "@/app/lib/api/account";

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
    const directory = useMemo(() => directoryResource(kind === "project"
        ? { projectId } : { library: "files" }), [kind, projectId]);
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
            : <FolderBrowser key={`${kind}:${projectId}`}
                list={directory.list} createFolder={directory.createFolder}
                rootLabel={kind === "project" ? "Project folders" : "Library folders"}
                onSelect={setFolder}
                onBack={kind === "project" ? () => {
                    setProjectId(""); setFolder(null);
                } : undefined} />}
    </Modal>;
}
