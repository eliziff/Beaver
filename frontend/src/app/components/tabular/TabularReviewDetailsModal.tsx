import { useEffect, useState } from "react";import { Modal } from "../modals/Modal";
import { FieldGroup, FormField } from "../modals/ModalFieldLabel";
import { Switch } from "../ui/switch";
import { ModalTextInput } from "../modals/ModalTextInput";
import { ProjectChoiceList } from "../projects/ProjectChoiceList";
import type { Project } from "@/app/lib/api/projects";
import type { TabularReview } from "@/app/lib/api/tabular";
interface TabularReviewDetailsModalProps {
    open: boolean;
    review: TabularReview | null;
    projects?: Project[];
    canEdit: boolean;
    lockProject?: boolean;
    onClose: () => void;
    onSave: (values: {
        title: string;
        projectId?: string | null;
    }) => Promise<void>;
}
export function TabularReviewDetailsModal({
    open,
    review,
    projects,
    canEdit,
    lockProject = false,
    onClose,
    onSave,
}: TabularReviewDetailsModalProps) {
    const [titleDraft, setTitleDraft] = useState("");
    const [underProject, setUnderProject] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!open || !review) return;
        setTitleDraft(review.title ?? "");
        setUnderProject(Boolean(review.project_id));
        setSelectedProjectId(review.project_id ?? "");
        setSaving(false);
        setSaved(false);
        setError(null);
    }, [open, review]);
    const trimmedTitle = titleDraft.trim();
    const nextProjectId = underProject ? selectedProjectId : null;
    const hasChanges =        !!review &&        (trimmedTitle !== (review.title ?? "") ||            nextProjectId !== (review.project_id ?? null));    if (!review) return null;
    const blocked = saving || !hasChanges || !trimmedTitle ||
        (underProject && !selectedProjectId);
    /** Any edit invalidates the "Updated" notice and clears a stale failure. */
    const touch = () => { setSaved(false); setError(null); };
    async function handleSave() {
        if (!canEdit || blocked) return;
        setSaving(true);
        touch();
        try {
            await onSave({
                title: trimmedTitle,
                projectId: nextProjectId,
            });
            setSaved(true);
        } catch {
            setError("Could not update tabular review details.");
        } finally {
            setSaving(false);
        }
    }
    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={[
                "Tabular Reviews",
                review.title || "Untitled Review",
                "Details",
            ]}
            footerStatus={
                error ? (
                    <span className="text-sm text-red-600">{error}</span>
                ) : saved ? (
                    <span className="text-sm text-gray-400">Updated</span>
                ) : null
            }
            primaryAction={
                canEdit
                    ? {
                          label: saving ? "Saving..." : "Save changes",
                          onClick: () => void handleSave(),
                          disabled: blocked,
                      }
                    : undefined
            }
        >
            <div className="space-y-6">
                <FormField label="Review name" htmlFor="tabular-review-details-title">
                    <ModalTextInput
                        type="text"
                        value={titleDraft}
                        onChange={(event) => { setTitleDraft(event.target.value); touch(); }}
                        placeholder="Review name"
                        variant="minimal"
                        className="placeholder:text-gray-400"
                        disabled={!canEdit || saving}
                        autoFocus
                    />
                </FormField>
                {!lockProject && (
                    <FieldGroup legend="Project" className="space-y-3">
                        <label className="flex w-fit items-center gap-2.5 text-sm text-gray-600">
                            <Switch checked={underProject} size="md" tone="dark"
                                disabled={!canEdit || saving} onChange={(next) => {
                                    setUnderProject(next);
                                    if (!next) setSelectedProjectId("");
                                    touch();
                                }} />
                            Move under a project
                        </label>
                        {underProject && (
                            <ProjectChoiceList
                                projects={projects}
                                value={selectedProjectId || null}
                                onChange={(value) => { setSelectedProjectId(value); touch(); }}
                                disabled={!canEdit || saving || projects?.length === 0}
                            />
                        )}
                    </FieldGroup>
                )}
            </div>
        </Modal>
    );
}
