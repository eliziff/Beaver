import { X } from "lucide-react";
import { DocPanel, type DocPanelMode } from "./DocPanel";
import type {
    WorkflowRunEvent,
    Citation,
    EditAnnotation,
    EditResolveHandlers,
} from "../shared/types";
import {
    LegalSourceViewer,
    type LegalSourceTab,
} from "@/app/components/legal/LegalSourceViewer";
import { cn } from "@/app/lib/utils";
import { LIQUID_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { WorkflowRunPanel } from "./WorkflowRun";
import { Tabs } from "@/app/components/ui/tabs";
import {
    DocumentWorkflowMenu,
    type DocumentWorkflowTarget,
} from "@/app/components/documents/DocumentWorkflowMenu";
type CommonTab = {
    id: string;
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
    warning?: string | null;
    initialScrollTop?: number | null;
};
type DocumentTab = CommonTab & { kind: "document" };
type CitationTab = CommonTab & {
    kind: "citation";
    citation: Citation;
};
type EditTab = CommonTab & {
    kind: "edit";
    edit: EditAnnotation;
    focusKey: number;
    changeNumber?: number;
};
type WorkflowRunTab = {
    kind: "workflow-run";
    id: string;
    run: WorkflowRunEvent;
};
type DocumentWorkflowTab = {
    kind: "document-workflows";
    id: string;
    document: DocumentWorkflowTarget;
};
export type AssistantDocumentTab = DocumentTab | CitationTab | EditTab;
export type AssistantSidePanelTab =
    | AssistantDocumentTab
    | LegalSourceTab
    | WorkflowRunTab
    | DocumentWorkflowTab;
interface Props {
    tabs: AssistantSidePanelTab[];
    activeTabId: string | null;
    projectId?: string;
    onActivateTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onCloseAll: () => void;
    isEditorReloading?: (documentId: string) => boolean;
    isEditReloading?: (editId: string) => boolean;
    onEditResolveStart?: EditResolveHandlers["onResolveStart"];
    onEditResolved?: EditResolveHandlers["onResolved"];
    onEditError?: EditResolveHandlers["onError"];
    onWarningDismiss?: (tabId: string) => void;
    onScrollChange?: (tabId: string, scrollTop: number) => void;
    embedded?: boolean;
}
export function AssistantSidePanel({
    tabs,
    activeTabId,
    projectId,
    onActivateTab,
    onCloseTab,
    onCloseAll,
    isEditorReloading,
    isEditReloading,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    onWarningDismiss,
    onScrollChange,
    embedded = false,
}: Props) {
    const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
    if (!active) return null;
    const options = tabs.map((tab) => {
        const title = tab.kind === "document-workflows" ? "Workflows"
            : tab.kind === "workflow-run" ? "Workflow"
            : tab.kind === "legal" ? tab.name || tab.citation : tab.filename;
        const showVersion = "documentId" in tab && Number.isFinite(tab.versionNumber) &&
            (tab.versionNumber ?? 0) > (tab.kind === "edit" ? 0 : 1);
        return { value: tab.id, onClose: () => onCloseTab(tab.id),
            closeLabel: `Close ${title}`, label: <span title={title}
                className="flex min-w-0 items-center gap-1.5 text-left">
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {showVersion && <span
                    className="shrink-0 rounded border border-gray-300 bg-white px-1 py-px text-[9px] text-gray-600">
                    V{tab.versionNumber}
                </span>}
            </span> };
    });
    return (
        <div
            className={cn(
                embedded
                    ? "relative flex min-h-0 w-full flex-1 flex-col"
                    : "relative flex h-full w-full shrink-0 flex-col md:my-3 md:mr-3 md:h-[calc(100%-1.5rem)] md:min-w-[360px] md:w-[min(46vw,680px)]",
                LIQUID_PANEL_SURFACE_CLASS,
                "overflow-hidden",
            )}
        >
            <Tabs value={active.id} onValueChange={onActivateTab} options={options}
                ariaLabel="Open sources" variant="quiet" className="h-full"
                actions={<button type="button"
                    onClick={onCloseAll}
                    className="grid size-8 shrink-0 place-items-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-200 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900"
                    title="Close panel"
                    aria-label="Close panel"
                >
                    <X className="h-4 w-4" />
                </button>}>
            <div className="flex-1 min-h-0 relative">
                {tabs.map((tab) => {
                    const isActive = tab.id === active.id;
                    const body = (() => {
                        if (tab.kind === "document-workflows") {
                            return (
                                <DocumentWorkflowMenu
                                    document={tab.document}
                                    embedded
                                />
                            );
                        }
                        if (tab.kind === "workflow-run") {
                            return <WorkflowRunPanel run={tab.run} />;
                        }
                        if (tab.kind === "legal") {
                            return <LegalSourceViewer {...tab} compact />;
                        }
                        const mode: DocPanelMode =
                            tab.kind === "citation"
                                ? {
                                      kind: "citation",
                                      citation: tab.citation,
                                  }
                                : tab.kind === "edit"
                                  ? {
                                        kind: "edit",
                                        edit: tab.edit,
                                        focusKey: tab.focusKey,
                                        isEditReloading:
                                            isEditReloading?.(
                                                tab.edit.edit_id,
                                            ) ?? false,
                                        onResolveStart: onEditResolveStart,
                                        onResolved: onEditResolved,
                                        onError: onEditError,
                                    }
                                  : { kind: "document" };
                        return (
                            <DocPanel
                                {...tab}
                                projectId={projectId}
                                mode={mode}
                                isReloading={
                                    isEditorReloading?.(tab.documentId) ?? false
                                }
                                warning={tab.warning ?? null}
                                onWarningDismiss={() =>
                                    onWarningDismiss?.(tab.id)
                                }
                                initialScrollTop={tab.initialScrollTop ?? null}
                                onScrollChange={(scrollTop) =>
                                    onScrollChange?.(tab.id, scrollTop)
                                }
                            />
                        );
                    })();
                    return (
                        <div
                            key={tab.id}
                            className={cn(
                                "absolute inset-0",
                                tab.kind === "workflow-run" ||
                                tab.kind === "document-workflows"
                                    ? "overflow-y-auto"
                                    : "flex flex-col",
                                !isActive && "invisible pointer-events-none",
                            )}
                            aria-hidden={!isActive}
                        >
                            {body}
                        </div>
                    );
                })}
            </div>
            </Tabs>
        </div>
    );
}
