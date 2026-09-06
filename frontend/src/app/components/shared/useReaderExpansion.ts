import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

export function preserveReaderScroll(target: HTMLElement | null) {
    const positions = target ? [target, ...target.querySelectorAll("*")]
        .filter((node) => node.scrollTop || node.scrollLeft)
        .map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft })) : [];
    return () => positions.forEach(({ node, top, left }) => {
        if (node.isConnected) { node.scrollTop = top; node.scrollLeft = left; }
    });
}

export function useReaderExpansion(target: RefObject<HTMLElement | null>, enabled = true) {
    const [fullscreen, setFullscreen] = useState(false);
    const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
    const expanded = fullscreen || fallbackFullscreen;
    const restoreScroll = useRef<(() => void) | null>(null);
    useEffect(() => {
        const update = () => setFullscreen(!!target.current && document.fullscreenElement === target.current);
        document.addEventListener("fullscreenchange", update);
        return () => document.removeEventListener("fullscreenchange", update);
    }, [target]);
    useEffect(() => {
        if (!enabled) {
            setFallbackFullscreen(false);
            if (document.fullscreenElement === target.current) void document.exitFullscreen();
        }
    }, [enabled, target]);
    async function expandReader(next: boolean) {
        if (next) restoreScroll.current = preserveReaderScroll(target.current);
        if (!next && fallbackFullscreen) { setFallbackFullscreen(false); return; }
        try {
            if (next) await target.current?.requestFullscreen();
            else await document.exitFullscreen();
        } catch { if (next) setFallbackFullscreen(true); }
    }
    useLayoutEffect(() => {
        if (expanded) return;
        restoreScroll.current?.(); restoreScroll.current = null;
    }, [expanded]);
    useLayoutEffect(() => {
        const panel = target.current;
        if (!fallbackFullscreen || !panel) return;
        const previousFocus = document.activeElement as HTMLElement | null;
        const siblings: HTMLElement[] = [];
        for (let current: HTMLElement | null = panel; current?.parentElement; current = current.parentElement) {
            siblings.push(...[...current.parentElement.children].filter((node) => node !== current) as HTMLElement[]);
            if (current.parentElement === document.body) break;
        }
        const previous = siblings.map((node) => ({ node, inert: node.inert, hidden: node.getAttribute("aria-hidden") }));
        siblings.forEach((node) => { node.inert = true; node.setAttribute("aria-hidden", "true"); });
        const controls = () => [...panel.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
        )].filter((node) => !node.closest('[aria-hidden="true"], [hidden], [inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" && node.getAttribute("role") !== "separator");
        panel.querySelector<HTMLElement>('[aria-label="Restore reader size"]')?.focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return;
            const nested = event.target instanceof Element ? event.target.closest('dialog, [role="dialog"], [role="alertdialog"]') : null;
            if (nested && nested !== panel) return;
            if (event.key === "Escape") { event.preventDefault(); setFallbackFullscreen(false); }
            if (event.key !== "Tab") return;
            const items = controls(), first = items[0], last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        };
        panel.addEventListener("keydown", keydown);
        return () => {
            panel.removeEventListener("keydown", keydown);
            previous.forEach(({ node, inert, hidden }) => { node.inert = inert;
                if (hidden === null) node.removeAttribute("aria-hidden"); else node.setAttribute("aria-hidden", hidden); });
            if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        };
    }, [fallbackFullscreen, target]);

    return { expanded, onChange: (next: boolean) => { void expandReader(next); },
        style: expanded ? { position: "fixed", inset: 0, zIndex: 1000, width: "100vw",
            height: "100dvh", maxWidth: "none", margin: 0, borderRadius: 0,
            overscrollBehavior: "contain" } as CSSProperties : undefined,
        dialogProps: expanded ? { role: "dialog" as const, "aria-modal": true as const } : {},
    };
}
