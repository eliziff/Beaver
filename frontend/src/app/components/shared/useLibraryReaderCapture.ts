import { useEffect, useRef } from "react";
import { legalPassageTargetFromSelection } from "@/app/components/legal/LegalSourceViewer";
import type { HighlightCapture } from "@/app/components/legal/SourcesWorkspace";
import type { ResearchSourceReference } from "@/app/lib/researchFiles";

type HighlightController = {
  armed: boolean;
  arm: (armed: boolean) => void;
  run: () => Promise<unknown>;
  registerReader: (capture: (() => HighlightCapture | null) | null) => void;
};

/**
 * Registers a reader capture for the Highlight tool on a rendered document
 * root. While armed, pointer-up with a selection saves it, clicking a
 * `[data-legal-block]` captures the whole block, and Escape disarms.
 */
export function useLibraryReaderCapture(
  root: React.RefObject<HTMLElement | null>,
  reference: ResearchSourceReference | null,
  highlight: HighlightController | null,
) {
  const wholeBlock = useRef<HTMLElement | null>(null);
  const capture = useRef<() => HighlightCapture | null>(() => null);
  capture.current = () => {
    const block = wholeBlock.current;
    wholeBlock.current = null;
    if (!reference || !root.current) return null;
    if (block) {
      const kind = block.dataset.locatorKind as HighlightCapture["locator"]["kind"] | undefined,
        value = block.dataset.locatorValue,
        quote = (block.textContent ?? "").replace(/\s+/gu, " ").trim();
      return kind && value && quote ? { reference, locator: { kind, value }, quote } : null;
    }
    const target = legalPassageTargetFromSelection(root.current, window.getSelection());
    return target ? { reference, ...target } : null;
  };
  const registerReader = highlight?.registerReader;
  useEffect(() => {
    registerReader?.(() => capture.current());
    return () => registerReader?.(null);
  }, [registerReader]);
  useEffect(() => {
    if (!highlight || !root.current) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") highlight.arm(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [highlight, root]);
  useEffect(() => {
    const element = root.current;
    if (!highlight?.armed || !element) return;
    const click = (event: MouseEvent) => {
      const block = (event.target as Element | null)?.closest?.("[data-legal-block]") as HTMLElement | null;
      if (block && element.contains(block)) {
        wholeBlock.current = block;
        void highlight.run().catch(() => undefined);
      }
    };
    const pointerUp = () => {
      if (window.getSelection()?.isCollapsed === false) void highlight.run().catch(() => undefined);
    };
    element.addEventListener("click", click);
    element.addEventListener("pointerup", pointerUp);
    return () => {
      element.removeEventListener("click", click);
      element.removeEventListener("pointerup", pointerUp);
    };
  }, [highlight, root]);
}
