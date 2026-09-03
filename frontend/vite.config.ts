import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = process.env.BEAVER_API_ORIGIN ?? "http://127.0.0.1:3001";
const pages = {
    main: fileURLToPath(new URL("./index.html", import.meta.url)),
    word: fileURLToPath(new URL("./word.html", import.meta.url)),
    courtRecords: fileURLToPath(new URL("./court-records.html", import.meta.url)),
    authorities: fileURLToPath(new URL("./authorities.html", import.meta.url)),
};
const canonicalJsonEsm = {
    name: "canonical-json-esm",
    apply: "serve" as const,
    enforce: "pre" as const,
    transform(code: string, id: string) {
        if (!id.replaceAll("\\", "/").endsWith("/shared/canonical-json.cjs")) return;
        return code.replace('"use strict";', "")
            .replace("exports.canonicalJson = canonicalJson;", "export { canonicalJson };");
    },
};

export default defineConfig(({ mode }) => {
    const input: Record<string, string> = mode === "court-records"
        ? { courtRecords: pages.courtRecords }
        : mode === "authorities" ? { authorities: pages.authorities }
            : { main: pages.main, word: pages.word };
    return {
        plugins: [canonicalJsonEsm, react()],
        build: {
            modulePreload: { polyfill: false },
            emptyOutDir: mode === "production",
            rolldownOptions: { input },
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
    };
});
