import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  base: "/static-shell/",
  build: { outDir: resolve(__dirname, "../dist-static-shell"), emptyOutDir: true, sourcemap: false },
});
