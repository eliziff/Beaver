import { useEffect, useState } from "react";import { Users } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { FormField } from "@/app/components/modals/ModalFieldLabel";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import type { Project } from "@/app/lib/api/projects";
import { ProjectPracticeField } from "./ProjectPracticeField";
interface ProjectDetailsModalProps {
    open: boolean;
    project: Project | null;
    canEdit: boolean;
    onClose: () => void;
    onSave: (values: { name: string; cmNumber: string; practice: string }) => Promise<void>;
    onShareProject?: () => void;
}
export function ProjectDetailsModal({
    open,
    project,
    canEdit,
    onClose,
    onSave,
    onShareProject,
}: ProjectDetailsModalProps) {
    const [draft, setDraft] = useState({ name: "", cm: "", practice: "" });
    const [status, setStatus] = useState<
        "idle" | "saving" | "saved" | "error"
    >("idle");
    useEffect(() => {
        if (!open || !project) return;
        setDraft({
            name: project.name,
            cm: project.cm_number ?? "",
            practice: project.practice ?? "",
        });
        setStatus("idle");
    }, [open, project]);
    const trimmedName = draft.name.trim();
    const trimmedCm = draft.cm.trim();
    const trimmedPractice = draft.practice.trim();
    const hasChanges =        !!project &&        (trimmedName !== project.name ||            trimmedCm !== (project.cm_number ?? "") ||            trimmedPractice !== (project.practice ?? ""));    if (!project) return null;
    const saving = status === "saving";
    function updateDraft(update: Partial<typeof draft>) {
        setDraft((current) => ({ ...current, ...update }));
        setStatus("idle");
    }
    async function handleSave() {
        if (!canEdit || saving || !hasChanges || !trimmedName) return;
        setStatus("saving");
        try {
            await onSave({
                name: trimmedName,
                cmNumber: trimmedCm,
                practice:
                    trimmedPractice && trimmedPractice !== "Other"
                        ? trimmedPractice
                        : "",
            });
            setStatus("saved");
        } catch {
            setStatus("error");
        }
    }
    return (
        <Modal
            open={open}
            onClose={onClose}
            fit
            breadcrumbs={["Projects", project.name, "Details"]}
            secondaryAction={
                onShareProject
                    ? {
                          label: "Share Project",
                          icon: <Users className="h-4 w-4" />,
                          onClick: onShareProject,
                      }
                    : undefined
            }
            footerStatus={
                status === "error" ? (
                    <span className="text-sm text-red-600">
                        Could not update project details.
                    </span>
                ) : status === "saved" ? (
                    <span className="text-sm text-gray-400">Updated</span>
                ) : null
            }
            primaryAction={
                canEdit
                    ? {
                          label: saving ? "Updating..." : "Update",
                          onClick: () => void handleSave(),
                          disabled: saving || !hasChanges || !trimmedName,
                      }
                    : undefined
            }
        >
            <div className="flex min-h-0 flex-1 flex-col gap-6 py-1">
                <FormField label="Project name" htmlFor="project-details-name">
                    <ModalTextInput
                        id="project-details-name"
                        value={draft.name}
                        onChange={(e) => updateDraft({ name: e.target.value })}
                        disabled={!canEdit || saving}
                        placeholder="Add project name"
                        variant="minimal"
                    />
                </FormField>
                <FormField label="CM number" htmlFor="project-details-cm">
                    <ModalTextInput
                        id="project-details-cm"
                        value={draft.cm}
                        onChange={(e) => updateDraft({ cm: e.target.value })}
                        disabled={!canEdit || saving}
                        placeholder="Optional"
                        variant="minimal"
                    />
                </FormField>
                <FormField label="Practice" htmlFor="project-details-practice">
                    <ProjectPracticeField
                        id="project-details-practice"
                        value={draft.practice}
                        onChange={(practice) => updateDraft({ practice })}
                        disabled={!canEdit || saving}
                    />
                </FormField>
            </div>
        </Modal>
    );
}
