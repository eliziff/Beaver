import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { directoryResource, uploadDocuments, uploadStandaloneDocument } from "@/app/lib/beaverApi";
import { Modal, MODAL_INPUT_CLASS, MODAL_LABEL_CLASS } from "../modals/Modal";
import { ProjectChoiceList } from "../projects/ProjectChoiceList";
import { FileDirectory } from "../shared/FileDirectory";
import type { Document, Project, Workflow } from "../shared/types";
import { useWorkflowPickerState } from "../workflows/WorkflowPickerModal";

type Props = {
    open: boolean;
    onClose: () => void;
    onAdd: (
        title: string,
        projectId?: string,
        documentIds?: string[],
        columnsConfig?: Workflow["columns_config"],
    ) => void;
    projects?: Project[];
    projectId?: string;
    projectName?: string;
    projectCmNumber?: string | null;
};

export function NewTRModal({ open, ...props }: Props) {
    return open ? <OpenNewTRModal {...props} /> : null;
}

function OpenNewTRModal({
    onClose,
    onAdd,
    projects,
    projectId: fixedProjectId,
    projectName,
    projectCmNumber,
}: Omit<Props, "open">) {
    const isProjectMode = fixedProjectId !== undefined;
    const [step, setStep] = useState<"details" | "documents">("details");
    const title = useRef("");
    const [underProject, setUnderProject] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [projectUploads, setProjectUploads] = useState<Document[]>([]);
    const [standaloneUploads, setStandaloneUploads] = useState<Document[]>([]);
    const [documents, setDocuments] = useState<Document[]>([]);
    const [uploading, setUploading] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const workflow = useWorkflowPickerState("tabular");
    const formId = "new-tabular-review-modal-form";
    const activeProjectId = fixedProjectId ??
        (underProject ? selectedProjectId : undefined);
    const invalid = underProject && !selectedProjectId;

    function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
        if (step === "details" || submitter?.value !== "create-review") {
            title.current = String(
                new FormData(event.currentTarget).get("title") ?? "",
            ).trim() || "Untitled review";
            if (!invalid) setStep("documents");
            return;
        }
        onAdd(
            title.current,
            activeProjectId,
            documents.length ? documents.map(({ id }) => id) : undefined,
            workflow.selected?.columns_config ?? undefined,
        );
        onClose();
    }

    async function upload(files: FileList | null) {
        if (!files?.length) return;
        setUploading(true);
        try {
            const resource = activeProjectId
                ? directoryResource({ projectId: activeProjectId })
                : null;
            const added = await uploadDocuments(
                Array.from(files),
                resource ? resource.uploadDocument : uploadStandaloneDocument,
            );
            (activeProjectId ? setProjectUploads : setStandaloneUploads)(
                (current) => [...added, ...current],
            );
            setDocuments((current) => [
                ...new Map(
                    [...current, ...added].map((document) => [
                        document.id,
                        document,
                    ]),
                ).values(),
            ]);
        } catch (error) {
            console.error("Upload failed", error);
        } finally {
            setUploading(false);
            if (fileInput.current) fileInput.current.value = "";
        }
    }

    const breadcrumbs = isProjectMode && projectName
        ? [
            "Projects",
            `${projectName}${projectCmNumber ? ` (#${projectCmNumber})` : ""}`,
            "New Tabular Review",
        ]
        : ["Tabular Reviews", "New Tabular Review"];

    return (
        <Modal
            open
            onClose={onClose}
            breadcrumbs={[
                ...breadcrumbs,
                step === "details" ? "Details" : "Add Documents",
            ]}
            secondaryAction={step === "documents" ? {
                label: uploading ? "Uploading…" : "Upload",
                icon: uploading
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Upload className="h-3.5 w-3.5" />,
                onClick: () => fileInput.current?.click(),
                disabled: uploading,
            } : undefined}
            cancelAction={step === "documents" ? {
                label: "Back",
                onClick: () => setStep("details"),
                disabled: uploading,
            } : undefined}
            primaryAction={step === "details" ? {
                label: "Next",
                type: "submit",
                form: formId,
                disabled: invalid,
            } : {
                label: "Create",
                type: "submit",
                form: formId,
                value: "create-review",
                disabled: invalid || uploading,
            }}
        >
            <input
                ref={fileInput}
                type="file"
                accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt"
                multiple
                hidden
                onChange={(event) => void upload(event.currentTarget.files)}
            />
            <form
                id={formId}
                onSubmit={submit}
                className="flex min-h-0 flex-1 flex-col"
            >
                {step === "details" ? (
                    <div className="space-y-6">
                        <div>
                            <label
                                className={MODAL_LABEL_CLASS}
                                htmlFor="new-tr-title"
                            >
                                Review name
                            </label>
                            <input
                                id="new-tr-title"
                                name="title"
                                type="text"
                                placeholder="Review name"
                                className={`${MODAL_INPUT_CLASS} placeholder:text-gray-400`}
                                autoFocus
                            />
                        </div>
                        <div>
                            <label
                                className={MODAL_LABEL_CLASS}
                                htmlFor="new-tr-workflow-template"
                            >
                                Workflow template
                            </label>
                            <div className="flex min-w-0 items-center gap-2">
                                <select
                                    id="new-tr-workflow-template"
                                    value={workflow.selected?.id ?? ""}
                                    disabled={workflow.loading && !workflow.workflows.length}
                                    onChange={(event) => workflow.setSelected(
                                        workflow.workflows.find(({ id }) =>
                                            id === event.currentTarget.value) ?? null,
                                    )}
                                    className="h-10 min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-gray-600 disabled:opacity-60"
                                >
                                    <option value="">Start from scratch</option>
                                    {workflow.workflows.map((item) => (
                                        <option key={item.id} value={item.id}>
                                            {item.metadata.title}
                                        </option>
                                    ))}
                                </select>
                                {workflow.hasMore && (
                                    <button
                                        type="button"
                                        onClick={() => void workflow.loadMore()}
                                        disabled={workflow.loading}
                                        className="h-10 shrink-0 px-2 text-sm text-gray-600 hover:text-gray-900"
                                    >
                                        {workflow.loading ? "Loading…" : "Load more"}
                                    </button>
                                )}
                            </div>
                            {workflow.selected?.metadata.description && (
                                <p className="mt-2 text-xs leading-5 text-gray-500">
                                    {workflow.selected.metadata.description}
                                </p>
                            )}
                        </div>
                        {!isProjectMode && (
                            <div className="space-y-3">
                                <p className={MODAL_LABEL_CLASS}>Project</p>
                                <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm text-gray-600">
                                    <input
                                        type="checkbox"
                                        checked={underProject}
                                        onChange={(event) => {
                                            setUnderProject(event.currentTarget.checked);
                                            if (!event.currentTarget.checked) {
                                                setSelectedProjectId("");
                                                setProjectUploads([]);
                                                setDocuments([]);
                                            }
                                        }}
                                        className="h-[18px] w-[18px] shrink-0 cursor-pointer rounded border-gray-500 accent-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
                                    />
                                    Create under a project
                                </label>
                                {underProject && (
                                    <ProjectChoiceList
                                        projects={projects}
                                        value={selectedProjectId || null}
                                        onChange={(value) => {
                                            setSelectedProjectId(value);
                                            setProjectUploads([]);
                                            setDocuments([]);
                                        }}
                                        disabled={projects?.length === 0}
                                    />
                                )}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                        {(!underProject || activeProjectId) && (
                            <FileDirectory
                                documents={activeProjectId
                                    ? projectUploads
                                    : standaloneUploads}
                                projectId={activeProjectId}
                                selectedDocuments={documents}
                                onChange={setDocuments}
                                showTabs={!isProjectMode && !underProject}
                            />
                        )}
                    </div>
                )}
            </form>
        </Modal>
    );
}
