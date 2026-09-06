import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MoreHorizontal, Zap } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import { WorkflowSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { Modal } from "@/app/components/modals/Modal";
import { CheckboxInput } from "@/app/components/ui/checkbox";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { AssistantDock, type AssistantDockTab } from "./AssistantDock";
import type { LibraryKind, Document } from "@/app/lib/api/documents";
import { createTabularReviewPath } from "../tabular/tabularReviewRoute";
import type { DirectoryTab } from "../shared/FileDirectory";
import { workflowDocumentTab, workflowMessage, type AssistantWorkflowLaunch,
    type WorkflowSelection } from "../workflows/workflowRoutes";
import {
    QUICK_ACTIONS,
    type QuickActionId,
    useAssistantPreferences,
} from "./assistantPreferences";
import type { ColumnConfig } from "@/app/lib/api/tabular";

import type { Message } from "@/app/lib/api/chat";
import { NewTRModal } from "../tabular/NewTRModal";
import { SelectAssistantProjectModal } from "./SelectAssistantProjectModal";
import { NewProjectModal } from "../projects/NewProjectModal";
import { InitialDockPanel } from "./InitialDockPanel";
type InitialModal = "project" | "newProject" | "review" | "quickActions";
const DOCUMENT_WORKFLOW_ACTIONS: Partial<
    Record<
        QuickActionId,
        {
            workflowId: string;
            variantId: string;
            title: string;
            prompt: string;
            initialDocumentTab?: DirectoryTab;
        }
    >
> = {
    proofread: {
        workflowId: "drafting",
        variantId: "builtin-proofread",
        title: "Proofread",
        prompt: "proofread",
    },
    compareDocuments: {
        workflowId: "document-review",
        variantId: "builtin-compare-documents",
        title: "Compare Documents",
        prompt: "compare documents",
    },
    extractKeyTerms: {
        workflowId: "document-review",
        variantId: "builtin-extract-key-terms",
        title: "Extract Key Terms",
        prompt: "extract key terms",
    },
    draftFromTemplate: {
        workflowId: "drafting",
        variantId: "builtin-draft-from-template",
        title: "Draft from Template",
        prompt: "draft from template",
        initialDocumentTab: "templates",
    },
};
export function InitialView({
    onSubmit,
    initialDocuments = [],
    initialWorkflow,
    onDraftChange,
}: {
    onSubmit: (message: Message) => void;
    initialDocuments?: Document[];
    initialWorkflow?: AssistantWorkflowLaunch;
    onDraftChange?: (draft: import("@/app/lib/api/chat").ChatDraft | null) => Promise<unknown>;
}) {
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const navigate = useNavigate();
    const [modal, setModal] = useState<InitialModal | null>(null);
    const [dockTab, setDockTab] = useState(initialWorkflow ? "workflows" : "sources");
    const [dockOpen, setDockOpen] = useState(!!initialWorkflow);
    const [libraryKind, setLibraryKind] = useState<LibraryKind>("files");
    const [workflowDocuments, setWorkflowDocuments] = useState<Document[]>(initialDocuments);
    const [{ quickActions: visibleActions }, updatePreferences] =
        useAssistantPreferences();
    const chatInputRef = useRef<ChatInputHandle>(null);
    const startedInitialWorkflow = useRef(false);
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";
    const visibleQuickActions = QUICK_ACTIONS.filter(
        (action) => visibleActions[action.id],
    );
    useEffect(() => {
        for (const document of initialDocuments) {
            chatInputRef.current?.addDoc(document);
        }
    }, [initialDocuments]);
    useEffect(() => {
        if (startedInitialWorkflow.current || !initialWorkflow) return;
        startedInitialWorkflow.current = true;
        const tab = initialWorkflow.documentTab;
        const hasDocument = tab === "templates"
            ? initialDocuments.some(({ library_kind }) => library_kind === "template")
            : initialDocuments.length > 0;
        chatInputRef.current?.startWorkflowDocumentSelection(
            initialWorkflow.workflow, undefined, { initialDocumentTab: tab,
                openDocumentPicker: !hasDocument });
        setDockTab("workflows");
        setDockOpen(true);
    }, [initialDocuments, initialWorkflow]);
    function handleDocumentWorkflowClick(id: QuickActionId) {
        const config = DOCUMENT_WORKFLOW_ACTIONS[id];
        if (!config) return;
        chatInputRef.current?.startWorkflowDocumentSelection(
            {
                id: config.workflowId,
                variant_id: config.variantId,
                title: config.title,
            },
            config.prompt,
            { initialDocumentTab: config.initialDocumentTab },
        );
    }
    async function handleNewReview(
        title: string,
        projectId?: string,
        documentIds?: string[],
        columnsConfig?: ColumnConfig[] | null,
        workflowId?: string,
    ) {
        const path = await createTabularReviewPath({
            title,
            document_ids: documentIds ?? [],
            columns_config: columnsConfig ?? [],
            ...(workflowId && { workflow_id: workflowId }),
            ...(projectId && { project_id: projectId }),
        });
        setModal(null);
        navigate(path);
    }
    function handleQuickAction(id: QuickActionId) {
        if (id === "projectChat") {
            setModal("project");
        } else if (DOCUMENT_WORKFLOW_ACTIONS[id]) {
            handleDocumentWorkflowClick(id);
        } else if (id === "newProject") {
            setModal("newProject");
        } else if (id === "newTabularReview") {
            setModal("review");
        }
    }
    const openDock = (tab: string) => {
        setDockTab(tab);
        setDockOpen(true);
    };
    const startWorkflow = (selection: WorkflowSelection) => {
        const documentTab = workflowDocumentTab(selection);
        chatInputRef.current?.startWorkflowDocumentSelection(
            workflowMessage(selection), undefined, {
                initialDocumentTab: documentTab,
                openDocumentPicker: documentTab === "templates",
            });
    };
    const dockPanel = (tab: "library" | "workflows" | "sources") => (
        <InitialDockPanel tab={tab} libraryKind={libraryKind}
            active={dockOpen && dockTab === tab}
            workflowDocuments={workflowDocuments}
            onLibraryKindChange={setLibraryKind}
            onOpenInChat={(documents) => {
                for (const document of documents) chatInputRef.current?.addDoc(document);
            }}
            onOpenWorkflows={(documents) => {
                for (const document of documents) chatInputRef.current?.addDoc(document);
                setWorkflowDocuments(documents);
                openDock("workflows");
            }}
            onWorkflowSelect={startWorkflow} onRun={onSubmit} />
    );
    const dockTabs: AssistantDockTab[] = [
        { id: "library", label: "Library", content: dockPanel("library") },
        { id: "workflows", label: "Workflows",
            icon: <WorkflowSkeuoIcon className="text-base leading-none" />,
            content: dockPanel("workflows") },
        { id: "sources", label: "Sources", content: dockPanel("sources") },
        { id: "agents", label: "Agents", content: <div className="grid h-full place-items-center p-6 text-center text-sm text-gray-500">Agent activity will appear here.</div> },
    ];
    return (
        <div className="relative flex h-full min-w-0 w-full">
        <div
            className={`min-w-0 flex-1 overflow-y-auto px-4 sm:px-6 ${dockOpen ? "md:max-lg:pe-2" : ""}`}
            style={{ scrollbarGutter: "stable" }}
        >
            <div className="mx-auto grid min-h-full w-full max-w-4xl grid-rows-[minmax(min-content,1fr)_auto_minmax(min-content,1fr)] py-4 xl:px-8">
            <div className="flex min-h-0 items-end justify-center pb-6">
                <div className="flex min-h-10 min-w-0 w-full items-center justify-center gap-3">
                    <BeaverIcon size={30} />
                    <h1 className="min-w-0 break-words text-center font-serif text-3xl font-light text-gray-900 sm:text-4xl">
                        Hi, {username}
                    </h1>
                </div>
            </div>
            <div className="w-full justify-self-center">
                <ChatInput
                    onDraftChange={onDraftChange}
                    ref={chatInputRef}
                    onSubmit={onSubmit}
                    onCancel={() => {}}
                    isLoading={false}
                    onOpenWorkflows={(_, documents = []) => {
                        setWorkflowDocuments(documents);
                        openDock("workflows");
                    }}
                />
            </div>
            <div className="min-h-0 w-full justify-self-center pt-1">
                <div className="text-center">
                    <p className="mb-12 py-2 text-xs text-gray-600">
                        AI can make mistakes. Answers are not legal advice.
                    </p>
                </div>
                {visibleQuickActions.length > 0 && (
                    <div className="flex flex-col items-center">
                        <div className="group relative flex min-h-8 items-center justify-center">
                            <span className="flex items-center gap-1.5 text-xs font-medium text-gray-800">
                                <Zap aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                                Shortcuts
                            </span>
                            <button
                                type="button"
                                onClick={() => setModal("quickActions")}
                                aria-label="Configure shortcuts"
                                className="absolute left-full ml-1 flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                            >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                        </div>
                        <div className="mt-3 grid w-full max-w-3xl grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                            {visibleQuickActions.map((action) => (
                                <button
                                    key={action.id}
                                    type="button"
                                    onClick={() => handleQuickAction(action.id)}
                                    className="inline-flex min-h-8 items-center justify-center rounded-full border border-gray-200 bg-white px-3 py-1.5 font-medium text-gray-600 hover:text-gray-900 disabled:cursor-default disabled:opacity-45"
                                >
                                    {action.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            </div>
            {modal === "quickActions" && (
                <Modal
                    open
                    onClose={() => setModal(null)}
                    breadcrumbs={["Assistant", "Edit shortcuts"]}
                    cancelAction={false}
                    primaryAction={{
                        label: "Done",
                        onClick: () => setModal(null),
                    }}
                >
                    <div className="flex min-h-0 flex-1 flex-col pb-5">
                        <div className="grid grid-cols-[minmax(0,1fr)_112px] px-2 pb-1 pt-0.5 text-[11px] font-medium text-gray-400">
                            <span>Shortcut</span>
                            <span className="flex items-center justify-end gap-2">
                                <span>Enabled</span>
                            </span>
                        </div>
                        <div className="w-full space-y-1">
                            {QUICK_ACTIONS.map((action) => (
                                <label
                                    key={action.id}
                                    className="grid min-h-10 w-full cursor-pointer grid-cols-[minmax(0,1fr)_112px] items-center rounded-lg px-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                                >
                                    <span className="min-w-0 truncate">
                                        {action.label}
                                    </span>
                                    <CheckboxInput
                                        checked={visibleActions[action.id]}
                                        aria-label={`Show ${action.label}`}
                                        onChange={() =>
                                            updatePreferences((current) => ({
                                                ...current,
                                                quickActions: {
                                                    ...current.quickActions,
                                                    [action.id]:
                                                        !current.quickActions[action.id],
                                                },
                                            }))
                                        }
                                        className="ml-auto"
                                    />
                                </label>
                            ))}
                        </div>
                    </div>
                </Modal>
            )}
            {modal === "project" && (
                <SelectAssistantProjectModal
                    open
                    onClose={() => setModal(null)}
                />
            )}
            {modal === "newProject" && (
                <NewProjectModal
                    open
                    onClose={() => setModal(null)}
                    onCreated={(project) => {
                        setModal(null);
                        navigate(`/projects/${project.id}`);
                    }}
                />
            )}
            {modal === "review" && (
                <NewTRModal
                    open
                    onClose={() => setModal(null)}
                    onAdd={handleNewReview}
                    onOpen={navigate}
                />
            )}
        </div>
        <AssistantDock tabs={dockTabs} activeTabId={dockTab}
            onActivateTab={setDockTab} expanded={dockOpen}
            onExpandedChange={setDockOpen} />
        </div>
    );
}
