import { useEffect, useRef, useState } from "react";
import { getDocumentReaderText, type DocumentReaderText } from "@/app/lib/api/documents";
import type { HighlightCapture, SavedHighlight } from "../legal/SourcesWorkspace";
import type { ResearchSourceReference } from "@/app/lib/researchFiles";
import { readerBlockSpan, readerSelectionSpan } from "./readerSelection";

type HighlightController = {
  armed: boolean; arm: (armed: boolean) => void;
  run: () => Promise<SavedHighlight | null>;
  registerReader: (capture: (() => HighlightCapture | null) | null) => void;
};

export function useLibraryReaderCapture(root: React.RefObject<HTMLElement | null>,
  reference: ResearchSourceReference | null, highlight: HighlightController | null,
  onSaved: (saved: SavedHighlight | null) => void = () => undefined) {
  const [text, setText] = useState<DocumentReaderText | null>(null),
    picked = useRef<HighlightCapture | null>(null), save = useRef(onSaved);
  save.current = onSaved;
  const id = reference?.kind === "document" ? reference.id : null,
    version = reference?.kind === "document" ? reference.versionId : null;
  useEffect(() => {
    setText(null); picked.current = null;
    if (!id || !version || !highlight) return;
    const abort = new AbortController();
    void getDocumentReaderText(id, version, abort.signal).then(setText).catch(() => undefined);
    return () => abort.abort();
  }, [id, version, !!highlight]);
  const register = highlight?.registerReader;
  useEffect(() => {
    register?.(text ? () => { const span = picked.current; picked.current = null; return span; } : null);
    return () => register?.(null);
  }, [register, text]);
  useEffect(() => {
    if (!highlight || !text || !reference || !root.current) return;
    const element = root.current;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") highlight.arm(false); };
    const pointerUp = (event: PointerEvent) => {
      if (!element.contains(event.target as Node)) return;
      const selection = window.getSelection(), block = (event.target as Element)?.closest?.<HTMLElement>("[data-legal-text]"),
        span = selection?.isCollapsed && block ? readerBlockSpan(block, text.slices)
          : readerSelectionSpan(element, selection, text.slices);
      picked.current = span ? { reference, revision: text.revision, ...span } : null;
      if (highlight.armed && picked.current) void highlight.run().then(save.current).catch(() => undefined);
    };
    document.addEventListener("keydown", escape); element.addEventListener("pointerup", pointerUp);
    return () => { document.removeEventListener("keydown", escape); element.removeEventListener("pointerup", pointerUp); };
  }, [highlight, reference, root, text]);
  return !!text;
}
