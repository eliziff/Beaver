import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { directoryResource, uploadDocumentsSettled, uploadStandaloneDocument } from "@/app/lib/beaverApi";
import { Modal } from "../modals/Modal";
import { FieldGroup, FormField } from "../modals/ModalFieldLabel";
import { ModalTextInput } from "../modals/ModalTextInput";
import { ModalSelect } from "../modals/ModalSelect";
import { ProjectChoiceList } from "../projects/ProjectChoiceList";
import { FileDirectory } from "../shared/FileDirectory";
import type { ColumnConfig, Document, Project } from "../shared/types";
import { useWorkflowPickerState } from "../workflows/WorkflowPickerModal";
import { workflowVariants, type WorkflowSelection } from "../workflows/workflowRoutes";
import { CheckboxInput } from "../ui/checkbox";

type Props = {
    open: boolean;
    onClose: () => void;
    onAdd: (
        title: string,
        projectId?: string,
        documentIds?: string[],
        columnsConfig?: ColumnConfig[] | null,
        workflowId?: string,
    ) => Promise<void> | void;
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
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
    const workflow = useWorkflowPickerState();
    const [workflowSelection, setWorkflowSelection] = useState<WorkflowSelection | null>(null);
    const workflowOptions = workflow.workflows.flatMap((item) =>
        workflowVariants(item, "tabular").map((variant) => ({ workflow: item, variant })));
    const formId = "new-tabular-review-modal-form";
    const activeProjectId = fixedProjectId ??
        (underProject ? selectedProjectId : undefined);
    const invalid = underProject && !selectedProjectId;

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
        if (step === "details" || submitter?.value !== "create-review") {
            title.current = String(
                new FormData(event.currentTarget).get("title") ?? "",
            ).trim() || "Untitled review";
            if (!invalid) { setError(""); setStep("documents"); }
            return;
        }
        setSubmitting(true); setError("");
        try {
            await onAdd(
                title.current,
                activeProjectId,
                documents.length ? documents.map(({ id }) => id) : undefined,
                workflowSelection?.variant.columns_config ?? undefined,
                workflowSelection?.workflow.id,
            );
            onClose();
        } catch {
            setError("The review could not be created. Try again.");
        } finally { setSubmitting(false); }
    }

    async function upload(files: FileList | null) {
        if (!files?.length) return;
        setUploading(true); setError("");
        try {
            const resource = activeProjectId
                ? directoryResource({ projectId: activeProjectId })
                : null;
            const results = await uploadDocumentsSettled(
                Array.from(files),
                resource ? resource.uploadDocument : uploadStandaloneDocument,
            );
            const added = results.flatMap((result) =>
                result.status === "fulfilled" ? [result.value] : []);
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
            const failed = results.length - added.length;
            if (failed) setError(`${failed} file${failed === 1 ? "" : "s"} could not be uploaded. Try again.`);
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
            breadcrumbs={breadcrumbs}
            size="2xl"
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
                disabled: uploading || submitting,
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
                disabled: invalid || uploading || submitting,
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
                    <div className="max-w-lg space-y-6">
                        <FormField label="Review name" htmlFor="new-tr-title">
                            <ModalTextInput name="title" placeholder="Review name" autoFocus
                                defaultValue={title.current} />
                        </FormField>
                        <FormField label="Workflow template" htmlFor="new-tr-workflow-template"
                            hint={workflowSelection?.workflow.metadata.description}>
                                <ModalSelect
                                    id="new-tr-workflow-template"
                                    value={workflowSelection?.variant.id ?? ""}
                                    disabled={workflow.loading && !workflow.workflows.length}
                                    onChange={(value) => setWorkflowSelection(
                                        workflowOptions.find(({ variant }) =>
                                            variant.id === value) ?? null)}
                                    placeholder={null}
                                    options={[
                                        { value: "", label: "Start from scratch" },
                                        ...workflowOptions.map(({ workflow: item, variant }) => ({
                                            value: variant.id,
                                            label: `${item.metadata.title}: ${variant.label}`,
                                        })),
                                    ]}
                                />
                        </FormField>
                        {!isProjectMode && (
                            <FieldGroup legend="Project" className="space-y-3">
                                <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm text-gray-600">
                                    <CheckboxInput
                                        checked={underProject}
                                        onChange={(event) => {
                                            setUnderProject(event.currentTarget.checked);
                                            if (!event.currentTarget.checked) {
                                                setSelectedProjectId("");
                                                setProjectUploads([]);
                                                setDocuments([]);
                                            }
                                        }}
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
                            </FieldGroup>
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
                {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
            </form>
        </Modal>
    );
}
