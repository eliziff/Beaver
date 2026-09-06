import { useEffect, useState, type ReactNode } from "react";
import { listWorkflows, type WorkflowVariant } from "@/app/lib/api/workflows";
import { Modal } from "../modals/Modal";

import { WorkflowPickerContent } from "./WorkflowPickerContent";
import type { AudienceFilter } from "./workflowCatalog";
import type { WorkflowSelection } from "./workflowRoutes";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

interface Props {
    open: boolean; onClose: () => void;
    onSelect: (selection: WorkflowSelection) => Promise<void> | void;
    execution: WorkflowVariant["execution"]; breadcrumbs: ReactNode[];
    selecting?: boolean; closeOnSelect?: boolean; initialWorkflowId?: string;
    disabledWorkflow?: (selection: WorkflowSelection) => boolean;
}

export function useWorkflowPickerState(initialWorkflowId?: string, initialAudience: AudienceFilter = "general") {
    const { profile } = useUserProfile();
    const [workflows, setWorkflows] = useState([] as WorkflowSelection["workflow"][]);
    const [audience, setAudience] = useState<AudienceFilter>(initialWorkflowId ? "all" : initialAudience);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [loadAttempt, setLoadAttempt] = useState(0);
    useEffect(() => { if (initialWorkflowId) setAudience("all"); }, [initialWorkflowId]);
    useEffect(() => {
        let active = true;
        setLoading(true); setLoadError(false);
        listWorkflows({ audience: "all" })
            .then((items) => { if (active) setWorkflows(items); })
            .catch(() => { if (active) setLoadError(true); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [loadAttempt]);
    return { workflows: workflows.filter(({ id, metadata }) =>
        (id !== "authorities" || profile?.features.authorities !== false) &&
        (audience === "all" || metadata.audiences.includes("general") || metadata.audiences.includes(audience))),
        setWorkflows, loading, loadError, retryLoad: () => setLoadAttempt((value) => value + 1),
        search, setSearch, audience, setAudience };
}

export function WorkflowPickerModal({ open, ...props }: Props) {
    return open ? <OpenWorkflowPickerModal key={`${props.execution}:${props.initialWorkflowId ?? ""}`} {...props} /> : null;
}

function OpenWorkflowPickerModal({ onClose, onSelect, execution, breadcrumbs,
    selecting = false, closeOnSelect = true, initialWorkflowId, disabledWorkflow }: Omit<Props, "open">) {
    const state = useWorkflowPickerState(initialWorkflowId, execution === "tabular" ? "all" : "general");
    async function choose(selection: WorkflowSelection) {
        if (selecting || disabledWorkflow?.(selection)) return;
        if (closeOnSelect) onClose();
        await onSelect(selection);
    }
    return <Modal open onClose={onClose} size="xl" breadcrumbs={breadcrumbs}>
        <WorkflowPickerContent workflows={state.workflows.filter(({ launcher }) =>
            (launcher.kind === "instructions" || launcher.kind === "quote_check"))}
            onSelect={(workflow, variant) => { if (variant) void choose({ workflow, variant }); }}
            search={state.search} onSearchChange={state.setSearch}
            audience={state.audience} onAudienceChange={state.setAudience}
            loading={state.loading} loadError={state.loadError} onRetryLoad={state.retryLoad}
            execution={execution} initialWorkflowId={initialWorkflowId}
            disabledItem={(workflow, variant) => !variant || selecting ||
                Boolean(disabledWorkflow?.({ workflow, variant }))} />
    </Modal>;
}
