import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { Modal } from "../modals/Modal";
import { ProjectChoiceList } from "../projects/ProjectChoiceList";
interface Props {
    open: boolean;
    onClose: () => void;
    chatTitle?: string | null;
    currentLocation?: string | null;
    currentProjectId?: string | null;
    onSelectProject?: (projectId: string | null) => Promise<void> | void;
}
export function SelectAssistantProjectModal({
    open,
    onClose,
    chatTitle,
    currentLocation,
    currentProjectId,
    onSelectProject,
}: Props) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const router = useRouter();
    const { saveChat } = useChatHistoryContext();
    useEffect(() => {
        if (!open) return;
        setSelectedId(currentProjectId ?? null);
    }, [currentProjectId, open]);
    if (!open) return null;
    async function handleContinue() {
        if (!onSelectProject && !selectedId) return;
        if (onSelectProject && selectedId === (currentProjectId ?? null)) return;
        setCreating(true);
        try {
            if (onSelectProject) {
                await onSelectProject(selectedId);
                onClose();
                return;
            }
            if (!selectedId) return;
            const chatId = await saveChat(selectedId);
            if (!chatId) return;
            onClose();
            router.push(`/projects/${selectedId}/assistant/chat/${chatId}`);
        } catch {
            return;
        } finally {
            setCreating(false);
        }
    }
    const actionLabel = onSelectProject
        ? chatTitle
            ? `Move “${chatTitle}” to a project`
            : "Move chat to a project"
        : "Start chat in a project";
    return (
        <Modal
            open={open}
            onClose={onClose}
            className="!h-auto max-h-[min(600px,calc(100dvh-2rem))]"
            breadcrumbs={["Assistant", actionLabel]}
            primaryAction={{
                label: creating
                    ? onSelectProject
                        ? "Moving…"
                        : "Creating…"
                    : onSelectProject
                      ? "Move chat"
                      : "Continue",
                onClick: handleContinue,
                disabled:
                    creating ||
                    (onSelectProject
                        ? selectedId === (currentProjectId ?? null)
                        : !selectedId),
            }}
        >
            {onSelectProject && (
                <p className="pb-3 pt-1 text-xs text-gray-500">
                    Current location:{" "}
                    <span className="text-gray-800">
                        {currentLocation ??
                            "Assistant"}
                    </span>
                </p>
            )}
            {onSelectProject && currentProjectId && (
                <button
                    type="button"
                    aria-pressed={selectedId === null}
                    onClick={() => setSelectedId(null)}
                    className={`mb-2 flex min-h-10 w-full items-center rounded-md border px-3 text-left text-sm ${
                        selectedId === null
                            ? "border-gray-900 bg-gray-900 text-white"
                            : "border-gray-300 bg-white text-gray-800 hover:bg-gray-100"
                    }`}
                >
                    Assistant (no project)
                </button>
            )}
            <ProjectChoiceList
                key={currentProjectId}
                value={selectedId}
                onChange={(projectId) =>
                    setSelectedId(
                        !onSelectProject && selectedId === projectId
                            ? null
                            : projectId,
                    )
                }
            />
        </Modal>
    );
}
