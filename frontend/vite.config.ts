import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = process.env.BEAVER_API_ORIGIN ?? "http://127.0.0.1:3001";

export default defineConfig({
    plugins: [react()],
    build: {
        rolldownOptions: {
            input: {
                main: fileURLToPath(new URL("./index.html", import.meta.url)),
                word: fileURLToPath(new URL("./word.html", import.meta.url)),
                courtRecords: fileURLToPath(new URL("./court-records.html", import.meta.url)),
                authorities: fileURLToPath(new URL("./authorities.html", import.meta.url)),
            },
        },
    },
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
            "/api": {
                target: apiOrigin,
                changeOrigin: true,
                configure: (proxy) => proxy.on("proxyReq", (request, source) => {
                    if (source.headers.origin) request.setHeader("origin", apiOrigin);
                }),
            },
        },
    },
});
