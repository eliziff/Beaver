import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Zap } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import { Modal } from "@/app/components/modals/Modal";
import { CheckboxInput } from "@/app/components/ui/checkbox";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { AssistantDock, type AssistantDockTab } from "./AssistantDock";
import { AssistantWorkflowDock } from "./AssistantWorkflowDock";
import { DocumentAutomation } from "../documents/DocumentAutomation";
import { LegalLibraryPage } from "../legal/LegalLibrary";
import { LibraryCollectionPage, LibraryWorkspaceProvider } from "../library/LibraryWorkspace";
import { createTabularReview } from "@/app/lib/beaverApi";
import { preloadDuringIdle } from "@/app/lib/preloadDuringIdle";
import type { DirectoryTab } from "../shared/FileDirectory";
import {
    QUICK_ACTIONS,
    type QuickActionId,
    useQuickActionsPreference,
} from "./quickActionsPreferences";
import type { Document, Message, Workflow } from "../shared/types";
const loadNewTRModal = () => import("../tabular/NewTRModal");
const loadSelectAssistantProjectModal = () => import("./SelectAssistantProjectModal");
const loadNewProjectModal = () => import("../projects/NewProjectModal");
const NewTRModal = lazy(() => loadNewTRModal().then(({ NewTRModal }) => ({ default: NewTRModal })));
const SelectAssistantProjectModal = lazy(() => loadSelectAssistantProjectModal().then(({ SelectAssistantProjectModal }) => ({ default: SelectAssistantProjectModal })));
const NewProjectModal = lazy(() => loadNewProjectModal().then(({ NewProjectModal }) => ({ default: NewProjectModal })));
type InitialModal = "project" | "newProject" | "review" | "quickActions";
const DOCUMENT_WORKFLOW_ACTIONS: Partial<
    Record<
        QuickActionId,
        {
            workflowId: string;
            title: string;
            prompt: string;
            initialDocumentTab?: DirectoryTab;
        }
    >
> = {
    proofread: {
        workflowId: "builtin-proofread",
        title: "Proofread",
        prompt: "proofread",
    },
    compareDocuments: {
        workflowId: "builtin-compare-documents",
        title: "Compare Documents",
        prompt: "compare documents",
    },
    extractKeyTerms: {
        workflowId: "builtin-extract-key-terms",
        title: "Extract Key Terms",
        prompt: "extract key terms",
    },
    draftFromTemplate: {
        workflowId: "builtin-draft-from-template",
        title: "Draft from Template",
        prompt: "draft from template",
        initialDocumentTab: "templates",
    },
};
export function InitialView({
    onSubmit,
    initialDocuments = [],
}: {
    onSubmit: (message: Message) => void;
    initialDocuments?: Document[];
}) {
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const router = useRouter();
    const [modal, setModal] = useState<InitialModal | null>(null);
    const [dockTab, setDockTab] = useState("sources");
    const [dockOpen, setDockOpen] = useState(false);
    const [automationDocument, setAutomationDocument] = useState<Document | null>(null);
    const { visibleActions, setVisibleActions } = useQuickActionsPreference();
    const chatInputRef = useRef<ChatInputHandle>(null);
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";
    const visibleQuickActions = QUICK_ACTIONS.filter(
        (action) => visibleActions[action.id],
    );
    useEffect(() => {
        return preloadDuringIdle(() => void Promise.all([
            loadNewTRModal(),
            loadSelectAssistantProjectModal(),
            loadNewProjectModal(),
        ]));
    }, []);
    useEffect(() => {
        for (const document of initialDocuments) {
            chatInputRef.current?.addDoc(document);
        }
    }, [initialDocuments]);
    function handleDocumentWorkflowClick(id: QuickActionId) {
        const config = DOCUMENT_WORKFLOW_ACTIONS[id];
        if (!config) return;
        chatInputRef.current?.startWorkflowDocumentSelection(
            {
                id: config.workflowId,
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
        columnsConfig?: Workflow["columns_config"],
    ) {
        const review = await createTabularReview({
            title,
            document_ids: documentIds ?? [],
            columns_config: columnsConfig ?? [],
            ...(projectId && { project_id: projectId }),
        });
        setModal(null);
        router.push(
            projectId
                ? `/projects/${projectId}/tabular-reviews/${review.id}`
                : `/tabular-reviews/${review.id}`,
        );
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
    const dockTabs: AssistantDockTab[] = [
        { id: "library", label: "Library", content: <LibraryWorkspaceProvider><LibraryCollectionPage kind="files" onOpenInChat={(documents) => { for (const document of documents) chatInputRef.current?.addDoc(document); }} embedded /></LibraryWorkspaceProvider> },
        { id: "workflows", label: "Workflows", content: <AssistantWorkflowDock onSelect={(workflow) => chatInputRef.current?.startWorkflowDocumentSelection({ id: workflow.id, title: workflow.metadata.title })} /> },
        { id: "automations", label: "Automation", content: automationDocument ? <DocumentAutomation document={automationDocument} embedded /> : <div className="grid h-full place-items-center p-6 text-center text-sm text-gray-500">Open a document to use its automations.</div> },
        { id: "sources", label: "Sources", content: <LegalLibraryPage embedded /> },
        { id: "agents", label: "Agents", content: <div className="grid h-full place-items-center p-6 text-center text-sm text-gray-500">Agent activity will appear here.</div> },
    ];
    return (
        <div className="flex h-full min-w-0 w-full">
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
                    ref={chatInputRef}
                    onSubmit={onSubmit}
                    onCancel={() => {}}
                    isLoading={false}
                    onOpenWorkflows={() => {
                        openDock("workflows");
                    }}
                    automationsAvailable={!!automationDocument}
                    onOpenAutomations={(document) => {
                        if (document) setAutomationDocument(document);
                        openDock("automations");
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
                                Quick actions
                            </span>
                            <button
                                type="button"
                                onClick={() => setModal("quickActions")}
                                aria-label="Configure quick actions"
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
                    breadcrumbs={["Assistant", "Edit quick actions"]}
                    cancelAction={false}
                    primaryAction={{
                        label: "Done",
                        onClick: () => setModal(null),
                    }}
                >
                    <div className="flex min-h-0 flex-1 flex-col pb-5">
                        <div className="grid grid-cols-[minmax(0,1fr)_112px] px-2 pb-1 pt-0.5 text-[11px] font-medium text-gray-400">
                            <span>Quick action</span>
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
                                            setVisibleActions((previous) => ({
                                                ...previous,
                                                [action.id]:
                                                    !previous[action.id],
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
                <Suspense fallback={null}>
                    <SelectAssistantProjectModal
                        open
                        onClose={() => setModal(null)}
                    />
                </Suspense>
            )}
            {modal === "newProject" && (
                <Suspense fallback={null}>
                    <NewProjectModal
                        open
                        onClose={() => setModal(null)}
                        onCreated={(project) => {
                            setModal(null);
                            router.push(`/projects/${project.id}`);
                        }}
                    />
                </Suspense>
            )}
            {modal === "review" && (
                <Suspense fallback={null}>
                    <NewTRModal
                        open
                        onClose={() => setModal(null)}
                        onAdd={handleNewReview}
                    />
                </Suspense>
            )}
        </div>
        <AssistantDock tabs={dockTabs} activeTabId={dockTab}
            onActivateTab={setDockTab} expanded={dockOpen}
            onExpandedChange={setDockOpen} />
        </div>
    );
}
