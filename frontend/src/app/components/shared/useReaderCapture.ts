import { useEffect, useRef, useState } from "react";
import { getDocumentReaderText } from "@/app/lib/api/documents";
import type { HighlightCapture } from "../legal/SourcesWorkspace";
import type { ResearchSourceReference } from "@/app/lib/researchFiles";
import { readerBlockSpan, readerSelectionSpan, type ReaderSlice } from "./readerSelection";

type HighlightController = {
  armed: boolean; arm: (armed: boolean) => void; run: () => Promise<boolean>;
  registerReader: (capture: (() => HighlightCapture | null) | null) => void;
};
type ReaderText = { revision: string; slices: ReaderSlice[] };

/** All readers capture the served revision; selection alone never opens a palette. */
export function useReaderCapture(root: React.RefObject<HTMLElement | null>,
  reference: ResearchSourceReference | null, highlight: HighlightController | null,
  supplied?: ReaderText | null, onError: (message: string) => void = () => undefined) {
  const [loaded, setLoaded] = useState<ReaderText | null>(null), text = supplied ?? loaded;
  const id = reference?.kind === "document" ? reference.id : null,
    version = reference?.kind === "document" ? reference.versionId : null;
  useEffect(() => {
    setLoaded(null);
    if (!id || !version || !highlight) return;
    const abort = new AbortController();
    void getDocumentReaderText(id, version, abort.signal).then(setLoaded).catch(() => undefined);
    return () => abort.abort();
  }, [id, version, !!highlight]);
  const block = useRef<HTMLElement | null>(null), capture = useRef<() => HighlightCapture | null>(() => null);
  capture.current = () => {
    const whole = block.current; block.current = null;
    if (!root.current || !text || !reference) return null;
    const span = whole ? readerBlockSpan(whole, text.slices) : readerSelectionSpan(root.current, window.getSelection(), text.slices);
    if (!span && (whole || window.getSelection()?.isCollapsed === false))
      throw new Error("Could not locate this selection in the source. Select the passage again.");
    return span ? { reference, revision: text.revision, ...span } : null;
  };
  const register = highlight?.registerReader;
  useEffect(() => {
    register?.(text ? () => capture.current() : null);
    return () => register?.(null);
  }, [register, !!text]);
  useEffect(() => {
    const element = root.current;
    if (!element || !highlight || !text) return;
    const pointerUp = (event: PointerEvent) => {
      if (!highlight.armed) return;
      const target = event.target instanceof Element ? event.target : null;
      if (window.getSelection()?.isCollapsed !== false) {
        if (target?.closest("[data-research-evidence]")) return;
        block.current = target?.closest<HTMLElement>("[data-legal-text]") ?? null;
      }
      void highlight.run().catch((error: Error) => onError(error.message));
    };
    element.addEventListener("pointerup", pointerUp);
    return () => element.removeEventListener("pointerup", pointerUp);
  }, [highlight, root, !!text, onError]);
  return !!text;
}
