import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  base: "/static-shell/",
  build: {
    outDir: resolve(__dirname, "../dist-static-shell"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
