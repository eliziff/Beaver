import { beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { initializeRuntimeConfig } from "@/app/lib/runtimeConfig";

await initializeRuntimeConfig(async () =>
    new Response(JSON.stringify({
        mode: "local", capabilities: { connectors: false },
    }), {
        headers: { "Content-Type": "application/json" },
    }),
);

if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
        this.open = false;
    };
}

const readBlob = <T>(blob: Blob, method: "readAsArrayBuffer" | "readAsText") =>
    new Promise<T>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result as T);
        reader[method](blob);
    });
Blob.prototype.arrayBuffer ??= function () { return readBlob(this, "readAsArrayBuffer"); };
Blob.prototype.text ??= function () { return readBlob(this, "readAsText"); };

// Per-tab UI state (for example whether the assistant dock is open) must not carry between tests.
beforeEach(() => sessionStorage.clear());

// The React Compiler's Babel pass makes a lazy module's first import slower under test;
// waits for such a module get more than Testing Library's default 1 s.
configure({ asyncUtilTimeout: 5_000 });
