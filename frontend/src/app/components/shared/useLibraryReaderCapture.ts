import { useEffect, useRef } from "react";
import type { HighlightCapture, SavedHighlight } from "@/app/components/legal/SourcesWorkspace";
import type { ResearchSourceReference } from "@/app/lib/researchFiles";

type HighlightController = {
  armed: boolean;
  arm: (armed: boolean) => void;
  run: () => Promise<SavedHighlight | null>;
  registerReader: (capture: (() => HighlightCapture | null) | null) => void;
};

/**
 * Registers a reader capture for the Highlight tool on a rendered document root: a PDF text layer,
 * a Word rendition, any rendered text. These readers render the original file, not the canonical
 * text, so they report the letters they captured and the server anchors that run to a span in the
 * revision it holds. Pressing a toolbar button collapses the selection, so the reader remembers the
 * last one made inside it and that is what the Highlight control saves. Clicking a
 * `[data-legal-block]` captures the whole block, and Escape disarms.
 */
export function useLibraryReaderCapture(
  root: React.RefObject<HTMLElement | null>,
  reference: ResearchSourceReference | null,
  highlight: HighlightController | null,
  onSaved: (saved: SavedHighlight | null) => void = () => undefined,
) {
  const wholeBlock = useRef<HTMLElement | null>(null), picked = useRef(""), save = useRef(onSaved);
  save.current = onSaved;
  const capture = useRef<() => HighlightCapture | null>(() => null);
  capture.current = () => {
    const block = wholeBlock.current;
    wholeBlock.current = null;
    const quote = (block ? block.textContent ?? "" : picked.current).replace(/\s+/gu, " ").trim();
    picked.current = "";
    return reference && root.current && quote ? { reference, quote } : null;
  };
  const registerReader = highlight?.registerReader;
  useEffect(() => {
    registerReader?.(() => capture.current());
    return () => registerReader?.(null);
  }, [registerReader]);
  useEffect(() => {
    if (!highlight) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") highlight.arm(false); };
    /** What the reader remembers is the selection the user finished making, never a later one the
     *  browser reshaped as pages rendered. */
    const selected = () => {
      const element = root.current, selection = window.getSelection();
      picked.current = element && selection && !selection.isCollapsed && selection.rangeCount
        && element.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : "";
    };
    /** Clicking a block captures the whole block; finishing a selection inside one does not. */
    const click = (event: MouseEvent) => {
      const element = root.current;
      const block = (event.target as Element | null)?.closest?.("[data-legal-block]") as HTMLElement | null;
      if (!highlight.armed || !block || !element?.contains(block) || window.getSelection()?.isCollapsed === false) return;
      wholeBlock.current = block;
      void highlight.run().then(save.current).catch(() => undefined);
    };
    const pointerUp = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) return;
      selected();
      if (highlight.armed && picked.current) void highlight.run().then(save.current).catch(() => undefined);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("click", click);
    document.addEventListener("pointerup", pointerUp);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("click", click);
      document.removeEventListener("pointerup", pointerUp);
    };
  }, [highlight, root]);
}
