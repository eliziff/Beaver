import { fileURLToPath, URL } from "node:url";
import { realpathSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import { precompressedAssets } from "./scripts/precompressed-assets.mjs";

const apiOrigin = process.env.BEAVER_API_ORIGIN ?? "http://127.0.0.1:3001";
const pages = {
    main: fileURLToPath(new URL("./index.html", import.meta.url)),
    word: fileURLToPath(new URL("./word.html", import.meta.url)),
    courtRecords: fileURLToPath(new URL("./court-records.html", import.meta.url)),
    authorities: fileURLToPath(new URL("./authorities.html", import.meta.url)),
};

export default defineConfig(({ mode }) => {
    const input: Record<string, string> = mode === "court-records"
        ? { courtRecords: pages.courtRecords }
        : mode === "authorities" ? { authorities: pages.authorities }
            : { main: pages.main, word: pages.word };
    return {
        plugins: [react(), precompressedAssets(), {
            name: "embedded-court-records-route",
            configureServer(server) {
                server.middlewares.use((request, _response, next) => {
                    // Vite's extensionless HTML fallback otherwise selects the standalone page.
                    request.url = request.url?.replace(/^\/court-records(?=\?|$)/u, "/index.html");
                    next();
                });
            },
        }],
        build: {
            modulePreload: { polyfill: false },
            emptyOutDir: mode === "production",
            rolldownOptions: {
                input,
                output: {
                    strictExecutionOrder: true,
                    codeSplitting: {
                        groups: [{
                            // Stable platform code, not a catch-all vendor chunk.
                            name: "platform",
                            test: /node_modules[\\/](?:react|react-dom|react-router|react-router-dom|scheduler|tailwind-merge)[\\/]/,
                            priority: 30,
                            includeDependenciesRecursively: false,
                        }, {
                            // Only configuration-independent UI primitives. Do
                            // not capture feature modals, viewers, or adapters.
                            name: "ui-primitives",
                            test: /src[\\/]app[\\/]components[\\/](?:ui[\\/]|modals[\\/]Modal(?:Select|TextInput|Textarea|SegmentedToggle|FieldLabel)?\.tsx$|shared[\\/](?:TablePrimitive|TableToolbar|PageHeader|CollectionState)\.tsx$)/,
                            minShareCount: 2,
                            includeDependenciesRecursively: false,
                        }, {
                            // Avoid dozens of sub-kilobyte requests for shared
                            // icons on a cold connection. Leave single-entry
                            // icons with their existing chunks; do not pull
                            // React or application dependencies into this group.
                            name: "shared-icons",
                            test: /node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/]/,
                            minShareCount: 2,
                            includeDependenciesRecursively: false,
                        }],
                    },
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
            fs: { allow: [searchForWorkspaceRoot(process.cwd()),
                realpathSync(new URL("./node_modules", import.meta.url))] },
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
