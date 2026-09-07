import { useLayoutEffect, useRef } from "react";

/** One placement for every anchored panel in the workspace: beside its anchor, inside the viewport,
 *  clear of the assistant dock, re-clamped while the page moves, dismissed on Escape or a click outside. */
export function useAnchoredPopover({ anchor, open = true, onDismiss, below = false }: {
  anchor: HTMLElement | DOMRect | null | undefined; open?: boolean;
  onDismiss: () => void; below?: boolean }) {
  const node = useRef<HTMLDivElement>(null), dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    const panel = node.current; if (!open || !panel) return;
    if (typeof panel.showPopover === "function") try { panel.showPopover(); }
    catch { panel.removeAttribute("popover"); }
    else panel.removeAttribute("popover");
    let frame = 0;
    const place = () => {
      const box = panel.getBoundingClientRect(), rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
      const dock = [...document.querySelectorAll<HTMLElement>("[data-assistant-dock]")]
        .map((element) => element.getBoundingClientRect())
        .filter((candidate) => candidate.width > 200 && (!rect || candidate.left > rect.left))
        .sort((left, right) => left.left - right.left)[0];
      const right = dock && rect && rect.left < dock.left ? dock.left - 8 : innerWidth - 8;
      panel.style.maxWidth = `${Math.max(0, innerWidth - 16)}px`;
      const beside = below ? rect?.left ?? (innerWidth - box.width) / 2
        : rect?.right && rect.right + box.width + 8 <= right ? rect.right + 8
          : rect && rect.left - box.width - 8 >= 8 ? rect.left - box.width - 8 : (innerWidth - box.width) / 2;
      panel.style.left = `${Math.max(8, Math.min(beside, Math.max(8, right - box.width)))}px`;
      panel.style.top = `${Math.max(8, Math.min(below ? (rect?.bottom ?? 0) + 4 : rect?.top ?? (innerHeight - box.height) / 2,
        Math.max(8, innerHeight - box.height - 8)))}px`;
    };
    const reclamp = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    panel.querySelector<HTMLElement>("[data-label-select][aria-pressed=true], button")?.focus();
    const outside = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node) &&
        !(anchor instanceof HTMLElement && anchor.contains(event.target as Node))) dismiss.current();
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); dismiss.current(); } };
    const observer = globalThis.ResizeObserver ? new ResizeObserver(reclamp) : null;
    observer?.observe(panel);
    document.addEventListener("pointerdown", outside);
    panel.addEventListener("keydown", keydown);
    addEventListener("resize", reclamp);
    addEventListener("scroll", reclamp, true);
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect();
      document.removeEventListener("pointerdown", outside);
      panel.removeEventListener("keydown", keydown);
      removeEventListener("resize", reclamp);
      removeEventListener("scroll", reclamp, true);
      try { panel.hidePopover?.(); } catch { /* Already closed or unsupported. */ }
    };
  }, [anchor, open, below]);
  return node;
}
