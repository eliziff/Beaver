import { useDeferredValue, useEffect, useState, type ReactNode } from "react";
import {
    getWorkflow,
    listSystemWorkflows,
    listWorkflows,
} from "@/app/lib/beaverApi";
import { Modal } from "../modals/Modal";
import type { Workflow } from "../shared/types";
import { WorkflowPickerContent } from "./WorkflowPickerContent";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
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
export function useWorkflowPickerState(
    workflowType: Workflow["metadata"]["type"],
    initialWorkflowId?: string,
) {
    const [systemWorkflows, setSystemWorkflows] = useState<Workflow[]>([]);
    const [systemLoading, setSystemLoading] = useState(true);
    const [selected, setSelected] = useState<Workflow | null>(null);
    const [search, setSearch] = useState("");
    const query = useDeferredValue(search.trim());
    const custom = usePagedQuery(
        (cursor, signal) => listWorkflows({
            type: workflowType,
            q: query,
            cursor,
        }, signal),
        [query, workflowType],
    );
    useEffect(() => {
        let cancelled = false;
        listSystemWorkflows(workflowType)
            .then((next) => {
                if (cancelled) return;
                setSystemWorkflows(next);
            })
            .catch(() => {
                if (cancelled) return;
                setSystemWorkflows([]);
            })
            .finally(() => {
                if (!cancelled) setSystemLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [workflowType]);
    useEffect(() => {
        if (!initialWorkflowId) return;
        const loaded = [...systemWorkflows, ...custom.items].find(
            (workflow) => workflow.id === initialWorkflowId,
        );
        if (loaded) {
            setSelected(loaded);
            return;
        }
        void getWorkflow(initialWorkflowId).then(setSelected).catch(() => {});
    }, [custom.items, initialWorkflowId, systemWorkflows]);
    const select = (workflow: Workflow | null) => {
        if (!workflow) return setSelected(null);
        setSelected(workflow);
        void getWorkflow(workflow.id).then(setSelected).catch(() => setSelected(null));
    };
    return {
        workflows: [...systemWorkflows, ...custom.items],
        loading: systemLoading || custom.loading,
        selected,
        setSelected: select,
        search,
        setSearch,
        hasMore: custom.hasMore,
        loadMore: custom.loadMore,
    };
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
    const {
        workflows, loading, selected, setSelected, search, setSearch,
        hasMore, loadMore,
    } =
        useWorkflowPickerState(workflowType, initialWorkflowId);
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
                hasMore={hasMore}
                onLoadMore={() => void loadMore()}
                disabledWorkflow={disabledWorkflow}
            />
        </Modal>
    );
}
