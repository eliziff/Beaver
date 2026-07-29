"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import type { Document, Project, Workflow } from "../shared/types";
import {
    getProject,
    uploadProjectDocument,
    uploadStandaloneDocument,
} from "@/app/lib/beaverApi";
import { FileDirectory } from "../shared/FileDirectory";
import { Modal } from "../modals/Modal";
import { ModalFieldLabel } from "../modals/ModalFieldLabel";
import { ModalTextInput } from "../modals/ModalTextInput";
import { ProjectChoiceList } from "../projects/ProjectChoiceList";
import { WorkflowPickerModal } from "../workflows/WorkflowPickerModal";
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
    projectDocs?: Document[];
    projectName?: string;
    projectCmNumber?: string | null;
}
export function NewTRModal({
    open,
    onClose,
    onAdd,
    projects = [],
    projectDocs: fixedProjectDocs,
    projectName,
    projectCmNumber,
}: Props) {
    const isProjectMode = fixedProjectDocs !== undefined;
    const [step, setStep] = useState<"details" | "documents">("details");
    const [title, setTitle] = useState("");
    const [underProject, setUnderProject] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [projectDocs, setProjectDocs] = useState<Document[]>([]);
    const [loadingDocs, setLoadingDocs] = useState(false);
    const [extraStandaloneDocs, setExtraStandaloneDocs] = useState<Document[]>(
        [],
    );
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(
        null,
    );
    const [workflowPickerOpen, setWorkflowPickerOpen] = useState(false);
    const formId = "new-tabular-review-modal-form";
    useEffect(() => {
        if (!open) return;
        if (isProjectMode) {
            setSelectedDocuments(fixedProjectDocs ?? []);
        }
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    if (!open) return null;
    function handleClose() {
        setStep("details");
        setTitle("");
        setUnderProject(false);
        setSelectedProjectId("");
        setProjectDocs([]);
        setExtraStandaloneDocs([]);
        setSelectedDocuments([]);
        setSelectedWorkflow(null);
        setWorkflowPickerOpen(false);
        onClose();
    }
    function submitterValue(e: React.FormEvent<HTMLFormElement>) {
        return (
            (e.nativeEvent as SubmitEvent).submitter as
                | HTMLButtonElement
                | null
        )?.value;
    }
    function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!title.trim()) return;
        if (underProject && !selectedProjectId) return;
        if (step === "details" || submitterValue(e) !== "create-review") {
            setStep("documents");
            return;
        }
        onAdd(
            title.trim(),
            underProject ? selectedProjectId : undefined,
            selectedDocuments.length > 0
                ? selectedDocuments.map((document) => document.id)
                : undefined,
            selectedWorkflow?.columns_config ?? undefined,
        );
        handleClose();
    }
    async function handleSelectProject(projectId: string) {
        setSelectedProjectId(projectId);
        setProjectDocs([]);
        setSelectedDocuments([]);
        setLoadingDocs(true);
        try {
            const proj = await getProject(projectId);
            const docs = (proj.documents ?? []).filter(
                (d) => d.status === "ready",
            );
            setProjectDocs(docs);
            setSelectedDocuments(docs);
        } finally {
            setLoadingDocs(false);
        }
    }
    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? []);
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                files.map((f) =>
                    underProject && selectedProjectId
                        ? uploadProjectDocument(selectedProjectId, f)
                        : uploadStandaloneDocument(f),
                ),
            );
            if (underProject && selectedProjectId) {
                setProjectDocs((prev) => [...uploaded, ...prev]);
            } else {
                setExtraStandaloneDocs((prev) => [...uploaded, ...prev]);
            }
            setSelectedDocuments((prev) => [
                ...prev,
                ...uploaded.filter(
                    (document) =>
                        !prev.some((selected) => selected.id === document.id),
                ),
            ]);
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }
    const directoryDocuments = isProjectMode
        ? (fixedProjectDocs ?? [])
        : underProject
          ? projectDocs
          : extraStandaloneDocs;
    const directoryLoading = isProjectMode
        ? false
        : underProject
          ? loadingDocs
          : false;
    const showDirectory = isProjectMode || !underProject || !!selectedProjectId;
    const breadcrumbs =
        isProjectMode && projectName
            ? [
                  "Projects",
                  `${projectName}${projectCmNumber ? ` (#${projectCmNumber})` : ""}`,
                  "New Tabular Review",
              ]
            : ["Tabular Reviews", "New Tabular Review"];
    return (
        <>
        <Modal
            open={open && !workflowPickerOpen}
            onClose={handleClose}
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
                          type: "button",
                          onClick: (event) => {
                              event.preventDefault();
                              setStep("documents");
                          },
                          disabled:
                              !title.trim() ||
                              (underProject && !selectedProjectId),
                      }
                    : {
                          label: "Create",
                          type: "submit",
                          form: formId,
                          name: "modalAction",
                          value: "create-review",
                          disabled:
                              !title.trim() ||
                              (underProject && !selectedProjectId),
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
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Review name"
                                variant="minimal"
                                className="placeholder:text-gray-400"
                                autoFocus
                            />
                        </div>
                        <div>
                            <ModalFieldLabel as="p">
                                Workflow template
                            </ModalFieldLabel>
                            <div className="flex min-w-0 items-center gap-2">
                                <button
                                    id="new-tr-workflow-template"
                                    type="button"
                                    onClick={() => setWorkflowPickerOpen(true)}
                                    className="flex h-10 min-w-0 flex-1 items-center rounded-md border border-gray-300 bg-white px-3 text-left text-sm text-gray-900 hover:border-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                                >
                                    <span className="truncate">
                                        {selectedWorkflow?.metadata.title ??
                                            "No template — start from scratch"}
                                    </span>
                                </button>
                                {selectedWorkflow && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSelectedWorkflow(null)
                                        }
                                        className="h-10 shrink-0 px-2 text-sm text-gray-600 hover:text-gray-900"
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>
                        </div>
                        {!isProjectMode && (
                            <div className="space-y-3">
                                <ModalFieldLabel as="p">
                                    Project
                                </ModalFieldLabel>
                                <button
                                    type="button"
                                    onClick={() => {
                                        const next = !underProject;
                                        setUnderProject(next);
                                        if (!next) {
                                            setSelectedProjectId("");
                                            setProjectDocs([]);
                                            setSelectedDocuments([]);
                                        }
                                    }}
                                    className="flex w-fit items-center gap-2.5"
                                >
                                    <span
                                        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full ${underProject ? "bg-gray-900" : "bg-gray-200"}`}
                                    >
                                        <span
                                            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white ${underProject ? "translate-x-4" : "translate-x-0"}`}
                                        />
                                    </span>
                                    <span className="text-sm text-gray-600">
                                        Create under a project
                                    </span>
                                </button>
                                {underProject && (
                                    <ProjectChoiceList
                                        projects={projects}
                                        value={selectedProjectId || null}
                                        onChange={(value) => {
                                            void handleSelectProject(value);
                                        }}
                                        disabled={projects.length === 0}
                                    />
                                )}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                        {showDirectory && (
                            <FileDirectory
                                documents={directoryDocuments}
                                loading={directoryLoading}
                                selectedDocuments={selectedDocuments}
                                onChange={setSelectedDocuments}
                                showTabs={!isProjectMode && !underProject}
                            />
                        )}
                    </div>
                )}
            </form>
        </Modal>
        <WorkflowPickerModal
            open={workflowPickerOpen}
            onClose={() => setWorkflowPickerOpen(false)}
            onSelect={(workflow) => setSelectedWorkflow(workflow)}
            workflowType="tabular"
            breadcrumbs={["New tabular review", "Workflow template"]}
            primaryLabel="Choose"
            initialWorkflowId={selectedWorkflow?.id}
        />
        </>
    );
}
