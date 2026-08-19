import "@testing-library/jest-dom/vitest";
import { initializeRuntimeConfig } from "@/app/lib/runtimeConfig";

await initializeRuntimeConfig(async () =>
    new Response(JSON.stringify({ mode: "local" }), {
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
