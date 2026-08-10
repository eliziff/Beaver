import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { ArrowRight, Check, Library, Loader2, Plus, Square, WandSparkles, Waypoints, X } from "lucide-react";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import { WarningPopup } from "../popups/WarningPopup";
import { ModelEffortToggle } from "./ModelToggle";
import { useSelectedModel, useSelectedReasoningEffort } from "@/app/hooks/useSelectedModel";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { getModelProvider, isModelAvailable, type ModelProvider } from "@/app/lib/modelAvailability";
import type { Document, Message, Workflow as WorkflowDefinition } from "../shared/types";
import type { DirectoryTab } from "../shared/useDirectoryData";
import { cn } from "@/app/lib/utils";
import { uploadStandaloneDocument } from "@/app/lib/beaverApi";
import { formatUnsupportedDocumentWarning, partitionSupportedDocumentFiles } from "@/app/lib/documentUploadValidation";
import { CHAT_DOCUMENT_DRAG_TYPE } from "@/app/components/documents/documentTree";
type Workflow = NonNullable<Message["workflow"]>;

function mergeDocuments(...groups: Document[][]) {
    return [...new Map(
        groups.flat().map((document) => [document.id, document]),
    ).values()];
}

type InputChipProps = {
    className: string; dark?: boolean; icon: React.ReactNode;
    label: string; onRemove?: () => void;
};
function InputChip({ className, dark, icon, label, onRemove }: InputChipProps) {
    return (
        <span className={cn("inline-flex items-center gap-1 py-0.5 text-xs shadow-sm", className)}>
            {icon}
            <span className="max-w-[140px] truncate">{label}</span>
            {onRemove && (
                <button
                    type="button" aria-label={`Remove ${label}`} onClick={onRemove}
                    className={cn(
                        "ml-0.5 rounded-full p-0.5",
                        dark ? "text-white/60 hover:bg-white/20 hover:text-white" : "text-gray-400 hover:bg-gray-900/5 hover:text-gray-700",
                    )}
                >
                    <X className="h-2.5 w-2.5" />
                </button>
            )}
        </span>
    );
}

export interface ChatInputHandle {
    addDoc: (doc: Document) => void;
    clearDraft: () => void;
    startWorkflowDocumentSelection: (workflow: Workflow, prompt?: string, options?: {
        initialDocumentTab?: DirectoryTab;
    }) => void;
}
interface Props {
    onSubmit: (message: Message) => void;
    onCancel: () => void;
    isLoading: boolean;
    showContextTools?: boolean;
    rows?: number;
    projectName?: string;
    projectCmNumber?: string | null;
    restoreDraft?: Message | null;
    onDraftRestored?: () => void;
    promptHistory?: string[];
    automationsAvailable?: boolean;
    onOpenAutomations?: (document?: Document) => void;
    onOpenWorkflows?: (
        onSelect: (workflow: WorkflowDefinition) => void,
        initialWorkflowId?: string,
    ) => void;
}
export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
    { onSubmit, onCancel, isLoading, showContextTools = true, rows = 1,
        projectName, projectCmNumber, restoreDraft, onDraftRestored,
        promptHistory = [], automationsAvailable = false,
        onOpenAutomations, onOpenWorkflows }: Props,
    ref,
) {
    const [hasValue, setHasValue] = useState(false);
    const [attachedDocs, setAttachedDocs] = useState<Document[]>([]);
    const [droppedDocuments, setDroppedDocuments] = useState<Document[]>([]);
    const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
    const [model, setModel] = useSelectedModel();
    const [reasoningEffort, setReasoningEffort] = useSelectedReasoningEffort();
    const { profile } = useUserProfile();
    const apiKeys = profile?.apiKeys;
    const textareaId = useId();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [picker, setPicker] = useState<DirectoryTab | "workflows" | null>(null);
    const [apiKeyModalProvider, setApiKeyModalProvider] = useState<ModelProvider | null>(null);
    const [uploadingFilenames, setUploadingFilenames] = useState<string[]>([]);
    const [uploadWarning, setUploadWarning] = useState<string | null>(null);
    const lastSubmittedDocsRef = useRef<Document[]>([]);
    const historyIndexRef = useRef<number | null>(null);
    const historyDraftRef = useRef("");

    function attachDocuments(documents: Document[], dropped = false) {
        setAttachedDocs((current) => mergeDocuments(current, documents));
        if (dropped) setDroppedDocuments((current) => mergeDocuments(current, documents));
    }

    function setInputValue(value: string, focus = false) {
        if (!textareaRef.current) return;
        textareaRef.current.value = value;
        setHasValue(!!value.trim());
        if (focus) textareaRef.current.focus();
    }

    function navigatePromptHistory(
        direction: "older" | "newer",
        target: HTMLTextAreaElement,
    ) {
        const history = promptHistory.filter((prompt) => prompt.trim());
        if (!history.length) return false;
        let index = historyIndexRef.current;
        if (direction === "older") {
            if (index === null) {
                historyDraftRef.current = target.value;
                index = history.length - 1;
            } else {
                index = Math.max(0, Math.min(index, history.length - 1) - 1);
            }
        } else {
            if (index === null) return false;
            if (index < history.length - 1) {
                index += 1;
            } else {
                historyIndexRef.current = null;
                setInputValue(historyDraftRef.current);
                target.setSelectionRange(target.value.length, target.value.length);
                return true;
            }
        }
        historyIndexRef.current = index;
        setInputValue(history[index]);
        target.setSelectionRange(target.value.length, target.value.length);
        return true;
    }

    useImperativeHandle(ref, () => ({
        addDoc: (doc: Document) => attachDocuments([doc]),
        clearDraft: () => {
            historyIndexRef.current = null;
            historyDraftRef.current = "";
            setInputValue("");
            setAttachedDocs([]);
            setSelectedWorkflow(null);
        },
        startWorkflowDocumentSelection: (workflow, prompt, options) => {
            setSelectedWorkflow(workflow);
            if (prompt && !textareaRef.current?.value) setInputValue(prompt);
            if (attachedDocs.length === 0) {
                setPicker(options?.initialDocumentTab ?? "files");
            }
        },
    }));
    useEffect(() => {
        if (!restoreDraft) return;
        const frame = requestAnimationFrame(() => {
            const current = textareaRef.current?.value ?? "";
            setInputValue(
                current.trim()
                    ? `${restoreDraft.content}\n\n${current}`
                    : restoreDraft.content,
                true,
            );
            const restoredIds = new Set(restoreDraft.files?.map((file) => file.document_id));
            setAttachedDocs((current) =>
                mergeDocuments(
                    current,
                    lastSubmittedDocsRef.current.filter(({ id }) => restoredIds.has(id)),
                ),
            );
            setSelectedWorkflow((current) => current ?? restoreDraft.workflow ?? null);
            onDraftRestored?.();
        });
        return () => cancelAnimationFrame(frame);
    }, [onDraftRestored, restoreDraft]);

    async function handleDroppedFiles(files: File[]) {
        const { supported, unsupported } = partitionSupportedDocumentFiles(files);
        setUploadWarning(formatUnsupportedDocumentWarning(unsupported));
        if (supported.length === 0) return;
        setUploadingFilenames(supported.map((file) => file.name));
        const results = await Promise.allSettled(supported.map(uploadStandaloneDocument));
        const uploaded = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
        );
        if (uploaded.length) attachDocuments(uploaded, true);
        if (results.some((result) => result.status === "rejected")) {
            setUploadWarning(
                uploaded.length
                    ? "Some documents could not be uploaded."
                    : "Documents could not be uploaded. Please try again.",
            );
        }
        setUploadingFilenames([]);
    }

    function handleFileDrag(event: React.DragEvent<HTMLDivElement>) {
        const libraryDrag = event.dataTransfer.types.includes(CHAT_DOCUMENT_DRAG_TYPE);
        if (!showContextTools ||
            (!libraryDrag && !event.dataTransfer.types.includes("Files"))) return;
        if (event.type !== "dragleave") event.preventDefault();
        if (event.type === "dragenter") event.currentTarget.dataset.dragging = "true";
        if (event.type === "dragover") event.dataTransfer.dropEffect = "copy";
        if (event.type === "dragleave" &&
            !event.currentTarget.contains(event.relatedTarget as Node | null)) {
            delete event.currentTarget.dataset.dragging;
        }
        if (event.type === "drop") {
            delete event.currentTarget.dataset.dragging;
            if (libraryDrag) {
                try {
                    const documents: unknown = JSON.parse(
                        event.dataTransfer.getData(CHAT_DOCUMENT_DRAG_TYPE),
                    );
                    if (Array.isArray(documents)) attachDocuments(documents.filter(
                        (document): document is Document => !!document &&
                            typeof document === "object" &&
                            typeof (document as Document).id === "string" &&
                            typeof (document as Document).filename === "string",
                    ));
                } catch {}
            } else {
                void handleDroppedFiles(Array.from(event.dataTransfer.files));
            }
        }
    }
    const handleSubmit = () => {
        const query = textareaRef.current?.value.trim();
        if (!query || isLoading) return;
        if (apiKeys && !isModelAvailable(model, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        setInputValue("");
        historyIndexRef.current = null;
        historyDraftRef.current = "";
        lastSubmittedDocsRef.current = attachedDocs;
        setAttachedDocs([]);
        setSelectedWorkflow(null);
        const files = attachedDocs.map(({ filename, id }) => ({ filename, document_id: id }));
        onSubmit({
            role: "user",
            content: query,
            files: files.length ? files : undefined,
            workflow: selectedWorkflow ?? undefined,
            model,
            reasoningEffort,
        });
    };
    const documentButtonLabel = attachedDocs.length
        ? `${attachedDocs.length} documents selected`
        : "Add document";
    return (
        <>
            <div
                className="chat-input-container min-w-0 w-full data-[dragging=true]:rounded-[22px] data-[dragging=true]:ring-2 data-[dragging=true]:ring-brand/30"
                onDragEnter={handleFileDrag}
                onDragOver={handleFileDrag}
                onDragLeave={handleFileDrag}
                onDrop={handleFileDrag}
            >
                <form
                    className="min-w-0 max-w-full rounded-[18px] border border-gray-200 bg-white shadow-sm md:rounded-[22px]"
                    onSubmit={(event) => {
                        event.preventDefault();
                        handleSubmit();
                    }}
                >
                    {(selectedWorkflow ||
                        attachedDocs.length > 0 ||
                        uploadingFilenames.length > 0) && (
                        <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
                            {selectedWorkflow && (
                                <InputChip
                                    className="rounded-full border border-white/20 bg-gray-950 pl-2.5 pr-1 text-white"
                                    dark icon={<Library className="h-2.5 w-2.5 shrink-0" />}
                                    label={selectedWorkflow.title}
                                    onRemove={() => setSelectedWorkflow(null)}
                                />
                            )}
                            {attachedDocs.map((document) => (
                                <InputChip
                                    key={document.id}
                                    className="rounded-[10px] border border-gray-200 bg-white pl-2 pr-1 text-gray-800"
                                    icon={<FileTypeIcon fileType={document.file_type}
                                        className="h-2.5 w-2.5" />}
                                    label={document.filename}
                                    onRemove={() =>
                                        setAttachedDocs((current) =>
                                            current.filter(({ id }) => id !== document.id),
                                        )
                                    }
                                />
                            ))}
                            {uploadingFilenames.map((label, index) => (
                                <InputChip
                                    key={`${label}-${index}`}
                                    className="rounded-[10px] bg-gray-50 px-2 py-1 text-gray-600"
                                    icon={<Loader2 className="h-2.5 w-2.5 animate-spin" />} label={label}
                                />
                            ))}
                        </div>
                    )}
                    <div className="px-4 pt-4">
                        <label className="sr-only" htmlFor={textareaId}>
                            Message
                        </label>
                        <textarea
                            id={textareaId}
                            ref={textareaRef}
                            rows={rows}
                            placeholder="How can I help?"
                            onChange={(event) => {
                                historyIndexRef.current = null;
                                const next = !!event.currentTarget.value.trim();
                                if (next !== hasValue) setHasValue(next);
                            }}
                            onKeyDown={(event) => {
                                if (
                                    (event.key === "ArrowUp" ||
                                        event.key === "ArrowDown") &&
                                    !event.altKey &&
                                    !event.ctrlKey &&
                                    !event.metaKey &&
                                    !event.shiftKey &&
                                    !event.nativeEvent.isComposing &&
                                    event.currentTarget.selectionStart ===
                                        event.currentTarget.selectionEnd
                                ) {
                                    const browsing =
                                        historyIndexRef.current !== null;
                                    const canStart =
                                        event.key === "ArrowUp" &&
                                        (!event.currentTarget.value.includes("\n") ||
                                            event.currentTarget.selectionStart === 0);
                                    if (
                                        (browsing || canStart) &&
                                        navigatePromptHistory(
                                            event.key === "ArrowUp"
                                                ? "older"
                                                : "newer",
                                            event.currentTarget,
                                        )
                                    ) {
                                        event.preventDefault();
                                        return;
                                    }
                                }
                                if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    handleSubmit();
                                }
                            }}
                            className="w-full max-h-48 resize-none overflow-y-auto border-0 bg-transparent p-0 text-base leading-6 outline-none [field-sizing:content] placeholder:text-gray-600"
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-1 p-2 md:p-2.5">
                        {showContextTools && (
                            <div className="flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => setPicker("files")}
                                    className={cn(
                                        "flex h-8 items-center gap-1 rounded-lg px-2 text-sm",
                                        attachedDocs.length
                                            ? "text-gray-700 hover:text-gray-900"
                                            : "text-gray-600 hover:text-gray-900",
                                    )}
                                    title={documentButtonLabel}
                                    aria-label={documentButtonLabel}
                                >
                                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-medium tabular-nums">
                                        {attachedDocs.length
                                            ? attachedDocs.length > 99
                                                ? "99+"
                                                : attachedDocs.length
                                            : <Plus className="h-4 w-4" />}
                                    </span>
                                    <span className="chat-input-control-label hidden sm:inline">
                                        Documents
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (onOpenWorkflows) {
                                            onOpenWorkflows(
                                                (workflow) =>
                                                    setSelectedWorkflow({
                                                        id: workflow.id,
                                                        title: workflow.metadata.title,
                                                    }),
                                                selectedWorkflow?.id,
                                            );
                                        } else {
                                            setPicker("workflows");
                                        }
                                    }}
                                    aria-label="Open workflows"
                                    className={cn(
                                        "flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm",
                                        selectedWorkflow
                                            ? "text-red-700 hover:text-red-800"
                                            : "text-gray-600 hover:text-gray-900",
                                    )}
                                >
                                    {selectedWorkflow
                                        ? <Check className="h-3.5 w-3.5" />
                                        : <Waypoints className="h-3.5 w-3.5" />}
                                    <span className="chat-input-control-label hidden sm:inline">
                                        Workflows
                                    </span>
                                </button>
                                {onOpenAutomations && (
                                    <button
                                        type="button"
                                        disabled={
                                            !automationsAvailable &&
                                            attachedDocs.length !== 1
                                        }
                                        onClick={() =>
                                            onOpenAutomations(
                                                attachedDocs.length === 1
                                                    ? attachedDocs[0]
                                                    : undefined,
                                            )
                                        }
                                        aria-label="Open automations"
                                        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-gray-600 hover:text-gray-900 disabled:cursor-default disabled:text-gray-300"
                                    >
                                        <WandSparkles className="h-3.5 w-3.5" />
                                        <span className="chat-input-control-label hidden sm:inline">
                                            Automations
                                        </span>
                                    </button>
                                )}
                            </div>
                        )}
                        <div className="chat-input-actions ml-auto flex w-full min-w-0 items-center justify-end gap-1">
                            <div className="chat-input-model min-w-0 flex-1">
                                <ModelEffortToggle
                                    model={model}
                                    effort={reasoningEffort}
                                    onModelChange={setModel}
                                    onEffortChange={setReasoningEffort}
                                    apiKeys={apiKeys}
                                />
                            </div>
                            <button
                                type={isLoading ? "button" : "submit"}
                                className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-brand text-white hover:bg-brand-dark disabled:cursor-default disabled:bg-gray-300"
                                onClick={isLoading ? onCancel : undefined}
                                aria-label={isLoading ? "Stop response" : "Send message"}
                                disabled={!isLoading && !hasValue}
                            >
                                {isLoading
                                    ? <Square className="h-4 w-4" fill="currentColor" strokeWidth={0} />
                                    : <ArrowRight className="h-4 w-4" />}
                            </button>
                        </div>
                    </div>
                </form>
            </div>
            {showContextTools && (
                <AddDocumentsModal
                    open={picker !== null && picker !== "workflows"}
                    keepMounted
                    onClose={() => setPicker(null)}
                    onSelect={(documents) => attachDocuments(documents)}
                    initialSelectedDocuments={attachedDocs}
                    externalUploadedDocuments={droppedDocuments}
                    initialTab={picker && picker !== "workflows" ? picker : "files"}
                    breadcrumb={
                        selectedWorkflow
                            ? ["Assistant", selectedWorkflow.title, "Add document"]
                            : ["Assistant", "Add document"]
                    }
                    primaryLabel="Use document"
                />
            )}
            {showContextTools && picker === "workflows" && (
                <AssistantWorkflowModal
                    open
                    onClose={() => setPicker(null)}
                    onSelect={(wf) => {
                        setSelectedWorkflow({ id: wf.id, title: wf.metadata.title });
                        setPicker(null);
                    }}
                    projectName={projectName}
                    projectCmNumber={projectCmNumber}
                />
            )}
            <ApiKeyMissingPopup open={apiKeyModalProvider !== null} provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
            <WarningPopup open={!!uploadWarning} message={uploadWarning}
                onClose={() => setUploadWarning(null)}
            />
        </>
    );
});
