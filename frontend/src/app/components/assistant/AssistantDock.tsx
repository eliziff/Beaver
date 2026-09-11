import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bot, BookOpenText, Folder, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { ASSISTANT_DOCK_CLASS, ASSISTANT_DOCK_DEFAULT_WIDTH, ASSISTANT_DOCK_MAX_WIDTH,
    ASSISTANT_DOCK_MIN_WIDTH } from "./assistantDockLayout";
import { Tabs } from "@/app/components/ui/tabs";
import { LibrarySkeuoIcon, WorkflowSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ReaderExpandButton } from "../shared/ReaderExpandButton";
import { useReaderExpansion } from "../shared/useReaderExpansion";

const widthProperty = "--assistant-dock-width";

export type AssistantDockTab = {
    id: string;
    label: string;
    title?: ReactNode;
    icon?: ReactNode;
    actions?: ReactNode;
    readerExpansion?: boolean;
    content: ReactNode;
};

export function AssistantDock({
    tabs,
    activeTabId,
    onActivateTab,
    expanded,
    onExpandedChange,
    inspectorContent,
    inspectorOpen = false,
    onCloseInspector,
    showCollapsedButton = true,
    defaultWidth = ASSISTANT_DOCK_DEFAULT_WIDTH,
    minWidth = ASSISTANT_DOCK_MIN_WIDTH,
    maxWidth = ASSISTANT_DOCK_MAX_WIDTH,
}: {
    tabs: AssistantDockTab[];
    activeTabId: string;
    onActivateTab: (id: string) => void;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    inspectorContent?: ReactNode;
    inspectorOpen?: boolean;
    onCloseInspector?: () => void;
    showCollapsedButton?: boolean;
    defaultWidth?: number;
    minWidth?: number;
    maxWidth?: string;
}) {
    const [width, setWidth] = useState(defaultWidth);
    const resizeStart = useRef<{
        x: number; width: number; min: number; max: number; next: number;
    } | null>(null);
    const dock = useRef<HTMLElement>(null);
    const reader = useReaderExpansion(dock, expanded);
    const singleTitleId = useId();
    const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
    const workspaceOnly = tabs.length === 1 && active?.label === "Workspace";
    const canExpandReader = reader.expanded || (active?.readerExpansion ??
        active?.id === "sources");
    const [visited, setVisited] = useState(() => new Set(expanded && active ? [active.id] : []));

    useEffect(() => {
        if (expanded && active && !visited.has(active.id)) {
            setVisited((ids) => new Set(ids).add(active.id));
        }
    }, [active, expanded, visited]);

    function measuredWidths() {
        const panel = dock.current;
        const fallbackMax = Math.max(0, window.innerWidth - 48);
        if (!panel) return { current: width, min: Math.min(minWidth, fallbackMax), max: fallbackMax };
        const current = panel.getBoundingClientRect().width || width;
        const previous = panel.style.getPropertyValue(widthProperty);
        panel.style.setProperty(widthProperty, "1000000px");
        const max = panel.getBoundingClientRect().width || fallbackMax;
        panel.style.setProperty(widthProperty, previous);
        const min = Math.min(minWidth, max);
        return { current: Math.max(min, Math.min(current, max)), min, max };
    }

    useEffect(() => {
        const resize = (event: PointerEvent) => {
            const start = resizeStart.current;
            if (!start) return;
            start.next = Math.max(start.min, Math.min(start.max,
                start.width + start.x - event.clientX));
            dock.current?.style.setProperty(widthProperty, `${start.next}px`);
        };
        const finish = (commit: boolean) => {
            const start = resizeStart.current;
            resizeStart.current = null;
            if (commit && start) setWidth(start.next);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        const stop = () => finish(true);
        window.addEventListener("pointermove", resize);
        window.addEventListener("pointerup", stop);
        return () => {
            window.removeEventListener("pointermove", resize);
            window.removeEventListener("pointerup", stop);
            finish(false);
        };
    }, []);

    if (!active) return null;
    const expandButton = !expanded && showCollapsedButton ? (
            <button
                type="button"
                onClick={() => onExpandedChange(true)}
                className="absolute end-3 top-0.5 z-30 grid size-[34px] place-items-center rounded-md border border-gray-200 bg-app-surface text-gray-700 hover:bg-app-floating focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                aria-label={workspaceOnly ? "Expand workspace" : "Expand assistant dock"}
            >
                <PanelRightOpen className="size-4" aria-hidden="true" />
            </button>
        ) : null;
    const showingInspector = active.id !== "sources" && inspectorOpen;
    const panel = <div className={cn(
        "relative min-h-0 flex-1 overflow-hidden",
        showingInspector && "grid grid-rows-[minmax(0,2fr)_minmax(0,3fr)]",
    )}>
        <div className={cn(
            "relative min-h-0 overflow-hidden",
            showingInspector ? "" : "absolute inset-0",
        )}>
            {tabs.filter((tab) => visited.has(tab.id) || expanded && tab.id === active.id).map((tab) => <div
                key={tab.id}
                aria-hidden={tab.id !== active.id}
                className={cn(
                    "absolute inset-0 flex flex-col overflow-hidden",
                    tab.id !== active.id && "invisible opacity-0 pointer-events-none",
                )}
            >
                {tab.content}
            </div>)}
        </div>
        {showingInspector && <section aria-label="Sources"
            className="flex min-h-0 flex-col overflow-hidden border-t border-gray-300">
            <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 bg-gray-50 ps-3 pe-2">
                <span className="text-xs font-medium text-gray-600">Sources</span>
                <button type="button" onClick={onCloseInspector} aria-label="Close sources"
                    className="grid size-8 place-items-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                    <X className="size-3.5" aria-hidden="true" />
                </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{inspectorContent}</div>
        </section>}
    </div>;
    return <>
        {expandButton}
        <aside
            ref={dock}
            tabIndex={-1}
            data-assistant-dock
            {...reader.dialogProps}
            aria-label={workspaceOnly ? "Workspace" : "Assistant dock"}
            aria-hidden={!expanded}
            inert={!expanded ? true : undefined}
            className={cn(
                expanded ? "@container flex min-h-0 shrink-0 flex-col overflow-hidden border border-gray-300 bg-app-surface shadow-lg" : "hidden",
                ASSISTANT_DOCK_CLASS,
            )}
            style={{ [widthProperty]: `${width}px`, "--assistant-dock-max-width": maxWidth,
                ...reader.style } as CSSProperties}
        >
            <div
                role="separator"
                aria-label={workspaceOnly ? "Resize workspace" : "Resize assistant dock"}
                aria-orientation="vertical"
                tabIndex={0}
                onPointerDown={(event) => {
                    const measured = measuredWidths();
                    resizeStart.current = { x: event.clientX, width: measured.current,
                        min: measured.min, max: measured.max, next: measured.current };
                    dock.current?.style.setProperty(widthProperty, `${measured.current}px`);
                    document.body.style.cursor = "col-resize";
                    document.body.style.userSelect = "none";
                }}
                onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    const measured = measuredWidths();
                    setWidth(Math.max(measured.min, Math.min(measured.max,
                        measured.current + (event.key === "ArrowLeft" ? 24 : -24))));
                }}
                className="absolute inset-y-0 start-0 z-20 w-1 cursor-col-resize bg-transparent hover:bg-gray-300 focus-visible:bg-gray-400 focus-visible:outline-none"
            />
            {tabs.length === 1 ? <div className="flex h-full min-h-0 flex-col">
                <div data-tabs-rail className={cn("flex min-h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-1.5", canExpandReader ? "pe-22" : "pe-12")}>
                    <span id={singleTitleId} className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-semibold text-gray-900">
                        {active.title ?? <><span className="inline-flex shrink-0">{active.icon ?? dockIcon(active.id)}</span>
                        <span className="truncate">{active.label}</span></>}
                    </span>
                    {active.actions && <span data-tabs-actions className="flex min-w-0 max-w-[55%] shrink items-center justify-end overflow-hidden">
                        {active.actions}
                    </span>}
                </div>
                <div role="region" aria-labelledby={singleTitleId} className="flex min-h-0 flex-1 flex-col">
                    {panel}
                </div>
            </div> : <Tabs
                value={active.id}
                onValueChange={onActivateTab}
                options={tabs.map(({ id, label, icon }) => ({ value: id, label:
                    <span className="flex min-w-0 items-center justify-center gap-1.5">
                        <span className="inline-flex">{icon ?? dockIcon(id)}</span>
                        <span className="truncate @max-[25rem]:sr-only">{label}</span>
                    </span> }))}
                ariaLabel="Assistant panels"
                variant="dock" actions={active.actions && <span className="flex justify-end">
                    {active.actions}
                </span>} className="h-full"
                railClassName={canExpandReader ? "pe-22" : "pe-12"}
            >
                {panel}
            </Tabs>}
            {canExpandReader && <span className="absolute end-12 top-2 z-10">
                <ReaderExpandButton expanded={reader.expanded} onChange={reader.onChange} />
            </span>}
            <button
                type="button"
                onClick={() => onExpandedChange(false)}
                className="absolute end-2 top-1.5 z-10 grid size-9 place-items-center rounded-md border border-gray-200 bg-app-surface text-gray-700 hover:bg-app-floating focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                aria-label={workspaceOnly
                    ? "Collapse workspace"
                    : "Collapse assistant dock"}
            >
                <PanelRightClose className="size-4" aria-hidden="true" />
            </button>
        </aside>
    </>;
}

const dockIcon = (id: string) => id === "library" ? <LibrarySkeuoIcon />
    : id === "workflows" ? <WorkflowSkeuoIcon />
    : id === "sources" ? <BookOpenText className="size-4" />
    : id === "agents" ? <Bot className="size-4" />
    : <Folder className="size-4" />;
