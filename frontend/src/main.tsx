import "@/app/globals.css";
import { initializeRuntimeConfig } from "@/app/lib/runtimeConfig";
import { createRoot } from "react-dom/client";
import { Router } from "@/app/router";

// A tab opened before a rebuild references chunk names that no longer exist;
// reload once instead of surfacing "Failed to fetch" on the next screen.
window.addEventListener("vite:preloadError", (event) => {
    const key = "beaver:chunk-reload";
    if (sessionStorage.getItem(key) === location.href) return;
    sessionStorage.setItem(key, location.href); event.preventDefault(); location.reload();
});

const container = document.getElementById("root");
if (!container) throw new Error("Missing Beaver application root");
const root = createRoot(container);

try {
    // Route definitions are configuration-independent, so Vite can preload
    // their static dependencies from HTML instead of discovering them after
    // the entry module executes. Runtime-dependent routes still wait here.
    const config = await initializeRuntimeConfig();
    const gate = config.mode === "cloud"
        ? await import("@/app/components/shared/MfaLoginGate") : null;
    root.render(<Router LoginGate={gate?.MfaLoginGate} />);
} catch (error) {
    console.error("Beaver startup failed:", error);
    root.render(
        <main className="flex min-h-dvh items-center justify-center p-6">
            <div className="max-w-md text-center">
                <h1 className="font-serif text-3xl text-gray-900">
                    Beaver could not start
                </h1>
                <p className="mt-3 text-sm text-gray-600" role="alert">
                    The application configuration could not be loaded. Check the
                    server and refresh this page.
                </p>
            </div>
        </main>,
    );
}
