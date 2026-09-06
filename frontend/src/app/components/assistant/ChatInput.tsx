import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Check, Library, Loader2, Plus, Square, X } from "lucide-react";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import { WorkflowPickerModal } from "../workflows/WorkflowPickerModal";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import { WarningPopup } from "../popups/WarningPopup";
import { ModelEffortToggle } from "./ModelToggle";
import { useSelectedModel, useSelectedReasoningEffort } from "@/app/hooks/useSelectedModel";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { getModelProvider, isModelAvailable, type ModelProvider } from "@/app/lib/modelAvailability";
import { type Document, uploadDocumentsSettled, uploadStandaloneDocument } from "@/app/lib/api/documents";
import type { Message, ChatDraft } from "@/app/lib/api/chat";
import { currentChatDraft, readChatDraft, writeChatDraft } from "@/app/lib/chatDrafts";
import { workflowDocumentTab, workflowMessage } from "../workflows/workflowRoutes";
import type { DirectoryTab } from "../shared/FileDirectory";
import { cn } from "@/app/lib/utils";

import { formatUnsupportedDocumentWarning, partitionSupportedDocumentFiles } from "@/app/lib/documentUploadValidation";
import { CHAT_DOCUMENT_DRAG_TYPE } from "@/app/components/documents/documentTree";
import { WorkflowSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { useAssistantPreferences } from "./assistantPreferences";
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
                        "ms-0.5 grid size-6 shrink-0 place-items-center rounded-full",
                        dark ? "text-white/60 hover:bg-white/20 hover:text-white" : "text-gray-400 hover:bg-gray-900/5 hover:text-gray-700",
                    )}
                >
                    <X className="size-3" aria-hidden="true" />
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
        openDocumentPicker?: boolean;
    }) => void;
}
interface Props {
    initialDraft?: ChatDraft | null;
    draftChatId?: string | null;
    onDraftChange?: (draft: ChatDraft | null) => Promise<unknown>;
    onSubmit: (message: Message) => void;
    onCancel: () => void;
    isLoading: boolean;
    contextUsage?: {
        usedTokens: number;
        windowTokens: number;
        compacting: boolean;
    };
    showContextTools?: boolean;
    rows?: number;
    projectName?: string;
    projectCmNumber?: string | null;
    restoreDraft?: Message | null;
    onDraftRestored?: () => void;
    promptHistory?: string[];
    onOpenWorkflows?: (initialWorkflowId?: string, documents?: Document[]) => void;
    initialModel?: string | null;
    initialReasoningEffort?: string | null;
    editModeLabels?: { manual: string; auto: string };
    disabled?: boolean;
}
export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
    { onSubmit, onCancel, isLoading, contextUsage, showContextTools = true, rows = 1,
        projectName, projectCmNumber, restoreDraft, onDraftRestored,
        promptHistory = [], onOpenWorkflows, initialModel,
        initialReasoningEffort, editModeLabels, disabled = false, draftChatId, onDraftChange, initialDraft }: Props,
    ref,
) {
    const [openingDraft] = useState(() => currentChatDraft(draftChatId, initialDraft));
    const [hasValue, setHasValue] = useState(!!openingDraft?.content.trim());
    const [attachedDocs, setAttachedDocs] = useState<Document[]>(openingDraft?.documents ?? []);
    const [droppedDocuments, setDroppedDocuments] = useState<Document[]>([]);
    const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(openingDraft?.workflow ?? null);
    const [draftPreferences, setDraftPreferences] = useState<Pick<ChatDraft, "model" | "reasoningEffort">>(openingDraft ?? {});
    const [model, setModel] = useSelectedModel(draftPreferences.model ?? initialModel);
    const [reasoningEffort, setReasoningEffort] =
        useSelectedReasoningEffort(draftPreferences.reasoningEffort ?? initialReasoningEffort);
    const [{ showAutoMode, showContextUsage, editMode }, updatePreferences] =
        useAssistantPreferences();
    const setEditMode = (mode: "manual" | "auto") => {
        scheduleDraft();
        updatePreferences((current) => ({ ...current, editMode: mode }));
    };
    const { profile } = useUserProfile();
    const apiKeys = profile?.apiKeys;
    const textareaId = useId();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [picker, setPicker] = useState<DirectoryTab | "workflows" | null>(null);
    const [apiKeyModalProvider, setApiKeyModalProvider] = useState<ModelProvider | null>(null);
    const [uploadingFilenames, setUploadingFilenames] = useState<string[]>([]);
    const [uploadWarning, setUploadWarning] = useState<string | null>(null);
    const [draftSaveFailed, setDraftSaveFailed] = useState(false);
    const lastSubmittedDocsRef = useRef<Document[]>([]);
    const restoredDraftRef = useRef<Message | null>(null);
    const historyIndexRef = useRef<number | null>(null);
    const historyDraftRef = useRef("");
    const draftEdited = useRef(false);
    const draftContent = useRef(openingDraft?.content ?? "");
    const draftCleared = useRef(false);
    const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const saveDraftRef = useRef<() => Promise<unknown>>(async () => {});
    const draftSnapshot = (): ChatDraft | null => {
        if (draftCleared.current) return null;
        const content = draftContent.current;
        return content || attachedDocs.length || selectedWorkflow ? {
            role: "user", content, documents: attachedDocs, workflow: selectedWorkflow ?? undefined,
            model, reasoningEffort, editMode,
        } : null;
    };
    saveDraftRef.current = async () => {
        const draft = draftSnapshot();
        try {
            if (onDraftChange) await onDraftChange(draft);
            else if (draftChatId) await writeChatDraft(draftChatId, draft);
            setDraftSaveFailed(false);
        } catch { setDraftSaveFailed(true); }
    };
    useLayoutEffect(() => {
        if (!draftChatId) return;
        let active = true;
        const loaded = currentChatDraft(draftChatId, initialDraft);
        const restore = (draft: ChatDraft | null) => {
            if (!active || !draft || draftEdited.current) return;
            setInputValue(draft.content, false, false);
            setAttachedDocs(draft.documents ?? []);
            setSelectedWorkflow(draft.workflow ?? null);
            setDraftPreferences({ model: draft.model, reasoningEffort: draft.reasoningEffort });
        };
        if (loaded !== undefined) restore(loaded);
        else void readChatDraft(draftChatId).then(restore).catch(() => {});
        return () => { active = false; };
    }, [draftChatId, initialDraft]);
    useEffect(() => {
        if (!draftEdited.current) return;
        scheduleDraft();
    }, [attachedDocs, selectedWorkflow, model, reasoningEffort, editMode]);
    function scheduleDraft() {
        draftEdited.current = true;
        if (!draftChatId && !onDraftChange) return;
        if (draftTimer.current) clearTimeout(draftTimer.current);
        draftTimer.current = setTimeout(() => { draftTimer.current = null; void saveDraftRef.current(); }, 250);
    }
    useEffect(() => () => {
        if (draftTimer.current) { clearTimeout(draftTimer.current); void saveDraftRef.current(); }
    }, []);

    function attachDocuments(documents: Document[], dropped = false) {
        scheduleDraft();
        draftCleared.current = false;
        setAttachedDocs((current) => mergeDocuments(current, documents));
        if (dropped) setDroppedDocuments((current) => mergeDocuments(current, documents));
    }

    function setInputValue(value: string, focus = false, persist = true) {
        if (!textareaRef.current) return;
        textareaRef.current.value = value;
        draftContent.current = value;
        if (persist) scheduleDraft();
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

    const startWorkflowDocumentSelection: ChatInputHandle["startWorkflowDocumentSelection"] =
        (workflow, prompt, options) => {
            scheduleDraft();
            setSelectedWorkflow(workflow);
            if (prompt && !textareaRef.current?.value) setInputValue(prompt);
            const tab = options?.initialDocumentTab ?? "files";
            const hasDocument = tab === "templates"
                ? attachedDocs.some(({ library_kind }) => library_kind === "template")
                : attachedDocs.length > 0;
            setPicker((options?.openDocumentPicker ?? !hasDocument) ? tab : null);
        };
    useImperativeHandle(ref, () => ({
        addDoc: (doc: Document) => attachDocuments([doc]),
        clearDraft: () => {
            historyIndexRef.current = null;
            historyDraftRef.current = "";
            setInputValue("");
            setAttachedDocs([]);
            setSelectedWorkflow(null);
        },
        startWorkflowDocumentSelection,
    }));
    useEffect(() => {
        if (!restoreDraft) { restoredDraftRef.current = null; return; }
        const restored = restoredDraftRef.current;
        if (restored && restored.turnId === restoreDraft.turnId && restored.content === restoreDraft.content) return;
        const frame = requestAnimationFrame(() => {
            restoredDraftRef.current = restoreDraft;
            const current = textareaRef.current?.value ?? "";
            setInputValue(
                current.trim() === restoreDraft.content.trim() ? current : current.trim()
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
        const results = await uploadDocumentsSettled(supported, uploadStandaloneDocument);
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
                } catch { /* Ignore malformed drag metadata. */ }
            } else {
                void handleDroppedFiles(Array.from(event.dataTransfer.files));
            }
        }
    }
    const handleSubmit = () => {
        const query = textareaRef.current?.value.trim();
        if (!query || disabled || contextUsage?.compacting) return;
        if (!["/compact", "/help"].includes(query.toLowerCase()) &&
            apiKeys && !isModelAvailable(model, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        setInputValue("");
        historyIndexRef.current = null;
        historyDraftRef.current = "";
        lastSubmittedDocsRef.current = attachedDocs;
        setAttachedDocs([]);
        setSelectedWorkflow(null);
        draftCleared.current = true;
        if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
        if (onDraftChange) void onDraftChange(null);
        else if (draftChatId) void writeChatDraft(draftChatId, null).catch(() => {});
        const files = attachedDocs.map(({ filename, id }) => ({ filename, document_id: id }));
        onSubmit({
            role: "user",
            content: query,
            files: files.length ? files : undefined,
            workflow: selectedWorkflow ?? undefined,
            model,
            reasoningEffort,
            editMode: showAutoMode || editModeLabels ? editMode : "manual",
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
                                    onRemove={() => { scheduleDraft(); setSelectedWorkflow(null); }}
                                />
                            )}
                            {attachedDocs.map((document) => (
                                <InputChip
                                    key={document.id}
                                    className="rounded-[10px] border border-gray-200 bg-white pl-2 pr-1 text-gray-800"
                                    icon={<FileTypeIcon fileType={document.file_type}
                                        className="h-2.5 w-2.5" />}
                                    label={document.filename}
                                    onRemove={() => {
                                        scheduleDraft();
                                        setAttachedDocs((current) =>
                                            current.filter(({ id }) => id !== document.id),
                                        );
                                    }}
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
                            defaultValue={openingDraft?.content ?? ""}
                            rows={rows}
                            placeholder="How can I help?"
                            onChange={(event) => {
                                draftEdited.current = true;
                                draftContent.current = event.currentTarget.value;
                                draftCleared.current = false;
                                scheduleDraft();
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
                            className="min-h-10 w-full max-h-48 resize-none overflow-y-auto border-0 bg-transparent p-0 text-base leading-6 outline-none [field-sizing:content] placeholder:text-gray-600"
                        />
                    </div>
                    {showContextUsage && contextUsage && (
                        <div
                            className="flex items-center justify-end gap-1.5 px-4 pb-1 text-[11px] text-gray-500"
                            role={contextUsage.compacting ? "status" : undefined}
                        >
                            <span>
                                {contextUsage.compacting
                                    ? "Compacting context"
                                    : `Context ${Math.min(100, Math.round((100 * contextUsage.usedTokens) / Math.max(1, contextUsage.windowTokens)))}%`}
                            </span>
                            <progress
                                className="h-1 w-16 accent-red-600"
                                max={contextUsage.windowTokens}
                                {...(!contextUsage.compacting && {
                                    value: Math.min(contextUsage.usedTokens, contextUsage.windowTokens),
                                })}
                                aria-label={contextUsage.compacting ? "Compacting context" : "Context window usage"}
                            />
                        </div>
                    )}
                    <div className="flex flex-wrap items-center gap-1 p-2 md:p-2.5">
                        {showContextTools && (
                            <div className="chat-input-context-tools flex items-center gap-1">
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
                                            onOpenWorkflows(selectedWorkflow?.id, attachedDocs);
                                        } else {
                                            setPicker("workflows");
                                        }
                                    }}
                                    aria-label="Workflows"
                                    className={cn(
                                        "flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm",
                                        selectedWorkflow
                                            ? "text-red-700 hover:text-red-800"
                                            : "text-gray-600 hover:text-gray-900",
                                    )}
                                >
                                    {selectedWorkflow
                                        ? <Check className="h-3.5 w-3.5" />
                                        : <WorkflowSkeuoIcon className="text-base leading-none" />}
                                    <span className="chat-input-control-label hidden sm:inline">
                                        Workflows
                                    </span>
                                </button>
                            </div>
                        )}
                        <div className="chat-input-actions ml-auto flex min-w-0 items-center justify-end gap-1">
                            {(showAutoMode || editModeLabels) && (
                                <div
                                    role="group"
                                    aria-label="Editing mode"
                                    className="flex h-8 shrink-0 items-center rounded-full bg-gray-100 p-1 ring-1 ring-inset ring-gray-200"
                                >
                                    {(["manual", "auto"] as const).map((mode) => (
                                        <button
                                            key={mode}
                                            type="button"
                                            aria-pressed={editMode === mode}
                                            title={
                                                mode === "auto"
                                                    ? "Apply edits directly and show a diff"
                                                    : "Save edits as tracked changes for review"
                                            }
                                            onClick={() => setEditMode(mode)}
                                            className={cn(
                                                "h-6 rounded-full px-2.5 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gray-900",
                                                editMode === mode
                                                    ? mode === "manual"
                                                        ? "bg-gray-700 text-white shadow-sm"
                                                        : "bg-brand text-white shadow-sm"
                                                    : "text-gray-500 hover:text-gray-800",
                                            )}
                                        >
                                            {editModeLabels?.[mode] ??
                                                (mode === "auto" ? "Auto" : "Manual")}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <div className="chat-input-model min-w-0">
                                <ModelEffortToggle
                                    model={model}
                                    effort={reasoningEffort}
                                    onModelChange={(value) => { scheduleDraft(); setModel(value); }}
                                    onEffortChange={(value) => { scheduleDraft(); setReasoningEffort(value); }}
                                    apiKeys={apiKeys}
                                />
                            </div>
                            {isLoading ? (
                                <button
                                    type="button"
                                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-gray-600 hover:bg-gray-100 hover:text-gray-950"
                                    onClick={onCancel}
                                    aria-label="Stop response"
                                >
                                    <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
                                </button>
                            ) : (
                            <button
                                type="submit"
                                className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-brand text-white hover:bg-brand-dark disabled:cursor-default disabled:bg-gray-300"
                                aria-label={disabled ? "Waiting for draft to save" : "Send message"}
                                disabled={disabled || !hasValue || contextUsage?.compacting}
                            >
                                <ArrowRight className="h-4 w-4" />
                            </button>
                            )}
                        </div>
                    </div>
                </form>
                {draftSaveFailed && <div role="status" className="mt-2 flex items-center gap-2 px-2 text-xs text-red-700">
                    <span>Draft not saved.</span>
                    <button type="button" onClick={() => void saveDraftRef.current()}
                        className="rounded px-1 py-1 font-medium underline underline-offset-2 focus-visible:outline focus-visible:outline-2">Retry saving</button>
                </div>}
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
                <WorkflowPickerModal
                    open
                    onClose={() => setPicker(null)}
                    onSelect={(selection) => {
                        const tab = workflowDocumentTab(selection);
                        startWorkflowDocumentSelection(workflowMessage(selection), undefined,
                            { initialDocumentTab: tab });
                    }}
                    execution="assistant"
                    breadcrumbs={projectName
                        ? ["Projects", `${projectName}${projectCmNumber ? ` (#${projectCmNumber})` : ""}`, "Assistant", "Add workflow"]
                        : ["Assistant", "Add workflow"]}
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
