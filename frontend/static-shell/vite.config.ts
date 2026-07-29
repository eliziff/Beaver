import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  base: "/static-shell/",
  server: { proxy: { "/chat": "http://127.0.0.1:3001", "/library": "http://127.0.0.1:3001" } },
  preview: { proxy: { "/chat": "http://127.0.0.1:3001", "/library": "http://127.0.0.1:3001" } },
  build: { outDir: resolve(__dirname, "../dist-static-shell"), emptyOutDir: true, sourcemap: false },
});
