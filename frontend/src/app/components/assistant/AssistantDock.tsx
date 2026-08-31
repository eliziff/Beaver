import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { Tabs } from "@/app/components/ui/tabs";

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
}: {
    tabs: AssistantDockTab[];
    activeTabId: string;
    onActivateTab: (id: string) => void;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    inspectorContent?: ReactNode;
    inspectorOpen?: boolean;
    onCloseInspector?: () => void;
}) {
    const [width, setWidth] = useState(480);
    const resizeStart = useRef<{ x: number; width: number } | null>(null);
    const dock = useRef<HTMLElement>(null);
    const changeExpanded = useRef(onExpandedChange);
    const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
    changeExpanded.current = onExpandedChange;

    useEffect(() => {
        const resize = (event: PointerEvent) => {
            if (!resizeStart.current) return;
            setWidth(
                Math.max(
                    360,
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
    }, []);

    useEffect(() => {
        const panel = dock.current;
        if (!expanded || !panel || !window.matchMedia?.("(max-width: 767px)").matches) return;
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
            if (event.key === "Escape") { event.preventDefault(); changeExpanded.current(false); return; }
            if (event.key !== "Tab") return;
            const items = controls();
            const first = items[0], last = items.at(-1);
            if (!first || !last) return;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        panel.addEventListener("keydown", trapFocus);
        return () => {
            panel.removeEventListener("keydown", trapFocus);
            previousState.forEach(({ node, inert, hidden }) => {
                node.inert = inert;
                if (hidden === null) node.removeAttribute("aria-hidden"); else node.setAttribute("aria-hidden", hidden);
            });
            if (parent) parent.style.overflow = previousOverflow;
            previousFocus?.focus();
        };
    }, [expanded]);

    if (!active) return null;
    if (!expanded) {
        return createPortal(
            <button
                type="button"
                onClick={() => onExpandedChange(true)}
                className="fixed end-3 top-3 z-[110] grid size-9 place-items-center rounded-md border border-gray-200 bg-app-surface text-gray-700 hover:bg-app-floating focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                aria-label="Expand assistant dock"
            >
                <PanelRightOpen className="size-4" aria-hidden="true" />
            </button>,
            document.body,
        );
    }
    const showingInspector = active.id !== "sources" && inspectorOpen;
    return (
        <aside
            ref={dock}
            tabIndex={-1}
            data-assistant-dock
            aria-label="Assistant dock"
            className={cn(
                "absolute inset-0 z-40 flex h-full w-full min-h-0 shrink-0 flex-col overflow-hidden border border-gray-300 bg-app-surface shadow-lg",
                "md:relative md:inset-auto md:my-3 md:me-3 md:h-[calc(100dvh-1.5rem)] md:w-[min(var(--assistant-dock-width),50%)] md:rounded-2xl",
            )}
            style={{ "--assistant-dock-width": `${width}px` } as CSSProperties}
        >
            <div
                role="separator"
                aria-label="Resize assistant dock"
                aria-orientation="vertical"
                tabIndex={0}
                onPointerDown={(event) => {
                    resizeStart.current = { x: event.clientX, width };
                    document.body.style.cursor = "col-resize";
                    document.body.style.userSelect = "none";
                }}
                onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    setWidth((current) =>
                        Math.max(
                            360,
                            Math.min(
                                window.innerWidth - 48,
                                current + (event.key === "ArrowLeft" ? 24 : -24),
                            ),
                        ),
                    );
                }}
                className="absolute inset-y-0 start-0 z-20 hidden w-1 cursor-col-resize bg-transparent hover:bg-gray-300 focus-visible:bg-gray-400 focus-visible:outline-none md:block"
            />
            <Tabs
                value={active.id}
                onValueChange={onActivateTab}
                options={tabs.map(({ id, label, icon }) => ({ value: id, label:
                    <span className="flex min-w-0 items-center justify-center gap-1.5">
                        {icon && <span className="hidden sm:inline-flex">{icon}</span>}
                        <span className="truncate">{label}</span>
                    </span> }))}
                ariaLabel="Assistant panels"
                variant="dock" actions={active.actions} className="h-full"
            >
                <div className={cn(
                    "relative min-h-0 flex-1 overflow-hidden",
                    showingInspector && "grid grid-rows-[minmax(0,2fr)_minmax(0,3fr)]",
                )}>
                    <div className={cn(
                        "relative min-h-0 overflow-hidden",
                        showingInspector ? "" : "absolute inset-0",
                    )}>
                        {tabs.map((tab) => <div
                            key={tab.id}
                            aria-hidden={tab.id !== active.id}
                            className={cn(
                                "absolute inset-0 flex flex-col overflow-hidden",
                                tab.id !== active.id && "invisible pointer-events-none",
                            )}
                        >
                            {tab.content}
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
                aria-label="Collapse assistant dock"
            >
                <PanelRightClose className="size-4" aria-hidden="true" />
            </button>
        </aside>
    );
}
