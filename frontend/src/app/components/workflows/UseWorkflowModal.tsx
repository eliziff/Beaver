"use client";

import { useEffect, useState } from "react";
import type { Document, Workflow } from "../shared/types";
import { createTabularReview } from "@/app/lib/beaverApi";
import { useRouter } from "next/navigation";
import { useDirectoryData } from "../shared/useDirectoryData";
import { FileDirectory } from "../shared/FileDirectory";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { Modal } from "../modals/Modal";
import { ModalFieldLabel } from "../modals/ModalFieldLabel";
import { ModalSegmentedToggle } from "../modals/ModalSegmentedToggle";
import { ModalTextarea } from "../modals/ModalTextarea";
import { ProjectChoiceList } from "../projects/ProjectChoiceList";
import { WorkflowPickerContent } from "./WorkflowPickerContent";

interface Props {
    workflows: Workflow[];
    workflow: Workflow | null;
    onClose: () => void;
    skipSelect?: boolean;
}

export function UseWorkflowModal({
    workflows,
    workflow,
    onClose,
    skipSelect = false,
}: Props) {
    const [screen, setScreen] = useState<"select" | "details" | "documents">(
        skipSelect ? "details" : "select",
    );
    const [selected, setSelected] = useState<Workflow | null>(workflow);
    const [listSearch, setListSearch] = useState("");

    const [inProject, setInProject] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
        null,
    );
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [assistantPrompt, setAssistantPrompt] = useState("");
    const [saving, setSaving] = useState(false);

    const router = useRouter();
    const { saveChat, stagePendingChatMessage } = useChatHistoryContext();
    const { loading: dirLoading, projects } = useDirectoryData(
        screen === "details",
        "projects",
    );

    useEffect(() => {
        if (workflow) {
            setSelected(workflow);
            setScreen(skipSelect ? "details" : "select");
            setListSearch("");
        } else {
            setSelected(null);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workflow?.id]);

    useEffect(() => {
        if (screen === "select") {
            resetConfigureState();
        }
    }, [screen]);

    function resetConfigureState() {
        setInProject(false);
        setSelectedProjectId(null);
        setSelectedDocuments([]);
        setAssistantPrompt("");
    }

    function handleClose() {
        setSelected(null);
        setScreen(skipSelect ? "details" : "select");
        resetConfigureState();
        onClose();
    }

    if (!workflow) return null;
    const wf = selected ?? workflow;

    async function handleStartChat() {
        setSaving(true);
        try {
            const projectId = inProject ? selectedProjectId! : undefined;
            const chatId = await saveChat(projectId);
            if (!chatId) return;
            const files = selectedDocuments.map((document) => ({
                filename: document.filename,
                document_id: document.id,
            }));
            const content = assistantPrompt.trim()
                ? `implement workflow\n${assistantPrompt.trim()}`
                : "implement workflow";
            stagePendingChatMessage(chatId, {
                role: "user",
                content,
                files: files.length > 0 ? files : undefined,
                workflow: { id: wf.id, title: wf.metadata.title },
            });
            handleClose();
            router.push(
                projectId
                    ? `/projects/${projectId}/assistant/chat/${chatId}`
                    : `/assistant/chat/${chatId}`,
            );
        } finally {
            setSaving(false);
        }
    }

    async function handleCreateReview() {
        const docIds = selectedDocuments.map((document) => document.id);
        const projectId = inProject ? selectedProjectId! : undefined;

        setSaving(true);
        try {
            const review = await createTabularReview({
                title: wf.metadata.title,
                document_ids: docIds,
                columns_config: wf.columns_config || [],
                workflow_id: wf.is_system ? undefined : wf.id,
                project_id: projectId,
            });
            handleClose();
            router.push(
                projectId
                    ? `/projects/${projectId}/tabular-reviews/${review.id}`
                    : `/tabular-reviews/${review.id}`,
            );
        } finally {
            setSaving(false);
        }
    }

    const selectedProject = projects.find((p) => p.id === selectedProjectId);
    const projectDocs = selectedProject?.documents ?? [];
    const location = inProject ? "project" : "workspace";
    const locationOptions =
        wf.metadata.type === "assistant"
            ? [
                  { value: "workspace" as const, label: "Assistant" },
                  { value: "project" as const, label: "Project assistant" },
              ]
            : [
                  { value: "workspace" as const, label: "Tabular reviews" },
                  {
                      value: "project" as const,
                      label: "Project tabular reviews",
                  },
              ];

    const breadcrumbs =
        screen === "select"
            ? ["Workflows", "Select workflow"]
            : [
                  skipSelect ? (
                      "Workflows"
                  ) : (
                      <button
                          key="workflows"
                          type="button"
                          onClick={() => setScreen("select")}
                          className="transition-colors hover:text-gray-700"
                      >
                          Workflows
                      </button>
                  ),
                  wf.metadata.title,
                  wf.metadata.type === "assistant" ? "New Chat" : "New Review",
                  screen === "details" ? "Details" : "Attach Documents",
              ];

    return (
        <Modal
            open={!!workflow}
            onClose={handleClose}
            size="xl"
            breadcrumbs={breadcrumbs}
            primaryAction={
                screen === "select"
                    ? {
                          label: "Use",
                          onClick: () => setScreen("details"),
                          disabled: !selected,
                      }
                    : screen === "details"
                      ? {
                            label: "Next",
                            onClick: () => setScreen("documents"),
                            disabled:
                                saving || (inProject && !selectedProjectId),
                        }
                    : wf.metadata.type === "assistant"
                      ? {
                            label: saving ? "Starting…" : "Start Chat",
                            onClick: handleStartChat,
                            disabled:
                                saving || (inProject && !selectedProjectId),
                        }
                      : {
                            label: saving ? "Creating…" : "Create Review",
                            onClick: handleCreateReview,
                            disabled:
                                saving ||
                                selectedDocuments.length === 0 ||
                                (inProject && !selectedProjectId),
                        }
            }
            cancelAction={
                screen === "select"
                    ? false
                    : {
                          label: "Back",
                          onClick: () =>
                              screen === "documents"
                                  ? setScreen("details")
                                  : skipSelect
                                    ? handleClose()
                                    : setScreen("select"),
                          disabled: saving,
                      }
            }
        >
            {screen === "select" && (
                <WorkflowPickerContent
                    workflows={workflows}
                    selected={selected}
                    onSelect={setSelected}
                    search={listSearch}
                    onSearchChange={setListSearch}
                    workflowType="all"
                    previewMode="auto"
                    showTypeIcon
                    allowClearPreview
                />
            )}

            {screen === "details" && (
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="space-y-6">
                        <div>
                            <ModalFieldLabel as="p">Use in</ModalFieldLabel>
                            <ModalSegmentedToggle
                                value={location}
                                onChange={(value) => {
                                    setInProject(value === "project");
                                    setSelectedProjectId(null);
                                    setSelectedDocuments([]);
                                }}
                                options={locationOptions}
                            />
                        </div>

                        {inProject && (
                            <div>
                                <ModalFieldLabel as="p">
                                    Project
                                </ModalFieldLabel>
                                <ProjectChoiceList
                                    projects={projects}
                                    value={selectedProjectId}
                                    onChange={(value) => {
                                        setSelectedProjectId(value);
                                        setSelectedDocuments([]);
                                    }}
                                    loading={dirLoading}
                                    disabled={dirLoading}
                                />
                            </div>
                        )}

                        {wf.metadata.type === "assistant" && (
                            <div>
                                <ModalFieldLabel htmlFor="workflow-additional-message">
                                    Additional message
                                </ModalFieldLabel>
                                <ModalTextarea
                                    id="workflow-additional-message"
                                    value={assistantPrompt}
                                    onChange={(e) =>
                                        setAssistantPrompt(e.target.value)
                                    }
                                    placeholder="Add any additional instructions..."
                                    rows={4}
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {screen === "documents" && (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div className="flex min-h-0 flex-1 flex-col">
                        <FileDirectory
                            documents={inProject ? projectDocs : undefined}
                            selectedDocuments={selectedDocuments}
                            onChange={setSelectedDocuments}
                            showTabs={!inProject}
                        />
                    </div>
                </div>
            )}
        </Modal>
    );
}
