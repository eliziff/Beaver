import { X } from "lucide-react";
import { DocPanel, type DocPanelMode } from "./DocPanel";
import type {
    AutomationRunEvent,
    Citation,
    EditAnnotation,
    EditResolveHandlers,
} from "../shared/types";
import {
    LegalSourceViewer,
    type CaseTab,
    type LegalSourceTab,
} from "@/app/components/legal/LegalSourceViewer";
import { cn } from "@/app/lib/utils";
import { LIQUID_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { AutomationRunPanel } from "./AutomationRun";
import {
    DocumentAutomation,
    type DocumentAutomationTarget,
} from "@/app/components/documents/DocumentAutomation";
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
    changeNumber?: number;
};
type AutomationTab = {
    kind: "automation";
    id: string;
    run: AutomationRunEvent;
};
type AutomationMenuTab = {
    kind: "automation-menu";
    id: string;
    document: DocumentAutomationTarget;
};
export type AssistantDocumentTab = DocumentTab | CitationTab | EditTab;
export type AssistantSidePanelTab =
    | AssistantDocumentTab
    | CaseTab
    | LegalSourceTab
    | AutomationTab
    | AutomationMenuTab;
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
function tabTitle(tab: AssistantSidePanelTab): string {
    if (tab.kind === "automation-menu") return "Automations";
    if (tab.kind === "automation") return "Automation";
    if (tab.kind === "case") {
        return tab.caseName || tab.citation || "Case";
    }
    if (tab.kind === "legal") {
        return tab.name || tab.citation;
    }
    return tab.filename;
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
            <div className="flex items-start gap-2 border-b border-gray-300 bg-gray-100 p-2">
                <div className="flex max-h-20 min-w-0 flex-1 flex-wrap gap-1 overflow-y-auto">
                    {tabs.map((tab) => {
                        const isActive = tab.id === active.id;
                        const showVersionBadge =
                            "documentId" in tab &&
                            Number.isFinite(tab.versionNumber) &&
                            (tab.versionNumber ?? 0) >
                                (tab.kind === "edit" ? 0 : 1);
                        const title = tabTitle(tab);
                        return (
                            <div
                                key={tab.id}
                                onClick={() => onActivateTab(tab.id)}
                                className={cn(
                                    "group flex h-8 min-w-24 max-w-[220px] flex-1 cursor-pointer select-none items-center gap-1.5 rounded-md border px-2",
                                    isActive
                                        ? "border-gray-400 bg-white text-gray-900"
                                        : "border-transparent bg-gray-100 text-gray-600 hover:border-gray-300 hover:bg-white",
                                )}
                            >
                                <span
                                    className="min-w-0 flex-1 truncate text-xs font-medium"
                                    title={title}
                                >
                                    {title}
                                </span>
                                {showVersionBadge && (
                                    <span
                                        className={cn(
                                            "inline-flex shrink-0 items-center rounded border px-1 py-px text-[9px] font-medium",
                                            isActive
                                                ? "border-gray-200 bg-white text-gray-600"
                                                : "border-gray-300 bg-white/70 text-gray-500",
                                        )}
                                    >
                                        V{tab.versionNumber}
                                    </span>
                                )}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onCloseTab(tab.id);
                                    }}
                                    className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-900"
                                    aria-label={`Close ${title}`}
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        );
                    })}
                </div>
                <button
                    onClick={onCloseAll}
                    className="shrink-0 rounded-md border border-gray-300 bg-white p-1.5 text-gray-600 hover:bg-gray-200 hover:text-gray-900"
                    title="Close panel"
                    aria-label="Close panel"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
            <div className="flex-1 min-h-0 relative">
                {tabs.map((tab) => {
                    const isActive = tab.id === active.id;
                    const body = (() => {
                        if (tab.kind === "automation-menu") {
                            return (
                                <DocumentAutomation
                                    document={tab.document}
                                    embedded
                                />
                            );
                        }
                        if (tab.kind === "automation") {
                            return <AutomationRunPanel run={tab.run} />;
                        }
                        if (tab.kind === "case") {
                            return <LegalSourceViewer caseTab={tab} compact />;
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
                                tab.kind === "automation" ||
                                tab.kind === "automation-menu"
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
        </div>
    );
}
