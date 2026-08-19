import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            "docx-preview": fileURLToPath(
                new URL("./vendor/docx-preview/index.ts", import.meta.url),
            ),
        },
    },
    server: {
        proxy: {
            "/api": "http://127.0.0.1:3001",
        },
    },
});
