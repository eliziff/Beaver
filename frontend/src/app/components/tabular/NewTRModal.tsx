import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import type { Document, Project, Workflow } from "../shared/types";
import {
    uploadProjectDocument,
    uploadStandaloneDocument,
} from "@/app/lib/beaverApi";
import { FileDirectory } from "../shared/FileDirectory";
import { Modal } from "../modals/Modal";
import { ModalFieldLabel } from "../modals/ModalFieldLabel";
import { ModalTextInput } from "../modals/ModalTextInput";
import { ProjectChoiceList } from "../projects/ProjectChoiceList";
import { useWorkflowPickerState } from "../workflows/WorkflowPickerModal";
import { CheckboxInput } from "../ui/checkbox";
interface Props {
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
}
export function NewTRModal({ open, ...props }: Props) {
    if (!open) return null;
    return <OpenNewTRModal open {...props} />;
}
function OpenNewTRModal({
    open,
    onClose,
    onAdd,
    projects,
    projectId: fixedProjectId,
    projectName,
    projectCmNumber,
}: Props) {
    const isProjectMode = fixedProjectId !== undefined;
    const [step, setStep] = useState<"details" | "documents">("details");
    const titleRef = useRef("");
    const [underProject, setUnderProject] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [projectDocs, setProjectDocs] = useState<Document[]>([]);
    const [extraStandaloneDocs, setExtraStandaloneDocs] = useState<Document[]>(
        [],
    );
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const {
        workflows,
        loading: workflowsLoading,
        selected: selectedWorkflow,
        setSelected: setSelectedWorkflow,
        hasMore: hasMoreWorkflows,
        loadMore: loadMoreWorkflows,
    } = useWorkflowPickerState("tabular");
    const formId = "new-tabular-review-modal-form";
    function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const title =
            step === "details"
                ? String(
                      new FormData(e.currentTarget).get("title") ?? "",
                  ).trim() || "Untitled review"
                : titleRef.current;
        if (underProject && !selectedProjectId) return;
        const submitter = (e.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
        if (step === "details" || submitter?.value !== "create-review") {
            titleRef.current = title;
            setStep("documents");
            return;
        }
        const projectId = fixedProjectId ?? (underProject ? selectedProjectId : undefined);
        onAdd(
            title.trim(),
            projectId || undefined,
            selectedDocuments.length > 0
                ? selectedDocuments.map((document) => document.id)
                : undefined,
            selectedWorkflow?.columns_config ?? undefined,
        );
        onClose();
    }
    async function handleSelectProject(projectId: string) {
        setSelectedProjectId(projectId);
        setProjectDocs([]);
        setSelectedDocuments([]);
    }
    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? []);
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                files.map((f) =>
                    fixedProjectId || (underProject && selectedProjectId)
                        ? uploadProjectDocument(fixedProjectId ?? selectedProjectId, f)
                        : uploadStandaloneDocument(f),
                ),
            );
            const addUploaded =
                fixedProjectId || (underProject && selectedProjectId)
                    ? setProjectDocs
                    : setExtraStandaloneDocs;
            addUploaded((prev) => [...uploaded, ...prev]);
            setSelectedDocuments((prev) => [
                ...new Map(
                    [...prev, ...uploaded].map((doc) => [doc.id, doc]),
                ).values(),
            ]);
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }
    const directoryDocuments = isProjectMode || underProject
        ? projectDocs
        : extraStandaloneDocs;
    const breadcrumbs =
        isProjectMode && projectName
            ? [
                  "Projects",
                  `${projectName}${projectCmNumber ? ` (#${projectCmNumber})` : ""}`,
                  "New Tabular Review",
              ]
            : ["Tabular Reviews", "New Tabular Review"];
    const invalid = underProject && !selectedProjectId;
    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={[
                ...breadcrumbs,
                step === "details" ? "Details" : "Add Documents",
            ]}
            secondaryAction={
                step === "documents"
                    ? {
                          label: uploading ? "Uploading..." : "Upload",
                          icon: uploading ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                              <Upload className="h-3.5 w-3.5" />
                          ),
                          onClick: () => fileInputRef.current?.click(),
                          disabled: uploading,
                      }
                    : undefined
            }
            cancelAction={
                step === "documents"
                    ? {
                          label: "Back",
                          onClick: () => setStep("details"),
                          disabled: uploading,
                      }
                    : undefined
            }
            primaryAction={
                step === "details"
                    ? {
                          label: "Next",
                          type: "submit",
                          form: formId,
                          disabled: invalid,
                      }
                    : {
                          label: "Create",
                          type: "submit",
                          form: formId,
                          value: "create-review",
                          disabled: invalid,
                      }
            }
        >
            <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt"
                multiple
                className="hidden"
                onChange={handleUpload}
            />
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="flex flex-col min-h-0 flex-1"
            >
                {step === "details" ? (
                    <div className="space-y-6">
                        <div>
                            <ModalFieldLabel htmlFor="new-tr-title">
                                Review name
                            </ModalFieldLabel>
                            <ModalTextInput
                                id="new-tr-title"
                                name="title"
                                type="text"
                                placeholder="Review name"
                                variant="minimal"
                                className="placeholder:text-gray-400"
                                autoFocus
                            />
                        </div>
                        <div>
                            <ModalFieldLabel htmlFor="new-tr-workflow-template">
                                Workflow template
                            </ModalFieldLabel>
                            <div className="flex min-w-0 items-center gap-2">
                                <select
                                    id="new-tr-workflow-template"
                                    value={selectedWorkflow?.id ?? ""}
                                    disabled={workflowsLoading && !workflows.length}
                                    onChange={(event) => setSelectedWorkflow(
                                        workflows.find(({ id }) => id === event.currentTarget.value) ?? null,
                                    )}
                                    className="h-10 min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-gray-600 disabled:opacity-60"
                                >
                                    <option value="">Start from scratch</option>
                                    {workflows.map((workflow) => (
                                        <option key={workflow.id} value={workflow.id}>
                                            {workflow.metadata.title}
                                        </option>
                                    ))}
                                </select>
                                {hasMoreWorkflows && (
                                    <button
                                        type="button"
                                        onClick={() => void loadMoreWorkflows()}
                                        disabled={workflowsLoading}
                                        className="h-10 shrink-0 px-2 text-sm text-gray-600 hover:text-gray-900"
                                    >
                                        {workflowsLoading ? "Loading..." : "Load more"}
                                    </button>
                                )}
                            </div>
                            {selectedWorkflow?.metadata.description && (
                                <p className="mt-2 text-xs leading-5 text-gray-500">
                                    {selectedWorkflow.metadata.description}
                                </p>
                            )}
                        </div>
                        {!isProjectMode && (
                            <div className="space-y-3">
                                <ModalFieldLabel as="p">
                                    Project
                                </ModalFieldLabel>
                                <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm text-gray-600">
                                    <CheckboxInput
                                        checked={underProject}
                                        onChange={(event) => {
                                            setUnderProject(
                                                event.currentTarget.checked,
                                            );
                                            if (!event.currentTarget.checked) {
                                                setSelectedProjectId("");
                                                setProjectDocs([]);
                                                setSelectedDocuments([]);
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
                                            void handleSelectProject(value);
                                        }}
                                        disabled={projects?.length === 0}
                                    />
                                )}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                        {(isProjectMode ||
                            !underProject ||
                            selectedProjectId) && (
                            <FileDirectory
                                documents={directoryDocuments}
                                projectId={isProjectMode
                                    ? fixedProjectId
                                    : underProject ? selectedProjectId : undefined}
                                selectedDocuments={selectedDocuments}
                                onChange={setSelectedDocuments}
                                showTabs={!isProjectMode && !underProject}
                            />
                        )}
                    </div>
                )}
            </form>
        </Modal>
    );
}
