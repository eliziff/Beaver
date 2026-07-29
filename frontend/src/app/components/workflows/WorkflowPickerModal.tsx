"use client";
import { useEffect, useState, type ReactNode } from "react";
import { listWorkflows } from "@/app/lib/beaverApi";
import { Modal } from "../modals/Modal";
import type { Workflow } from "../shared/types";
import { WorkflowPickerContent } from "./WorkflowPickerContent";
interface WorkflowPickerModalProps {
    open: boolean;
    onClose: () => void;
    onSelect: (workflow: Workflow) => Promise<void> | void;
    workflowType: Workflow["metadata"]["type"];
    breadcrumbs: ReactNode[];
    primaryLabel?: string;
    selectingLabel?: string;
    selecting?: boolean;
    closeOnSelect?: boolean;
    initialWorkflowId?: string;
    disabledWorkflow?: (workflow: Workflow) => boolean;
}
export function WorkflowPickerModal({
    open,
    ...props
}: WorkflowPickerModalProps) {
    if (!open) return null;
    return (
        <OpenWorkflowPickerModal
            key={`${props.workflowType}:${props.initialWorkflowId ?? ""}`}
            {...props}
        />
    );
}
function OpenWorkflowPickerModal({
    onClose,
    onSelect,
    workflowType,
    breadcrumbs,
    primaryLabel = "Use",
    selectingLabel,
    selecting = false,
    closeOnSelect = true,
    initialWorkflowId,
    disabledWorkflow,
}: Omit<WorkflowPickerModalProps, "open">) {
    const [workflows, setWorkflows] = useState<Workflow[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<Workflow | null>(null);
    const [search, setSearch] = useState("");
    useEffect(() => {
        let cancelled = false;
        listWorkflows(workflowType)
            .then((workflows) => {
                if (cancelled) return;
                setWorkflows(workflows);
                if (initialWorkflowId) {
                    setSelected(
                        workflows.find(
                            (workflow) => workflow.id === initialWorkflowId,
                        ) ?? null,
                    );
                }
            })
            .catch(() => {
                if (cancelled) return;
                setWorkflows([]);
                setSelected(null);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [initialWorkflowId, workflowType]);
    const selectionDisabled =
        !selected || selecting || (selected && disabledWorkflow?.(selected));
    const resolvedPrimaryLabel =
        selecting && selectingLabel ? selectingLabel : primaryLabel;
    function handleClose() {
        onClose();
    }
    async function handleSelect() {
        if (!selected || selectionDisabled) return;
        await onSelect(selected);
        if (closeOnSelect) handleClose();
    }
    return (
        <Modal
            open
            onClose={handleClose}
            size="xl"
            breadcrumbs={breadcrumbs}
            primaryAction={{
                label: resolvedPrimaryLabel,
                onClick: () => void handleSelect(),
                disabled: selectionDisabled,
            }}
        >
            <WorkflowPickerContent
                workflows={workflows}
                selected={selected}
                onSelect={setSelected}
                search={search}
                onSearchChange={setSearch}
                loading={loading}
                workflowType={workflowType}
                previewMode={workflowType === "tabular" ? "columns" : "prompt"}
                disabledWorkflow={disabledWorkflow}
            />
        </Modal>
    );
}
