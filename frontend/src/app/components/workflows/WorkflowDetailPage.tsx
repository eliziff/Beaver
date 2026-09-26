import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Users } from "lucide-react";
import {
  deleteWorkflow,
  getWorkflow,
  updateWorkflow,
  exportWorkflow,
  type Workflow,
  type WorkflowVariant,
} from "@/app/lib/api/workflows";
import { downloadBlob } from "@/app/lib/download";
import { uploadDocumentSession } from "@/app/lib/api/uploads";
import { deleteDocument, downloadDocument, uploadDocumentVersion } from "@/app/lib/api/documents";
import type { ColumnConfig } from "@/app/lib/api/tabular";

import { AddColumnModal } from "../tabular/AddColumnModal";
import { AccessModal } from "../modals/AccessModal";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { MoreActionsMenu, type MoreActionsMenuItem } from "../shared/MoreActionsMenu";
import { PageHeader, type PageHeaderAction } from "../shared/PageHeader";
import { Button } from "../ui/button";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { workflowPath } from "./workflowRoutes";

type Modal = "details" | "share" | "delete" | null;
const variantInput = ({ label, result, execution, skill_md, columns_config }: WorkflowVariant) =>
    ({ label, result, execution, skill_md, columns_config });

export function WorkflowDetailPage({ id }: { id: string }) {
    const navigate = useNavigate();
    const [workflow, setWorkflow] = useState<Workflow | null>();
    const [modal, setModal] = useState<Modal>(null);
    const [column, setColumn] = useState<ColumnConfig | "new" | null>(null);
    const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [deleting, setDeleting] = useState(false);
    const [fileError, setFileError] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    async function changeFiles(operation: () => Promise<unknown>) {
        setUploading(true); setFileError(null);
        try { await operation(); setWorkflow(await getWorkflow(id)); }
        catch (error) { setFileError(error instanceof Error ? error.message : "The file could not be updated."); }
        finally { setUploading(false); }
    }
    useEffect(() => {
        getWorkflow(id).then((loaded) => {
            if (loaded.is_system) { navigate(`/workflows?workflow=${encodeURIComponent(loaded.id)}`,
                { replace: true }); return; }
            if (loaded.launcher.kind !== "instructions") { navigate(workflowPath(loaded),
                { replace: true }); return; }
            setWorkflow(loaded);
        }).catch(() => setWorkflow(null));
    }, [id, navigate]);
    const variant = workflow?.launcher.kind === "instructions" ? workflow.launcher.variants[0] : undefined;
    const readOnly = workflow?.is_system !== false || workflow.allow_edit === false;
    const canShare = workflow?.is_system === false;
    async function saveVariant(next: WorkflowVariant) {
        if (!workflow || readOnly) return;
        setStatus("saving");
        try {
            const updated = await updateWorkflow(id, { launcher: { kind: "instructions",
                variants: [variantInput(next)] } });
            setWorkflow(updated);
            setStatus("saved"); setTimeout(() => setStatus("idle"), 1500);
        } catch { setStatus("error"); }
    }
    function saveColumns(next: ColumnConfig[]) {
        if (variant) void saveVariant({ ...variant, columns_config: next }); setColumn(null);
    }
    async function remove() {
        if (!workflow || readOnly) return;
        setDeleting(true);
        try { await deleteWorkflow(id); navigate("/workflows"); } finally { setDeleting(false); }
    }
    if (workflow === null) return <div className="grid h-full place-items-center text-sm text-gray-500">Workflow not found.</div>;
    const menuItems: MoreActionsMenuItem[] = workflow ? [{ label: "Download workflow",
        onSelect: () => void exportWorkflow(id)
            .then(({ blob, filename }) => downloadBlob(blob, filename ?? "workflow.zip")) },
        ...(!readOnly ? [{ label: "Edit details", onSelect: () => setModal("details") },
            { label: "Delete", onSelect: () => setModal("delete") }] : []),
    ] : [];
    const actions: (PageHeaderAction | null)[] | undefined = workflow ? [
        { type: "custom", render: <span role="status" className={`w-20 text-center text-xs ${
            status === "error" ? "text-red-700" : "text-gray-500"}`}>
            {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? "Save failed" : ""}
        </span> },
        canShare ? { title: "Share workflow", iconOnly: true,
            icon: <Users aria-hidden="true" className="h-4 w-4" />, onClick: () => setModal("share") } : null,
        { type: "custom", render: <MoreActionsMenu label="Workflow actions" items={menuItems} /> },
    ] : undefined;
    return <div className="flex h-full min-h-0 flex-col">
            <PageHeader shrink breadcrumbs={[
                { label: "Workflows", title: "Back to Workflows", onClick: () => navigate("/workflows") },
                workflow ? { label: workflow.metadata.title }
                    : { loading: true, skeletonClassName: "w-40" },
            ]} actions={actions} />
            {workflow && variant && <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
                <header className="mb-5">
                    <p className="text-xs font-medium text-gray-500">{workflow.metadata.category}</p>
                    <h1 className="mt-1 font-serif text-2xl font-medium text-gray-900">{workflow.metadata.title}</h1>
                    {workflow.metadata.description && <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">{workflow.metadata.description}</p>}
                </header>
                {variant.execution === "assistant" ? <textarea
                    key={variant.id} aria-label="Workflow instructions" readOnly={readOnly}
                    defaultValue={variant.skill_md ?? ""}
                    onBlur={(event) => { if (event.currentTarget.value !== (variant.skill_md ?? ""))
                        void saveVariant({ ...variant, skill_md: event.currentTarget.value }); }}
                    placeholder="Write the workflow instructions in Markdown."
                    className="min-h-96 w-full resize-y rounded-lg border border-gray-300 bg-white p-4 font-mono text-sm leading-6 text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 read-only:resize-none read-only:bg-gray-50" />
                : <section aria-labelledby="workflow-columns-title">
                    <div className="flex items-center justify-between gap-3">
                        <h2 id="workflow-columns-title" className="font-serif text-xl font-medium text-gray-900">Table columns</h2>
                        {!readOnly && <Button size="compact"
                            onClick={() => setColumn("new")}><Plus aria-hidden="true" className="h-4 w-4" />Add column</Button>}
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {(variant.columns_config ?? []).map((item) => <button
                                key={item.index} type="button" disabled={readOnly}
                                onClick={() => setColumn(item)}
                                className="min-h-20 rounded-lg bg-gray-50 p-3 text-left disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                                <span className="block text-sm font-medium text-gray-800">{item.name}</span>
                                <span className="mt-1 block text-xs leading-5 text-gray-500">{item.prompt}</span>
                            </button>)}
                    </div>
                </section>}
                <section className="mt-6 space-y-3" aria-label="Reference documents">
                    <h2 className="text-base font-medium text-gray-900">Reference documents</h2>
                    {!readOnly && <label className="block text-sm text-gray-700">Add files
                        <input type="file" multiple disabled={uploading} className="mt-2 block w-full"
                            onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = "";
                                void changeFiles(async () => { for (const file of files) await uploadDocumentSession(file, { workflow_id: id }); }); }} />
                    </label>}
                    {fileError && <p role="alert" className="text-sm text-red-700">{fileError}</p>}
                    {(workflow.documents ?? []).map((document) => <div key={document.id} className="flex flex-wrap items-center gap-3 text-sm">
                        <button type="button" className="underline" onClick={() => void downloadDocument(document.id, document.current_version_id)
                            .then(({ blob, filename }) => downloadBlob(blob, filename ?? document.filename))
                            .catch(() => setFileError("The file could not be downloaded."))}>{document.filename}</button>
                        {!readOnly && <>
                            <label className="text-gray-600">New version
                                <input type="file" disabled={uploading} aria-label={`Upload a new version of ${document.filename}`}
                                    onChange={(event) => { const file = event.target.files?.[0]; event.target.value = "";
                                        if (file) void changeFiles(() => uploadDocumentVersion(document.id, file,
                                            document.current_version_id, document.current_working_revision)); }} />
                            </label>
                            <button type="button" disabled={uploading} aria-label={`Remove ${document.filename}`}
                                onClick={() => { if (window.confirm(`Remove ${document.filename} from this workflow?`))
                                    void changeFiles(() => deleteDocument({ ...document, project_id: null, folder_id: null })); }}>Remove</button>
                        </>}
                    </div>)}
                </section>
            </main>}
            {workflow && <>
                <NewWorkflowModal open={modal === "details"} editWorkflow={workflow}
                    onClose={() => setModal(null)} onUpdated={setWorkflow} />
                <AccessModal open={modal === "share"} onClose={() => setModal(null)}
                    kind="workflow" resourceId={id} title={workflow.metadata.title}
                    onChange={async () => setWorkflow(await getWorkflow(id))} />
                <ConfirmPopup open={modal === "delete"} title="Delete workflow?"
                    message="This permanently deletes the workflow." confirmLabel="Delete workflow"
                    confirmStatus={deleting ? "loading" : "idle"}
                    onConfirm={() => void remove()} onCancel={() => setModal(null)} />
            </>}
            {workflow && variant && !readOnly && <AddColumnModal open={column !== null}
                existingCount={variant.columns_config?.length ?? 0} editingColumn={column === "new"
                    ? undefined : column ?? undefined}
                onClose={() => setColumn(null)}
                onAdd={(added) => saveColumns([...(variant.columns_config ?? []),
                    ...added.map((item, index) => ({ ...item,
                        index: (variant.columns_config?.length ?? 0) + index }))])}
                onSave={(updated) => saveColumns((variant.columns_config ?? []).map((item) =>
                    item.index === updated.index ? updated : item))}
                onDelete={column && column !== "new" ? () => saveColumns(
                    (variant.columns_config ?? []).filter(({ index }) => index !== column.index)
                        .map((item, index) => ({ ...item, index }))) : undefined} />}
        </div>;
}
