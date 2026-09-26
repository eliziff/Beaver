// The dock shares layout space with its sibling at every viewport width.
// Keep it in flow: overlays prevent concurrent use of chat and workspace.
export const ASSISTANT_DOCK_CLASS =
    "relative my-3 me-3 h-[calc(100%-1.5rem)] min-w-0 w-[min(var(--assistant-dock-width),var(--assistant-dock-max-width))] rounded-2xl";
export const ASSISTANT_DOCK_DEFAULT_WIDTH = 520;
// 324 = 360 less 10%: at narrow widths the dock yields ~10% so the chat keeps room.
export const ASSISTANT_DOCK_MIN_WIDTH = 324;
// The cap the dock honours while open in flow (at xl and wider): never below its
// floor, and never so wide that the reading column beside it drops under 43rem.
// Below xl the dock is a modal drawer, so it no longer competes for that space.
export const ASSISTANT_DOCK_MAX_WIDTH = `max(${ASSISTANT_DOCK_MIN_WIDTH}px, calc(100% - 43rem))`;

// Whether the dock is open carries over between the start screen and each chat in this
// browser tab: every chat mounts its own view, and without it the dock would snap shut.
const DOCK_OPEN_KEY = "beaver.assistant.dockOpen";
export function rememberedDockOpen() {
    try { return sessionStorage.getItem(DOCK_OPEN_KEY) === "1"; } catch { return false; }
}
export function rememberDockOpen(open: boolean) {
    try { sessionStorage.setItem(DOCK_OPEN_KEY, open ? "1" : "0"); } catch { /* unavailable */ }
}
