import { fileURLToPath, URL } from "node:url";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
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
    const input: Record<string, string> = mode === "court-records" || mode === "authorities"
        ? { courtRecords: pages.courtRecords, authorities: pages.authorities }
        : { main: pages.main, word: pages.word };
    return {
        // React Compiler memoizes components and hooks at build time, so a render re-runs
        // only what changed. Code that breaks the Rules of React is left uncompiled.
        plugins: [react(), babel({ presets: [reactCompilerPreset()] }), precompressedAssets(), {
            name: "shared-schema-entry",
            config(config, { command }) {
                const output = config.build?.rolldownOptions?.output;
                if (command === "build" && !Array.isArray(output) && output?.codeSplitting !== false) {
                    // A stable namespace lets separate build graphs share the same schema chunk.
                    return { resolve: { alias: [{
                        find: /^zod$/,
                        replacement: createRequire(import.meta.url).resolve("zod"),
                    }] } };
                }
            },
        }, {
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
                    // Keep routes, viewers and libraries readable; shorten internal import URLs.
                    chunkFileNames: chunk => chunk.isDynamicEntry || /^(?:platform|pdf-library|docx-renderer|class-merging|schema-library|court-profiles|authorities-presets|common-icons|icon-runtime|ui-primitives|shared-icons|DocxCanvas|createLucideIcon)$/.test(chunk.name)
                        ? "assets/[name]-[hash].js"
                        : "assets/[hash].js",
                    // Identical CSS from separate entry graphs shares one payload.
                    assetFileNames: ({ names }) => names.some(name => name.endsWith(".css"))
                        ? "assets/style-[hash][extname]"
                        : "assets/[name]-[hash][extname]",
                    codeSplitting: {
                        groups: [{
                            // Share React independently of routing and class merging.
                            name: "platform",
                            test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
                            priority: 30,
                            includeDependenciesRecursively: false,
                        }, {
                            // The app and standalone assemblers use the same PDF library.
                            name: "pdf-library",
                            test: /node_modules[\\/](?:pdf-lib|@pdf-lib[\\/](?:standard-fonts|upng)|pako|tslib)[\\/]/,
                            priority: 20,
                            includeDependenciesRecursively: false,
                        }, {
                            // Both document viewers use the same DOCX renderer.
                            name: "docx-renderer",
                            test: /vendor[\\/]docx-preview[\\/]dist[\\/]docx-preview\.mjs$/,
                            priority: 20,
                            includeDependenciesRecursively: false,
                        }, {
                            // Share class merging across otherwise separate UI graphs.
                            name: "class-merging",
                            test: /node_modules[\\/]tailwind-merge[\\/]/,
                            priority: 20,
                            includeDependenciesRecursively: false,
                        }, {
                            name: "schema-library",
                            test: /node_modules[\\/](?:zod)[\\/]/,
                            priority: 20,
                            includeDependenciesRecursively: false,
                        }, {
                            // Share presets independently of the Court Records catalogue.
                            name: "authorities-presets",
                            test: /shared[\\/]authorities-profiles\.json$/,
                            priority: 20,
                            includeDependenciesRecursively: false,
                        }, {
                            // Keep the complete profile catalogue in one shared payload.
                            name: "court-profiles",
                            test: /shared[\\/]court-record-profiles\.json$/,
                            priority: 20,
                            includeDependenciesRecursively: false,
                        }, {
                            // Share the measured one-export icon intersection and its factory import.
                            name: "common-icons",
                            test: /node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](?:arrow-left|book-marked|book-open|check|chevron-down|chevron-left|chevron-right|chevron-up|circle-alert|circle-question-mark|clock|download|ellipsis|external-link|eye|file-check-corner|file-plus-corner|file-stack|file-type-corner|file-x-corner|folder-input|folder-open|folder-search|folder-up|folder|highlighter|history|loader-circle|lock-keyhole|maximize-2|minimize-2|mouse-pointer-2|pause|pencil|play|plus|redo-2|rotate-cw|scale|search|settings-2|sliders-horizontal|square|text-quote|trash-2|undo-2|upload|x|zoom-in|zoom-out)\.js$/,
                            priority: 20,
                            includeDependenciesRecursively: false,
                        }, {
                            name: "icon-runtime",
                            test: /node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/](?:createLucideIcon|Icon|defaultAttributes|shared[\\/]src[\\/]utils)\.js$/,
                            priority: 20,
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
                "mike/shared": fileURLToPath(new URL("../shared", import.meta.url)),
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
