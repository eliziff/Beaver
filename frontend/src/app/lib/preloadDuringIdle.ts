export function preloadDuringIdle(load: () => void) {
    const run = () => load();
    if ("requestIdleCallback" in window) {
        const id = window.requestIdleCallback(run, { timeout: 250 });
        return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(run, 0);
    return () => clearTimeout(id);
}
