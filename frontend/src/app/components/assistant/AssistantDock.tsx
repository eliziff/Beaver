import { Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bot, BookOpenText, Folder, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { ASSISTANT_DOCK_CLASS } from "./assistantDockLayout";
import { Tabs } from "@/app/components/ui/tabs";
import { LibrarySkeuoIcon, WorkflowSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";

const compactDock = "(max-width: 1279px)";

export type AssistantDockTab = {
    id: string;
    label: string;
    icon?: ReactNode;
    actions?: ReactNode;
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
    defaultWidth = 480,
    minWidth = 360,
    maxWidth = "calc(100% - 36rem)",
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
    const [compact, setCompact] = useState(() => window.matchMedia?.(compactDock).matches ?? false);
    const resizeStart = useRef<{ x: number; width: number } | null>(null);
    const dock = useRef<HTMLElement>(null);
    const changeExpanded = useRef(onExpandedChange);
    const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
    const [visited, setVisited] = useState(() => new Set(expanded && active ? [active.id] : []));
    changeExpanded.current = onExpandedChange;

    useEffect(() => {
        if (expanded && active && !visited.has(active.id)) {
            setVisited((ids) => new Set(ids).add(active.id));
        }
    }, [active, expanded, visited]);

    useEffect(() => {
        const media = window.matchMedia?.(compactDock);
        if (!media) return;
        const update = () => setCompact(media.matches);
        media.addEventListener?.("change", update);
        return () => media.removeEventListener?.("change", update);
    }, []);

    useEffect(() => {
        const resize = (event: PointerEvent) => {
            if (!resizeStart.current) return;
            setWidth(
                Math.max(
                    minWidth,
                    Math.min(
                        window.innerWidth - 48,
                        resizeStart.current.width + resizeStart.current.x - event.clientX,
                    ),
                ),
            );
        };
        const stop = () => {
            resizeStart.current = null;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("pointermove", resize);
        window.addEventListener("pointerup", stop);
        return () => {
            window.removeEventListener("pointermove", resize);
            window.removeEventListener("pointerup", stop);
            stop();
        };
    }, [minWidth]);

    useLayoutEffect(() => {
        const panel = dock.current;
        if (!expanded || !compact || !panel) return;
        const root = document.documentElement;
        const previousRootGutter = root.style.scrollbarGutter;
        root.style.scrollbarGutter = "auto";
        const parent = panel.parentElement;
        const previousFocus = document.activeElement as HTMLElement | null;
        const siblings = parent ? [...parent.children].filter((node) => node !== panel) as HTMLElement[] : [];
        const previousOverflow = parent?.style.overflow ?? "";
        const previousState = siblings.map((node) => ({
            node, inert: node.inert, hidden: node.getAttribute("aria-hidden"),
        }));
        siblings.forEach((node) => { node.inert = true; node.setAttribute("aria-hidden", "true"); });
        if (parent) parent.style.overflow = "hidden";
        const controls = () => [...panel.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
        )].filter((node) => node.getAttribute("role") !== "separator" && !node.closest('[aria-hidden="true"]'));
        (panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? controls()[0] ?? panel).focus();
        const trapFocus = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                const dialog = event.target instanceof Element
                    ? event.target.closest('dialog, [role="dialog"], [role="alertdialog"]') : null;
                if (dialog && dialog !== panel) return;
                event.preventDefault();
                changeExpanded.current(false);
                return;
            }
            if (event.key !== "Tab") return;
            const items = controls();
            const first = items[0], last = items.at(-1);
            if (!first || !last) return;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        panel.addEventListener("keydown", trapFocus);
        return () => {
            root.style.scrollbarGutter = previousRootGutter;
            panel.removeEventListener("keydown", trapFocus);
            previousState.forEach(({ node, inert, hidden }) => {
                node.inert = inert;
                if (hidden === null) node.removeAttribute("aria-hidden"); else node.setAttribute("aria-hidden", hidden);
            });
            if (parent) parent.style.overflow = previousOverflow;
            previousFocus?.focus();
        };
    }, [compact, expanded]);

    if (!active) return null;
    const expandButton = !expanded && showCollapsedButton ? (
            <button
                type="button"
                onClick={() => onExpandedChange(true)}
                className="absolute end-3 top-3 z-30 grid size-9 place-items-center rounded-md border border-gray-200 bg-app-surface text-gray-700 hover:bg-app-floating focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                aria-label="Expand assistant dock"
            >
                <PanelRightOpen className="size-4" aria-hidden="true" />
            </button>
        ) : null;
    const showingInspector = active.id !== "sources" && inspectorOpen;
    return <>
        {expandButton}
        <aside
            ref={dock}
            tabIndex={-1}
            data-assistant-dock
            role={expanded && compact ? "dialog" : undefined}
            aria-modal={expanded && compact || undefined}
            aria-label="Assistant dock"
            aria-hidden={!expanded}
            inert={!expanded ? true : undefined}
            className={cn(
                expanded ? "flex min-h-0 shrink-0 flex-col overflow-hidden border border-gray-300 bg-app-surface shadow-lg" : "hidden",
                ASSISTANT_DOCK_CLASS,
            )}
            style={{ "--assistant-dock-width": `${width}px`, "--assistant-dock-max-width": maxWidth } as CSSProperties}
        >
            <div
                role="separator"
                aria-label="Resize assistant dock"
                aria-orientation="vertical"
                tabIndex={0}
                onPointerDown={(event) => {
                    resizeStart.current = { x: event.clientX, width: dock.current?.getBoundingClientRect().width || width };
                    document.body.style.cursor = "col-resize";
                    document.body.style.userSelect = "none";
                }}
                onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    setWidth((current) =>
                        Math.max(
                            minWidth,
                            Math.min(
                                window.innerWidth - 48,
                                (dock.current?.getBoundingClientRect().width || current) + (event.key === "ArrowLeft" ? 24 : -24),
                            ),
                        ),
                    );
                }}
                className="absolute inset-y-0 start-0 z-20 hidden w-1 cursor-col-resize bg-transparent hover:bg-gray-300 focus-visible:bg-gray-400 focus-visible:outline-none xl:block"
            />
            <Tabs
                value={active.id}
                onValueChange={onActivateTab}
                options={tabs.map(({ id, label, icon }) => ({ value: id, label:
                    <span className="flex min-w-0 items-center justify-center gap-1.5">
                        <span className="inline-flex">{icon ?? dockIcon(id)}</span>
                        <span className="truncate max-[25rem]:sr-only">{label}</span>
                    </span> }))}
                ariaLabel="Assistant panels"
                variant="dock" actions={active.actions} className="h-full"
                railClassName="pe-12"
            >
                <div className={cn(
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
                                tab.id !== active.id && "invisible pointer-events-none",
                            )}
                        >
                            <Suspense fallback={<div className="h-full bg-app-surface" />}>
                                {tab.content}
                            </Suspense>
                        </div>)}
                    </div>
                    {showingInspector && <section
                    aria-label="Sources"
                    className="flex min-h-0 flex-col overflow-hidden border-t border-gray-300"
                >
                    <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 bg-gray-50 ps-3 pe-2">
                        <span className="text-xs font-medium text-gray-600">Sources</span>
                        <button
                            type="button"
                            onClick={onCloseInspector}
                            aria-label="Close sources"
                            className="grid size-8 place-items-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                        >
                            <X className="size-3.5" aria-hidden="true" />
                        </button>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{inspectorContent}</div>
                </section>}
                </div>
            </Tabs>
            <button
                type="button"
                onClick={() => onExpandedChange(false)}
                className="absolute end-2 top-1.5 z-10 grid size-9 place-items-center rounded-md border border-gray-200 bg-app-surface text-gray-700 hover:bg-app-floating focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                aria-label={compact ? "Close assistant" : "Collapse assistant dock"}
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
