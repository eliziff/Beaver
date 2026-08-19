import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { initializeRuntimeConfig } from "@/app/lib/runtimeConfig";

const container = document.getElementById("root");
if (!container) throw new Error("Missing Beaver application root");
const root = createRoot(container);

try {
    await initializeRuntimeConfig();
    const { Router } = await import("@/app/router");
    root.render(
        <StrictMode>
            <Router />
        </StrictMode>,
    );
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
