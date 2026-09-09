// The dock shares layout space with its sibling at every viewport width.
// Keep it in flow: overlays prevent concurrent use of chat and workspace.
export const ASSISTANT_DOCK_CLASS =
    "relative my-3 me-3 h-[calc(100%-1.5rem)] min-w-0 w-[min(var(--assistant-dock-width),var(--assistant-dock-max-width))] rounded-2xl";
