"use client";

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
} from "react";
import { X } from "lucide-react";
import { DocPanel, type DocPanelMode } from "./DocPanel";
import type {
    AutomationRunEvent,
    Citation,
    EditAnnotation,
} from "../shared/types";
import {
    CaseLawPanel,
    type CaseTab,
} from "./CaseLawPanel";
import {
    LegalSourceViewer,
    type LegalSourceTab,
} from "@/app/components/legal/LegalSourceViewer";
import { cn } from "@/app/lib/utils";
import { LIQUID_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { AutomationRunPanel } from "@/app/components/documents/AutomationRun";

// ---------------------------------------------------------------------------
// Tab data
// ---------------------------------------------------------------------------
//
// Each tab represents ONE of:
//   - a document view (no specific annotation),
//   - a single citation quote,
//   - a single tracked change.
// There is no selector UI inside the panel — the user picks what to view
// by clicking a different tab (or opening a new one from a citation pill,
// an EditCard's View button, or the download card).

type CommonTab = {
    id: string;
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
    warning?: string | null;
    initialScrollTop?: number | null;
};

export type DocumentTab = CommonTab & { kind: "document" };

export type CitationTab = CommonTab & {
    kind: "citation";
    citation: Citation;
};

export type EditTab = CommonTab & {
    kind: "edit";
    edit: EditAnnotation;
    changeNumber?: number;
};

export type AutomationTab = {
    kind: "automation";
    id: string;
    run: AutomationRunEvent;
};

export type AssistantSidePanelTab =
    | DocumentTab
    | CitationTab
    | EditTab
    | CaseTab
    | LegalSourceTab
    | AutomationTab;

interface Props {
    tabs: AssistantSidePanelTab[];
    activeTabId: string | null;
    onActivateTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onCloseAll: () => void;
    /**
     * Parent-driven reloading flag per document. Download buttons in
     * DocPanel show a spinner iff this returns true for the tab's
     * documentId. Used to signal "accept/reject in flight".
     */
    isEditorReloading?: (documentId: string) => boolean;
    /**
     * True while an accept/reject for this exact edit is in flight.
     * Disables the panel's Accept/Reject buttons for only the edit
     * currently being resolved — sibling edits stay clickable.
     */
    isEditReloading?: (editId: string) => boolean;
    onEditResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onEditResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    onEditError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
    onWarningDismiss?: (tabId: string) => void;
    onScrollChange?: (tabId: string, scrollTop: number) => void;
}

const MIN_WIDTH = 300;
const MAX_WIDTH_OFFSET = 56;
const MIN_CHAT_WIDTH = 400;

function maxPanelWidth() {
    if (typeof window === "undefined") return 600;
    return Math.max(
        MIN_WIDTH,
        window.innerWidth - MAX_WIDTH_OFFSET - MIN_CHAT_WIDTH,
    );
}

function tabTitle(tab: AssistantSidePanelTab): string {
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
}: Props) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [panelWidth, setPanelWidth] = useState(() =>
        typeof window !== "undefined"
            ? Math.min(
                  maxPanelWidth(),
                  Math.round((window.innerWidth - MAX_WIDTH_OFFSET) / 2),
              )
            : 600,
    );

    const dragStartX = useRef<number>(0);
    const dragStartWidth = useRef<number>(0);

    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragStartX.current = e.clientX;
            dragStartWidth.current =
                panelRef.current?.offsetWidth ?? panelWidth;

            const onMouseMove = (ev: MouseEvent) => {
                const delta = dragStartX.current - ev.clientX;
                setPanelWidth(
                    Math.min(
                        maxPanelWidth(),
                        Math.max(MIN_WIDTH, dragStartWidth.current + delta),
                    ),
                );
            };
            const onMouseUp = () => {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        },
        [panelWidth],
    );

    useEffect(() => {
        const onResize = () => {
            setPanelWidth((width) =>
                Math.min(maxPanelWidth(), Math.max(MIN_WIDTH, width)),
            );
        };
        window.addEventListener("resize", onResize);
        onResize();
        return () => window.removeEventListener("resize", onResize);
    }, []);

    const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;
    if (!active) return null;

    return (
        <div
            ref={panelRef}
            className={cn(
                "relative flex h-full w-full shrink-0 flex-col md:my-3 md:mr-3 md:h-[calc(100%-1.5rem)] md:w-[var(--assistant-panel-width)]",
                LIQUID_PANEL_SURFACE_CLASS,
                "overflow-hidden",
            )}
            style={{
                "--assistant-panel-width": `${panelWidth}px`,
            } as CSSProperties}
        >
            <div
                onMouseDown={onMouseDown}
                className="absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize hover:bg-gray-400 md:block"
                style={{ marginLeft: -2 }}
            />

            <div className="flex items-start gap-2 border-b border-gray-300 bg-gray-100 p-2">
                <div className="flex max-h-20 min-w-0 flex-1 flex-wrap gap-1 overflow-y-auto">
                    {tabs.map((tab) => {
                        const isActive = tab.id === active.id;
                        const showVersionBadge =
                            tab.kind !== "automation" &&
                            tab.kind !== "case" &&
                            tab.kind !== "legal" &&
                            typeof tab.versionNumber === "number" &&
                            Number.isFinite(tab.versionNumber) &&
                            tab.versionNumber >
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
                                    className={`min-w-0 flex-1 truncate text-xs ${isActive ? "font-medium" : "font-normal"}`}
                                    title={title}
                                >
                                    {title}
                                </span>
                                {showVersionBadge && (
                                    <span
                                        className={`shrink-0 inline-flex items-center rounded border px-1 py-px text-[9px] font-medium ${
                                            isActive
                                                ? "border-gray-200 bg-white text-gray-600"
                                                : "border-gray-300 bg-white/70 text-gray-500"
                                        }`}
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

            {/* Tab bodies — all mounted, inactive ones hidden. Each tab
                preserves its state (scroll, docx-preview render, etc.)
                when inactive. */}
            <div className="flex-1 min-h-0 relative">
                {tabs.map((tab) => {
                    const isActive = tab.id === active.id;
                    if (tab.kind === "automation") {
                        return (
                            <div
                                key={tab.id}
                                className={`absolute inset-0 overflow-y-auto ${isActive ? "" : "invisible pointer-events-none"}`}
                                aria-hidden={!isActive}
                            >
                                <AutomationRunPanel run={tab.run} />
                            </div>
                        );
                    }
                    if (tab.kind === "case") {
                        return (
                            <div
                                key={tab.id}
                                className={`absolute inset-0 flex flex-col ${isActive ? "" : "invisible pointer-events-none"}`}
                                aria-hidden={!isActive}
                            >
                                <CaseLawPanel
                                    tab={tab}
                                    compactActions={panelWidth < 600}
                                />
                            </div>
                        );
                    }
                    if (tab.kind === "legal") {
                        return (
                            <div
                                key={tab.id}
                                className={`absolute inset-0 flex flex-col ${isActive ? "" : "invisible pointer-events-none"}`}
                                aria-hidden={!isActive}
                            >
                                <LegalSourceViewer
                                    provider={tab.provider}
                                    citation={tab.citation}
                                    sourceId={tab.sourceId}
                                    docType={tab.docType}
                                    language={tab.language}
                                    dataset={tab.dataset}
                                    quotes={tab.quotes}
                                    citationRef={tab.citationRef}
                                    compact
                                />
                            </div>
                        );
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
                                        isEditReloading?.(tab.edit.edit_id) ??
                                        false,
                                    onResolveStart: onEditResolveStart,
                                    onResolved: onEditResolved,
                                    onError: onEditError,
                                }
                              : { kind: "document" };
                    return (
                        <div
                            key={tab.id}
                            className={`absolute inset-0 flex flex-col ${isActive ? "" : "invisible pointer-events-none"}`}
                            aria-hidden={!isActive}
                        >
                            <DocPanel
                                documentId={tab.documentId}
                                filename={tab.filename}
                                versionId={tab.versionId}
                                versionNumber={tab.versionNumber}
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
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
