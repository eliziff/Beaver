"use client";

import { useEffect, useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { Options as DocxPreviewOptions } from "docx-preview";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { supabase } from "@/app/lib/supabase";
import {
    clearDocxQuoteHighlights,
    highlightDocxQuote,
} from "./highlightDocxQuote";
import type { CitationQuote } from "../types";

interface Props {
    documentId: string;
    versionId?: string | null;
    /**
     * Called once the document has been rendered to the DOM. Handy for
     * scrolling to a particular tracked change after a re-render.
     */
    onReady?: () => void;
    /**
     * Tracked-change to scroll to + briefly flash after each render. The
     * `key` is used to re-trigger scrolling when the same edit is clicked
     * twice in a row.
     */
    highlightEdit?: {
        key: string;
        inserted_text?: string;
        deleted_text?: string;
        /**
         * Numeric w:id values of the <w:ins>/<w:del> wrappers in
         * document.xml. Preferred over text matching — uniquely identifies
         * the right DOM element even when multiple edits share identical
         * inserted/deleted text. `docx-preview` drops these during parsing,
         * so we re-tag each rendered <ins>/<del> with data-w-id after load.
         */
        ins_w_id?: string | null;
        del_w_id?: string | null;
    } | null;
    /**
     * Forces a byte re-fetch when it changes, even if documentId/versionId
     * are stable. Used after accept/reject: the backend overwrites bytes at
     * the same storage path (no new version row), so the hook has no other
     * signal that the file changed.
     */
    refetchKey?: number;
    /**
     * Citation quotes to highlight in the rendered output. The first match
     * is scrolled into view. Matching remains text-based; stored Word page
     * breaks are used for display but are not stable quote identifiers.
     */
    quotes?: CitationQuote[];
    /** Changes when the parent wants the current quote re-focused. */
    quoteFocusKey?: string | number;
    /**
     * Warning banner copy rendered in the top-left of the viewer. Used
     * for non-blocking errors (e.g. "Accept failed — reverted").
     */
    warning?: string | null;
    /**
     * Called when the user dismisses the warning banner.
     */
    onWarningDismiss?: () => void;
    /**
     * Scroll position to restore after the first render — used by parents
     * that track per-tab scroll and want to re-enter at the same spot.
     * Null/undefined means "no override" (preserve the pre-render scroll).
     */
    initialScrollTop?: number | null;
    /**
     * Fires on scroll (throttled by rAF) so the parent can persist the
     * current scrollTop against its tab state.
     */
    onScrollChange?: (scrollTop: number) => void;
    rounded?: boolean;
}

export const DOCX_RENDER_OPTIONS = {
    inWrapper: true,
    ignoreWidth: false,
    ignoreHeight: false,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderFootnotes: true,
    renderEndnotes: true,
    renderChanges: true,
    experimental: true,
} satisfies Partial<DocxPreviewOptions>;

export function decorateDocxPages(container: HTMLElement): void {
    const pages = container.querySelectorAll<HTMLElement>(
        ".docx-wrapper > section.docx",
    );
    pages.forEach((page, index) => {
        const pageNumber = String(index + 1);
        page.dataset.pageNumber = pageNumber;
        page.setAttribute("aria-label", `Page ${pageNumber}`);
    });
}

type TrackedChangeId = { kind: "ins" | "del"; w_id: string };
const trackedChangeIdsCache = new Map<
    string,
    Promise<TrackedChangeId[]>
>();

async function loadTrackedChangeIds(
    documentId: string,
    versionId: string | null | undefined,
    refetchKey?: number,
): Promise<TrackedChangeId[]> {
    const key = `${documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;
    const cached = trackedChangeIdsCache.get(key);
    if (cached) return cached;

    const pending = (async () => {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        const apiBase =
            process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
        const qs = versionId
            ? `?version_id=${encodeURIComponent(versionId)}`
            : "";
        const response = await fetch(
            `${apiBase}/single-documents/${documentId}/tracked-change-ids${qs}`,
            { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        if (!response.ok) {
            throw new Error(`tracked-change-ids HTTP ${response.status}`);
        }
        const data = (await response.json()) as { ids?: TrackedChangeId[] };
        return data.ids ?? [];
    })();
    trackedChangeIdsCache.set(key, pending);
    try {
        return await pending;
    } catch (error) {
        trackedChangeIdsCache.delete(key);
        throw error;
    }
}

function findEditElement(
    root: HTMLElement,
    tag: "ins" | "del",
    opts: { w_id?: string | null; text?: string },
): HTMLElement | null {
    if (opts.w_id) {
        const byId = root.querySelector(
            `${tag}[data-w-id="${CSS.escape(opts.w_id)}"]`,
        ) as HTMLElement | null;
        if (byId) return byId;
    }
    const text = opts.text ?? "";
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const target = normalize(text);
    if (!target) return null;
    const candidates = Array.from(root.querySelectorAll(tag)) as HTMLElement[];
    return (
        candidates.find((el) => normalize(el.textContent ?? "") === target) ??
        candidates.find((el) =>
            normalize(el.textContent ?? "").includes(target),
        ) ??
        null
    );
}

function scrollToHighlight(
    container: HTMLElement,
    scrollEl: HTMLElement,
    edit: {
        inserted_text?: string;
        deleted_text?: string;
        ins_w_id?: string | null;
        del_w_id?: string | null;
    },
) {
    const insEl = findEditElement(container, "ins", {
        w_id: edit.ins_w_id,
        text: edit.inserted_text,
    });
    const delEl = findEditElement(container, "del", {
        w_id: edit.del_w_id,
        text: edit.deleted_text,
    });
    const anchor = insEl ?? delEl;
    if (!anchor) return;

    const scrollRect = scrollEl.getBoundingClientRect();
    const targetRect = anchor.getBoundingClientRect();
    const offset = targetRect.top - scrollRect.top + scrollEl.scrollTop - 80;
    scrollEl.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });

    const flashed = [insEl, delEl].filter((el): el is HTMLElement => !!el);
    flashed.forEach((el) => el.classList.add("docx-edit-flash"));
    window.setTimeout(() => {
        flashed.forEach((el) => el.classList.remove("docx-edit-flash"));
    }, 2000);
}

/**
 * Fetch the ordered list of w:ids for every w:ins/w:del in the current
 * version and tag each rendered <ins>/<del> with data-w-id. The backend
 * returns ids in document order, and docx-preview emits <ins>/<del>
 * in the same order, so we can align by index.
 */
async function tagWIdsOnRenderedDom(
    container: HTMLElement,
    documentId: string,
    versionId: string | null | undefined,
    refetchKey?: number,
): Promise<void> {
    try {
        const domEls = Array.from(
            container.querySelectorAll("ins, del"),
        ) as HTMLElement[];
        if (domEls.length === 0) return;

        const ids = await loadTrackedChangeIds(
            documentId,
            versionId,
            refetchKey,
        );
        for (let i = 0; i < Math.min(domEls.length, ids.length); i++) {
            const el = domEls[i];
            const info = ids[i];
            if (el.tagName.toLowerCase() !== info.kind) continue;
            el.setAttribute("data-w-id", info.w_id);
        }
    } catch (e) {
        console.warn("[DocxView] tagWIdsOnRenderedDom failed", e);
    }
}

/**
 * Renders a .docx in the browser using `docx-preview`. Tracked changes
 * (`w:ins` / `w:del`) show up automatically with coloured strike/underline
 * styling. Scroll position is preserved across re-renders so Accept/Reject
 * doesn't jump the user back to the top.
 */
export function DocxView({
    documentId,
    versionId,
    onReady,
    highlightEdit,
    refetchKey,
    quotes,
    quoteFocusKey,
    warning,
    onWarningDismiss,
    initialScrollTop,
    onScrollChange,
    rounded = true,
}: Props) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const lastScrollTopRef = useRef(0);
    const renderKeyRef = useRef(0);
    // Ref-stabilize onReady and highlightEdit so the render effect only
    // re-fires when `bytes` actually change. Without this, any parent
    // re-render (e.g. clicking a new highlight) creates a new onReady
    // identity, triggers a full re-render, and snaps scroll back to top.
    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    const highlightEditRef = useRef(highlightEdit);
    highlightEditRef.current = highlightEdit;
    const quotesRef = useRef(quotes);
    quotesRef.current = quotes;
    const initialScrollTopRef = useRef(initialScrollTop ?? null);
    initialScrollTopRef.current = initialScrollTop ?? null;
    const onScrollChangeRef = useRef(onScrollChange);
    onScrollChangeRef.current = onScrollChange;

    // Stable key for the quote list so the re-highlight effect re-fires
    // only when the actual text/order of quotes changes.
    const quoteKey = useMemo(
        () => (quotes ?? []).map((q) => q.quote).join("||"),
        [quotes],
    );

    const { bytes, loading, error } = useFetchDocxBytes(
        documentId,
        versionId,
        refetchKey,
    );

    /**
     * Highlight every quote in `list` inside the rendered DOM and scroll
     * the first match into view. Returns true if any match was found.
     */
    const applyQuoteHighlights = (
        containerEl: HTMLElement,
        scrollEl: HTMLElement,
        list: CitationQuote[] | undefined,
    ): boolean => {
        clearDocxQuoteHighlights(containerEl);
        if (!list || list.length === 0) return false;

        let firstMatch: HTMLElement | null = null;
        for (const q of list) {
            const match = highlightDocxQuote(containerEl, q.quote);
            if (match && !firstMatch) firstMatch = match;
        }
        if (!firstMatch) return false;

        const scrollRect = scrollEl.getBoundingClientRect();
        const targetRect = firstMatch.getBoundingClientRect();
        const offset =
            targetRect.top -
            scrollRect.top +
            scrollEl.scrollTop -
            scrollEl.clientHeight / 2 +
            targetRect.height / 2;
        scrollEl.scrollTo({
            top: Math.max(0, offset),
            behavior: "instant" as ScrollBehavior,
        });
        return true;
    };

    /**
     * docx-preview renders pages at their natural Word page width (e.g.
     * ~816px for US Letter). When the side-panel is narrower than that,
     * the page overflows horizontally. Apply CSS `zoom` on each
     * section.docx so the document shrinks to fit — `zoom` (unlike
     * `transform: scale`) also shrinks the layout box, so the scroll
     * container's scrollHeight adapts. We zoom each page rather than the
     * wrapper because docx-preview injects flex styles on `.docx-wrapper`
     * that can interfere with wrapper-level zoom.
     */
    const applyDocxScale = () => {
        const containerEl = containerRef.current;
        const scrollEl = scrollRef.current;
        if (!containerEl || !scrollEl) return;
        const wrapper = containerEl.querySelector<HTMLElement>(".docx-wrapper");
        if (!wrapper) return;
        const sections = Array.from(
            wrapper.querySelectorAll<HTMLElement>("section.docx"),
        );
        if (sections.length === 0) return;
        // Page widths do not change after a render. Cache each natural width
        // on its section so panel resizes do not repeatedly force layout for
        // every page in a long document.
        const naturalWidths = sections.map((section) => {
            const cached = Number(section.dataset.docxNaturalWidth);
            if (Number.isFinite(cached) && cached > 0) return cached;
            section.style.zoom = "1";
            return 0;
        });
        naturalWidths.forEach((width, index) => {
            if (width > 0) return;
            const measured = sections[index].offsetWidth;
            naturalWidths[index] = measured;
            if (measured > 0) {
                sections[index].dataset.docxNaturalWidth = String(measured);
            }
        });
        // Use the scroll container's content box (clientWidth - padding)
        // as the available width.
        const styles = window.getComputedStyle(scrollEl);
        const padX =
            (parseFloat(styles.paddingLeft) || 0) +
            (parseFloat(styles.paddingRight) || 0);
        const available = scrollEl.clientWidth - padX;
        if (available <= 0) return;
        // Scale each page independently against its own natural width so
        // landscape/custom-size pages still fit without distorting the
        // page dividers.
        sections.forEach((s, index) => {
            const w = naturalWidths[index];
            if (!w) return;
            const scale = Math.min(1, available / w);
            const nextZoom = String(scale);
            if (s.style.zoom !== nextZoom) s.style.zoom = nextZoom;
        });
    };

    // Observe the scroll container (which tracks the side panel's width)
    // and re-scale whenever its viewport changes. Rendering itself calls
    // applyDocxScale directly; observing document height would create
    // redundant work as pages and images settle.
    useEffect(() => {
        const scrollEl = scrollRef.current;
        if (!scrollEl) return;
        let raf = 0;
        const schedule = () => {
            if (raf) cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => applyDocxScale());
        };
        const ro = new ResizeObserver(schedule);
        ro.observe(scrollEl);
        return () => {
            if (raf) cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        if (!bytes || !containerRef.current || !scrollRef.current) return;

        const scrollEl = scrollRef.current;
        const containerEl = containerRef.current;

        // Remember scroll position across re-renders so Accept/Reject stays put.
        lastScrollTopRef.current = scrollEl.scrollTop;
        const thisRender = ++renderKeyRef.current;

        (async () => {
            try {
                const { renderAsync } = await import("docx-preview");
                if (cancelled) return;
                containerEl.innerHTML = "";
                await renderAsync(
                    bytes,
                    containerEl,
                    undefined,
                    DOCX_RENDER_OPTIONS,
                );
                if (cancelled) return;
                decorateDocxPages(containerEl);
                // Make the first painted frame correctly sized. Documents
                // without tracked changes now avoid the metadata request
                // below entirely.
                applyDocxScale();
                await tagWIdsOnRenderedDom(
                    containerEl,
                    documentId,
                    versionId ?? null,
                    refetchKey,
                );
                if (cancelled) return;
                requestAnimationFrame(() => {
                    if (
                        !scrollRef.current ||
                        thisRender !== renderKeyRef.current
                    )
                        return;
                    const pendingHighlight = highlightEditRef.current;
                    const pendingQuotes = quotesRef.current;
                    const pendingInitialScroll = initialScrollTopRef.current;
                    if (pendingHighlight) {
                        scrollToHighlight(
                            containerEl,
                            scrollRef.current,
                            pendingHighlight,
                        );
                        // Highlight quotes too, but don't override the edit scroll
                        if (pendingQuotes?.length) {
                            for (const q of pendingQuotes)
                                highlightDocxQuote(containerEl, q.quote);
                        }
                    } else if (
                        pendingQuotes &&
                        applyQuoteHighlights(
                            containerEl,
                            scrollRef.current,
                            pendingQuotes,
                        )
                    ) {
                        // scrolled inside applyQuoteHighlights
                    } else if (typeof pendingInitialScroll === "number") {
                        scrollRef.current.scrollTop = pendingInitialScroll;
                    } else {
                        scrollRef.current.scrollTop = lastScrollTopRef.current;
                    }
                    onReadyRef.current?.();
                });
            } catch (e) {
                console.error("docx-preview render failed", e);
            }
        })();

        return () => {
            cancelled = true;
        };
        // documentId/versionId intentionally follow `bytes`: adding them
        // would briefly render the previous document under a new identity
        // while the replacement bytes are loading.
    }, [bytes]); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-scroll/highlight if the target edit changes without a re-render
    // (e.g. same doc, different edit clicked).
    useEffect(() => {
        if (!highlightEdit || !containerRef.current || !scrollRef.current)
            return;
        scrollToHighlight(
            containerRef.current,
            scrollRef.current,
            highlightEdit,
        );
    }, [highlightEdit?.key]); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-apply quote highlights when the quote list changes without a full
    // re-render (e.g. clicking a different citation on the same doc).
    useEffect(() => {
        if (!containerRef.current || !scrollRef.current) return;
        applyQuoteHighlights(
            containerRef.current,
            scrollRef.current,
            quotesRef.current,
        );
    }, [quoteKey, quoteFocusKey]);

    // Fire onScrollChange (rAF-throttled) so parents can persist scroll
    // per-tab. We still maintain lastScrollTopRef locally for same-mount
    // re-renders (Accept/Reject preserving scroll within one view).
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        let scheduled = false;
        const onScroll = () => {
            lastScrollTopRef.current = el.scrollTop;
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                onScrollChangeRef.current?.(el.scrollTop);
            });
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, []);

    return (
        <div
            className={`relative flex flex-col flex-1 overflow-hidden bg-gray-100 ${rounded ? "rounded-lg" : ""}`}
        >
            {warning && (
                <div className="absolute top-2 left-2 z-10 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 shadow-sm">
                    <span>{warning}</span>
                    <button
                        type="button"
                        onClick={() => onWarningDismiss?.()}
                        className="text-amber-600 hover:text-amber-900"
                        aria-label="Dismiss warning"
                    >
                        ×
                    </button>
                </div>
            )}
            <div
                ref={scrollRef}
                className="flex-1 overflow-auto px-5 pt-5 pb-3 docx-view-scroll"
                data-document-id={documentId}
                data-version-id={versionId ?? ""}
            >
                {loading && !bytes && (
                    <div className="flex h-full items-center justify-center">
                        <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                    </div>
                )}
                {error && (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-sm text-red-500">{error}</p>
                    </div>
                )}
                <div ref={containerRef} className="docx-view-container" />
            </div>
        </div>
    );
}
