import { CITATIONS_OPEN_TAG } from "./citations";

/**
 * Splits an assistant content stream at the <CITATIONS> marker: prose before
 * the marker goes to onVisible, everything after to onHidden. A tail one
 * character shorter than the marker is held back so the tag is caught even
 * when it straddles chunk boundaries. Both chat transports (cloud
 * runLLMStream and local streamAnonymousChat) share this exact algorithm —
 * it must never fork again.
 */
export function createVisibleStreamSplitter(sink: {
  onVisible: (text: string) => void;
  /** Fires once when the marker is found, before any hidden content. */
  onOpen?: () => void;
  onHidden?: (text: string) => void;
}) {
  let tail = "";
  let open = false;
  return {
    get open() {
      return open;
    },
    push(delta: string) {
      if (!delta) return;
      if (open) {
        sink.onHidden?.(delta);
        return;
      }
      const combined = tail + delta;
      const markerIndex = combined.indexOf(CITATIONS_OPEN_TAG);
      if (markerIndex >= 0) {
        if (markerIndex > 0) sink.onVisible(combined.slice(0, markerIndex));
        tail = "";
        open = true;
        sink.onOpen?.();
        const hidden = combined.slice(markerIndex + CITATIONS_OPEN_TAG.length);
        if (hidden) sink.onHidden?.(hidden);
        return;
      }
      const retained = Math.min(CITATIONS_OPEN_TAG.length - 1, combined.length);
      tail = combined.slice(combined.length - retained);
      const visible = combined.slice(0, combined.length - retained);
      if (visible) sink.onVisible(visible);
    },
    /** Returns and clears the held-back visible tail (empty once open). */
    takeTail(): string {
      const t = open ? "" : tail;
      tail = "";
      return t;
    },
    reset() {
      tail = "";
      open = false;
    },
  };
}
