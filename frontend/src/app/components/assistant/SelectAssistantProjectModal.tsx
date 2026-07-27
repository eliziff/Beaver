"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { SearchBar } from "@/app/components/ui/search-bar";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
import { useDirectoryData } from "../shared/useDirectoryData";
import { ClosedProjectSvgIcon } from "../shared/FolderSvgIcon";
import { Modal } from "../modals/Modal";

interface Props {
    open: boolean;
    onClose: () => void;
}

export function SelectAssistantProjectModal({ open, onClose }: Props) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [search, setSearch] = useState("");
    const router = useRouter();
    const { saveChat } = useChatHistoryContext();
    const { loading, projects } = useDirectoryData(open, "projects");

    useEffect(() => {
        if (!open) return;
        setSelectedId(null);
        setSearch("");
    }, [open]);

    if (!open) return null;

    async function handleContinue() {
        if (!selectedId) return;
        setCreating(true);
        try {
            const chatId = await saveChat(selectedId);
            if (!chatId) return;
            onClose();
            router.push(`/projects/${selectedId}/assistant/chat/${chatId}`);
        } finally {
            setCreating(false);
        }
    }

    const query = search.toLowerCase().trim();
    const filteredProjects = query
        ? projects.filter((project) =>
              project.name.toLowerCase().includes(query),
          )
        : projects;

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={["Assistant", "Start Chat in a Project"]}
            primaryAction={{
                label: creating ? "Creating…" : "Continue",
                onClick: handleContinue,
                disabled: !selectedId || creating,
            }}
        >
            <div className="pb-2 pt-1">
                <SearchBar
                    value={search}
                    onValueChange={setSearch}
                    placeholder="Search projects..."
                    autoFocus
                />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                {loading ? (
                    <div className="space-y-px">
                        <div className="flex items-center rounded-md px-2 py-2">
                            <div className="h-3 w-14 rounded bg-gray-100" />
                        </div>
                        {[65, 45, 80, 55, 70].map((width, index) => (
                            <div
                                key={index}
                                className="flex items-center gap-2 rounded-md px-2 py-2"
                            >
                                <div className="h-3.5 w-3.5 shrink-0 rounded border border-gray-200" />
                                <div className="h-3.5 w-3.5 shrink-0 rounded bg-gray-100" />
                                <div
                                    className="h-3 rounded bg-gray-100"
                                    style={{ width: `${width}%` }}
                                />
                            </div>
                        ))}
                    </div>
                ) : filteredProjects.length === 0 ? (
                    <p className="py-8 text-center text-sm text-gray-400">
                        {query ? "No matches found" : "No projects yet"}
                    </p>
                ) : (
                    <div className="overflow-hidden rounded-sm">
                        <div className="flex items-center justify-between px-2 py-2">
                            <p className="text-xs font-medium text-gray-400">
                                Projects
                            </p>
                        </div>
                        <div className="space-y-px">
                            {filteredProjects.map((project) => {
                                const isSelected = selectedId === project.id;
                                const documentCount =
                                    project.document_count ??
                                    project.documents?.length ??
                                    0;
                                return (
                                    <button
                                        key={project.id}
                                        type="button"
                                        onClick={() =>
                                            setSelectedId(
                                                isSelected ? null : project.id,
                                            )
                                        }
                                        className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors ${isSelected ? APP_SURFACE_ACTIVE_CLASS : APP_SURFACE_HOVER_CLASS}`}
                                    >
                                        <span
                                            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${isSelected ? "border-gray-900 bg-gray-900" : "border-gray-300"}`}
                                        >
                                            {isSelected && (
                                                <span className="h-1.5 w-1.5 rounded-sm bg-white" />
                                            )}
                                        </span>
                                        <ClosedProjectSvgIcon className="h-3.5 w-3.5 shrink-0" />
                                        <span
                                            className={`flex-1 truncate ${isSelected ? "text-gray-900" : "text-gray-700"}`}
                                        >
                                            {project.name}
                                            {project.cm_number && (
                                                <span className="ml-1 font-normal text-gray-400">
                                                    (#{project.cm_number})
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0 text-gray-400">
                                            {documentCount}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}
