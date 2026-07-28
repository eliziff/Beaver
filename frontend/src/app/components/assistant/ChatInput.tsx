"use client";

import {
    useState,
    useCallback,
    useEffect,
    useRef,
    forwardRef,
    useImperativeHandle,
} from "react";
import {
    ArrowRight,
    Check,
    Library,
    Loader2,
    Square,
    Waypoints,
    X,
} from "lucide-react";
import { AddDocButton } from "./AddDocButton";
import { UploadOverlay } from "./UploadOverlay";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import {
    ModelToggle,
    ReasoningEffortToggle,
} from "./ModelToggle";
import {
    useSelectedModel,
    useSelectedReasoningEffort,
} from "@/app/hooks/useSelectedModel";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import type { Document, Message } from "../shared/types";
import type { DirectoryTab } from "../shared/useDirectoryData";
import { cn } from "@/app/lib/utils";
import {
    uploadProjectDocument,
    uploadStandaloneDocument,
} from "@/app/lib/beaverApi";
import {
    formatUnsupportedDocumentWarning,
    partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";

export interface ChatInputHandle {
    addDoc: (doc: Document) => void;
    clearDraft: () => void;
    startWorkflowDocumentSelection: (
        workflow: { id: string; title: string },
        prompt?: string,
        options?: { initialDocumentTab?: DirectoryTab },
    ) => void;
}

interface Props {
    onSubmit: (message: Message) => void;
    onCancel: () => void;
    isLoading: boolean;
    hideAddDocButton?: boolean;
    projectName?: string;
    projectCmNumber?: string | null;
    projectId?: string;
    onDocumentsUploaded?: (documents: Document[]) => void;
    restoreDraft?: Message | null;
    onDraftRestored?: () => void;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
    {
        onSubmit,
        onCancel,
        isLoading,
        hideAddDocButton,
        projectName,
        projectCmNumber,
        projectId,
        onDocumentsUploaded,
        restoreDraft,
        onDraftRestored,
    }: Props,
    ref,
) {
    const [value, setValue] = useState("");
    const [attachedDocs, setAttachedDocs] = useState<Document[]>([]);
    const [selectedWorkflow, setSelectedWorkflow] = useState<{
        id: string;
        title: string;
    } | null>(null);
    const [model, setModel] = useSelectedModel();
    const [reasoningEffort, setReasoningEffort] =
        useSelectedReasoningEffort();
    const { profile } = useUserProfile();
    const apiKeys = profile?.apiKeys;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [docSelectorOpen, setDocSelectorOpen] = useState(false);
    const [docSelectorInitialTab, setDocSelectorInitialTab] =
        useState<DirectoryTab>("files");
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [uploadingFilenames, setUploadingFilenames] = useState<string[]>([]);
    const [uploadWarning, setUploadWarning] = useState<string | null>(null);
    const [droppedDocuments, setDroppedDocuments] = useState<Document[]>([]);
    const dragDepthRef = useRef(0);
    const lastSubmittedDocsRef = useRef<Document[]>([]);

    useImperativeHandle(ref, () => ({
        addDoc: (doc: Document) => {
            setAttachedDocs((prev) => {
                if (prev.some((d) => d.id === doc.id)) return prev;
                return [...prev, doc];
            });
        },
        clearDraft: () => {
            setValue("");
            setAttachedDocs([]);
            setSelectedWorkflow(null);
            if (textareaRef.current) {
                textareaRef.current.style.height = "auto";
            }
        },
        startWorkflowDocumentSelection: (workflow, prompt, options) => {
            setSelectedWorkflow(workflow);
            setDocSelectorInitialTab(options?.initialDocumentTab ?? "files");
            if (prompt) {
                setValue((current) => current || prompt);
                requestAnimationFrame(() => {
                    if (!textareaRef.current) return;
                    textareaRef.current.style.height = "auto";
                    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
                });
            }
            if (attachedDocs.length === 0) setDocSelectorOpen(true);
        },
    }));

    useEffect(() => {
        if (!restoreDraft) return;
        const frame = requestAnimationFrame(() => {
            setValue((current) =>
                current.trim()
                    ? `${restoreDraft.content}\n\n${current}`
                    : restoreDraft.content,
            );
            const restoredIds = new Set(
                (restoreDraft.files ?? []).flatMap((file) =>
                    file.document_id ? [file.document_id] : [],
                ),
            );
            setAttachedDocs((current) => {
                const existing = new Set(
                    current.map((document) => document.id),
                );
                return [
                    ...current,
                    ...lastSubmittedDocsRef.current.filter(
                        (document) =>
                            restoredIds.has(document.id) &&
                            !existing.has(document.id),
                    ),
                ];
            });
            if (restoreDraft.workflow) {
                setSelectedWorkflow(
                    (current) => current ?? restoreDraft.workflow!,
                );
            }
            if (textareaRef.current) {
                textareaRef.current.style.height = "auto";
                textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
                textareaRef.current.focus();
            }
            onDraftRestored?.();
        });
        return () => cancelAnimationFrame(frame);
    }, [onDraftRestored, restoreDraft]);

    const handleAddDocsFromSelector = useCallback(
        (selectedDocs: Document[]) => {
            setAttachedDocs((prev) => {
                const existing = new Set(prev.map((d) => d.id));
                return [
                    ...prev,
                    ...selectedDocs.filter((d) => !existing.has(d.id)),
                ];
            });
        },
        [],
    );

    const addAttachedDocuments = useCallback((documents: Document[]) => {
        setAttachedDocs((prev) => {
            const existing = new Set(prev.map((document) => document.id));
            return [
                ...prev,
                ...documents.filter((document) => !existing.has(document.id)),
            ];
        });
    }, []);

    const handleDroppedFiles = useCallback(
        async (files: File[]) => {
            const { supported, unsupported } =
                partitionSupportedDocumentFiles(files);
            setUploadWarning(formatUnsupportedDocumentWarning(unsupported));
            if (supported.length === 0) return;

            setUploadingFilenames(supported.map((file) => file.name));
            const results = await Promise.allSettled(
                supported.map((file) =>
                    projectId
                        ? uploadProjectDocument(projectId, file)
                        : uploadStandaloneDocument(file),
                ),
            );
            const uploaded = results.flatMap((result) =>
                result.status === "fulfilled" ? [result.value] : [],
            );
            if (uploaded.length > 0) {
                addAttachedDocuments(uploaded);
                setDroppedDocuments((prev) => {
                    const existing = new Set(
                        prev.map((document) => document.id),
                    );
                    return [
                        ...prev,
                        ...uploaded.filter(
                            (document) => !existing.has(document.id),
                        ),
                    ];
                });
                onDocumentsUploaded?.(uploaded);
            }
            if (results.some((result) => result.status === "rejected")) {
                setUploadWarning(
                    uploaded.length > 0
                        ? "Some documents could not be uploaded."
                        : "Documents could not be uploaded. Please try again.",
                );
            }
            setUploadingFilenames([]);
        },
        [addAttachedDocuments, onDocumentsUploaded, projectId],
    );

    useEffect(() => {
        const hasFiles = (dataTransfer: DataTransfer | null) =>
            !!dataTransfer && Array.from(dataTransfer.types).includes("Files");

        const handleDragEnter = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            dragDepthRef.current += 1;
            setIsDraggingFiles(true);
        };
        const handleDragOver = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        };
        const handleDragLeave = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setIsDraggingFiles(false);
        };
        const handleDrop = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            dragDepthRef.current = 0;
            setIsDraggingFiles(false);
            void handleDroppedFiles(Array.from(event.dataTransfer?.files ?? []));
        };

        window.addEventListener("dragenter", handleDragEnter);
        window.addEventListener("dragover", handleDragOver);
        window.addEventListener("dragleave", handleDragLeave);
        window.addEventListener("drop", handleDrop);
        return () => {
            window.removeEventListener("dragenter", handleDragEnter);
            window.removeEventListener("dragover", handleDragOver);
            window.removeEventListener("dragleave", handleDragLeave);
            window.removeEventListener("drop", handleDrop);
        };
    }, [handleDroppedFiles]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setValue(e.target.value);
        const el = e.target;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    };

    const handleSubmit = () => {
        const query = value.trim();
        if (!query || isLoading) return;
        if (apiKeys && !isModelAvailable(model, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        setValue("");
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
        }

        const files = attachedDocs.map((d) => ({
            filename: d.filename,
            document_id: d.id,
        }));
        lastSubmittedDocsRef.current = attachedDocs;
        setAttachedDocs([]);
        const wf = selectedWorkflow;
        setSelectedWorkflow(null);

        onSubmit?.({
            role: "user",
            content: query,
            files: files.length > 0 ? files : undefined,
            workflow: wf ?? undefined,
            model,
            reasoningEffort,
        });
    };

    const handleActionClick = () => {
        if (isLoading) {
            onCancel();
        } else {
            handleSubmit();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <>
            <div className="chat-input-container w-full">
                <div className="rounded-[18px] border border-gray-200 bg-white shadow-sm md:rounded-[22px]">
                    {/* Attached chips */}
                    {(selectedWorkflow || attachedDocs.length > 0) && (
                        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                            {selectedWorkflow && (
                                <div className="inline-flex items-center gap-1 rounded-full border border-white/20 bg-gray-950 py-0.5 pl-2.5 pr-1 text-xs text-white shadow-sm">
                                    <Library className="h-2.5 w-2.5 shrink-0" />
                                    <span className="max-w-[140px] truncate">
                                        {selectedWorkflow.title}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSelectedWorkflow(null)
                                        }
                                        className="rounded-full p-0.5 ml-0.5 text-white/60 hover:text-white hover:bg-white/20"
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                </div>
                            )}
                            {attachedDocs.map((doc) => {
                                return (
                                    <div
                                        key={doc.id}
                                        className="inline-flex items-center gap-1 rounded-[10px] border border-gray-200 bg-white py-0.5 pl-2 pr-1 text-xs text-gray-800 shadow-sm"
                                    >
                                        <FileTypeIcon
                                            fileType={doc.file_type}
                                            className="h-2.5 w-2.5"
                                        />
                                        <span className="max-w-[140px] truncate">
                                            {doc.filename}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setAttachedDocs((prev) =>
                                                    prev.filter(
                                                        (d) => d.id !== doc.id,
                                                    ),
                                                )
                                            }
                                            className="ml-0.5 rounded-full p-0.5 text-gray-400 hover:bg-gray-900/5 hover:text-gray-700"
                                        >
                                            <X className="h-2.5 w-2.5" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {uploadingFilenames.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
                            {uploadingFilenames.map((filename, index) => (
                                <div
                                    key={`${filename}-${index}`}
                                    className="inline-flex items-center gap-1 rounded-[10px] bg-gray-50 px-2 py-1 text-xs text-gray-600 shadow-sm"
                                >
                                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                    <span className="max-w-[140px] truncate">
                                        {filename}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Input */}
                    <div className="px-4 pt-4">
                        <textarea
                            ref={textareaRef}
                            rows={1}
                            placeholder="How can I help?"
                            value={value}
                            onChange={handleChange}
                            onKeyDown={handleKeyDown}
                            className="w-full resize-none text-sm overflow-hidden border-0 text-base p-0 bg-transparent outline-none placeholder:text-gray-400 leading-6 max-h-48"
                        />
                    </div>

                    {/* Controls */}
                    <div className="flex flex-wrap items-center gap-1 p-2 md:p-2.5">
                        <div className="flex items-center gap-1">
                            {!hideAddDocButton && (
                                <AddDocButton
                                    onBrowseAll={() => {
                                        setDocSelectorInitialTab("files");
                                        setDocSelectorOpen(true);
                                    }}
                                    selectedDocIds={attachedDocs.map(
                                        (d) => d.id,
                                    )}
                                />
                            )}
                            <button
                                type="button"
                                onClick={() => setWorkflowModalOpen(true)}
                                aria-label="Open workflows"
                                className={cn(
                                    "flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm",
                                    selectedWorkflow
                                        ? "text-red-700 hover:text-red-800"
                                        : "text-gray-400 hover:text-gray-700",
                                )}
                            >
                                {selectedWorkflow ? (
                                    <Check className="h-3.5 w-3.5" />
                                ) : (
                                    <Waypoints className="h-3.5 w-3.5" />
                                )}
                                <span className="chat-input-control-label hidden sm:inline">
                                    Workflows
                                </span>
                            </button>
                        </div>

                        <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto sm:flex-nowrap">
                            <div className="order-2 sm:order-1">
                                <ReasoningEffortToggle
                                    model={model}
                                    value={reasoningEffort}
                                    onChange={setReasoningEffort}
                                />
                            </div>
                            <div className="order-1 flex w-full min-w-0 justify-end sm:order-2 sm:w-auto">
                                <ModelToggle
                                    value={model}
                                    onChange={setModel}
                                    apiKeys={apiKeys}
                                />
                            </div>
                            <button
                                type="button"
                                className={cn(
                                    "order-3 relative flex h-8 w-8 items-center justify-center rounded-[10px] bg-brand text-white hover:bg-brand-dark disabled:cursor-default disabled:bg-gray-300",
                                )}
                                onClick={handleActionClick}
                                disabled={!isLoading && !value.trim()}
                            >
                                {isLoading ? (
                                    <Square
                                        className="h-4 w-4"
                                        fill="currentColor"
                                        strokeWidth={0}
                                    />
                                ) : (
                                    <ArrowRight className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <AddDocumentsModal
                open={docSelectorOpen}
                keepMounted
                onClose={() => setDocSelectorOpen(false)}
                onSelect={handleAddDocsFromSelector}
                initialSelectedDocuments={attachedDocs}
                externalUploadedDocuments={droppedDocuments}
                initialTab={docSelectorInitialTab}
                projectId={projectId}
                breadcrumb={
                    selectedWorkflow
                        ? ["Assistant", selectedWorkflow.title, "Add document"]
                        : ["Assistant", "Add document"]
                }
                primaryLabel="Use document"
            />
            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={(wf) => {
                    setSelectedWorkflow({
                        id: wf.id,
                        title: wf.metadata.title,
                    });
                    setWorkflowModalOpen(false);
                }}
                projectName={projectName}
                projectCmNumber={projectCmNumber}
            />
            <ApiKeyMissingPopup
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
            <UploadOverlay
                open={isDraggingFiles}
                warning={uploadWarning}
                onWarningClose={() => setUploadWarning(null)}
            />
        </>
    );
});
