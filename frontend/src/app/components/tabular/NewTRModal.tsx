import { useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Plus, Upload, X } from "lucide-react";
import { directoryResource, uploadDocumentsSettled, type Document } from "@/app/lib/api/documents";
import type { ColumnConfig, TabularResearchScope } from "@/app/lib/api/tabular";
import type { Project } from "@/app/lib/api/projects";
import { Modal } from "../modals/Modal";
import { FormField } from "../modals/ModalFieldLabel";
import { ModalTextInput } from "../modals/ModalTextInput";
import { FileDirectory, type DirectoryLocation } from "../shared/FileDirectory";
import { useWorkflowPickerState } from "../workflows/WorkflowPickerModal";
import type { WorkflowSelection } from "../workflows/workflowRoutes";
import { WorkflowPickerContent } from "../workflows/WorkflowPickerContent";
import { Button } from "../ui/button";
import { ColumnEditor, emptyColumn } from "./ColumnEditor";

type Props = {
    open: boolean; onClose: () => void;
    onAdd: (title: string, projectId?: string, documentIds?: string[],
        columnsConfig?: ColumnConfig[] | null, workflowId?: string, research?: TabularResearchScope) => Promise<void> | void;
    projects?: Project[]; projectId?: string; projectName?: string; projectCmNumber?: string | null;
    research?: TabularResearchScope;
};
export function NewTRModal({ open, ...props }: Props) {
    return open ? <OpenNewTRModal {...props} /> : null;
}
function OpenNewTRModal({ onClose, onAdd, projectId, projectName, research }: Omit<Props, "open">) {
    const [choosing, setChoosing] = useState(true);
    const [title, setTitle] = useState("");
    const [location, setLocation] = useState<DirectoryLocation>(projectId ? { projectId } : { library: "files" });
    const [uploads, setUploads] = useState<Document[]>([]);
    const [documents, setDocuments] = useState<Document[]>([]);
    const [uploading, setUploading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
    const workflow = useWorkflowPickerState(undefined, "all");
    const [selection, setSelection] = useState<WorkflowSelection | null>(null);
    const [columns, setColumns] = useState<ColumnConfig[] | undefined>();
    const [expandedColumn, setExpandedColumn] = useState<number | null>(null);
    const nextColumn = useRef(0);
    const hasChosen = useRef(false);
    const activeProjectId = "projectId" in location ? location.projectId ?? undefined : undefined;
    const busy = uploading || submitting;
    function choose(value: WorkflowSelection | null) {
        if (!hasChosen.current || value?.workflow.id !== selection?.workflow.id || value?.variant.id !== selection?.variant.id) {
            const configured = value?.variant.columns_config ?? undefined;
            setColumns(configured); nextColumn.current = Math.max(-1, ...(configured ?? []).map(({ index }) => index)) + 1;
            setExpandedColumn(null);
        }
        hasChosen.current = true;
        setSelection(value); setChoosing(false); setError("");
    }
    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        const invalid = columns?.find((column) => !column.name.trim() || !column.prompt.trim());
        if (invalid) { setExpandedColumn(invalid.index); setError("Give each column a title and prompt."); return; }
        setSubmitting(true); setError("");
        try {
            await onAdd(title.trim() || "Untitled review", activeProjectId,
                documents.length ? documents.map(({ id }) => id) : undefined,
                columns?.map((column, index) => ({ ...column, index, name: column.name.trim(), prompt: column.prompt.trim() })), selection?.workflow.id,
                ...(research ? [research] : []));
            onClose();
        } catch { setError("The review could not be created. Try again."); }
        finally { setSubmitting(false); }
    }
    async function upload(files: FileList | null) {
        if (!files?.length || ("projectId" in location && !location.projectId)) return;
        setUploading(true); setError("");
        try {
            const resource = directoryResource("projectId" in location ? { projectId: location.projectId! } : location);
            const results = await uploadDocumentsSettled(Array.from(files), resource.uploadDocument);
            const added = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
            setUploads((current) => [...current, ...added]);
            setDocuments((current) => [...current, ...added]);
            const failed = results.length - added.length;
            if (failed) setError(`${failed} file${failed === 1 ? "" : "s"} could not be uploaded. Try again.`);
        } catch { setError("Files could not be uploaded. Try again."); }
        finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; }
    }
    return <Modal open onClose={onClose} size="2xl" breadcrumbs={[projectName ?? "New review", ...(!choosing ? [selection?.variant.label ?? "Create custom"] : [])]}
        headerStart={!choosing ? <Button type="button" variant="outline" size="icon-sm" aria-label="Back"
            disabled={busy} onClick={() => setChoosing(true)}><ArrowLeft aria-hidden className="size-3.5" /></Button> : undefined}
        primaryAction={!choosing ? { label: submitting ? "Creating…" : "Create", type: "submit", form: "new-tabular-review-modal-form", disabled: busy } : undefined}>
        {choosing ? <WorkflowPickerContent workflows={workflow.workflows} execution="tabular"
            searchAction={<Button type="button" variant="outline" className="h-10 shrink-0 px-3" onClick={() => choose(null)}><Plus />Create custom</Button>}
            search={workflow.search} onSearchChange={workflow.setSearch} audience={workflow.audience} onAudienceChange={workflow.setAudience}
            loading={workflow.loading} loadError={workflow.loadError} onRetryLoad={workflow.retryLoad}
            onSelect={(item, variant) => { if (variant) choose({ workflow: item, variant }); }} />
        : <form id="new-tabular-review-modal-form" onSubmit={submit} noValidate className="flex flex-1 flex-col gap-4 pb-3 md:min-h-0">
            <FormField label="Review name" htmlFor="new-tr-title">
                <ModalTextInput value={title} autoFocus placeholder="Untitled review" onChange={(event) => setTitle(event.currentTarget.value)} />
            </FormField>
            <div className={`grid flex-1 gap-5 md:min-h-0 ${research ? "" : "md:grid-cols-2"}`}>
                <section aria-label="Columns" className={`flex min-h-0 min-w-0 flex-col gap-2 ${research ? "" : "md:border-r md:border-gray-200 md:pr-5"}`}>
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-medium text-gray-900">Columns</h2>
                        <Button type="button" variant="outline" size="compact" onClick={() => {
                            const column = emptyColumn(nextColumn.current++);
                            setColumns((items) => [...(items ?? []), column]); setExpandedColumn(column.index);
                        }}><Plus />Add column</Button>
                    </div>
                    <div className="space-y-2 pb-2 md:min-h-0 md:overflow-y-auto">
                        {columns?.length ? columns.map((column, position) => <div key={column.index} className="border-b border-gray-200 pb-2">
                            <div className="flex items-center gap-2">
                                <button type="button" aria-expanded={expandedColumn === column.index}
                                    onClick={() => setExpandedColumn(expandedColumn === column.index ? null : column.index)}
                                    className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded px-1 text-left text-sm font-medium text-gray-800 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900">
                                    <ChevronDown aria-hidden className={`size-3.5 shrink-0 text-gray-500 ${expandedColumn === column.index ? "" : "-rotate-90"}`} />
                                    <span className="truncate">{column.name || `Column ${position + 1}`}</span>
                                </button>
                                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove column ${position + 1}`}
                                    onClick={() => setColumns((items) => items?.filter((item) => item.index !== column.index))}><X /></Button>
                            </div>
                            {expandedColumn === column.index && <ColumnEditor column={column}
                                onChange={(updated) => setColumns((items) => items?.map((item) => item.index === column.index ? updated : item))} />}
                        </div>) : <p className="py-2 text-sm text-gray-500">Add columns now or after creating the review.</p>}
                    </div>
                </section>
                {!research && <section aria-label="Documents" className="flex h-80 min-w-0 flex-col gap-2 md:h-auto md:min-h-0">
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-medium text-gray-900">Documents</h2>
                        <Button type="button" variant="outline" size="compact" disabled={busy || ("projectId" in location && !location.projectId)}
                            onClick={() => fileInput.current?.click()}><Upload />{uploading ? "Uploading…" : "Upload"}</Button>
                    </div>
                    <fieldset disabled={busy} className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <FileDirectory documents={uploads.filter((document) => (document.project_id ?? undefined) === activeProjectId &&
                            ("projectId" in location || (document.library_kind ?? "file") === (location.library === "templates" ? "template" : "file")))}
                            projectId={projectId} initialLocation={location} selectedDocuments={documents} onChange={setDocuments}
                            showTabs={!projectId} autoFocus={false} onLocationChange={setLocation} />
                    </fieldset>
                </section>}
            </div>
            <input ref={fileInput} type="file" accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt" multiple hidden
                onChange={(event) => void upload(event.currentTarget.files)} />
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </form>}
    </Modal>;
}


