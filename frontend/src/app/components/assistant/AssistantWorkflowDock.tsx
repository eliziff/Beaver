"use client";

import type { Workflow } from "../shared/types";
import { WorkflowPickerContent } from "../workflows/WorkflowPickerContent";
import { useWorkflowPickerState } from "../workflows/WorkflowPickerModal";

export function AssistantWorkflowDock({
    onSelect,
    initialWorkflowId,
}: {
    onSelect: (workflow: Workflow) => void;
    initialWorkflowId?: string;
}) {
    const state = useWorkflowPickerState("assistant", initialWorkflowId);
    return (
        <div className="flex h-full min-h-0 flex-col p-3">
            <WorkflowPickerContent
                workflows={state.workflows}
                selected={state.selected}
                onSelect={state.setSelected}
                search={state.search}
                onSearchChange={state.setSearch}
                loading={state.loading}
                singlePane
            />
            <div className="flex shrink-0 justify-end pt-3">
                <button
                    type="button"
                    disabled={!state.selected}
                    onClick={() => state.selected && onSelect(state.selected)}
                    className="min-h-10 rounded-md bg-gray-900 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-default disabled:bg-gray-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                >
                    Use workflow
                </button>
            </div>
        </div>
    );
}
