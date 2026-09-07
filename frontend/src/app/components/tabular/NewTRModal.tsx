import { useRef, useState } from "react";
import { ArrowLeft, Import, ListPlus, Plus, Sparkles, Upload } from "lucide-react";
import { directoryResource, uploadDocumentsSettled, type Document } from "@/app/lib/api/documents";
import { designTabularReview, type ColumnConfig, type TabularResearchScope } from "@/app/lib/api/tabular";
import type { Project } from "@/app/lib/api/projects";
import { Modal } from "../modals/Modal";
import { FormField } from "../modals/ModalFieldLabel";
import { ModalTextInput } from "../modals/ModalTextInput";
import { ModalTextarea } from "../modals/ModalTextarea";
import { ChoiceCards } from "../shared/ChoiceCards";
import { FileDirectory, type DirectoryLocation } from "../shared/FileDirectory";
import { useWorkflowPickerState } from "../workflows/WorkflowPickerModal";
import type { WorkflowSelection } from "../workflows/workflowRoutes";
import { WorkflowPickerContent } from "../workflows/WorkflowPickerContent";
import { Button } from "../ui/button";
import { emptyColumn } from "./ColumnEditor";
import { ColumnList } from "./ColumnList";
import { ImportResearchSet } from "./ImportResearchSet";

type Step = "workflows" | "custom" | "form" | "import";
type Props = {
    open: boolean; onClose: () => void;
    onAdd: (title: string, projectId?: string, documentIds?: string[],
        columnsConfig?: ColumnConfig[] | null, workflowId?: string, research?: TabularResearchScope) => Promise<void> | void;
    onOpen: (path: string) => void;
    projects?: Project[]; projectId?: string; projectName?: string; projectCmNumber?: string | null;
    research?: TabularResearchScope;
};
const CARDS = [
    { id: "manual" as const, icon: ListPlus, title: "Set columns manually", hint: "Write each column yourself." },
    { id: "assist" as const, icon: Sparkles, title: "Chat assist", hint: "Describe the review and revise the proposed columns." },
    { id: "import" as const, icon: Import, title: "Import a Research set", hint: "Turn saved sources or passages into rows." },
];
export function NewTRModal({ open, ...props }: Props) {
    return open ? <OpenNewTRModal {...props} /> : null;
}
function OpenNewTRModal({ onClose, onAdd, onOpen, projectId, projectName, research }: Omit<Props, "open">) {
    const [step, setStep] = useState<Step>("workflows");
    const [origin, setOrigin] = useState<Step>("workflows");
    const [assist, setAssist] = useState(false);
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
    function reindex(configured?: ColumnConfig[]) {
        setColumns(configured); nextColumn.current = Math.max(-1, ...(configured ?? []).map(({ index }) => index)) + 1;
        setExpandedColumn(null);
    }
    function choose(value: WorkflowSelection | null, from: Step) {
        if (!hasChosen.current || value?.workflow.id !== selection?.workflow.id || value?.variant.id !== selection?.variant.id)
            reindex(value?.variant.columns_config ?? undefined);
        hasChosen.current = true;
        setSelection(value); setOrigin(from); setStep("form"); setError("");
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
    if (step === "import") return <ImportResearchSet open onClose={() => setStep("custom")}
        projectId={projectId} onOpen={onOpen} />;
    const crumb = step === "custom" ? "Create custom"
        : step === "form" ? selection?.variant.label ?? (assist ? "Chat assist" : "Set columns manually") : null;
    return <Modal open onClose={onClose} size="2xl" breadcrumbs={[projectName ?? "New review", ...(crumb ? [crumb] : [])]}
        headerStart={step !== "workflows" ? <Button type="button" variant="outline" size="icon-sm" aria-label="Back"
            disabled={busy} onClick={() => setStep(step === "form" ? origin : "workflows")}><ArrowLeft aria-hidden className="size-3.5" /></Button> : undefined}
        primaryAction={step === "form" ? { label: submitting ? "Creating…" : "Create", type: "submit", form: "new-tabular-review-modal-form", disabled: busy } : undefined}>
        {step === "workflows" ? <WorkflowPickerContent workflows={workflow.workflows} execution="tabular"
            searchAction={<Button type="button" variant="outline" className="h-10 shrink-0 px-3" onClick={() => setStep("custom")}><Plus />Create custom</Button>}
            search={workflow.search} onSearchChange={workflow.setSearch} audience={workflow.audience} onAudienceChange={workflow.setAudience}
            loading={workflow.loading} loadError={workflow.loadError} onRetryLoad={workflow.retryLoad}
            onSelect={(item, variant) => { if (variant) choose({ workflow: item, variant }, "workflows"); }} />
        : step === "custom" ? <ChoiceCards options={CARDS} onChoose={(id) => {
            if (id === "import") return setStep("import");
            setAssist(id === "assist"); choose(null, "custom");
        }} />
        : <form id="new-tabular-review-modal-form" onSubmit={submit} noValidate className="flex flex-1 flex-col gap-4 pb-3 md:min-h-0">
            {assist && <DesignBox current={columns} title={title} documentNames={documents.map(({ filename }) => filename)}
                onDesign={(design) => { setTitle(design.title); reindex(design.columns_config); }} />}
            <FormField label="Review name" htmlFor="new-tr-title">
                <ModalTextInput value={title} autoFocus={!assist} placeholder="Untitled review" onChange={(event) => setTitle(event.currentTarget.value)} />
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
                        <ColumnList columns={columns ?? []} expanded={expandedColumn} onExpand={setExpandedColumn}
                            onChange={(updated) => setColumns((items) => items?.map((item) => item.index === updated.index ? updated : item))}
                            onRemove={({ index }) => setColumns((items) => items?.filter((item) => item.index !== index))} />
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

function DesignBox({ current, title, documentNames, onDesign }: {
    current?: ColumnConfig[]; title: string; documentNames: string[];
    onDesign: (design: { title: string; columns_config: ColumnConfig[] }) => void;
}) {
    const [request, setRequest] = useState("");
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");
    async function propose() {
        const text = request.trim();
        if (!text || running) return;
        setRunning(true); setError("");
        try {
            onDesign(await designTabularReview({ request: text, ...(title.trim() ? { title: title.trim() } : {}),
                ...(current?.length ? { current } : {}), ...(documentNames.length ? { documentNames } : {}) }));
        } catch { setError("Could not propose a design. Try again."); }
        finally { setRunning(false); }
    }
    return <div className="space-y-2">
        <ModalTextarea aria-label="Describe the review" value={request} rows={2} disabled={running} className="min-h-16"
            placeholder={current?.length ? "Describe a revision…" : "Describe the review…"}
            onChange={(event) => setRequest(event.currentTarget.value)} />
        <div className="flex items-center justify-end gap-3">
            {error && <p role="alert" className="mr-auto text-sm text-red-700">{error}</p>}
            <Button type="button" variant="outline" size="compact" disabled={running || !request.trim()}
                onClick={() => void propose()}>{running ? "Proposing…" : "Propose design"}</Button>
        </div>
    </div>;
}
