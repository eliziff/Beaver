import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import { WorkflowSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { CHAT_COLUMN_CLASS } from "./chatLayout";
import { AssistantDock, type AssistantDockTab } from "./AssistantDock";
import type { LibraryKind, Document } from "@/app/lib/api/documents";
import { workflowDocumentTab, workflowMessage, type AssistantWorkflowLaunch,
    type WorkflowSelection } from "../workflows/workflowRoutes";

import type { Message } from "@/app/lib/api/chat";
import { InitialDockPanel } from "./InitialDockPanel";
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
    const [dockTab, setDockTab] = useState(initialWorkflow ? "workflows" : "sources");
    const [dockOpen, setDockOpen] = useState(!!initialWorkflow);
    const [libraryKind, setLibraryKind] = useState<LibraryKind>("files");
    const [workflowDocuments, setWorkflowDocuments] = useState<Document[]>(initialDocuments);
    const chatInputRef = useRef<ChatInputHandle>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const startedInitialWorkflow = useRef(false);
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";
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
    ];
    return (
        <div data-dock-host className="relative flex h-full min-w-0 w-full">
        <div
            ref={scrollerRef}
            className="min-w-0 flex-1 overflow-y-auto px-2 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={{ scrollbarGutter: "auto" }}
        >
            <div className={`${dockOpen ? "ms-auto me-0" : "mx-auto"} grid min-h-full ${CHAT_COLUMN_CLASS} grid-rows-[minmax(min-content,1fr)_auto_auto] py-4 xl:px-8`}>
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
            </div>
            </div>
        </div>
        <AssistantDock tabs={dockTabs} activeTabId={dockTab}
            onActivateTab={setDockTab} expanded={dockOpen}
            onExpandedChange={setDockOpen} />
        </div>
    );
}
