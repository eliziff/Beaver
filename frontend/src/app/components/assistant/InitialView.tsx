"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import { QuickActionsSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { SelectAssistantProjectModal } from "./SelectAssistantProjectModal";
import { QuickActionsModal } from "./QuickActionsModal";
import { NewProjectModal } from "../projects/NewProjectModal";
import { NewTRModal } from "../tabular/NewTRModal";
import { createTabularReview } from "@/app/lib/beaverApi";
import { useDirectoryData, type DirectoryTab } from "../shared/useDirectoryData";
import {
    QUICK_ACTIONS,
    type QuickActionId,
    useQuickActionsPreference,
} from "./quickActionsPreferences";
import type { Message, Workflow } from "../shared/types";
interface InitialViewProps {
    onSubmit: (message: Message) => void;
}
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
export function InitialView({ onSubmit }: InitialViewProps) {
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const router = useRouter();
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const [newProjectOpen, setNewProjectOpen] = useState(false);
    const [newTROpen, setNewTROpen] = useState(false);
    const [quickActionsModalOpen, setQuickActionsModalOpen] = useState(false);
    const { visibleActions, setVisibleActions } = useQuickActionsPreference();
    const chatInputRef = useRef<ChatInputHandle>(null);
    const { projects } = useDirectoryData(newTROpen, "projects");
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";
    const visibleQuickActions = QUICK_ACTIONS.filter(
        (action) => visibleActions[action.id],
    );
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
        setNewTROpen(false);
        router.push(
            projectId
                ? `/projects/${projectId}/tabular-reviews/${review.id}`
                : `/tabular-reviews/${review.id}`,
        );
    }
    function handleQuickAction(id: QuickActionId) {
        if (id === "projectChat") {
            setProjectModalOpen(true);
        } else if (DOCUMENT_WORKFLOW_ACTIONS[id]) {
            handleDocumentWorkflowClick(id);
        } else if (id === "newProject") {
            setNewProjectOpen(true);
        } else if (id === "newTabularReview") {
            setNewTROpen(true);
        }
    }
    return (
        <div className="grid h-full w-full grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] px-6">
            <div className="flex min-h-0 items-end justify-center pb-6">
                <div className="flex h-10 w-full max-w-4xl items-center justify-center gap-3 px-0 xl:px-8">
                    <BeaverIcon size={30} />
                    <h1 className="whitespace-nowrap font-serif text-4xl font-light text-gray-900">
                        Hi, {username}
                    </h1>
                </div>
            </div>
            <div className="w-full max-w-4xl justify-self-center px-0 xl:px-8">
                <ChatInput
                    ref={chatInputRef}
                    onSubmit={onSubmit}
                    onCancel={() => {}}
                    isLoading={false}
                />
            </div>
            <div className="min-h-0 w-full max-w-4xl justify-self-center px-0 pt-1 xl:px-8">
                <div className="text-center">
                    <p className="text-xs py-2 mb-12 text-gray-500">
                        AI can make mistakes. Answers are not legal advice.
                    </p>
                </div>
                {visibleQuickActions.length > 0 && (
                    <div className="flex flex-col items-center">
                        <div className="group relative flex h-5 items-center justify-center">
                            <span className="flex items-center gap-1.5 text-xs font-medium text-gray-800">
                                <QuickActionsSkeuoIcon className="h-3.5 w-3.5 shrink-0" />
                                Quick actions
                            </span>
                            <button
                                type="button"
                                onClick={() => setQuickActionsModalOpen(true)}
                                aria-label="Configure quick actions"
                                className="absolute left-full ml-1.5 flex h-5 w-5 items-center justify-center text-gray-400 opacity-0 hover:text-gray-700 group-hover:opacity-100 focus:opacity-100"
                            >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                        </div>
                        <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs">
                            {visibleQuickActions.map((action) => (
                                <button
                                    key={action.id}
                                    type="button"
                                    onClick={() => handleQuickAction(action.id)}
                                    className="inline-flex h-8 items-center justify-center rounded-full border border-gray-200 bg-white px-3 font-medium text-gray-600 hover:text-gray-900 disabled:cursor-default disabled:opacity-45"
                                >
                                    {action.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            <QuickActionsModal
                open={quickActionsModalOpen}
                onClose={() => setQuickActionsModalOpen(false)}
                visibleActions={visibleActions}
                onVisibleActionsChange={setVisibleActions}
            />
            <SelectAssistantProjectModal
                open={projectModalOpen}
                onClose={() => setProjectModalOpen(false)}
            />
            <NewProjectModal
                open={newProjectOpen}
                onClose={() => setNewProjectOpen(false)}
                onCreated={(project) => {
                    setNewProjectOpen(false);
                    router.push(`/projects/${project.id}`);
                }}
            />
            <NewTRModal
                open={newTROpen}
                onClose={() => setNewTROpen(false)}
                onAdd={handleNewReview}
                projects={projects}
            />
        </div>
    );
}
