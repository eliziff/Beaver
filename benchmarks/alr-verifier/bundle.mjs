// Bundles what compose.ts runs (the ALR runtime's operations, and the model arms' codexArm.ts) into modules of
// <out dir>, so each compose process starts without compiling TypeScript: node bundle.mjs <ALR repository> <out dir>.
// Packages stay in node_modules. The bundles' require and __dirname are backend/src/lib's, which the bundled modules
// resolve their files from.
import { build } from "esbuild";
import path from "node:path";

const [alr, outdir] = process.argv.slice(2);
await build({
  entryPoints: { operations: path.join(alr, "beaver_app/runtime/operations.ts"),
    canliiIndex: path.join(alr, "beaver_app/runtime/canliiIndex.ts"),
    canlii: path.join(import.meta.dirname, "../../backend/src/lib/legalSources/canlii.ts"),
    a2aj: path.join(import.meta.dirname, "../../backend/src/lib/legalSources/a2aj.ts"),
    ai: path.join(import.meta.dirname, "../../backend/src/lib/quoteVerification/runModel.ts"),
    checkedWorkbook: path.join(import.meta.dirname, "../../backend/src/lib/quoteVerification/checkedWorkbook.ts"),
    codexArm: path.join(import.meta.dirname, "codexArm.ts") },
  // Split, so the entries share one copy of each module (the CanLII index compose installs is the one operations reads).
  bundle: true, splitting: true, platform: "node", format: "esm", packages: "external", logLevel: "warning", outExtension: { ".js": ".mjs" },
  tsconfig: path.join(import.meta.dirname, "tsconfig.json"), outdir,
  // The page's file mounts (its wasm SQLite): compose mounts no picked file, and the index opens canlii.db by its path.
  plugins: [{ name: "no-page-mounts", setup(build) {
    build.onResolve({ filter: /html[\\/]node[\\/]sqlite\.mjs$/ }, () => ({ path: "page-mounts", namespace: "page-mounts" }));
    build.onLoad({ filter: /.*/, namespace: "page-mounts" }, () => ({
      contents: "export const ready = Promise.resolve(); export function mountFile() {}" }));
  } }],
  banner: { js: [
    "import { createRequire as __alrRequire } from 'node:module';",
    "import { fileURLToPath as __alrPath } from 'node:url';",
    "import { dirname as __alrDir, join as __alrJoin } from 'node:path';",
    "const require = __alrRequire(import.meta.url);",
    `const __dirname = __alrJoin(__alrDir(__alrPath(import.meta.url)), ${JSON.stringify(path.relative(outdir,
      path.join(import.meta.dirname, "../../backend/src/lib")).replaceAll("\\", "/"))});`,
    "const __filename = __alrJoin(__dirname, 'bundle.mjs');",
  ].join(" ") },
});
